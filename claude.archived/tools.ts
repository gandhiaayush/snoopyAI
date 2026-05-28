import Anthropic from "@anthropic-ai/sdk";

export const WORKER_TOOLS: Anthropic.Tool[] = [
  {
    name: "getOrderByPhone",
    description:
      "Primary lookup — call this at the START of every inbound call using the Twilio caller's From number. Returns up to 5 orders for that phone number. Always do this first before any other tool.",
    input_schema: {
      type: "object",
      properties: {
        phone: {
          type: "string",
          description: "Customer phone in E.164 format e.g. +14155551234",
        },
      },
      required: ["phone"],
    },
  },
  {
    name: "getOrderById",
    description:
      "Look up a specific order by ORDER_ID. Use when the customer provides their order number verbally.",
    input_schema: {
      type: "object",
      properties: {
        orderId: {
          type: "string",
          description: "The ORDER_ID value provided by the customer",
        },
      },
      required: ["orderId"],
    },
  },
  {
    name: "searchOrdersByName",
    description:
      "Search orders by customer name. Use as fallback when getOrderByPhone finds nothing — customer may be calling from a different number. Always confirm identity before reading or updating any data.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Customer name or partial name to search for",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "lookupPrice",
    description:
      "Look up price for a specific garment item. Item name must match EXACTLY as stored in the pricing schedule (e.g. 'Shirt (dress)', 'Pants (casual)', 'Wedding Dress'). Call listAllPrices first if unsure of the exact name. Also returns special notes (e.g. 'Call for quote on heavily beaded').",
    input_schema: {
      type: "object",
      properties: {
        item: {
          type: "string",
          description:
            "Exact item name from pricing schedule e.g. 'Shirt (dress)', 'Suit (2-piece)'",
        },
        orderType: {
          type: "string",
          enum: ["Regular", "Expedited"],
          description: "Whether to get regular or expedited price",
        },
      },
      required: ["item", "orderType"],
    },
  },
  {
    name: "listAllPrices",
    description:
      "Return the full pricing schedule grouped by category with regular and expedited prices. Use when customer asks for a general price list or when you need to find the exact item name before calling lookupPrice.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "listPendingCallbacks",
    description:
      "Return all callback requests with STATUS = Pending. Staff-facing tool.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "appendOrderNote",
    description:
      "Append a note to an existing order. Use to record customer preferences, special handling instructions, or any information captured during the call. Previous notes are preserved.",
    input_schema: {
      type: "object",
      properties: {
        pageId: {
          type: "string",
          description:
            "Notion page ID from getOrderByPhone or getOrderById (the pageId field)",
        },
        note: {
          type: "string",
          description: "Text to append. Be specific and concise.",
        },
      },
      required: ["pageId", "note"],
    },
  },
  {
    name: "setOrderType",
    description:
      "Change order type between Regular and Expedited. When quoting expedited, always say the price then add: 'Expedited slots can fill up — would you like someone to call you back to confirm capacity?' If yes, call requestCallback. If no, proceed with this tool then call lookupPrice + updateOrderPrice.",
    input_schema: {
      type: "object",
      properties: {
        pageId: {
          type: "string",
          description:
            "Notion page ID from getOrderByPhone or getOrderById (the pageId field)",
        },
        orderType: {
          type: "string",
          enum: ["Regular", "Expedited"],
          description: "The new order type",
        },
      },
      required: ["pageId", "orderType"],
    },
  },
  {
    name: "updateTracker",
    description: "Update how far along an order is in the cleaning process.",
    input_schema: {
      type: "object",
      properties: {
        pageId: {
          type: "string",
          description:
            "Notion page ID from getOrderByPhone or getOrderById (the pageId field)",
        },
        stage: {
          type: "string",
          enum: [
            "Received",
            "Sorting",
            "Cleaning",
            "Pressing",
            "Ready for Pickup",
            "Delivered",
            "Cancelled",
          ],
          description: "Current stage of the order",
        },
      },
      required: ["pageId", "stage"],
    },
  },
  {
    name: "updatePayment",
    description:
      "Record or update payment. Set paymentDate to today in YYYY-MM-DD when marking as paid. Use null for paymentDate if setting method to Unpaid.",
    input_schema: {
      type: "object",
      properties: {
        pageId: {
          type: "string",
          description:
            "Notion page ID from getOrderByPhone or getOrderById (the pageId field)",
        },
        paymentMethod: {
          type: "string",
          enum: ["Cash", "Card", "Venmo", "Zelle", "Unpaid"],
          description: "How the customer paid",
        },
        paymentDate: {
          type: ["string", "null"],
          description:
            "Date paid in YYYY-MM-DD format, or null if not yet paid",
        },
      },
      required: ["pageId", "paymentMethod", "paymentDate"],
    },
  },
  {
    name: "updateGarmentType",
    description:
      "Set or correct the garment type. Use exact item name from pricing schedule. After updating, call lookupPrice then updateOrderPrice to sync the price.",
    input_schema: {
      type: "object",
      properties: {
        pageId: {
          type: "string",
          description:
            "Notion page ID from getOrderByPhone or getOrderById (the pageId field)",
        },
        garmentType: {
          type: "string",
          description:
            "Exact item name from pricing schedule e.g. 'Shirt (dress)', 'Suit (2-piece)'",
        },
      },
      required: ["pageId", "garmentType"],
    },
  },
  {
    name: "updateOrderPrice",
    description:
      "Update the price on an order. Always call after setOrderType or updateGarmentType — use the price returned by lookupPrice.",
    input_schema: {
      type: "object",
      properties: {
        pageId: {
          type: "string",
          description:
            "Notion page ID from getOrderByPhone or getOrderById (the pageId field)",
        },
        price: {
          type: "number",
          description: "New total price in dollars e.g. 24.99",
        },
      },
      required: ["pageId", "price"],
    },
  },
  {
    name: "updateOrderExpectedDate",
    description:
      "Update the expected pickup/delivery date when a customer is told a new date.",
    input_schema: {
      type: "object",
      properties: {
        pageId: {
          type: "string",
          description:
            "Notion page ID from getOrderByPhone or getOrderById (the pageId field)",
        },
        expectedDate: {
          type: "string",
          description: "New date in YYYY-MM-DD format e.g. 2025-05-20",
        },
      },
      required: ["pageId", "expectedDate"],
    },
  },
  {
    name: "requestCallback",
    description:
      "Log a callback request in the Callbacks database so staff can follow up. Use when: customer wants expedited capacity confirmed, item needs custom quote (e.g. heavily beaded wedding dress), or question needs staff answer. Always call this — don't just tell the customer someone will call.",
    input_schema: {
      type: "object",
      properties: {
        pageId: {
          type: "string",
          description:
            "Notion page ID from getOrderByPhone or getOrderById (the pageId field)",
        },
        customerName: {
          type: "string",
          description: "Customer's name for the callback record",
        },
        phone: {
          type: "string",
          description: "Phone number to call back",
        },
        orderId: {
          type: "string",
          description: "ORDER_ID value for reference",
        },
        reason: {
          type: "string",
          description:
            "Why the customer wants a callback e.g. 'Confirming expedited capacity for Suit (2-piece) pickup Friday'",
        },
      },
      required: ["pageId", "customerName", "phone", "orderId", "reason"],
    },
  },
  {
    name: "resolveCallback",
    description:
      "Mark a callback as handled. Use callbackId from listPendingCallbacks output.",
    input_schema: {
      type: "object",
      properties: {
        callbackId: {
          type: "string",
          description: "Notion page ID of the callback record",
        },
        status: {
          type: "string",
          enum: ["Called Back", "Resolved"],
          description:
            "Called Back = spoke to customer, Resolved = fully handled",
        },
      },
      required: ["callbackId", "status"],
    },
  },
  {
    name: "cancelOrder",
    description:
      "Mark an order as Cancelled. Always confirm with the customer before calling this — it cannot be undone by the voice agent.",
    input_schema: {
      type: "object",
      properties: {
        pageId: {
          type: "string",
          description:
            "Notion page ID from getOrderByPhone or getOrderById (the pageId field)",
        },
      },
      required: ["pageId"],
    },
  },
];
