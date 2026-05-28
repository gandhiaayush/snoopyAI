import { callWorkerTool } from "../notion/worker";

type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export interface RealtimeTool {
  type: "function";
  name: string;
  description: string;
  parameters: JsonSchema;
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = []
): RealtimeTool {
  return {
    type: "function",
    name,
    description,
    parameters: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}

const T_GET_ORDER_BY_PHONE = tool(
  "getOrderByPhone",
  "Look up all orders for a phone number. Returns up to 5 most recent. Use only when the caller explicitly gives their phone number.",
  {
    phone: { type: "string", description: "Customer phone number e.g. +14155550123" },
  },
  ["phone"]
);

const T_GET_ORDER_BY_ID = tool(
  "getOrderById",
  "Look up a specific order by its ORDER_ID (e.g. ORD-0010). Use when customer provides their order number.",
  {
    orderId: { type: "string", description: "The ORDER_ID value e.g. ORD-0010" },
  },
  ["orderId"]
);

const T_SEARCH_BY_NAME = tool(
  "searchOrdersByName",
  "Search orders by customer name. Fallback when the customer does not know an order number.",
  {
    name: { type: "string", description: "Customer name or partial name" },
  },
  ["name"]
);

const T_LOOKUP_PRICE = tool(
  "lookupPrice",
  "Look up price for a specific garment item. Item name must match EXACTLY as stored (e.g. 'Shirt (dress)', 'Pants (casual)', 'Wedding Dress'). Call listAllPrices first if unsure of exact name.",
  {
    item: { type: "string", description: "Exact item name from pricing schedule e.g. 'Shirt (dress)', 'Suit (2-piece)'" },
    orderType: {
      type: "string",
      enum: ["Regular", "Expedited"],
      description: "Regular or Expedited",
    },
  },
  ["item", "orderType"]
);

const T_LIST_ALL_PRICES = tool(
  "listAllPrices",
  "Return the full pricing schedule. Use when customer asks for a general price list or to find exact item names."
);

const T_APPEND_NOTE = tool(
  "appendOrderNote",
  "Append a note to an existing order. Use to record customer preferences or special handling instructions.",
  {
    pageId: { type: "string", description: "Notion page ID from getOrderByPhone or getOrderById" },
    note: { type: "string", description: "Text to append. Be specific and concise." },
  },
  ["pageId", "note"]
);

const T_SET_ORDER_TYPE = tool(
  "setOrderType",
  "Change an order to Regular or Expedited. When quoting expedited, state price then ask if they want a callback to confirm capacity.",
  {
    pageId: { type: "string", description: "Notion page ID from getOrderByPhone or getOrderById" },
    orderType: {
      type: "string",
      enum: ["Regular", "Expedited"],
      description: "The new order type",
    },
  },
  ["pageId", "orderType"]
);

const T_REQUEST_CALLBACK = tool(
  "requestCallback",
  "Log a callback request so staff can follow up. Use this whenever you cannot give a firm answer, especially for expedited requests, same-day timing, pickup-time changes, schedule exceptions, or anything that needs staff confirmation. If you already loaded the order, pass pageId and reason and the system will fill in the customer details for you.",
  {
    pageId: { type: "string", description: "Notion page ID from getOrderByPhone or getOrderById. Preferred when an order is already loaded." },
    customerName: { type: "string", description: "Customer's name, only needed if pageId is not available" },
    phone: { type: "string", description: "Phone number to call back, only needed if pageId is not available" },
    orderId: { type: "string", description: "ORDER_ID for reference e.g. ORD-0010, only needed if pageId is not available" },
    reason: { type: "string", description: "Why the customer wants a callback and what needs staff confirmation" },
  },
  ["reason"]
);

const T_CANCEL_ORDER = tool(
  "cancelOrder",
  "Mark an order as Cancelled. Always confirm with the customer before calling.",
  {
    pageId: { type: "string", description: "Notion page ID from getOrderByPhone or getOrderById" },
  },
  ["pageId"]
);

const T_UPDATE_TRACKER = tool(
  "updateTracker",
  "Update what stage an order is at in the cleaning process.",
  {
    pageId: { type: "string", description: "Notion page ID from getOrderByPhone or getOrderById" },
    stage: {
      type: "string",
      enum: ["Received", "Sorting", "Cleaning", "Pressing", "Ready for Pickup", "Delivered", "Cancelled"],
      description: "Current stage of the order",
    },
  },
  ["pageId", "stage"]
);

const T_UPDATE_PAYMENT = tool(
  "updatePayment",
  "Record or update how and when an order was paid. Use null paymentDate if setting to Unpaid.",
  {
    pageId: { type: "string", description: "Notion page ID from getOrderByPhone or getOrderById" },
    paymentMethod: {
      type: "string",
      enum: ["Cash", "Card", "Venmo", "Zelle", "Unpaid"],
      description: "How the customer paid",
    },
    paymentDate: {
      type: "string",
      description: "Date paid in YYYY-MM-DD format, or empty string if not yet paid",
    },
  },
  ["pageId", "paymentMethod", "paymentDate"]
);

const T_UPDATE_GARMENT = tool(
  "updateGarmentType",
  "Set or correct the garment type. Use exact item name from pricing schedule. After updating, call lookupPrice then updateOrderPrice.",
  {
    pageId: { type: "string", description: "Notion page ID from getOrderByPhone or getOrderById" },
    garmentType: {
      type: "string",
      description: "Exact item name from pricing schedule e.g. 'Shirt (dress)', 'Suit (2-piece)'",
    },
  },
  ["pageId", "garmentType"]
);

const T_UPDATE_PRICE = tool(
  "updateOrderPrice",
  "Update the price on an order. Always call after setOrderType or updateGarmentType using the price from lookupPrice.",
  {
    pageId: { type: "string", description: "Notion page ID from getOrderByPhone or getOrderById" },
    price: { type: "number", description: "New total price in dollars e.g. 24.99" },
  },
  ["pageId", "price"]
);

const T_UPDATE_EXPECTED_DATE = tool(
  "updateOrderExpectedDate",
  "Update the expected pickup date on an order.",
  {
    pageId: { type: "string", description: "Notion page ID from getOrderByPhone or getOrderById" },
    expectedDate: { type: "string", description: "New expected date in YYYY-MM-DD format" },
  },
  ["pageId", "expectedDate"]
);

const T_LIST_PENDING_CALLBACKS = tool(
  "listPendingCallbacks",
  "Return all callback requests with STATUS = Pending. Staff-facing tool."
);

const T_TRIGGER_PICKUP_CALL = tool(
  "triggerPickupCall",
  "Trigger an outbound pickup reminder call to a customer whose order is Ready for Pickup. The Notion Worker stamps NOTIFIED_AT and POSTs to the outbound webhook to initiate the call.",
  {
    pageId: { type: "string", description: "Notion page ID from getOrderByPhone or getOrderById" },
    phone: { type: "string", description: "Customer phone number in E.164 format" },
    customerName: { type: "string", description: "Customer's name" },
    orderId: { type: "string", description: "ORDER_ID value e.g. ORD-0010" },
  },
  ["pageId", "phone", "customerName", "orderId"]
);

const T_RESOLVE_CALLBACK = tool(
  "resolveCallback",
  "Mark a callback as handled. Use callbackId from listPendingCallbacks.",
  {
    callbackId: { type: "string", description: "Notion page ID of the callback record" },
    status: {
      type: "string",
      enum: ["Called Back", "Resolved"],
      description: "Called Back = spoke to customer, Resolved = fully handled",
    },
  },
  ["callbackId", "status"]
);

const T_HANG_UP = tool(
  "hangUp",
  "End the call. Only call this AFTER you have already spoken your goodbye phrase aloud. Do not call this mid-conversation."
);

export const CONSUMER_TOOLS: RealtimeTool[] = [
  T_GET_ORDER_BY_PHONE,
  T_GET_ORDER_BY_ID,
  T_SEARCH_BY_NAME,
  T_LOOKUP_PRICE,
  T_LIST_ALL_PRICES,
  T_APPEND_NOTE,
  T_SET_ORDER_TYPE,
  T_REQUEST_CALLBACK,
  T_HANG_UP,
];

export const OWNER_TOOLS: RealtimeTool[] = [
  T_GET_ORDER_BY_PHONE,
  T_GET_ORDER_BY_ID,
  T_SEARCH_BY_NAME,
  T_LOOKUP_PRICE,
  T_LIST_ALL_PRICES,
  T_APPEND_NOTE,
  T_SET_ORDER_TYPE,
  T_REQUEST_CALLBACK,
  T_CANCEL_ORDER,
  T_UPDATE_TRACKER,
  T_UPDATE_PAYMENT,
  T_UPDATE_GARMENT,
  T_UPDATE_PRICE,
  T_UPDATE_EXPECTED_DATE,
  T_LIST_PENDING_CALLBACKS,
  T_RESOLVE_CALLBACK,
  T_TRIGGER_PICKUP_CALL,
  T_HANG_UP,
];

export async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  hangupCallback?: () => void
): Promise<{ result: unknown; action: string }> {
  if (toolName === "hangUp") {
    hangupCallback?.();
    return { result: { success: true }, action: "hangUp: call ending" };
  }

  const result = await callWorkerTool(toolName, input);
  return {
    result,
    action: `${toolName}: done`,
  };
}
