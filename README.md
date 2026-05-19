# Charlie's Cleaners — AI Voice Agent + Owner Dashboard

> **A phone number that thinks.** Customers call to place and check dry cleaning orders. The owner gets a live dashboard to manage everything. Every interaction writes directly to Notion in real time.

**Demo:**

[![Demo Video](https://img.youtube.com/vi/XOXFFaRLPxI/maxresdefault.jpg)](https://youtu.be/XOXFFaRLPxI)

---

## What It Does

One Twilio phone number handles two caller types:

| Caller | Experience |
|--------|------------|
| **Customer** | Place a new order, check status, cancel, request expediting — all by speaking naturally |
| **Owner** | Get a full rundown of the day's orders, make updates, hear about callbacks needed |

While the caller is speaking, Claude processes their intent and writes the result to a Notion database. By the time the call ends, the order is already live in Notion — no manual data entry, no forms.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        INBOUND CALL FLOW                            │
│                                                                     │
│   Customer/Owner                                                    │
│   calls +1 (925) 515-5725                                          │
│           │                                                         │
│           ▼                                                         │
│   ┌───────────────┐    TwiML     ┌─────────────────────────────┐   │
│   │    Twilio     │ ──────────── │   Express API  (Vercel)     │   │
│   │  (STT / TTS)  │ ◄─────────── │   POST /voice  /gather      │   │
│   └───────────────┘  SpeechResult│   POST /status              │   │
│                                  └──────────┬──────────────────┘   │
│                                             │                       │
│                              ┌──────────────▼──────────────────┐   │
│                              │   Claude claude-haiku-4-5        │   │
│                              │   Tool-use loop (max 15 turns)   │   │
│                              │   System prompt + 15 tools       │   │
│                              └──────────────┬──────────────────┘   │
│                                             │ tool calls            │
│                              ┌──────────────▼──────────────────┐   │
│                              │        Notion API               │   │
│                              │  Orders DB · Pricing DB         │   │
│                              │  Callbacks DB · Call Log DB     │   │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                     BACKGROUND AUTOMATION                           │
│                                                                     │
│   ┌──────────────────────────────────────────────────────────┐     │
│   │              Notion Worker  (src/index.ts)                │     │
│   │                                                           │     │
│   │   callbackPoller  ──── every 2 min ──► scan Callbacks DB │     │
│   │        │                               auto-dial customer │     │
│   │        └─────────────────────────────► log to Call Log   │     │
│   │                                                           │     │
│   │   pickupPoller  ────── every 10 min ──► scan Orders DB   │     │
│   │        │                               find "Ready"       │     │
│   │        └─────────────────────────────► auto-dial pickup  │     │
│   └──────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                       OWNER DASHBOARD                               │
│                                                                     │
│   Browser  ──► GET / ──► public/index.html  (Vercel static)        │
│                                                                     │
│   Dashboard API  (src/dashboard.ts on Vercel)                      │
│     POST /api/auth          →  validate DASHBOARD_TOKEN            │
│     GET  /api/orders        →  Notion Orders DB query              │
│     GET  /api/stats         →  live counts (open/unpaid/callbacks) │
│     PATCH /api/orders/:id/* →  update stage / payment / note …    │
│     POST /api/ai            →  Claude agent, natural-language edits│
└─────────────────────────────────────────────────────────────────────┘
```

---

## How Notion Powers Everything

Notion is not just a data store here — it is the **single source of truth** for the entire operation. Every part of the system reads from and writes to Notion databases directly.

### Databases

| Database | Purpose | Written by | Read by |
|----------|---------|-----------|--------|
| **Orders** | Every dry cleaning order: customer, garment, stage, price, payment, notes | Voice agent (Claude tools), Owner dashboard AI | Voice agent, Dashboard, Worker pollers |
| **Pricing** | Per-garment prices for Regular and Expedited | Manual / owner | Voice agent (`lookupPrice`), Dashboard |
| **Callbacks** | Customers who requested a callback | Voice agent (`requestCallback`) | Worker `callbackPoller` every 2 min |
| **Callback Call Log** | Managed log of every auto-dialed callback attempt | Notion Worker | Dashboard Callbacks tab |

### Notion Worker — Automated Pollers

The `src/index.ts` file is a **Notion Worker** — a serverless function that runs on Notion's infrastructure and has direct, low-latency access to Notion databases via the `@notionhq/workers` SDK.

```
callbackPoller  (every 2 min)
  → queries Callbacks DB for unresolved entries
  → dials the customer via Twilio outbound call
  → writes result (Called / Failed) to Call Log DB

pickupPoller  (every 10 min)
  → queries Orders DB for stage = "Ready for Pickup"
  → dials customer to notify order is ready
  → logs the attempt
```

This means **no customer has to wonder if their order is ready** — the system calls them automatically.

### Claude Tool Calls → Notion Writes

During a live phone call, Claude does not generate free-form text. It calls typed tools that map directly to Notion API operations:

```
Customer: "I'd like to drop off a suit for dry cleaning, I need it by Friday."
                              │
                              ▼ Claude calls:
         createOrder({ customerName, phone, garmentType: "Suit",
                       orderType: "Regular", expectedDate: "2026-05-22" })
                              │
                              ▼ Notion API:
         pages.create({ parent: { database_id: ORDERS_DB },
                        properties: { ORDER_ID, CUSTOMER_NAME, ORDER_PHONE,
                                      GARMENT_TYPE, EXPECTED_DATE, OPEN: "OPEN" } })
                              │
                              ▼ Twilio TTS reads back:
         "Got it — suit order created for Friday. Your order number is DCL-2843."
```

The entire round-trip — speech → Claude → Notion write → spoken confirmation — happens within a single `<Gather>` timeout window.

---

## Claude Tools (15 total)

| Tool | What it does |
|------|-------------|
| `getOrderByPhone` | Look up all orders for a caller's phone number |
| `getOrderById` | Retrieve a specific order by ORDER_ID |
| `searchOrdersByName` | Fallback search by customer name |
| `lookupPrice` | Get price for garment type × order type |
| `listAllPrices` | Return full pricing schedule |
| `updateTracker` | Advance order through: Received → Sorting → Cleaning → Pressing → Ready → Delivered |
| `updatePayment` | Record payment method (Cash / Card / Venmo / Zelle) + date |
| `updateGarmentType` | Correct garment type on an order |
| `updateOrderPrice` | Override the price |
| `updateOrderExpectedDate` | Change pickup/delivery date |
| `setOrderType` | Switch Regular ↔ Expedited |
| `appendOrderNote` | Append to the order notes field |
| `requestCallback` | Log callback request + reason in Callbacks DB |
| `cancelOrder` | Mark order Cancelled |
| `triggerPickupCall` | Manually trigger an outbound pickup notification call |

---

## Owner Dashboard

A single-page app deployed on Vercel. No framework — plain HTML/JS served as a static file, calling a Node.js Express backend.

**Tabs:**
- **Orders** — full orders table with filters (status, stage, garment, payment, date range, text search). Click any row to open a side drawer with inline editing for every field.
- **Revenue** — daily / weekly / monthly totals, revenue by payment method, revenue by garment type, recent paid orders.
- **Needs Attention** — overdue orders and pending callbacks surfaced in one place with one-click actions.
- **Insights** — stage distribution, garment mix, avg turnaround time, payment health.

**AI Ask panel** (`⌘K` or the Ask AI button):
Type anything in plain English. Claude reads the live Notion database and can write changes back directly:

```
"Mark Angela Torres' coat as Ready for Pickup"
→ searches Orders DB for Angela Torres
→ PATCH TRACKER_STAGE = "Ready for Pickup"
→ "Done — #DCL-2838 is now Ready for Pickup."

"New order: Maria Garcia, dress, expedited, $27, due May 20"
→ creates a new Notion page in Orders DB
→ "Created #DCL-2843 for Maria Garcia."

"Who still owes payment?"
→ searches Orders DB for PAYMENT_METHOD = Unpaid
→ returns formatted list with amounts
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Phone / STT / TTS | [Twilio Voice](https://www.twilio.com/docs/voice) + `<Gather>` |
| AI inference | [Anthropic claude-haiku-4-5](https://docs.anthropic.com/en/docs/about-claude/models) |
| Database | [Notion](https://developers.notion.com/) — Orders, Pricing, Callbacks, Call Log |
| Background automation | [Notion Workers](https://developers.notion.com/docs/workers) |
| Voice API server | Node.js + Express (TypeScript) |
| Dashboard API | Express on [Vercel](https://vercel.com) serverless |
| Dashboard UI | Vanilla HTML/CSS/JS (no build step) |
| Auth | Bearer token (`DASHBOARD_TOKEN`) |

---

## Project Structure

```
notionbrain/
├── src/
│   ├── index.ts          # Notion Worker — callbackPoller + pickupPoller + all tools
│   └── dashboard.ts      # Express API — all /api/* dashboard routes
├── public/
│   └── index.html        # Owner dashboard SPA (vanilla JS, no framework)
├── tools.json            # Claude tool definitions (15 tools, Anthropic schema)
├── vercel.json           # Vercel routing — static HTML + Node functions
├── tsconfig.json
└── package.json
```

---

## Environment Variables

```bash
# Twilio
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+1...
TWILIO_WEBHOOK_BASE=https://your-deployment.vercel.app

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Notion
NOTION_API_KEY=secret_...
ORDERS_DATA_SOURCE_ID=       # ntn datasources resolve <orders-db-id>
PRICING_DATA_SOURCE_ID=      # ntn datasources resolve <pricing-db-id>
CALLBACKS_DATA_SOURCE_ID=    # ntn datasources resolve <callbacks-db-id>

# Dashboard
DASHBOARD_TOKEN=             # openssl rand -hex 32
DASHBOARD_ORIGIN=            # optional: deployed URL for CORS

# Business
OWNER_PHONE_NUMBER=+1...
OWNER_NAME=Charlie
```

---

## Deploying

**Voice agent + Dashboard API:**
```bash
vercel deploy
# Sets TWILIO_WEBHOOK_BASE in your Twilio console to: https://your-app.vercel.app
```

**Notion Worker (pollers):**
```bash
npm install -g @notionhq/workers-cli
ntn workers env push        # push .env vars to Worker runtime
ntn deploy                  # deploy callbackPoller + pickupPoller
```

**Local development:**
```bash
cp .env.example .env        # fill in credentials
npx tsx src/dashboard.ts    # dashboard API on :3000
ngrok http 3000             # expose for Twilio webhooks
```

---

## Call Flow

```
1. Caller dials +1 (925) 515-5725
2. Twilio POST /voice  →  Express checks From number
   - Owner number?  →  owner system prompt
   - Anyone else?   →  customer system prompt
3. TwiML <Gather> reads greeting, listens for speech
4. Caller speaks  →  Twilio POST /gather with SpeechResult
5. Express runs Claude tool-use loop:
   - Confidence < 0.4?  →  return clarify TwiML, skip Claude
   - Goodbye detected?  →  return hangup TwiML, skip Claude
   - Otherwise: Claude picks tool(s), Express executes against Notion
6. Claude returns text response  →  TwiML <Say> reads it aloud
7. Loop continues until hangup or max turns (15)
8. POST /status  →  session archived to Supabase
```

---

## Why Notion

Most AI voice agents use a traditional database (Postgres, DynamoDB) as the backend. This project uses Notion for three reasons:

1. **The owner already lives in Notion.** The orders table is visible in real time on any device — no custom admin UI is needed just to see what came in.
2. **Notion Workers = zero-infra automation.** The callback and pickup pollers run *inside* Notion's infrastructure, with direct low-latency data source access — no separate cron server needed.
3. **Schema changes are instant.** Adding a new property to the Orders database takes 10 seconds in Notion and zero code changes — the agent just starts using it.

---

*Built for the Notion Hackathon 2026.*
