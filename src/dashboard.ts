import express from "express";
import cors from "cors";
import path from "path";
import * as dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = Number(process.env.DASHBOARD_PORT ?? 3001);

const NOTION_TOKEN   = process.env.NOTION_API_TOKEN!;
const NOTION_VERSION = "2022-06-28";
const CALL_LOG_DB    = "3635d395-6c96-81e0-a7cd-c9321d05e996";

async function logCall(customerName: string, phone: string, reason: string, result: "Called" | "Failed") {
	const today = new Date().toISOString().split("T")[0];
	await notionCreatePage(CALL_LOG_DB, {
		Customer:      { title: [{ type: "text", text: { content: customerName } }] },
		"Callback ID": { rich_text: [{ type: "text", text: { content: `manual-${Date.now()}` } }] },
		Phone:         { rich_text: [{ type: "text", text: { content: phone } }] },
		Reason:        { rich_text: [{ type: "text", text: { content: reason } }] },
		"Called At":   { date: { start: today } },
		Result:        { select: { name: result } },
	}).catch(() => {}); // non-critical — don't let log failure break the call response
}

async function notionQuery(databaseId: string, body: Record<string, unknown> = {}) {
	const res = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${NOTION_TOKEN}`,
			"Notion-Version": NOTION_VERSION,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ page_size: 100, ...body }),
	});
	if (!res.ok) throw new Error(`Notion query failed: ${await res.text()}`);
	return (await res.json()) as { results: any[] };
}

async function notionGetPage(pageId: string) {
	const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
		headers: { Authorization: `Bearer ${NOTION_TOKEN}`, "Notion-Version": NOTION_VERSION },
	});
	if (!res.ok) throw new Error(`Notion page fetch failed: ${await res.text()}`);
	return res.json() as Promise<any>;
}

async function notionUpdatePage(pageId: string, properties: Record<string, unknown>) {
	const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
		method: "PATCH",
		headers: {
			Authorization: `Bearer ${NOTION_TOKEN}`,
			"Notion-Version": NOTION_VERSION,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ properties }),
	});
	if (!res.ok) throw new Error(`Notion update failed: ${await res.text()}`);
	return res.json() as Promise<any>;
}

async function notionCreatePage(databaseId: string, properties: Record<string, unknown>) {
	const res = await fetch("https://api.notion.com/v1/pages", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${NOTION_TOKEN}`,
			"Notion-Version": NOTION_VERSION,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ parent: { database_id: databaseId }, properties }),
	});
	if (!res.ok) throw new Error(`Notion create failed: ${await res.text()}`);
	return res.json() as Promise<any>;
}

// Notion database IDs (from URL / search API)
const ORDERS_DB    = "3625d395-6c96-8080-b502-cdd3f4e57863";
const PRICING_DB   = "3625d395-6c96-8085-8029-c9b12fcf3636";
const CALLBACKS_DB = "3625d395-6c96-800a-9f2c-db85d7fdbab1";
const SCHEDULED_PICKUPS_DB = process.env.SCHEDULED_PICKUPS_DATABASE_ID ?? "";

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getText(prop: any): string {
	return (prop?.rich_text ?? prop?.title ?? []).map((t: any) => t.plain_text as string).join("");
}

function shapeOrder(page: any) {
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
		paymentDate:   null,
		garmentType:   getText(p["GARMENT_TYPE"]) || null,
		notifiedAt:    null,
	};
}

async function fetchOrderPage(pageId: string) {
	return shapeOrder(await notionGetPage(pageId));
}

function shapePickup(page: any) {
	const p = page.properties;
	return {
		pickupId:            page.id as string,
		customerName:        getText(p["CUSTOMER_NAME"]),
		phone:               (p["ORDER_PHONE"]?.phone_number ?? null) as string | null,
		address:             getText(p["ADDRESS"]) || null,
		scheduledDatetime:   (p["SCHEDULED_DATETIME"]?.date?.start ?? null) as string | null,
		orderIds:            getText(p["ORDER_IDS"]) || null,
		reminderSent:        (p["REMINDER_SENT"]?.checkbox ?? false) as boolean,
		reminderCallStatus:  getText(p["REMINDER_CALL_STATUS"]) || null,
	};
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

app.post("/api/dashboard/auth", (req, res) => {
	const { token } = req.body as { token?: string };
	if (!token || token !== process.env.DASHBOARD_TOKEN) {
		res.status(401).json({ error: "Unauthorized" });
		return;
	}
	res.json({ ok: true });
});

// ─── Protected routes ─────────────────────────────────────────────────────────

const r = express.Router();

// GET /orders  — list + filter in-code
r.get("/orders", async (req, res) => {
	try {
		const result = await notionQuery(ORDERS_DB);
		let orders = result.results.map(shapeOrder);
		const { q, status, stage, garmentType, paymentMethod, orderType, from, to } =
			req.query as Record<string, string>;
		const isOpen = (o: ReturnType<typeof shapeOrder>) => o.tracker !== "Delivered" && o.tracker !== "Cancelled";
		if (status === "OPEN")   orders = orders.filter(isOpen);
		if (status === "CLOSED") orders = orders.filter(o => !isOpen(o));
		if (q) {
			const ql = q.toLowerCase();
			orders = orders.filter(o =>
				o.customerName.toLowerCase().includes(ql) ||
				o.orderId.toLowerCase().includes(ql) ||
				(o.phone?.includes(q) ?? false),
			);
		}
		if (stage)         orders = orders.filter(o => o.tracker === stage);
		if (garmentType)   orders = orders.filter(o => o.garmentType === garmentType);
		if (paymentMethod) orders = orders.filter(o => o.paymentMethod === paymentMethod);
		if (orderType)     orders = orders.filter(o => o.orderType === orderType);
		if (from) orders = orders.filter(o => !!o.expectedDate && o.expectedDate >= from);
		if (to)   orders = orders.filter(o => !!o.expectedDate && o.expectedDate <= to);
		res.json(orders);
	} catch (err) {
		console.error("GET /orders:", err);
		res.status(500).json({ error: "Failed to fetch orders" });
	}
});

// GET /orders/:id
r.get("/orders/:id", async (req, res) => {
	try { res.json(await fetchOrderPage(req.params.id)); }
	catch (err) { res.status(500).json({ error: String(err) }); }
});

// GET /stats
r.get("/stats", async (req, res) => {
	try {
		const [ordersRes, callbacksRes] = await Promise.all([
			notionQuery(ORDERS_DB),
			notionQuery(CALLBACKS_DB),
		]);
		const orders  = ordersRes.results.map(shapeOrder);
		const open    = orders.filter(o => o.tracker !== "Delivered" && o.tracker !== "Cancelled");
		const pending = callbacksRes.results.filter(p => getText(p.properties["STATUS"]) === "Pending");
		res.json({
			open:      open.length,
			expedited: open.filter(o => o.orderType === "Expedited").length,
			unpaid:    open.filter(o => !o.paymentMethod || o.paymentMethod === "Unpaid").length,
			callbacks: pending.length,
		});
	} catch (err) { res.status(500).json({ error: String(err) }); }
});

// GET /prices
r.get("/prices", async (req, res) => {
	try {
		const result = await notionQuery(PRICING_DB);
		const prices = result.results.map(page => ({
			item:           getText(page.properties["ITEM"]),
			category:       getText(page.properties["CATEGORY"]) || null,
			regularPrice:   (page.properties["REGULAR_PRICE"]?.number ?? null) as number | null,
			expeditedPrice: (page.properties["EXPEDITED_PRICE"]?.number ?? null) as number | null,
			notes:          getText(page.properties["NOTES"]) || null,
		}));
		res.json(prices);
	} catch (err) { res.status(500).json({ error: String(err) }); }
});

// GET /callbacks  — returns Pending + Approved (excludes Called Back / Resolved)
r.get("/callbacks", async (req, res) => {
	try {
		const result = await notionQuery(CALLBACKS_DB);
		const active = ["Pending", "Approved"];
		const callbacks = result.results
			.filter(p => active.includes(getText(p.properties["STATUS"])))
			.map(p => ({
				callbackId:   p.id as string,
				customerName: getText(p.properties["CUSTOMER_NAME"]),
				phone:        (p.properties["PHONE"]?.phone_number ?? null) as string | null,
				orderId:      getText(p.properties["ORDER_ID"]),
				reason:       getText(p.properties["REASON"]),
				requestedAt:  (p.properties["REQUESTED_AT"]?.date?.start ?? null) as string | null,
				status:       getText(p.properties["STATUS"]),
			}));
		res.json(callbacks);
	} catch (err) { res.status(500).json({ error: String(err) }); }
});

// PATCH /callbacks/:id/phone  — edit the phone number before approving
r.patch("/callbacks/:id/phone", async (req, res) => {
	const { phone } = req.body as { phone?: string };
	if (!phone) { res.status(400).json({ error: "phone required" }); return; }
	try {
		await notionUpdatePage(req.params.id, { PHONE: { phone_number: phone } });
		res.json({ ok: true, phone });
	} catch (err) { res.status(500).json({ error: String(err) }); }
});

// POST /callbacks/:id/call  — trigger Twilio call immediately (no waiting for poller)
r.post("/callbacks/:id/call", async (req, res) => {
	const { phone, customerName, orderId, reason, garmentType, trackerStage, price, paymentMethod, orderType, notes, pageId } = req.body as {
		phone: string; customerName: string; orderId: string; reason: string;
		garmentType?: string; trackerStage?: string; price?: number; paymentMethod?: string; orderType?: string; notes?: string; pageId?: string;
	};
	const accountSid  = process.env.TWILIO_ACCOUNT_SID;
	const authToken   = process.env.TWILIO_AUTH_TOKEN;
	const fromNumber  = process.env.TWILIO_PHONE_NUMBER;
	const webhookBase = process.env.TWILIO_WEBHOOK_BASE?.replace(/\/$/, "");
	if (!accountSid || !authToken || !fromNumber || !webhookBase) {
		res.status(500).json({ error: "Twilio env vars not set" }); return;
	}
	try {
		const callParamObj: Record<string, string> = {
			outbound: "true", callType: "callback",
			customerName, orderId, reason: reason || "",
			garmentType: garmentType || "", trackerStage: trackerStage || "",
			price: String(price ?? ""), paymentMethod: paymentMethod || "",
			orderType: orderType || "", notes: (notes || "").slice(0, 400),
		};
		if (pageId) callParamObj["pageId"] = pageId;
		const callUrl = `${webhookBase}/voice?${new URLSearchParams(callParamObj).toString()}`;
		const creds   = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
		const r2 = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`, {
			method: "POST",
			headers: { Authorization: `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ To: phone, From: fromNumber, Url: callUrl }),
		});
		const twilioRes = await r2.text();
		if (!r2.ok) {
			await logCall(customerName, phone, reason, "Failed");
			res.status(500).json({ error: `Twilio: ${twilioRes}` }); return;
		}
		const { sid } = JSON.parse(twilioRes) as { sid: string };
		await notionUpdatePage(req.params.id, { STATUS: { rich_text: [{ type: "text", text: { content: "Called Back" } }] } });
		await logCall(customerName, phone, reason, "Called");
		res.json({ ok: true, callSid: sid });
	} catch (err) { res.status(500).json({ error: String(err) }); }
});

// GET /urgent  — overdue / due today / ready-for-pickup orders
r.get("/urgent", async (req, res) => {
	try {
		const result = await notionQuery(ORDERS_DB);
		const today  = new Date().toISOString().split("T")[0];
		const all    = result.results.map(shapeOrder);
		const active = all.filter(o => o.tracker !== "Delivered" && o.tracker !== "Cancelled" && o.tracker !== null);
		const overdue        = active.filter(o => o.expectedDate && o.expectedDate < today);
		const dueToday       = active.filter(o => o.expectedDate && o.expectedDate === today);
		const urgentIds      = new Set([...overdue, ...dueToday].map(o => o.pageId));
		const readyForPickup = active.filter(o => o.tracker === "Ready for Pickup" && !urgentIds.has(o.pageId));
		res.json({ overdue, dueToday, readyForPickup });
	} catch (err) { res.status(500).json({ error: String(err) }); }
});

// POST /callbacks  — manually create a callback record
r.post("/callbacks", async (req, res) => {
	try {
		const { customerName, phone, orderId, reason } = req.body as {
			customerName: string; phone?: string; orderId?: string; reason: string;
		};
		if (!customerName || !reason) { res.status(400).json({ error: "customerName and reason required" }); return; }
		const today = new Date().toISOString().split("T")[0];
		const props: Record<string, unknown> = {
			CUSTOMER_NAME: { title: [{ type: "text", text: { content: customerName } }] },
			REASON:        { rich_text: [{ type: "text", text: { content: reason } }] },
			REQUESTED_AT:  { date: { start: today } },
			STATUS:        { rich_text: [{ type: "text", text: { content: "Pending" } }] },
		};
		if (orderId) props["ORDER_ID"] = { rich_text: [{ type: "text", text: { content: orderId } }] };
		if (phone)   props["PHONE"]    = { phone_number: phone };
		await notionCreatePage(CALLBACKS_DB, props);
		res.json({ ok: true });
	} catch (err) { res.status(500).json({ error: String(err) }); }
});

// GET /calls  — recent call log from the managed callbackCallLog database
r.get("/calls", async (req, res) => {
	try {
		const result = await notionQuery(CALL_LOG_DB);
		const calls = result.results.map(p => ({
			customer:    p.properties["Customer"]?.title?.[0]?.plain_text ?? "—",
			phone:       p.properties["Phone"]?.rich_text?.[0]?.plain_text ?? "—",
			reason:      p.properties["Reason"]?.rich_text?.[0]?.plain_text ?? "—",
			calledAt:    p.properties["Called At"]?.date?.start ?? null,
			result:      p.properties["Result"]?.select?.name ?? "—",
		}));
		res.json(calls);
	} catch (err) { res.status(500).json({ error: String(err) }); }
});

// POST /callbacks/:id/approve  — Pending → Approved (triggers poller to call)
r.post("/callbacks/:id/approve", async (req, res) => {
	try {
		await notionUpdatePage(req.params.id, { STATUS: { rich_text: [{ type: "text", text: { content: "Approved" } }] } });
		res.json({ ok: true });
	} catch (err) { res.status(500).json({ error: String(err) }); }
});

// POST /callbacks/:id/resolve
r.post("/callbacks/:id/resolve", async (req, res) => {
	try {
		await notionUpdatePage(req.params.id, { STATUS: { rich_text: [{ type: "text", text: { content: "Resolved" } }] } });
		res.json({ ok: true });
	} catch (err) { res.status(500).json({ error: String(err) }); }
});

// POST /orders  — create a new order from NLP-parsed fields
r.post("/orders", async (req, res) => {
	try {
		const { customerName, phone, garmentType, orderType, price, expectedDate, notes } = req.body as {
			customerName: string; phone?: string; garmentType?: string;
			orderType?: string; price?: number; expectedDate?: string; notes?: string;
		};
		if (!customerName) { res.status(400).json({ error: "customerName required" }); return; }
		const orderId = `ORD-${Date.now().toString(36).toUpperCase().slice(-6)}`;
		const props: Record<string, unknown> = {
			CUSTOMER_NAME:  { title: [{ type: "text", text: { content: customerName } }] },
			ORDER_ID:       { rich_text: [{ type: "text", text: { content: orderId } }] },
			TRACKER_STAGE:  { rich_text: [{ type: "text", text: { content: "Received" } }] },
			PAYMENT_METHOD: { rich_text: [{ type: "text", text: { content: "Unpaid" } }] },
		};
		if (phone)       props["ORDER_PHONE"]  = { phone_number: phone };
		if (garmentType) props["GARMENT_TYPE"] = { rich_text: [{ type: "text", text: { content: garmentType } }] };
		if (orderType)   props["ORDER_TYPE"]   = { rich_text: [{ type: "text", text: { content: orderType } }] };
		if (price != null)props["ORDER_PRICE"]     = { number: price };
		if (expectedDate) props["EXPECTED_DATE"]   = { date: { start: expectedDate } };
		if (notes)        props["NOTES"]           = { rich_text: [{ type: "text", text: { content: notes } }] };
		const page = await notionCreatePage(ORDERS_DB, props);
		res.json(shapeOrder(page));
	} catch (err) { res.status(500).json({ error: String(err) }); }
});

// PATCH /orders/:id/phone
r.patch("/orders/:id/phone", async (req, res) => {
	const { phone } = req.body as { phone?: string };
	if (!phone) { res.status(400).json({ error: "phone required" }); return; }
	try {
		await notionUpdatePage(req.params.id, { ORDER_PHONE: { phone_number: phone } });
		res.json(await fetchOrderPage(req.params.id));
	} catch (err) { res.status(500).json({ error: String(err) }); }
});

// POST /orders/:id/call  — call customer directly from the order drawer
r.post("/orders/:id/call", async (req, res) => {
	const { phone, customerName, orderId, garmentType, trackerStage, price, paymentMethod, orderType, notes } = req.body as {
		phone: string; customerName: string; orderId: string;
		garmentType?: string; trackerStage?: string; price?: number; paymentMethod?: string; orderType?: string; notes?: string;
	};
	const accountSid  = process.env.TWILIO_ACCOUNT_SID;
	const authToken   = process.env.TWILIO_AUTH_TOKEN;
	const fromNumber  = process.env.TWILIO_PHONE_NUMBER;
	const webhookBase = process.env.TWILIO_WEBHOOK_BASE?.replace(/\/$/, "");
	if (!accountSid || !authToken || !fromNumber || !webhookBase) {
		res.status(500).json({ error: "Twilio env vars not set" }); return;
	}
	if (!phone) { res.status(400).json({ error: "phone required" }); return; }
	try {
		const params = new URLSearchParams({
			outbound: "true", callType: "order",
			customerName, orderId,
			pageId: req.params.id,
			garmentType: garmentType || "", trackerStage: trackerStage || "",
			price: String(price ?? ""), paymentMethod: paymentMethod || "",
			orderType: orderType || "", notes: (notes || "").slice(0, 400),
		});
		const callUrl = `${webhookBase}/voice?${params.toString()}`;
		const creds   = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
		const r2 = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`, {
			method: "POST",
			headers: { Authorization: `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ To: phone, From: fromNumber, Url: callUrl }),
		});
		const twilioRes2 = await r2.text();
		if (!r2.ok) {
			await logCall(customerName, phone, "Order call", "Failed");
			res.status(500).json({ error: twilioRes2 }); return;
		}
		const { sid } = JSON.parse(twilioRes2) as { sid: string };
		await logCall(customerName, phone, `Order ${orderId}`, "Called");
		res.json({ ok: true, callSid: sid });
	} catch (err) { res.status(500).json({ error: String(err) }); }
});

// PATCH /orders/:id/tracker
r.patch("/orders/:id/tracker", async (req, res) => {
	try {
		await notionUpdatePage(req.params.id, { TRACKER_STAGE: { rich_text: [{ type: "text", text: { content: req.body.stage } }] } });
		res.json(await fetchOrderPage(req.params.id));
	} catch (err) { res.status(500).json({ error: String(err) }); }
});

// PATCH /orders/:id/payment
r.patch("/orders/:id/payment", async (req, res) => {
	try {
		await notionUpdatePage(req.params.id, {
			PAYMENT_METHOD: { rich_text: [{ type: "text", text: { content: req.body.method } }] },
		});
		res.json(await fetchOrderPage(req.params.id));
	} catch (err) { res.status(500).json({ error: String(err) }); }
});

// PATCH /orders/:id/note
r.patch("/orders/:id/note", async (req, res) => {
	try {
		const page = await notionGetPage(req.params.id);
		const existing = getText(page.properties["NOTES"]);
		const updated = existing ? `${existing}\n${req.body.note}` : req.body.note;
		await notionUpdatePage(req.params.id, { NOTES: { rich_text: [{ type: "text", text: { content: updated } }] } });
		res.json(await fetchOrderPage(req.params.id));
	} catch (err) { res.status(500).json({ error: String(err) }); }
});

// PATCH /orders/:id/garment
r.patch("/orders/:id/garment", async (req, res) => {
	try {
		await notionUpdatePage(req.params.id, {
			GARMENT_TYPE: { rich_text: [{ type: "text", text: { content: req.body.garmentType } }] },
		});
		res.json(await fetchOrderPage(req.params.id));
	} catch (err) { res.status(500).json({ error: String(err) }); }
});

// PATCH /orders/:id/price
r.patch("/orders/:id/price", async (req, res) => {
	try {
		await notionUpdatePage(req.params.id, { ORDER_PRICE: { number: req.body.price } });
		res.json(await fetchOrderPage(req.params.id));
	} catch (err) { res.status(500).json({ error: String(err) }); }
});

// PATCH /orders/:id/type
r.patch("/orders/:id/type", async (req, res) => {
	try {
		await notionUpdatePage(req.params.id, { ORDER_TYPE: { rich_text: [{ type: "text", text: { content: req.body.orderType } }] } });
		res.json(await fetchOrderPage(req.params.id));
	} catch (err) { res.status(500).json({ error: String(err) }); }
});

// PATCH /orders/:id/date
r.patch("/orders/:id/date", async (req, res) => {
	try {
		await notionUpdatePage(req.params.id, { EXPECTED_DATE: { date: { start: req.body.expectedDate } } });
		res.json(await fetchOrderPage(req.params.id));
	} catch (err) { res.status(500).json({ error: String(err) }); }
});

// PATCH /orders/:id/callback  — logs note + creates Callback record
r.patch("/orders/:id/callback", async (req, res) => {
	try {
		const page = await notionGetPage(req.params.id);
		const p = page.properties;
		const existing = getText(p["NOTES"]);
		const noteText = `CALLBACK REQUESTED: ${req.body.reason}`;
		await notionUpdatePage(req.params.id, {
			NOTES: { rich_text: [{ type: "text", text: { content: existing ? `${existing}\n${noteText}` : noteText } }] },
		});
		const today = new Date().toISOString().split("T")[0];
		const cbProps: Record<string, unknown> = {
			CUSTOMER_NAME: { title: [{ type: "text", text: { content: getText(p["CUSTOMER_NAME"]) } }] },
			ORDER_ID:      { rich_text: [{ type: "text", text: { content: getText(p["ORDER_ID"]) } }] },
			REASON:        { rich_text: [{ type: "text", text: { content: req.body.reason } }] },
			REQUESTED_AT:  { date: { start: today } },
			STATUS:        { rich_text: [{ type: "text", text: { content: "Pending" } }] },
		};
		const phone = p["ORDER_PHONE"]?.phone_number;
		if(phone) cbProps["PHONE"] = { phone_number: phone };
		await notionCreatePage(CALLBACKS_DB, cbProps);
		res.json(await fetchOrderPage(req.params.id));
	} catch (err) { res.status(500).json({ error: String(err) }); }
});

// POST /ai — handled by Notion Custom Agent (Worker tools), not directly here
r.post("/ai", (_req, res) => {
	res.json({
		reply: `For AI queries, use the <strong>Notion Custom Agent</strong> — it has live access to all your orders via the Worker tools.<br/><br/>This dashboard handles order management directly.`,
		actions: [],
	});
});

// POST /parse-order — NLP order parsing via GPT-4o-mini
r.post("/parse-order", async (req, res) => {
  const { text } = req.body as { text?: string };
  if (!text) { res.status(400).json({ error: "text required" }); return; }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) { res.status(500).json({ error: "OPENAI_API_KEY not set" }); return; }
  const today = new Date().toISOString().split("T")[0];
  try {
    const r2 = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `You are an order parser for a dry cleaning shop. Today is ${today}. Extract fields from natural language and return a JSON object with these optional keys: customerName (string, the person's full name if clearly stated), phone (E.164 string, e.g. "+14155551234"), garmentType (string, one of: Shirt, Pants, Dress, Suit, Jacket, Coat, Skirt, Wedding Dress, Other), orderType ("Regular" or "Expedited"), price (number, dollars), expectedDate (YYYY-MM-DD string), notes (string). Only include keys you are confident about. Extract customerName if it is explicitly stated in the text; omit it if ambiguous.`,
          },
          { role: "user", content: text },
        ],
      }),
    });
    if (!r2.ok) throw new Error(await r2.text());
    const body = await r2.json() as any;
    const parsed = JSON.parse(body.choices[0].message.content);
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /pickups
r.get("/pickups", async (req, res) => {
	try {
		if (!SCHEDULED_PICKUPS_DB) { res.json([]); return; }
		const result = await notionQuery(SCHEDULED_PICKUPS_DB);
		res.json(result.results.map(shapePickup));
	} catch (err) { res.status(500).json({ error: String(err) }); }
});

// POST /pickups
r.post("/pickups", async (req, res) => {
	if (!SCHEDULED_PICKUPS_DB) { res.status(500).json({ error: "SCHEDULED_PICKUPS_DATABASE_ID not set" }); return; }
	const { customerName, phone, address, scheduledDatetime, orderIds } = req.body as {
		customerName: string; phone?: string; address?: string;
		scheduledDatetime?: string; orderIds?: string;
	};
	if (!customerName) { res.status(400).json({ error: "customerName required" }); return; }
	try {
		const props: Record<string, unknown> = {
			CUSTOMER_NAME:       { title: [{ type: "text", text: { content: customerName } }] },
			REMINDER_SENT:       { checkbox: false },
			REMINDER_CALL_STATUS:{ rich_text: [{ type: "text", text: { content: "" } }] },
		};
		if (phone)             props["ORDER_PHONE"]          = { phone_number: phone };
		if (address)           props["ADDRESS"]              = { rich_text: [{ type: "text", text: { content: address } }] };
		if (scheduledDatetime) props["SCHEDULED_DATETIME"]   = { date: { start: scheduledDatetime } };
		if (orderIds)          props["ORDER_IDS"]            = { rich_text: [{ type: "text", text: { content: orderIds } }] };
		const page = await notionCreatePage(SCHEDULED_PICKUPS_DB, props);
		res.json(shapePickup(page));
	} catch (err) { res.status(500).json({ error: String(err) }); }
});

// PATCH /pickups/:id
r.patch("/pickups/:id", async (req, res) => {
	try {
		const { address, scheduledDatetime, orderIds, reminderSent, reminderCallStatus } = req.body as {
			address?: string; scheduledDatetime?: string; orderIds?: string;
			reminderSent?: boolean; reminderCallStatus?: string;
		};
		const updates: Record<string, unknown> = {};
		if (address !== undefined)           updates["ADDRESS"]               = { rich_text: [{ type: "text", text: { content: address } }] };
		if (scheduledDatetime !== undefined) updates["SCHEDULED_DATETIME"]    = { date: { start: scheduledDatetime } };
		if (orderIds !== undefined)          updates["ORDER_IDS"]             = { rich_text: [{ type: "text", text: { content: orderIds } }] };
		if (reminderSent !== undefined)      updates["REMINDER_SENT"]         = { checkbox: reminderSent };
		if (reminderCallStatus !== undefined)updates["REMINDER_CALL_STATUS"]  = { rich_text: [{ type: "text", text: { content: reminderCallStatus } }] };
		await notionUpdatePage(req.params.id, updates);
		res.json(shapePickup(await notionGetPage(req.params.id)));
	} catch (err) { res.status(500).json({ error: String(err) }); }
});

// POST /pickups/:id/call — manually trigger a pickup reminder call (demo / override)
r.post("/pickups/:id/call", async (req, res) => {
	try {
		const page = await notionGetPage(req.params.id);
		const p = page.properties;
		const phone: string | null = p["ORDER_PHONE"]?.phone_number ?? null;
		const customerName = getText(p["CUSTOMER_NAME"]);
		const orderIds = getText(p["ORDER_IDS"]) || "";
		const scheduledDatetime: string | null = p["SCHEDULED_DATETIME"]?.date?.start ?? null;
		if (!phone) { res.status(400).json({ error: "No phone number on this pickup" }); return; }
		const accountSid  = process.env.TWILIO_ACCOUNT_SID;
		const authToken   = process.env.TWILIO_AUTH_TOKEN;
		const fromNumber  = process.env.TWILIO_PHONE_NUMBER;
		const webhookBase = process.env.TWILIO_WEBHOOK_BASE?.replace(/\/$/, "");
		if (!accountSid || !authToken || !fromNumber || !webhookBase) {
			res.status(500).json({ error: "Twilio env vars not set" }); return;
		}
		const callParams = new URLSearchParams({
			outbound: "true", callType: "pickup_reminder",
			customerName, orderId: orderIds,
			reason: `Scheduled pickup reminder${scheduledDatetime ? ` — arriving ${scheduledDatetime}` : ""}`,
		});
		const callUrl = `${webhookBase}/voice?${callParams.toString()}`;
		const creds = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
		const r2 = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`, {
			method: "POST",
			headers: { Authorization: `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ To: phone, From: fromNumber, Url: callUrl }),
		});
		if (!r2.ok) { res.status(500).json({ error: await r2.text() }); return; }
		const { sid } = await r2.json() as { sid: string };
		await notionUpdatePage(req.params.id, {
			REMINDER_SENT: { checkbox: true },
			REMINDER_CALL_STATUS: { rich_text: [{ type: "text", text: { content: "Called (manual)" } }] },
		});
		res.json({ ok: true, callSid: sid, called: phone });
	} catch (err) { res.status(500).json({ error: String(err) }); }
});

app.use("/api/dashboard", r);

// Local dev: start server. On Vercel the default export is used instead.
if (process.env.VERCEL !== "1") {
	app.listen(PORT, () => {
		console.log(`✓ Dashboard → http://localhost:${PORT}`);
	});
}

export default app;
