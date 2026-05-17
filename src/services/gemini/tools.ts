import { FunctionDeclaration, Type } from "@google/genai";
import { callWorkerTool } from "../notion/worker";

// ─── Tool Declarations ────────────────────────────────────────────────────────

const T_GET_ORDER_BY_PHONE: FunctionDeclaration = {
  name: "getOrderByPhone",
  description: "Look up all orders for a phone number. Returns up to 5 most recent. Use automatically on every call.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      phone: { type: Type.STRING, description: "Customer phone number e.g. +14155550123" },
    },
    required: ["phone"],
  },
};

const T_GET_ORDER_BY_ID: FunctionDeclaration = {
  name: "getOrderById",
  description: "Look up a specific order by its ORDER_ID (e.g. ORD-0010). Use when customer provides their order number.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      orderId: { type: Type.STRING, description: "The ORDER_ID value e.g. ORD-0010" },
    },
    required: ["orderId"],
  },
};

const T_SEARCH_BY_NAME: FunctionDeclaration = {
  name: "searchOrdersByName",
  description: "Search orders by customer name. Fallback when getOrderByPhone finds nothing.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      name: { type: Type.STRING, description: "Customer name or partial name" },
    },
    required: ["name"],
  },
};

const T_LOOKUP_PRICE: FunctionDeclaration = {
  name: "lookupPrice",
  description: "Look up price for a specific garment item. Item name must match EXACTLY as stored (e.g. 'Shirt (dress)', 'Pants (casual)', 'Wedding Dress'). Call listAllPrices first if unsure of exact name.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      item: { type: Type.STRING, description: "Exact item name from pricing schedule e.g. 'Shirt (dress)', 'Suit (2-piece)'" },
      orderType: {
        type: Type.STRING,
        enum: ["Regular", "Expedited"],
        description: "Regular or Expedited",
      },
    },
    required: ["item", "orderType"],
  },
};

const T_LIST_ALL_PRICES: FunctionDeclaration = {
  name: "listAllPrices",
  description: "Return the full pricing schedule. Use when customer asks for a general price list or to find exact item names.",
  parameters: {
    type: Type.OBJECT,
    properties: {},
    required: [],
  },
};

const T_APPEND_NOTE: FunctionDeclaration = {
  name: "appendOrderNote",
  description: "Append a note to an existing order. Use to record customer preferences or special handling instructions.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      pageId: { type: Type.STRING, description: "Notion page ID from getOrderByPhone or getOrderById" },
      note: { type: Type.STRING, description: "Text to append. Be specific and concise." },
    },
    required: ["pageId", "note"],
  },
};

const T_SET_ORDER_TYPE: FunctionDeclaration = {
  name: "setOrderType",
  description: "Change an order to Regular or Expedited. When quoting expedited, state price then ask if they want a callback to confirm capacity.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      pageId: { type: Type.STRING, description: "Notion page ID from getOrderByPhone or getOrderById" },
      orderType: {
        type: Type.STRING,
        enum: ["Regular", "Expedited"],
        description: "The new order type",
      },
    },
    required: ["pageId", "orderType"],
  },
};

const T_REQUEST_CALLBACK: FunctionDeclaration = {
  name: "requestCallback",
  description: "Log a callback request so staff knows to follow up. Use when only staff can answer. Always call this — don't just tell the customer someone will call.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      pageId: { type: Type.STRING, description: "Notion page ID from getOrderByPhone or getOrderById" },
      customerName: { type: Type.STRING, description: "Customer's name" },
      phone: { type: Type.STRING, description: "Phone number to call back" },
      orderId: { type: Type.STRING, description: "ORDER_ID for reference e.g. ORD-0010" },
      reason: { type: Type.STRING, description: "Why the customer wants a callback" },
    },
    required: ["pageId", "customerName", "phone", "orderId", "reason"],
  },
};

const T_CANCEL_ORDER: FunctionDeclaration = {
  name: "cancelOrder",
  description: "Mark an order as Cancelled. Always confirm with the customer before calling.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      pageId: { type: Type.STRING, description: "Notion page ID from getOrderByPhone or getOrderById" },
    },
    required: ["pageId"],
  },
};

const T_UPDATE_TRACKER: FunctionDeclaration = {
  name: "updateTracker",
  description: "Update what stage an order is at in the cleaning process.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      pageId: { type: Type.STRING, description: "Notion page ID from getOrderByPhone or getOrderById" },
      stage: {
        type: Type.STRING,
        enum: ["Received", "Sorting", "Cleaning", "Pressing", "Ready for Pickup", "Delivered", "Cancelled"],
        description: "Current stage of the order",
      },
    },
    required: ["pageId", "stage"],
  },
};

const T_UPDATE_PAYMENT: FunctionDeclaration = {
  name: "updatePayment",
  description: "Record or update how and when an order was paid. Use null paymentDate if setting to Unpaid.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      pageId: { type: Type.STRING, description: "Notion page ID from getOrderByPhone or getOrderById" },
      paymentMethod: {
        type: Type.STRING,
        enum: ["Cash", "Card", "Venmo", "Zelle", "Unpaid"],
        description: "How the customer paid",
      },
      paymentDate: {
        type: Type.STRING,
        description: "Date paid in YYYY-MM-DD format, or empty string if not yet paid",
      },
    },
    required: ["pageId", "paymentMethod", "paymentDate"],
  },
};

const T_UPDATE_GARMENT: FunctionDeclaration = {
  name: "updateGarmentType",
  description: "Set or correct the garment type. Use exact item name from pricing schedule. After updating, call lookupPrice then updateOrderPrice.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      pageId: { type: Type.STRING, description: "Notion page ID from getOrderByPhone or getOrderById" },
      garmentType: {
        type: Type.STRING,
        description: "Exact item name from pricing schedule e.g. 'Shirt (dress)', 'Suit (2-piece)'",
      },
    },
    required: ["pageId", "garmentType"],
  },
};

const T_UPDATE_PRICE: FunctionDeclaration = {
  name: "updateOrderPrice",
  description: "Update the price on an order. Always call after setOrderType or updateGarmentType using the price from lookupPrice.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      pageId: { type: Type.STRING, description: "Notion page ID from getOrderByPhone or getOrderById" },
      price: { type: Type.NUMBER, description: "New total price in dollars e.g. 24.99" },
    },
    required: ["pageId", "price"],
  },
};

const T_UPDATE_EXPECTED_DATE: FunctionDeclaration = {
  name: "updateOrderExpectedDate",
  description: "Update the expected pickup date on an order.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      pageId: { type: Type.STRING, description: "Notion page ID from getOrderByPhone or getOrderById" },
      expectedDate: { type: Type.STRING, description: "New expected date in YYYY-MM-DD format" },
    },
    required: ["pageId", "expectedDate"],
  },
};

const T_LIST_PENDING_CALLBACKS: FunctionDeclaration = {
  name: "listPendingCallbacks",
  description: "Return all callback requests with STATUS = Pending. Staff-facing tool.",
  parameters: {
    type: Type.OBJECT,
    properties: {},
    required: [],
  },
};

const T_TRIGGER_PICKUP_CALL: FunctionDeclaration = {
  name: "triggerPickupCall",
  description: "Trigger an outbound pickup reminder call to a customer whose order is Ready for Pickup. The Notion Worker stamps NOTIFIED_AT and POSTs to the outbound webhook to initiate the call.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      pageId: { type: Type.STRING, description: "Notion page ID from getOrderByPhone or getOrderById" },
      phone: { type: Type.STRING, description: "Customer phone number in E.164 format" },
      customerName: { type: Type.STRING, description: "Customer's name" },
      orderId: { type: Type.STRING, description: "ORDER_ID value e.g. ORD-0010" },
    },
    required: ["pageId", "phone", "customerName", "orderId"],
  },
};

const T_RESOLVE_CALLBACK: FunctionDeclaration = {
  name: "resolveCallback",
  description: "Mark a callback as handled. Use callbackId from listPendingCallbacks.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      callbackId: { type: Type.STRING, description: "Notion page ID of the callback record" },
      status: {
        type: Type.STRING,
        enum: ["Called Back", "Resolved"],
        description: "Called Back = spoke to customer, Resolved = fully handled",
      },
    },
    required: ["callbackId", "status"],
  },
};

// ─── Tool Sets ────────────────────────────────────────────────────────────────

export const CONSUMER_TOOLS: FunctionDeclaration[] = [
  T_GET_ORDER_BY_PHONE,
  T_GET_ORDER_BY_ID,
  T_SEARCH_BY_NAME,
  T_LOOKUP_PRICE,
  T_LIST_ALL_PRICES,
  T_APPEND_NOTE,
  T_SET_ORDER_TYPE,
  T_REQUEST_CALLBACK,
];

export const OWNER_TOOLS: FunctionDeclaration[] = [
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
];

// ─── Dispatcher — all tools route through Notion Worker ───────────────────────

export async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  _callSid: string,
  _callerPhone: string
): Promise<{ result: unknown; action: string }> {
  const result = await callWorkerTool(toolName, input);
  return {
    result,
    action: `${toolName}: done`,
  };
}
