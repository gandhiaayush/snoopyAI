# Charlie's Cleaners — AI Voice Agent
## Session Context for Fresh Starts

Read `README.md` for the full architecture. This file is the quicker operator handoff: current state, gotchas, and next moves.

---

## Current State (as of 2026-05-27)

**Branch:** `voice-agent`
**Active voice path:** Twilio Media Streams -> Express/WebSocket server -> OpenAI Realtime (`gpt-realtime-2` by default)
**Gemini code:** Still present under `src/services/gemini/*` as legacy reference code. Not the active media-stream path.
**Persistent voice host:** Railway config and deploy runbook are now in-repo. Service is not deployed yet.
**Dashboard:** Code exists (`src/dashboard.ts` + `public/index.html`) — Vercel deploy still needs end-to-end validation.
**Notion Worker pollers:** Code exists (`src/index.ts`) — not deployed yet.

### What is confirmed
- Inbound Twilio webhook + media-stream routing works structurally
- Owner vs consumer role detection still comes from Supabase `callers`
- All existing Notion tools remain wired through `callWorkerTool()`
- Clean hangup still uses the 3.5 second delay, then Twilio REST hangup
- Reconnect handling still buffers finalization for 8 seconds
- Callback escalation rules for expedite / schedule-exception requests are in the prompts and tool layer
- Supabase session operations now use `.throwOnError()` so failures surface instead of silently breaking the call
- Railway config now exists for the voice server: healthcheck, no sleep, single replica, deploy draining
- TypeScript check passes after the OpenAI Realtime migration work

### What still needs manual validation
- Live Twilio call against the OpenAI Realtime path
- Final voice choice and perceived latency tuning on a real phone call
- Railway deploy and Twilio Console cutover
- Notion Worker deployment (`ntn deploy`)
- Dashboard production validation

---

## File Map

| File | Role |
|------|------|
| `src/server.ts` | Express + WebSocket server entry point |
| `src/routes/voice.ts` | Creates call session and returns TwiML `<Connect><Stream>` |
| `src/routes/mediaStream.ts` | Active Twilio <-> OpenAI Realtime bridge |
| `src/routes/outbound.ts` | Twilio REST outbound call trigger |
| `src/routes/status.ts` | Twilio status callback |
| `src/services/openai/realtimeSession.ts` | Active OpenAI Realtime socket session, audio forwarding, tool loop |
| `src/services/openai/tools.ts` | Active Realtime function-tool schemas + dispatcher |
| `src/services/openai/systemPrompt.ts` | Active prompts for consumer, owner, and outbound calls |
| `src/services/gemini/liveSession.ts` | Legacy Gemini path kept for reference only |
| `src/services/gemini/tools.ts` | Legacy Gemini tool declarations |
| `src/services/gemini/systemPrompt.ts` | Legacy Gemini prompts |
| `src/services/notion/worker.ts` | All Notion reads/writes |
| `src/services/supabase/sessions.ts` | Session creation, lookup, completion, caller role |
| `src/index.ts` | Notion Worker pollers |
| `src/config.ts` | Zod-validated env config |

---

## Gotchas

**The active runtime is OpenAI Realtime, not Gemini.**
- `src/routes/mediaStream.ts` imports `src/services/openai/realtimeSession.ts`
- Gemini files are intentionally kept, but they are not the live voice path anymore

**Twilio and OpenAI now match on telephony codec.**
- Active path uses `g711_ulaw` / μ-law 8kHz directly
- The Gemini-only `audioConverter.ts` is still in the repo, but not used by the active call bridge

**Do not enable aggressive interruption by default.**
- `server_vad` is enabled
- `interrupt_response` is intentionally `false` to avoid background noise cutting the assistant off

**`OPENAI_REALTIME_MAX_OUTPUT_TOKENS` is optional.**
- Leave it blank unless you specifically want a response cap
- We intentionally avoided a low default cap because clipped spoken responses are worse than slightly longer ones

**Supabase is still required for session bootstrap.**
- If `createSession()` or `getSession()` fails, the call will fail before the model can speak
- Current code now surfaces these failures instead of swallowing them

**`NODE_ENV=development` skips Twilio signature validation.**
- Production host must run with `NODE_ENV=production`
- `TWILIO_WEBHOOK_BASE` must exactly match the public voice URL Twilio calls
- `TWILIO_WEBHOOK_BASE` is normalized to remove trailing slashes and must start with `https://` in production

**ngrok still changes the public URL on restart.**
- Update both `TWILIO_WEBHOOK_BASE` and `BASE_URL` in `.env`
- Restart nodemon after `.env` changes
- Update the Twilio console voice webhook to `https://<public-url>/voice`

**Outbound call context is passed through the Twilio webhook URL.**
- `src/routes/outbound.ts` calls Twilio REST with:
  `.../voice?outbound=true&customerName=...&orderId=...`
- `src/routes/voice.ts` stores that as outbound session context

**Railway is the selected persistent host for the voice server.**
- Run only the voice server there; dashboard and Notion Workers are separate deploys
- Railway injects `PORT`; do not set it manually unless debugging
- Keep one replica for now because reconnect handling is process-local
- Deployment runbook: `docs/voice-server-railway.md`

---

## Decisions In Force

| Decision | Why |
|----------|-----|
| OpenAI Realtime is the active voice engine | Better fit for the requested migration and direct Twilio `g711_ulaw` passthrough |
| Gemini code stays in the repo | User explicitly wanted it archived, not deleted |
| Conservative interruption policy | Avoid false barge-in from background phone noise |
| 3.5 second delayed hangup stays | Lets goodbye audio finish before the call is cut |
| 8 second reconnect window stays | Twilio reconnects quickly after temporary drops |
| Supabase remains the session store | Fast session bootstrap and audit logging |

---

## Next Steps

1. Live-test the OpenAI Realtime voice path by calling the Twilio number.
2. Tune voice and VAD only after hearing the real call behavior.
3. Deploy the Railway voice server and move Twilio off ngrok.
4. Deploy the Notion Worker pollers.
5. Validate dashboard production routes.
6. Consider latency improvements that move Notion off the hot path via Supabase cache / outbox, rather than adding a second synchronous agent hop.

---

## Local Run

```bash
npm run dev
# separate terminal:
ngrok http 3000
# update .env:
#   TWILIO_WEBHOOK_BASE=https://<new-url>
#   BASE_URL=https://<new-url>
# restart nodemon after .env changes
# update Twilio voice webhook:
#   https://<new-url>/voice
```

**Owner phone:** `OWNER_PHONE_NUMBER` in `.env`

**Manual outbound trigger:**
```bash
curl -X POST http://localhost:3000/outbound \
  -H "Content-Type: application/json" \
  -d '{"phone":"+1XXXXXXXXXX","customerName":"John Smith","orderId":"ORD-0010"}'
```
