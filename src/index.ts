import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";

const worker = new Worker();
export default worker;

// Managed database — logs every outbound callback call the sync makes
const callbackCallLog = worker.database("callbackCallLog", {
	type: "managed",
	initialTitle: "Callback Call Log",
	primaryKeyProperty: "Callback ID",
	schema: {
		properties: {
			"Customer":    Schema.title(),
			"Callback ID": Schema.richText(),
			"Phone":       Schema.richText(),
			"Reason":      Schema.richText(),
			"Called At":   Schema.date(),
			"Result":      Schema.select([{ name: "Called" }, { name: "Failed", color: "red" }]),
		},
	},
});

// Set these in .env or push via `ntn workers env push`
// To find IDs: ntn datasources resolve <database-id>
function ordersDs(): string {
	const id = process.env.ORDERS_DATA_SOURCE_ID;
	if (!id) throw new Error("ORDERS_DATA_SOURCE_ID env var is not set");
	return id;
}

function pricingDs(): string {
	const id = process.env.PRICING_DATA_SOURCE_ID;
	if (!id) throw new Error("PRICING_DATA_SOURCE_ID env var is not set");
	return id;
}

// For querying only — data source ID from `ntn datasources resolve <db-id>`
function callbacksDs(): string {
	const id = process.env.CALLBACKS_DATA_SOURCE_ID;
	if (!id) throw new Error("CALLBACKS_DATA_SOURCE_ID env var is not set");
	return id;
}

// For pages.create — must use the Notion database ID (from URL), NOT data_source_id
function callbacksDbId(): string {
	const id = process.env.CALLBACKS_DATABASE_ID;
	if (!id) throw new Error("CALLBACKS_DATABASE_ID env var is not set");
	return id;
}

function twilioEnv() {
	const accountSid = process.env.TWILIO_ACCOUNT_SID;
	const authToken = process.env.TWILIO_AUTH_TOKEN;
	const fromNumber = process.env.TWILIO_PHONE_NUMBER;
	const webhookBase = process.env.TWILIO_WEBHOOK_BASE;
	if (!accountSid || !authToken || !fromNumber || !webhookBase) {
		throw new Error(
			"Missing Twilio env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, TWILIO_WEBHOOK_BASE",
		);
	}
	return { accountSid, authToken, fromNumber, webhookBase };
}

// Extract plain text from a Notion title or rich_text property value
function getText(prop: any): string {
	return (prop?.rich_text ?? prop?.title ?? [])
		.map((t: any) => t.plain_text as string)
		.join("");
}

type OrderShape = {
	pageId: string;
	orderId: string;
	customerName: string;
	phone: string | null;
	price: number | null;
	expectedDate: string | null;
	notes: string;
	orderType: string | null;
	tracker: string | null;
	paymentMethod: string | null;
	garmentType: string | null;
};

function shapeOrder(page: any): OrderShape {
	const p = page.properties;
	return {
		pageId:        page.id as string,
		orderId:       getText(p["ORDER_ID"]),
		customerName:  getText(p["CUSTOMER_NAME"]),
		phone:         (p["ORDER_PHONE"]?.phone_number ?? null) as string | null,
		price:         (p["ORDER_PRICE"]?.number ?? null) as number | null,
		expectedDate:  (p["EXPECTED_DATE"]?.date?.start ?? null) as string | null,
		notes:         getText(p["NOTES"]),
		orderType:     getText(p["ORDER_TYPE"]) || null,
		tracker:       getText(p["TRACKER_STAGE"]) || null,
		paymentMethod: getText(p["PAYMENT_METHOD"]) || null,
		garmentType:   getText(p["GARMENT_TYPE"]) || null,
	};
}

// ─── READ TOOLS ──────────────────────────────────────────────────────────────

worker.tool("getOrderByPhone", {
	title: "Get Orders by Phone",
	description:
		"Look up all orders associated with a phone number. Returns order details including ID, customer name, price, expected pickup date, notes, order type, tracker stage, payment status, and garment type. Primary lookup when a customer calls in. Returns up to 5 most recent orders.",
	schema: j.object({
		phone: j
			.string()
			.describe("Customer phone number exactly as stored, e.g. +14155551234"),
	}),
	hints: { readOnlyHint: true },
	execute: async ({ phone }, { notion }) => {
		const res = await notion.dataSources.query({
			data_source_id: ordersDs(),
			filter: { property: "ORDER_PHONE", phone_number: { equals: phone } },
			page_size: 5,
		});
		const orders = res.results.map((p) => shapeOrder(p));
		return { found: orders.length > 0, orders };
	},
});

worker.tool("getOrderById", {
	title: "Get Order by ID",
	description:
		"Look up a specific order by its ORDER_ID value. Use this when the customer provides their order number verbally during the call.",
	schema: j.object({
		orderId: j.string().describe("The ORDER_ID value provided by the customer"),
	}),
	hints: { readOnlyHint: true },
	execute: async ({ orderId }, { notion }) => {
		const res = await notion.dataSources.query({
			data_source_id: ordersDs(),
			filter: { property: "ORDER_ID", rich_text: { equals: orderId } },
			page_size: 1,
		});
		const results = res.results.map((p) => shapeOrder(p));
		return { found: results.length > 0, order: results[0] ?? null };
	},
});

worker.tool("lookupPrice", {
	title: "Look Up Price",
	description:
		"Look up the price for a specific item from the pricing schedule. Use when a customer asks how much something costs, or to auto-fill ORDER_PRICE when updating an order. The item name must match exactly (e.g. 'Shirt (dress)', 'Pants (casual)', 'Wedding Dress'). If unsure of the exact name, call listAllPrices first. Also returns any special notes (e.g. 'Call for quote on heavily beaded').",
	schema: j.object({
		item: j
			.string()
			.describe(
				"Exact item name from the pricing schedule, e.g. 'Shirt (dress)', 'Pants (casual)', 'Wedding Dress'",
			),
		orderType: j
			.enum("Regular", "Expedited")
			.describe("Whether to get the regular or expedited price"),
	}),
	hints: { readOnlyHint: true },
	execute: async ({ item, orderType }, { notion }) => {
		const res = await notion.dataSources.query({
			data_source_id: pricingDs(),
			filter: { property: "ITEM", rich_text: { equals: item } },
			page_size: 1,
		});
		const p = res.results.length > 0 ? (res.results[0] as any).properties : null;
		const price = p
			? orderType === "Expedited"
				? (p["EXPEDITED_PRICE"]?.number ?? null)
				: (p["REGULAR_PRICE"]?.number ?? null)
			: null;
		const notes = p ? getText(p["NOTES"]) : null;
		const category = p ? (getText(p["CATEGORY"]) || null) : null;
		return { found: res.results.length > 0, item, orderType, price, category, notes };
	},
});

worker.tool("listAllPrices", {
	title: "List All Prices",
	description:
		"Return the full pricing schedule grouped by category (Tops, Bottoms, Dresses, Suits, etc.) with regular and expedited prices and any special notes per item. Use when a customer asks for a general price list or when you need to find the correct item name before calling lookupPrice.",
	schema: j.object({}),
	hints: { readOnlyHint: true },
	execute: async (_input, { notion }) => {
		const res = await notion.dataSources.query({
			data_source_id: pricingDs(),
			page_size: 100,
		});
		const prices = res.results.map((page: any) => {
			const p = page.properties;
			return {
				category: getText(p["CATEGORY"]) || null,
				item: getText(p["ITEM"]),
				regularPrice: (p["REGULAR_PRICE"]?.number ?? null) as number | null,
				expeditedPrice: (p["EXPEDITED_PRICE"]?.number ?? null) as number | null,
				notes: getText(p["NOTES"]) || null,
			};
		});
		return { prices };
	},
});

worker.tool("searchOrdersByName", {
	title: "Search Orders by Name",
	description:
		"Search for orders by customer name. Use as a fallback when getOrderByPhone finds nothing — e.g. customer is calling from a different number. Returns partial matches. Always confirm identity with the customer before reading or updating any order data.",
	schema: j.object({
		name: j.string().describe("Customer name or partial name to search for"),
	}),
	hints: { readOnlyHint: true },
	execute: async ({ name }, { notion }) => {
		const res = await notion.dataSources.query({
			data_source_id: ordersDs(),
			filter: { property: "CUSTOMER_NAME", title: { contains: name } },
			page_size: 5,
		});
		const orders = res.results.map((p) => shapeOrder(p));
		return { found: orders.length > 0, orders };
	},
});

worker.tool("cancelOrder", {
	title: "Cancel Order",
	description:
		"Mark an order as Cancelled by updating the TRACKER stage. Use when a customer calls to cancel before pickup. Always confirm with the customer before cancelling — this cannot be undone by the voice agent.",
	schema: j.object({
		pageId: j
			.string()
			.describe("Notion page ID from getOrderByPhone or getOrderById"),
	}),
	execute: async ({ pageId }, { notion }) => {
		await notion.pages.update({
			page_id: pageId,
			properties: {
				TRACKER_STAGE: { rich_text: [{ type: "text", text: { content: "Cancelled" } }] } as any,
			},
		});
		return { success: true };
	},
});

// ─── WRITE TOOLS ─────────────────────────────────────────────────────────────

worker.tool("appendOrderNote", {
	title: "Append Order Note",
	description:
		"Append a note to an existing order. Use this to record customer preferences, special handling instructions, or any NLP-captured information from the call (e.g. 'fabric is delicate, cold wash only'). Previous notes are preserved.",
	schema: j.object({
		pageId: j
			.string()
			.describe(
				"Notion page ID returned by getOrderByPhone or getOrderById (the pageId field)",
			),
		note: j
			.string()
			.describe("Text to append to the order notes. Be specific and concise."),
	}),
	execute: async ({ pageId, note }, { notion }) => {
		const page = (await notion.pages.retrieve({ page_id: pageId })) as any;
		const existing = getText(page.properties["NOTES"]);
		const updated = existing ? `${existing}\n${note}` : note;
		await notion.pages.update({
			page_id: pageId,
			properties: {
				NOTES: {
					type: "rich_text",
					rich_text: [{ type: "text", text: { content: updated } }],
				},
			},
		});
		return { success: true, notes: updated };
	},
});

worker.tool("setOrderType", {
	title: "Set Order Type",
	description:
		"Change an order's type — e.g. upgrade a Regular order to Expedited when a customer requests faster service. Consider calling lookupPrice afterward to update the price accordingly.",
	schema: j.object({
		pageId: j
			.string()
			.describe(
				"Notion page ID returned by getOrderByPhone or getOrderById (the pageId field)",
			),
		orderType: j
			.enum("Regular", "Expedited")
			.describe("The new order type to set"),
	}),
	execute: async ({ pageId, orderType }, { notion }) => {
		await notion.pages.update({
			page_id: pageId,
			properties: {
				ORDER_TYPE: { rich_text: [{ type: "text", text: { content: orderType } }] } as any,
			},
		});
		return { success: true, orderType };
	},
});

worker.tool("updateTracker", {
	title: "Update Tracker Stage",
	description:
		"Update how far along an order is in the cleaning process. Use this when staff report progress or when a customer asks and the status has changed.",
	schema: j.object({
		pageId: j
			.string()
			.describe(
				"Notion page ID returned by getOrderByPhone or getOrderById (the pageId field)",
			),
		stage: j
			.enum(
				"Received",
				"Sorting",
				"Cleaning",
				"Pressing",
				"Ready for Pickup",
				"Delivered",
				"Cancelled",
			)
			.describe("The current stage of the order"),
	}),
	execute: async ({ pageId, stage }, { notion }) => {
		await notion.pages.update({
			page_id: pageId,
			properties: {
				TRACKER_STAGE: { rich_text: [{ type: "text", text: { content: stage } }] } as any,
			},
		});
		return { success: true, stage };
	},
});

worker.tool("updatePayment", {
	title: "Update Payment",
	description: "Record how an order was paid.",
	schema: j.object({
		pageId: j.string().describe("Notion page ID from getOrderByPhone or getOrderById"),
		paymentMethod: j.enum("Cash", "Card", "Venmo", "Zelle", "Unpaid").describe("How the customer paid"),
	}),
	execute: async ({ pageId, paymentMethod }, { notion }) => {
		await notion.pages.update({
			page_id: pageId,
			properties: {
				PAYMENT_METHOD: { rich_text: [{ type: "text", text: { content: paymentMethod } }] } as any,
			},
		});
		return { success: true, paymentMethod };
	},
});

worker.tool("updateGarmentType", {
	title: "Update Garment Type",
	description:
		"Set or correct the garment item on an order. Use the exact item name from the pricing schedule (e.g. 'Shirt (dress)', 'Pants (casual)', 'Wedding Dress'). Call listAllPrices first if you need to confirm the exact name. After updating, call lookupPrice then updateOrderPrice to sync the price.",
	schema: j.object({
		pageId: j
			.string()
			.describe(
				"Notion page ID returned by getOrderByPhone or getOrderById (the pageId field)",
			),
		garmentType: j
			.string()
			.describe(
				"Exact item name from the pricing schedule, e.g. 'Shirt (dress)', 'Suit (2-piece)', 'Wedding Dress'",
			),
	}),
	execute: async ({ pageId, garmentType }, { notion }) => {
		await notion.pages.update({
			page_id: pageId,
			properties: {
				GARMENT_TYPE: { rich_text: [{ type: "text", text: { content: garmentType } }] } as any,
			},
		});
		return { success: true, garmentType };
	},
});

worker.tool("requestCallback", {
	title: "Request Callback",
	description:
		"Log a callback request into the dedicated Callbacks database so staff can see and action it. Use when: (1) customer wants to confirm expedited capacity, (2) item needs a custom quote (e.g. heavily beaded wedding dress), or (3) question only staff can answer. Always call this instead of just telling the customer someone will call — it creates the actual record.",
	schema: j.object({
		pageId: j
			.string()
			.describe("Notion page ID from getOrderByPhone or getOrderById"),
		customerName: j.string().describe("Customer's name for the callback record"),
		phone: j.string().describe("Phone number to call back"),
		orderId: j.string().describe("ORDER_ID value for reference"),
		reason: j
			.string()
			.describe(
				"Why the customer wants a callback, e.g. 'Confirming expedited capacity for Suit (2-piece) pickup Friday'",
			),
	}),
	execute: async ({ customerName, phone, orderId, reason }, { notion }) => {
		const today = new Date().toISOString().split("T")[0];
		await notion.pages.create({
			parent: { database_id: callbacksDbId() },
			properties: {
				CUSTOMER_NAME: {
					title: [{ type: "text", text: { content: customerName } }],
				},
				ORDER_ID: {
					rich_text: [{ type: "text", text: { content: orderId } }],
				},
				PHONE: { phone_number: phone },
				REASON: {
					rich_text: [{ type: "text", text: { content: reason } }],
				},
				REQUESTED_AT: { date: { start: today } },
				STATUS: { rich_text: [{ type: "text", text: { content: "Pending" } }] },
			} as any,
		});
		return { success: true, callbackLogged: true, reason };
	},
});

worker.tool("triggerCallbackCall", {
	title: "Trigger Callback Call",
	description:
		"Initiate an outbound call to a customer who requested a callback. Use callbackId from listPendingCallbacks. Calls the customer via Twilio and marks the callback as 'Called Back' automatically.",
	schema: j.object({
		callbackId: j
			.string()
			.describe("Notion page ID of the callback record from listPendingCallbacks"),
		phone: j.string().describe("Customer phone number from the callback record"),
		customerName: j.string().describe("Customer name from the callback record"),
		orderId: j.string().describe("ORDER_ID from the callback record"),
		reason: j.string().describe("Reason for callback — passed to voice agent for context"),
	}),
	execute: async ({ callbackId, phone, customerName, orderId, reason }, { notion }) => {
		const { accountSid, authToken, fromNumber, webhookBase } = twilioEnv();
		const base = webhookBase.replace(/\/$/, "");
		const callUrl = `${base}/voice?${new URLSearchParams({ outbound: "true", callType: "callback", customerName, orderId, reason }).toString()}`;

		const credentials = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
		const res = await fetch(
			`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`,
			{
				method: "POST",
				headers: {
					Authorization: `Basic ${credentials}`,
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({ To: phone, From: fromNumber, Url: callUrl }),
			},
		);
		if (!res.ok) throw new Error(`Twilio call failed: ${await res.text()}`);
		const { sid } = (await res.json()) as { sid: string };

		await notion.pages.update({
			page_id: callbackId,
			properties: {
				STATUS: { rich_text: [{ type: "text", text: { content: "Called Back" } }] },
			},
		});
		return { success: true, callSid: sid, called: phone };
	},
});

worker.tool("listPendingCallbacks", {
	title: "List Pending Callbacks",
	description:
		"Return all callback requests that are still Pending. For staff use — shows who to call back and why.",
	schema: j.object({}),
	hints: { readOnlyHint: true },
	execute: async (_input, { notion }) => {
		const res = await notion.dataSources.query({
			data_source_id: callbacksDs(),
			page_size: 50,
		});
		const callbacks = res.results
		.filter((page: any) => getText(page.properties["STATUS"]) === "Pending")
		.map((page: any) => {
			const p = page.properties;
			return {
				callbackId: page.id as string,
				customerName: getText(p["CUSTOMER_NAME"]),
				phone: (p["PHONE"]?.phone_number ?? null) as string | null,
				orderId: getText(p["ORDER_ID"]),
				reason: getText(p["REASON"]),
				requestedAt: (p["REQUESTED_AT"]?.date?.start ?? null) as string | null,
				status: getText(p["STATUS"]) || null,
			};
		});
		return { count: callbacks.length, callbacks };
	},
});

worker.tool("resolveCallback", {
	title: "Resolve Callback",
	description:
		"Mark a callback as Called Back or Resolved once staff have followed up. Use callbackId from listPendingCallbacks.",
	schema: j.object({
		callbackId: j
			.string()
			.describe("Notion page ID of the callback record from listPendingCallbacks"),
		status: j
			.enum("Called Back", "Resolved")
			.describe("Called Back = spoke to customer, Resolved = fully handled"),
	}),
	execute: async ({ callbackId, status }, { notion }) => {
		await notion.pages.update({
			page_id: callbackId,
			properties: {
				STATUS: { rich_text: [{ type: "text", text: { content: status } }] },
			},
		});
		return { success: true, status };
	},
});

worker.tool("updateOrderPrice", {
	title: "Update Order Price",
	description:
		"Update the price on an order. Use after lookupPrice returns a price, or when a staff member authorizes a manual price change.",
	schema: j.object({
		pageId: j
			.string()
			.describe(
				"Notion page ID returned by getOrderByPhone or getOrderById (the pageId field)",
			),
		price: j.number().describe("New total price in dollars (e.g. 24.99)"),
	}),
	execute: async ({ pageId, price }, { notion }) => {
		await notion.pages.update({
			page_id: pageId,
			properties: { ORDER_PRICE: { type: "number", number: price } },
		});
		return { success: true, price };
	},
});

worker.tool("updateOrderExpectedDate", {
	title: "Update Expected Date",
	description:
		"Update the expected delivery/pickup date on an order. Use when a customer is told a new date during the call.",
	schema: j.object({
		pageId: j
			.string()
			.describe(
				"Notion page ID returned by getOrderByPhone or getOrderById (the pageId field)",
			),
		expectedDate: j
			.date()
			.describe("New expected date in YYYY-MM-DD format (e.g. 2025-05-20)"),
	}),
	execute: async ({ pageId, expectedDate }, { notion }) => {
		await notion.pages.update({
			page_id: pageId,
			properties: {
				EXPECTED_DATE: { type: "date", date: { start: expectedDate } },
			},
		});
		return { success: true, expectedDate };
	},
});

worker.tool("triggerPickupCall", {
	title: "Trigger Pickup Call",
	description:
		"Initiates an outbound call to notify a customer their order is ready for pickup. Use this when TRACKER is set to 'Ready for Pickup'. Stamps NOTIFIED_AT on the order to prevent duplicate calls. Only call this if NOTIFIED_AT is not already set.",
	schema: j.object({
		pageId: j.string().describe("Notion page ID from getOrderByPhone or getOrderById"),
		phone: j.string().describe("Customer phone number in E.164 format e.g. +14155551234"),
		customerName: j.string().describe("Customer name to pass to the voice agent"),
		orderId: j.string().describe("ORDER_ID value for reference"),
	}),
	execute: async ({ phone, customerName, orderId }) => {
		const { accountSid, authToken, fromNumber, webhookBase } = twilioEnv();

		const credentials = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
		const base = webhookBase.replace(/\/$/, "");
		const callUrl = `${base}/voice?${new URLSearchParams({ outbound: "true", callType: "pickup", customerName, orderId, reason: "Your order is ready for pickup" }).toString()}`;

		const res = await fetch(
			`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`,
			{
				method: "POST",
				headers: {
					Authorization: `Basic ${credentials}`,
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({ To: phone, From: fromNumber, Url: callUrl }),
			},
		);
		if (!res.ok) throw new Error(`Twilio call failed: ${await res.text()}`);
		const { sid } = (await res.json()) as { sid: string };

		return { success: true, callSid: sid, called: phone };
	},
});

// ─── CALLBACK POLLER ─────────────────────────────────────────────────────────
// Runs every 2 minutes. Finds Pending callbacks, calls via Twilio, marks Called Back.

worker.sync("callbackPoller", {
	database: callbackCallLog,
	mode: "incremental",
	schedule: "2m",
	execute: async (_state, { notion }) => {
		const res = await notion.dataSources.query({
			data_source_id: callbacksDs(),
			page_size: 50,
		});

		const today = new Date().toISOString().split("T")[0];
		const { accountSid, authToken, fromNumber, webhookBase } = twilioEnv();
		const base = webhookBase.replace(/\/$/, "");

		const changes: any[] = [];

		for (const page of res.results) {
			const status = getText((page as any).properties["STATUS"]);
			if (status !== "Approved") continue;
			const p = (page as any).properties;
			const phone: string | null = p["PHONE"]?.phone_number ?? null;
			const customerName = getText(p["CUSTOMER_NAME"]);
			const orderId = getText(p["ORDER_ID"]);
			const reason = getText(p["REASON"]);

			if (!phone) continue;

			// Count prior failures from notes to cap retries at 3
			const failCount = getText(p["NOTES"] ?? {}).split("❌").length - 1;
			if (failCount >= 3) {
				// Too many failures — reset to Pending so staff can review
				await notion.pages.update({
					page_id: page.id,
					properties: {
						STATUS: { rich_text: [{ type: "text", text: { content: "Pending" } }] },
						NOTES: { rich_text: [{ type: "text", text: { content: `❌×${failCount} Auto-reset to Pending after 3 failed attempts` } }] },
					},
				});
				continue;
			}

			// Look up the order for full context
			let orderCtx: Record<string, string> = {};
			let orderPageId: string | null = null;
			let orderNotes = "";
			try {
				const orderRes = await notion.dataSources.query({
					data_source_id: ordersDs(),
					filter: { property: "ORDER_ID", rich_text: { equals: orderId } },
					page_size: 1,
				});
				if (orderRes.results.length > 0) {
					orderPageId = (orderRes.results[0] as any).id as string;
					const op = (orderRes.results[0] as any).properties;
					orderNotes = getText(op["NOTES"]).slice(0, 400);
					orderCtx = {
						garmentType:   getText(op["GARMENT_TYPE"]),
						trackerStage:  getText(op["TRACKER_STAGE"]),
						price:         String(op["ORDER_PRICE"]?.number ?? ""),
						paymentMethod: getText(op["PAYMENT_METHOD"]),
						orderType:     getText(op["ORDER_TYPE"]),
						notes:         orderNotes,
					};
				}
			} catch (_) { /* non-fatal */ }

			let result = "Called";
			try {
				const callParams = new URLSearchParams({
					outbound: "true", callType: "callback",
					customerName, orderId, reason: reason || "",
					...(orderPageId ? { pageId: orderPageId } : {}),
					...orderCtx,
				});
				const callUrl = `${base}/voice?${callParams.toString()}`;
				const creds = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
				const r = await fetch(
					`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`,
					{
						method: "POST",
						headers: {
							Authorization: `Basic ${creds}`,
							"Content-Type": "application/x-www-form-urlencoded",
						},
						body: new URLSearchParams({ To: phone, From: fromNumber, Url: callUrl }),
					},
				);
				if (!r.ok) throw new Error(await r.text());
				// Success — mark callback as Called Back
				await notion.pages.update({
					page_id: page.id,
					properties: { STATUS: { rich_text: [{ type: "text", text: { content: "Called Back" } }] } },
				});
				// Write callback reason to ORDER notes so the order record reflects the call
				if (orderPageId) {
					const callNote = `📞 Callback call made ${today}: ${reason}`;
					const updatedOrderNotes = orderNotes ? `${orderNotes}\n${callNote}` : callNote;
					await notion.pages.update({
						page_id: orderPageId,
						properties: { NOTES: { rich_text: [{ type: "text", text: { content: updatedOrderNotes } }] } },
					});
				}
			} catch (err) {
				result = "Failed";
				// Log failure in callback notes so retry count is tracked
				const existingNotes = getText(p["NOTES"] ?? {});
				const failNote = `❌ Call failed ${today}: ${String(err).slice(0, 80)}`;
				await notion.pages.update({
					page_id: page.id,
					properties: {
						NOTES: { rich_text: [{ type: "text", text: { content: existingNotes ? `${existingNotes}\n${failNote}` : failNote } }] },
					},
				});
				// STATUS stays "Approved" — poller will retry next cycle
			}

			changes.push({
				type: "upsert" as const,
				key: page.id,
				properties: {
					Customer:      Builder.title(customerName),
					"Callback ID": Builder.richText(page.id),
					Phone:         Builder.richText(phone),
					Reason:        Builder.richText(reason),
					"Called At":   Builder.date(today),
					Result:        Builder.select(result),
				},
			});
		}

		return { changes, hasMore: false };
	},
});

// ─── PICKUP REMINDER POLLER ───────────────────────────────────────────────────
// Runs every 10 minutes. Finds orders at "Ready for Pickup" not yet called, dials them.

worker.sync("pickupPoller", {
	database: callbackCallLog,
	mode: "incremental",
	schedule: "10m",
	execute: async (_state, { notion }) => {
		const res = await notion.dataSources.query({
			data_source_id: ordersDs(),
			page_size: 100,
		});

		const today = new Date().toISOString().split("T")[0];
		const { accountSid, authToken, fromNumber, webhookBase } = twilioEnv();
		const base = webhookBase.replace(/\/$/, "");
		const changes: any[] = [];

		// Pre-fetch all active callbacks so we can skip orders that have one pending
		const activeCbRes = await notion.dataSources.query({
			data_source_id: callbacksDs(),
			filter: { or: [
				{ property: "STATUS", rich_text: { equals: "Pending" } },
				{ property: "STATUS", rich_text: { equals: "Approved" } },
			] },
			page_size: 100,
		});
		const activeCallbackOrderIds = new Set(
			activeCbRes.results.map((p: any) => getText(p.properties["ORDER_ID"])).filter(Boolean)
		);

		for (const page of res.results) {
			const p = (page as any).properties;
			const tracker = getText(p["TRACKER_STAGE"]);
			if (tracker !== "Ready for Pickup") continue;

			const notes = getText(p["NOTES"]);
			if (notes.includes("📱 Pickup reminder sent")) continue;

			const phone: string | null = p["ORDER_PHONE"]?.phone_number ?? null;
			if (!phone) continue;

			const customerName = getText(p["CUSTOMER_NAME"]);
			const orderId = getText(p["ORDER_ID"]);

			// Skip if there's already a pending/approved callback for this order —
			// the callbackPoller will handle the call with the correct context
			if (activeCallbackOrderIds.has(orderId)) continue;

			let result = "Called";
			try {
				const garmentType = getText(p["GARMENT_TYPE"]);
				const orderType   = getText(p["ORDER_TYPE"]);
				const paymentMethod = getText(p["PAYMENT_METHOD"]);
				const price       = p["ORDER_PRICE"]?.number ?? "";
				const expectedDate = p["EXPECTED_DATE"]?.date?.start ?? "";
				const pickupParams = new URLSearchParams({
					outbound: "true", callType: "pickup", customerName, orderId,
					pageId: page.id,
					reason: "Your order is ready for pickup",
					garmentType, orderType, trackerStage: "Ready for Pickup",
					price: String(price), paymentMethod, expectedDate,
				});
				const callUrl = `${base}/voice?${pickupParams.toString()}`;
				const creds = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
				const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`, {
					method: "POST",
					headers: { Authorization: `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({ To: phone, From: fromNumber, Url: callUrl }),
				});
				if (!r.ok) throw new Error(await r.text());
				const updatedNotes = notes ? `${notes}\n📱 Pickup reminder sent: ${today}` : `📱 Pickup reminder sent: ${today}`;
				await notion.pages.update({
					page_id: page.id,
					properties: { NOTES: { rich_text: [{ type: "text", text: { content: updatedNotes } }] } },
				});
			} catch (_e) { result = "Failed"; }

			changes.push({
				type: "upsert" as const,
				key: `pickup-${page.id}-${today}`,
				properties: {
					"Customer":    Builder.title(customerName),
					"Callback ID": Builder.richText(`pickup-${page.id}`),
					"Phone":       Builder.richText(phone),
					"Reason":      Builder.richText("Pickup reminder"),
					"Called At":   Builder.date(today),
					"Result":      Builder.select(result),
				},
			});
		}
		return { changes, hasMore: false };
	},
});

// ─── AUTOMATION ──────────────────────────────────────────────────────────────
// worker.automation() is in private alpha — disabled until enabled on this workspace.
// Uncomment both blocks below once Notion enables automation capabilities.

/* worker.automation("pickupReminder", {
	title: "Pickup Ready — Call Customer",
	description:
		"Triggers an outbound call via the voice agent when TRACKER is set to 'Ready for Pickup'. Skips orders already notified (NOTIFIED_AT is set). The voice agent's system handles Twilio internally.",
	execute: async (event, { notion }) => {
		const { pageId, pageData } = event;
		if (!pageId || !pageData) return;

		const p = pageData.properties as any;

		const stage = p["TRACKER"]?.select?.name as string | undefined;
		if (stage !== "Ready for Pickup") return;

		const alreadyNotified = p["NOTIFIED_AT"]?.date?.start;
		if (alreadyNotified) return;

		const phone = p["ORDER_PHONE"]?.phone_number as string | undefined;
		if (!phone) return;

		const today = new Date().toISOString().split("T")[0];
		await notion.pages.update({
			page_id: pageId,
			properties: {
				NOTIFIED_AT: { type: "date", date: { start: today } },
			},
		});
	},
});

worker.automation("archiveDeliveredOrder", {
	title: "Archive Delivered Order",
	description:
		"Moves an order to the Archive database when TRACKER is set to 'Delivered'. Keeps the Orders database clean with only active orders.",
	execute: async (event, { notion }) => {
		const { pageId, pageData } = event;
		if (!pageId || !pageData) return;

		const p = pageData.properties as any;

		const stage = p["TRACKER"]?.select?.name as string | undefined;
		if (stage !== "Delivered") return;

		await notion.pages.move({
			page_id: pageId,
			parent: { data_source_id: archiveDs() },
		});
	},
}); */
