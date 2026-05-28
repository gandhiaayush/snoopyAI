import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_API_KEY! });

function ds(envKey: string): string {
  const v = process.env[envKey];
  if (!v) throw new Error(`${envKey} env var is not set`);
  return v;
}

function getText(prop: any): string {
  return (prop?.rich_text ?? prop?.title ?? [])
    .map((t: any) => t.plain_text as string)
    .join("");
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
    paymentDate:   (p["PAYMENT_DATE"]?.date?.start ?? null) as string | null,
    garmentType:   getText(p["GARMENT_TYPE"]) || null,
    notifiedAt:    (p["NOTIFIED_AT"]?.date?.start ?? null) as string | null,
  };
}

// ─── READ: Orders ──────────────────────────────────────────────────────────────

function phoneVariants(phone: string): string[] {
  // Twilio sends E.164 (+14155550305). Notion stores arbitrary formats.
  // Try: E.164, local 10-digit, (XXX) XXX-XXXX, XXX-XXXXXXX
  const digits = phone.replace(/\D/g, "");
  const local = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return [
    phone,
    `+1${local}`,
    local,
    `(${local.slice(0,3)}) ${local.slice(3,6)}-${local.slice(6)}`,
    `${local.slice(0,3)}-${local.slice(3,6)}-${local.slice(6)}`,
    `${local.slice(0,3)}-${local.slice(3)}`,
  ].filter((v, i, a) => a.indexOf(v) === i);
}

async function getOrderByPhone({ phone }: { phone: string }) {
  const variants = phoneVariants(phone);
  // Track which variant matched each result for verification signals
  const rawByVariant = await Promise.all(
    variants.map((v) =>
      (notion as any).dataSources.query({
        data_source_id: ds("ORDERS_DATA_SOURCE_ID"),
        filter: { property: "ORDER_PHONE", phone_number: { equals: v } },
        page_size: 5,
      }).then((r: any) => r.results.map((p: any) => ({ page: p, matchedVariant: v }))).catch(() => [])
    )
  );
  const seen = new Set<string>();
  const enriched: Array<ReturnType<typeof shapeOrder> & { matchedPhone: string }> = [];
  for (const batch of rawByVariant) {
    for (const { page, matchedVariant } of batch) {
      if (seen.has(page.id)) continue;
      seen.add(page.id);
      enriched.push({ ...shapeOrder(page), matchedPhone: matchedVariant });
    }
  }
  const hint =
    enriched.length > 1
      ? `Multiple orders found — ask customer which garment (${enriched.map((o) => o.garmentType || o.orderId).join(", ")}) before reading order details`
      : enriched.length === 0
      ? `No order matched phone ${phone} — try searchOrdersByName as fallback`
      : null;
  return { found: enriched.length > 0, orders: enriched, _verify: hint };
}

async function getOrderById({ orderId }: { orderId: string }) {
  const res = await (notion as any).dataSources.query({
    data_source_id: ds("ORDERS_DATA_SOURCE_ID"),
    filter: { property: "ORDER_ID", rich_text: { equals: orderId } },
    page_size: 1,
  });
  const results = res.results.map(shapeOrder);
  const order = results[0] ?? null;
  // Verification hint: caller ID lookup has no phone check — confirm identity before any write
  const hint = order
    ? `Verify caller identity — confirm customer name matches "${order.customerName}" before making any changes`
    : null;
  return { found: results.length > 0, order, _verify: hint };
}

async function searchOrdersByName({ name }: { name: string }) {
  const res = await (notion as any).dataSources.query({
    data_source_id: ds("ORDERS_DATA_SOURCE_ID"),
    filter: { property: "CUSTOMER_NAME", title: { contains: name } },
    page_size: 5,
  });
  const orders = res.results.map(shapeOrder);
  return { found: orders.length > 0, orders };
}

// ─── READ: Pricing ─────────────────────────────────────────────────────────────

async function lookupPrice({ item, orderType }: { item: string; orderType: string }) {
  const res = await (notion as any).dataSources.query({
    data_source_id: ds("PRICING_DATA_SOURCE_ID"),
    filter: { property: "ITEM", title: { equals: item } },
    page_size: 1,
  });
  const p = res.results.length > 0 ? (res.results[0] as any).properties : null;
  const price = p
    ? orderType === "Expedited"
      ? (p["EXPEDITED_PRICE"]?.number ?? null)
      : (p["REGULAR_PRICE"]?.number ?? null)
    : null;
  return {
    found: res.results.length > 0,
    item,
    orderType,
    price,
    category: p ? (p["CATEGORY"]?.select?.name ?? null) : null,
    notes: p ? getText(p["NOTES"]) || null : null,
  };
}

async function listAllPrices() {
  const res = await (notion as any).dataSources.query({
    data_source_id: ds("PRICING_DATA_SOURCE_ID"),
    page_size: 100,
  });
  const prices = res.results.map((page: any) => {
    const p = page.properties;
    return {
      category:       (p["CATEGORY"]?.select?.name ?? null) as string | null,
      item:           getText(p["ITEM"]),
      regularPrice:   (p["REGULAR_PRICE"]?.number ?? null) as number | null,
      expeditedPrice: (p["EXPEDITED_PRICE"]?.number ?? null) as number | null,
      notes:          getText(p["NOTES"]) || null,
    };
  });
  return { prices };
}

// ─── READ: Workspace search ────────────────────────────────────────────────────

async function searchWorkspace({ query }: { query: string }) {
  const res = await notion.search({
    query,
    sort: { direction: "descending", timestamp: "last_edited_time" },
    page_size: 8,
  });

  const results = res.results.map((item: any) => {
    let title = "Untitled";
    if (item.object === "database") {
      title = (item.title ?? []).map((t: any) => t.plain_text as string).join("") || "Untitled";
    } else {
      const props = item.properties ?? {};
      const titleProp = Object.values(props).find((p: any) => p.type === "title") as any;
      if (titleProp) {
        title = (titleProp.title ?? []).map((t: any) => t.plain_text as string).join("") || "Untitled";
      }
    }
    return {
      id: item.id as string,
      type: item.object as string,
      title,
      lastEdited: item.last_edited_time as string,
    };
  });

  return { found: results.length > 0, count: results.length, results };
}

// ─── READ: Callbacks ───────────────────────────────────────────────────────────

async function listPendingCallbacks() {
  const res = await (notion as any).dataSources.query({
    data_source_id: ds("CALLBACKS_DATA_SOURCE_ID"),
    filter: { property: "STATUS", rich_text: { equals: "Pending" } },
    page_size: 50,
  });
  const callbacks = res.results.map((page: any) => {
    const p = page.properties;
    return {
      callbackId:   page.id as string,
      customerName: getText(p["CUSTOMER_NAME"]),
      phone:        (p["PHONE"]?.phone_number ?? null) as string | null,
      orderId:      getText(p["ORDER_ID"]),
      reason:       getText(p["REASON"]),
      requestedAt:  (p["REQUESTED_AT"]?.date?.start ?? null) as string | null,
      status:       getText(p["STATUS"]) || null,
    };
  });
  return { count: callbacks.length, callbacks };
}

// ─── WRITE: Order updates ──────────────────────────────────────────────────────

async function appendOrderNote({ pageId, note }: { pageId: string; note: string }) {
  const page = await notion.pages.retrieve({ page_id: pageId }) as any;
  const existing = getText(page.properties["NOTES"]);
  const updated = existing ? `${existing}\n${note}` : note;
  await notion.pages.update({
    page_id: pageId,
    properties: {
      NOTES: { rich_text: [{ type: "text", text: { content: updated } }] },
    } as any,
  });
  return { success: true, notes: updated };
}

async function setOrderType({ pageId, orderType }: { pageId: string; orderType: string }) {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      ORDER_TYPE: { rich_text: [{ type: "text", text: { content: orderType } }] },
    } as any,
  });
  return { success: true, orderType };
}

async function updateTracker({ pageId, stage }: { pageId: string; stage: string }) {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      TRACKER_STAGE: { rich_text: [{ type: "text", text: { content: stage } }] },
    } as any,
  });
  return { success: true, stage };
}

async function updatePayment({
  pageId, paymentMethod, paymentDate,
}: { pageId: string; paymentMethod: string; paymentDate: string | null }) {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      PAYMENT_METHOD: { rich_text: [{ type: "text", text: { content: paymentMethod } }] },
      PAYMENT_DATE:   { date: paymentDate ? { start: paymentDate } : null },
    } as any,
  });
  return { success: true, paymentMethod, paymentDate };
}

async function updateGarmentType({ pageId, garmentType }: { pageId: string; garmentType: string }) {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      GARMENT_TYPE: { rich_text: [{ type: "text", text: { content: garmentType } }] },
    } as any,
  });
  return { success: true, garmentType };
}

async function updateOrderPrice({ pageId, price }: { pageId: string; price: number }) {
  await notion.pages.update({
    page_id: pageId,
    properties: { ORDER_PRICE: { number: price } } as any,
  });
  return { success: true, price };
}

async function updateOrderExpectedDate({ pageId, expectedDate }: { pageId: string; expectedDate: string }) {
  await notion.pages.update({
    page_id: pageId,
    properties: { EXPECTED_DATE: { date: { start: expectedDate } } } as any,
  });
  return { success: true, expectedDate };
}

async function cancelOrder({ pageId }: { pageId: string }) {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      TRACKER_STAGE: { rich_text: [{ type: "text", text: { content: "Cancelled" } }] },
    } as any,
  });
  return { success: true };
}

// ─── WRITE: Create callback ────────────────────────────────────────────────────

async function requestCallback({
  pageId, customerName, phone, orderId, reason,
}: { pageId?: string; customerName?: string; phone?: string; orderId?: string; reason: string }) {
  if (pageId && (!customerName || !phone || !orderId)) {
    const page = await notion.pages.retrieve({ page_id: pageId }) as any;
    const order = shapeOrder(page);
    customerName = customerName ?? order.customerName;
    phone = phone ?? order.phone ?? undefined;
    orderId = orderId ?? order.orderId;
  }

  if (!customerName || !phone || !orderId) {
    throw new Error("requestCallback requires either pageId or explicit customerName, phone, and orderId");
  }

  const today = new Date().toISOString().split("T")[0];
  await notion.pages.create({
    parent: { database_id: ds("CALLBACKS_DATABASE_ID") } as any,
    properties: {
      CUSTOMER_NAME: { title: [{ type: "text", text: { content: customerName } }] },
      ORDER_ID:      { rich_text: [{ type: "text", text: { content: orderId } }] },
      PHONE:         { phone_number: phone },
      REASON:        { rich_text: [{ type: "text", text: { content: reason } }] },
      REQUESTED_AT:  { date: { start: today } },
      STATUS:        { rich_text: [{ type: "text", text: { content: "Pending" } }] },
    } as any,
  });
  return { success: true, callbackLogged: true, reason };
}

async function resolveCallback({ callbackId, status }: { callbackId: string; status: string }) {
  await notion.pages.update({
    page_id: callbackId,
    properties: { STATUS: { rich_text: [{ type: "text", text: { content: status } }] } } as any,
  });
  return { success: true, status };
}

// ─── Outbound call ─────────────────────────────────────────────────────────────

async function triggerPickupCall({
  pageId, phone, customerName, orderId,
}: { pageId: string; phone: string; customerName: string; orderId: string }) {
  const accountSid  = process.env.TWILIO_ACCOUNT_SID!;
  const authToken   = process.env.TWILIO_AUTH_TOKEN!;
  const fromNumber  = process.env.TWILIO_PHONE_NUMBER!;
  const webhookBase = (process.env.TWILIO_WEBHOOK_BASE ?? "").replace(/\/$/, "");

  const creds   = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const callUrl = `${webhookBase}/voice?outbound=true&customerName=${encodeURIComponent(customerName)}&orderId=${encodeURIComponent(orderId)}`;

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${creds}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: phone, From: fromNumber, Url: callUrl }),
    }
  );
  if (!res.ok) throw new Error(`Twilio call failed: ${await res.text()}`);
  const { sid } = await res.json() as { sid: string };

  const today = new Date().toISOString().split("T")[0];
  await notion.pages.update({
    page_id: pageId,
    properties: { NOTIFIED_AT: { date: { start: today } } } as any,
  });
  return { success: true, callSid: sid, called: phone, notifiedAt: today };
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

const TOOLS: Record<string, (input: any) => Promise<unknown>> = {
  getOrderByPhone,
  getOrderById,
  searchOrdersByName,
  searchWorkspace,
  lookupPrice,
  listAllPrices,
  listPendingCallbacks,
  appendOrderNote,
  setOrderType,
  updateTracker,
  updatePayment,
  updateGarmentType,
  updateOrderPrice,
  updateOrderExpectedDate,
  requestCallback,
  resolveCallback,
  cancelOrder,
  triggerPickupCall,
};

export async function callWorkerTool(
  toolName: string,
  input: Record<string, unknown>
): Promise<unknown> {
  const fn = TOOLS[toolName];
  if (!fn) throw new Error(`Unknown tool: ${toolName}`);
  return fn(input);
}
