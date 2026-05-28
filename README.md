# Snoopy AI — AI Voice Agent + Owner Dashboard

> **A phone number that thinks.** Customers call to place and check dry cleaning orders. The owner gets a live dashboard to manage everything. Every interaction writes directly to Notion in real time.

---

## What It Does

One Twilio phone number handles two caller types:

| Caller | Experience |
|--------|------------|
| **Customer** | Check order status, ask about expedited timing, request schedule exceptions, add notes, and create callbacks — all by speaking naturally |
| **Owner** | Full rundown of orders, make updates, trigger pickup calls, manage callbacks — all by voice |

While the caller is speaking, OpenAI Realtime processes the audio, calls tools against the Notion workflow, and streams voice back over Twilio Media Streams. By the time the call ends, the order is already updated in Notion — no manual data entry, no forms.

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
│   ┌───────────────┐  <Connect>   ┌─────────────────────────────┐   │
│   │    Twilio     │ ──Stream──►  │   Express Voice Server      │   │
│   │  (phone/RTP)  │ ◄──audio──   │   POST /voice               │   │
│   └───────────────┘              │   WS   /media-stream        │   │
│          │                       └──────────┬──────────────────┘   │
│    μ-law 8kHz                               │                       │
│    WebSocket frames                         │ μ-law 8kHz            │
│                              ┌──────────────▼──────────────────┐   │
│                              │   OpenAI Realtime               │   │
│                              │   (gpt-realtime-2 default)      │   │
│                              │   Real-time audio-in / audio-out │   │
│                              │   Tool declarations + dispatch   │   │
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
│   │        │                               find Approved      │     │
│   │        └─────────────────────────────► auto-dial customer │     │
│   │                                        log to Call Log   │     │
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
│     POST /api/dashboard/auth          →  validate DASHBOARD_TOKEN  │
│     GET  /api/dashboard/orders        →  Notion Orders DB query    │
│     GET  /api/dashboard/stats         →  live counts               │
│     PATCH /api/dashboard/orders/:id/* →  update any field          │
│     POST /api/dashboard/callbacks/:id/call → trigger outbound call │
└─────────────────────────────────────────────────────────────────────┘
```

---

## How Notion Powers Everything

Notion is the **single source of truth** for the entire operation.

### Databases

| Database | Purpose | Written by | Read by |
|----------|---------|-----------|--------|
| **Orders** | Every dry cleaning order: customer, garment, stage, price, payment, notes | Voice agent tools, Owner dashboard | Voice agent, Dashboard, Worker pollers |
| **Pricing** | Per-garment prices for Regular and Expedited | Manual / owner | Voice agent (`lookupPrice`), Dashboard |
| **Callbacks** | Customers who requested a callback | Voice agent (`requestCallback`), Dashboard | Worker `callbackPoller` every 2 min |
| **Callback Call Log** | Managed log of every auto-dialed callback attempt | Notion Worker | Dashboard Callbacks tab |

### Notion Worker — Automated Pollers

`src/index.ts` is the **Notion Worker** — deployed to Notion's infrastructure via `ntn deploy`. Two pollers run inside Notion with direct low-latency data source access.

```
callbackPoller  (every 2 min)
  → queries Callbacks DB for STATUS = "Approved"
  → dials the customer via Twilio outbound call
  → marks "Called Back" on success; appends failure note + retries up to 3×
  → logs to Callback Call Log DB

pickupPoller  (every 10 min)
  → queries Orders DB for TRACKER_STAGE = "Ready for Pickup"
  → skips orders already notified (NOTES contains "📱 Pickup reminder sent")
  → dials customer, stamps NOTES with reminder sent date
```

### Callback Approval Flow

```
Customer calls → says they need a callback
  → AI calls requestCallback() → Notion Callbacks DB: STATUS = "Pending"

Owner sees it in dashboard → clicks Approve
  → STATUS = "Approved"

callbackPoller fires (≤2 min later)
  → finds Approved entry → dials via Twilio
  → STATUS = "Called Back"
```

The same callback flow is also used when the agent cannot guarantee an answer from tool data, such as expedited turnaround confirmation, same-day timing, or pickup-time exceptions.

---

## Voice Agent — How It Works

### Real-Time Audio Pipeline

```
Twilio                   Voice Server            OpenAI Realtime
  │   μ-law 8kHz frame      │                          │
  │ ────────────────────►   │  g711_ulaw passthrough   │
  │                         │ ─────────────────────►   │
  │                         │                          │ processes audio
  │                         │  g711_ulaw response      │
  │                         │ ◄─────────────────────   │
  │   μ-law 8kHz frame      │                          │
  │ ◄────────────────────   │                          │
```

OpenAI Realtime listens and speaks in real time. When it decides to call a tool, the server executes the request against the existing Notion workflow, sends a `function_call_output` back into the Realtime session, and the model continues the conversation with the result.

### Opening Cue System

On `start` event from Twilio, the server sends the Realtime session a text cue:
- **Inbound customer**: `"[Call connected. Say exactly: 'Hey, this is Charlie's Cleaners — how can I help you today?']"`
- **Inbound owner**: opens with greeting, waits for command
- **Outbound pickup call**: `"[Say exactly: 'Hey, this is Charlie's Cleaners — is this {name}? Your order {id} is ready for pickup!']"`
- **Wi-Fi reconnect** (session age > 8s): `"[Call reconnected. Do NOT re-introduce yourself. Say: 'Sorry about that — we got disconnected. Where were we?']"`

### hangUp Tool

When the conversation ends, the Realtime model calls `hangUp`. The server:
1. Waits 3.5 seconds for goodbye audio to play
2. Calls Twilio REST API: `calls(callSid).update({ status: "completed" })`
3. Runs `completeSession()` → writes audit log to Supabase

---

## Tool Sets

### Consumer Tools (9)

| Tool | What it does |
|------|-------------|
| `getOrderByPhone` | Look up orders by caller's phone — tries 6 phone format variants |
| `getOrderById` | Look up by ORDER_ID (e.g. "ORD-0010") |
| `searchOrdersByName` | Partial name match — fallback when phone lookup fails |
| `lookupPrice` | Get price for garment × order type |
| `listAllPrices` | Full pricing schedule |
| `appendOrderNote` | Add note to an order |
| `setOrderType` | Switch Regular ↔ Expedited |
| `requestCallback` | Log callback request in Callbacks DB; can auto-fill customer details from a loaded order |
| `hangUp` | End the call cleanly |

### Owner Tools (18)

All consumer tools, plus:

| Tool | What it does |
|------|-------------|
| `cancelOrder` | Mark order Cancelled |
| `updateTracker` | Advance stage: Received → Sorting → Cleaning → Pressing → Ready → Delivered |
| `updatePayment` | Record payment method (Cash / Card / Venmo / Zelle / Unpaid) + date |
| `updateGarmentType` | Correct garment type |
| `updateOrderPrice` | Override price |
| `updateOrderExpectedDate` | Change pickup/delivery date |
| `listPendingCallbacks` | See all Pending callbacks |
| `resolveCallback` | Mark callback Called Back or Resolved |
| `triggerPickupCall` | Manually trigger outbound pickup notification |

---

## Owner Dashboard

Single-page app deployed on Vercel. Vanilla HTML/JS — no framework, no build step.

**Dashboard API prefix:** `/api/dashboard/*`

| Endpoint | Action |
|---------|--------|
| `POST /auth` | Validate `DASHBOARD_TOKEN` |
| `GET /orders` | List orders with filters (status, stage, garment, payment, date range, text search) |
| `GET /orders/:id` | Single order |
| `GET /stats` | Live counts (open, expedited, unpaid, callbacks) |
| `GET /prices` | Full pricing schedule |
| `GET /callbacks` | Active callbacks (Pending + Approved) |
| `GET /urgent` | Overdue orders + Ready for Pickup |
| `GET /calls` | Call log from Notion managed DB |
| `PATCH /orders/:id/tracker` | Update stage |
| `PATCH /orders/:id/payment` | Record payment |
| `PATCH /orders/:id/note` | Append note |
| `PATCH /orders/:id/garment` | Update garment type |
| `PATCH /orders/:id/price` | Update price |
| `PATCH /orders/:id/type` | Update order type |
| `PATCH /orders/:id/date` | Update expected date |
| `PATCH /orders/:id/phone` | Update phone number |
| `PATCH /orders/:id/callback` | Create callback record from dashboard |
| `POST /orders` | Create new order |
| `POST /orders/:id/call` | Trigger outbound call directly from order drawer |
| `POST /callbacks/:id/call` | Trigger outbound callback call immediately |
| `PATCH /callbacks/:id/phone` | Edit phone before approving |
| `POST /callbacks/:id/approve` | Pending → Approved |
| `POST /callbacks/:id/resolve` | Mark Resolved |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Phone / call routing | [Twilio Voice](https://www.twilio.com/docs/voice) — `<Connect><Stream>` WebSocket |
| AI voice model | [OpenAI Realtime](https://developers.openai.com/api/docs/guides/realtime) (`gpt-realtime-2` default, `gpt-realtime` fallback if needed) |
| Audio codec | Direct Twilio `g711_ulaw` / μ-law 8kHz passthrough |
| Notion tool execution | `@notionhq/client` (direct REST) |
| Background automation | `@notionhq/workers` (Notion Worker pollers) |
| Session / audit store | [Supabase](https://supabase.com) — `call_sessions`, `audit_logs`, `callers` |
| Voice API server | Node.js + Express (TypeScript) — persistent host required |
| Dashboard API | Express on [Vercel](https://vercel.com) serverless |
| Dashboard UI | Vanilla HTML/CSS/JS (no build step) |
| Auth | Bearer token (`DASHBOARD_TOKEN`) |
| Config validation | Zod |

---

## Project Structure

```
charlie-cleaners/
├── src/
│   ├── server.ts                      # Express + WebSocket server entry point
│   ├── config.ts                      # Zod-validated env config
│   ├── dashboard.ts                   # Vercel dashboard API (all /api/dashboard/* routes)
│   ├── routes/
│   │   ├── voice.ts                   # POST /voice — session init, TwiML <Connect><Stream>
│   │   ├── mediaStream.ts             # WS /media-stream — Twilio ↔ OpenAI Realtime audio bridge
│   │   ├── outbound.ts                # POST /outbound — trigger outbound call via Twilio REST
│   │   └── status.ts                  # POST /status — Twilio call status webhook
│   ├── middleware/
│   │   └── twilioValidate.ts          # Validates Twilio request signature (skipped in dev)
│   ├── services/
│   │   ├── openai/
│   │   │   ├── realtimeSession.ts     # Active OpenAI Realtime session + tool loop
│   │   │   ├── tools.ts               # Active tool schema for Realtime function calling
│   │   │   └── systemPrompt.ts        # Active prompts for consumer / owner / outbound calls
│   │   ├── gemini/
│   │   │   ├── liveSession.ts         # Legacy Gemini session code kept for reference
│   │   │   ├── tools.ts               # Legacy Gemini tool declarations
│   │   │   ├── systemPrompt.ts        # Legacy Gemini prompts
│   │   │   └── audioConverter.ts      # Legacy codec bridge used only by Gemini path
│   │   ├── notion/
│   │   │   └── worker.ts              # callWorkerTool() — all Notion reads/writes
│   │   └── supabase/
│   │       └── sessions.ts            # createSession, getSession, completeSession, getCallerRole
│   └── utils/
│       ├── twiml.ts                   # buildStreamTwiml(), buildHangupTwiml()
│       └── phone.ts                   # normalizePhone()
├── src/index.ts                       # Notion Worker — callbackPoller + pickupPoller + tools
├── public/
│   └── index.html                     # Owner dashboard SPA (vanilla JS)
├── vercel.json                        # Vercel routing — static HTML + Node function
├── tsconfig.json
├── nodemon.json                       # Dev: watch src/, run tsx src/server.ts
└── package.json
```

---

## Environment Variables

```bash
# Twilio
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+1...
TWILIO_WEBHOOK_BASE=https://your-voice-server-url  # voice server URL; no trailing slash

# OpenAI
OPENAI_API_KEY=sk-...
OPENAI_REALTIME_MODEL=gpt-realtime-2
OPENAI_REALTIME_VOICE=marin
OPENAI_REALTIME_MAX_OUTPUT_TOKENS=        # optional; leave blank unless you want a cap
OPENAI_REALTIME_VAD_SILENCE_MS=450

# Gemini (optional; legacy code path retained, not active)
GEMINI_API_KEY=AIza...

# Anthropic (optional; reserved, not currently used by voice agent)
ANTHROPIC_API_KEY=sk-ant-...

# Notion
NOTION_API_KEY=ntn_...
ORDERS_DATA_SOURCE_ID=       # ntn datasources resolve <orders-db-id>
PRICING_DATA_SOURCE_ID=      # ntn datasources resolve <pricing-db-id>
CALLBACKS_DATABASE_ID=       # raw Notion DB ID (for @notionhq/client pages.create)
CALLBACKS_DATA_SOURCE_ID=    # ntn datasources resolve <callbacks-db-id>  ← different from DATABASE_ID
ARCHIVE_DATA_SOURCE_ID=      # ntn datasources resolve <archive-db-id>

# Supabase (service role key only — never expose anon key server-side)
SUPABASE_URL=https://...supabase.co
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...

# Dashboard
DASHBOARD_TOKEN=             # openssl rand -hex 32

# Business
OWNER_PHONE_NUMBER=+1...     # this phone number gets OWNER_TOOLS; all others get CONSUMER_TOOLS
OWNER_NAME=Charlie           # used in system prompts

# Limits
MAX_TURNS_PER_CALL=15
NODE_ENV=development         # set to production on real host — enables Twilio signature validation
```

---

## Deploying

**Voice server (requires persistent host — NOT Vercel):**
```bash
# Recommended production host: Railway
npm run build
npm start
```

Production deployment is documented in [`docs/voice-server-railway.md`](docs/voice-server-railway.md). The Railway service uses the root `railway.json`, runs one persistent replica, disables app sleeping, checks `/health`, and expects Railway to inject `PORT`.

For production, set `NODE_ENV=production` and set `TWILIO_WEBHOOK_BASE` to the exact Railway HTTPS domain with no trailing slash. Do not set `BASE_URL` for the voice server; the code uses `TWILIO_WEBHOOK_BASE`.

```bash
# Local dev with ngrok
npm run dev
ngrok http 3000
# Set TWILIO_WEBHOOK_BASE to the ngrok URL
# Set that URL as your Twilio voice webhook
```

If calls connect and then go silent before the model speaks, verify `SUPABASE_URL` points to a real, resolvable Supabase project hostname and that `OPENAI_API_KEY` is valid for the Realtime API. Session creation now fails fast and `/voice` returns a spoken fallback instead of silently dropping the media stream when Supabase is unreachable.

**Dashboard (Vercel):**
```bash
vercel deploy
# TWILIO_WEBHOOK_BASE must point to your voice server, not this Vercel deploy
```

**Notion Worker (pollers):**
```bash
npm install -g @notionhq/workers-cli
ntn workers env push        # push .env vars to Worker runtime
ntn deploy                  # deploy callbackPoller + pickupPoller
```

---

## Call Flow

```
1. Caller dials +1 (925) 515-5725
2. Twilio POST /voice  →  Express checks From number against Supabase callers table
   - Owner number?  →  owner system prompt + OWNER_TOOLS (18)
   - Anyone else?   →  consumer system prompt + CONSUMER_TOOLS (9)
3. TwiML <Connect><Stream> sent — Twilio opens WebSocket to /media-stream
4. Server opens OpenAI Realtime session with system prompt + tools
5. Server sends opening cue → model speaks greeting
6. Caller speaks → Twilio sends μ-law 8kHz frames → server forwards `g711_ulaw` audio directly to OpenAI Realtime
7. OpenAI Realtime streams `g711_ulaw` audio back → Twilio → caller
8. Model calls tools → server executes against Notion API → `function_call_output` sent back to Realtime
9. Model calls `hangUp` → server waits 3.5s → Twilio REST hangup → `completeSession()`
10. POST /status (Twilio callback) → fallback session completion
```

---

## Why OpenAI Realtime

Most voice agents use a pipeline: STT → LLM text → TTS. This project uses OpenAI Realtime's native speech-to-speech mode:

1. **No STT/TTS round-trip** — the model processes audio directly and responds in audio.
2. **Direct Twilio codec match** — Twilio μ-law can pass straight through as `g711_ulaw`, which removes the old resample / transcode hop from the hot path.
3. **Reliable tool use in conversation** — the model can call Notion tools during the voice session and continue speaking after the tool result arrives.

The current session is intentionally conservative about interruptions:

1. `server_vad` is enabled for turn detection.
2. `interrupt_response` is disabled so background noise is less likely to cut off the assistant mid-sentence.
3. `OPENAI_REALTIME_MAX_OUTPUT_TOKENS` is optional instead of hard-capped by default.

---

*Built for the Notion Hackathon 2026.*
