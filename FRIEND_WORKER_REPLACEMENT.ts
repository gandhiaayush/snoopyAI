// src/services/notion/worker.ts
// Replace the entire file with this.
// Uses @notionhq/client directly — no Notion Worker HTTP API needed.

import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_API_KEY! });

const ORDERS_DB   = () => env("ORDERS_DATABASE_ID");
const PRICING_DB  = () => env("PRICING_DATABASE_ID");
const CALLBACKS_DB = () => env("CALLBACKS_DATABASE_ID");

function env(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} env var is not set`);
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
    orderType:     (p["ORDER_TYPE"]?.select?.name ?? null) as string | null,
    tracker:       (p["TRACKER"]?.select?.name ?? null) as string | null,
    paymentMethod: (p["PAYMENT_METHOD"]?.select?.name ?? null) as string | null,
    paymentDate:   (p["PAYMENT_DATE"]?.date?.start ?? null) as string | null,
    garmentType:   getText(p["GARMENT_TYPE"]) || null,
  };
}

// ─── Tool implementations ─────────────────────────────────────────────────────

async function getOrderByPhone({ phone }: { phone: string }) {
  const res = await notion.databases.query({
    database_id: ORDERS_DB(),
    filter: { property: "ORDER_PHONE", phone_number: { equals: phone } },
    page_size: 5,
  });
  const orders = res.results.map(shapeOrder);
  return { found: orders.length > 0, orders };
}

async function getOrderById({ orderId }: { orderId: string }) {
  const res = await notion.databases.query({
    database_id: ORDERS_DB(),
    filter: { property: "ORDER_ID", rich_text: { equals: orderId } },
    page_size: 1,
  });
  const results = res.results.map(shapeOrder);
  return { found: results.length > 0, order: results[0] ?? null };
}

async function searchOrdersByName({ name }: { name: string }) {
  const res = await notion.databases.query({
    database_id: ORDERS_DB(),
    filter: { property: "CUSTOMER_NAME", title: { contains: name } },
    page_size: 5,
  });
  const orders = res.results.map(shapeOrder);
  return { found: orders.length > 0, orders };
}

async function lookupPrice({ item, orderType }: { item: string; orderType: string }) {
  const res = await notion.databases.query({
    database_id: PRICING_DB(),
    filter: { property: "ITEM", title: { equals: item } },
    page_size: 1,
  });
  const p = res.results.length > 0 ? (res.results[0] as any).properties : null;
  const price = p
    ? orderType === "Expedited"
      ? (p["EXPEDITED_PRICE"]?.number ?? null)
      : (p["REGULAR_PRICE"]?.number ?? null)
    : null;
  const notes = p ? getText(p["NOTES"]) || null : null;
  const category = p ? (p["CATEGORY"]?.select?.name ?? null) : null;
  return { found: res.results.length > 0, item, orderType, price, category, notes };
}

async function listAllPrices() {
  const res = await notion.databases.query({
    database_id: PRICING_DB(),
    page_size: 100,
  });
  const prices = res.results.map((page: any) => {
    const p = page.properties;
    return {
      category:      (p["CATEGORY"]?.select?.name ?? null) as string | null,
      item:          getText(p["ITEM"]),
      regularPrice:  (p["REGULAR_PRICE"]?.number ?? null) as number | null,
      expeditedPrice:(p["EXPEDITED_PRICE"]?.number ?? null) as number | null,
      notes:         getText(p["NOTES"]) || null,
    };
  });
  return { prices };
}

async function listPendingCallbacks() {
  const res = await notion.databases.query({
    database_id: CALLBACKS_DB(),
    filter: { property: "STATUS", select: { equals: "Pending" } },
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
      status:       (p["STATUS"]?.select?.name ?? null) as string | null,
    };
  });
  return { count: callbacks.length, callbacks };
}

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
    properties: { ORDER_TYPE: { select: { name: orderType } } } as any,
  });
  return { success: true, orderType };
}

async function updateTracker({ pageId, stage }: { pageId: string; stage: string }) {
  await notion.pages.update({
    page_id: pageId,
    properties: { TRACKER: { select: { name: stage } } } as any,
  });
  return { success: true, stage };
}

async function updatePayment({ pageId, paymentMethod, paymentDate }: { pageId: string; paymentMethod: string; paymentDate: string | null }) {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      PAYMENT_METHOD: { select: { name: paymentMethod } },
      PAYMENT_DATE: { date: paymentDate ? { start: paymentDate } : null },
    } as any,
  });
  return { success: true, paymentMethod, paymentDate };
}

async function updateGarmentType({ pageId, garmentType }: { pageId: string; garmentType: string }) {
  await notion.pages.update({
    page_id: pageId,
    properties: { GARMENT_TYPE: { rich_text: [{ type: "text", text: { content: garmentType } }] } } as any,
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

async function requestCallback({ pageId, reason }: { pageId: string; reason: string }) {
  // Look up the order to extract customer info — voice agent only sends pageId + reason
  const page = await notion.pages.retrieve({ page_id: pageId }) as any;
  const p = page.properties;
  const customerName = getText(p["CUSTOMER_NAME"]);
  const phone: string | null = p["ORDER_PHONE"]?.phone_number ?? null;
  const orderId = getText(p["ORDER_ID"]);

  const today = new Date().toISOString().split("T")[0];
  const cbProps: Record<string, unknown> = {
    CUSTOMER_NAME: { title: [{ type: "text", text: { content: customerName } }] },
    ORDER_ID:      { rich_text: [{ type: "text", text: { content: orderId } }] },
    REASON:        { rich_text: [{ type: "text", text: { content: reason } }] },
    REQUESTED_AT:  { date: { start: today } },
    STATUS:        { select: { name: "Pending" } },
  };
  if (phone) cbProps["PHONE"] = { phone_number: phone };
  await notion.pages.create({
    parent: { database_id: CALLBACKS_DB() },
    properties: cbProps as any,
  });
  return { success: true, callbackLogged: true, reason };
}

async function resolveCallback({ callbackId, status }: { callbackId: string; status: string }) {
  await notion.pages.update({
    page_id: callbackId,
    properties: { STATUS: { select: { name: status } } } as any,
  });
  return { success: true, status };
}

async function cancelOrder({ pageId }: { pageId: string }) {
  await notion.pages.update({
    page_id: pageId,
    properties: { TRACKER: { select: { name: "Cancelled" } } } as any,
  });
  return { success: true };
}

async function triggerPickupCall({ pageId, phone, customerName, orderId }: {
  pageId: string; phone: string; customerName: string; orderId: string;
}) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID!;
  const authToken  = process.env.TWILIO_AUTH_TOKEN!;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER!;
  const webhookBase = (process.env.TWILIO_WEBHOOK_BASE ?? "").replace(/\/$/, "");

  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const callUrl = `${webhookBase}/voice?outbound=true&customerName=${encodeURIComponent(customerName)}&orderId=${encodeURIComponent(orderId)}`;

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: phone, From: fromNumber, Url: callUrl }),
  });
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
