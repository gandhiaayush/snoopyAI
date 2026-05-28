# Voice Server Deployment on Railway

This deploys only the persistent Twilio voice server:

- `POST /voice`
- `WS /media-stream`
- `POST /status`
- `POST /outbound`
- `GET /health`

The dashboard and Notion Worker pollers are separate deploys. Do not point Twilio voice traffic at Vercel.

## Recommendation

Use Railway for the voice server.

Why:

- The voice server is a long-lived Node/Express process with a WebSocket upgrade path.
- Railway provides a stable public HTTPS domain and injects `PORT`.
- The repo has `railway.json` with build, start, healthcheck, single-replica, no-sleep, and deploy-draining settings.
- Vercel Functions do not act as WebSocket servers.
- Render is viable on a paid web service, but free Render services can spin down when idle, which is unsafe for inbound calls.

Run exactly one Railway replica for now. Active Twilio/OpenAI Realtime call state is process-local, and reconnect handling is only reliable within a single service instance.

## Required Railway Variables

Set these on the Railway service. Do not commit real values.

```bash
NODE_ENV=production

TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+1...
TWILIO_WEBHOOK_BASE=https://<your-railway-domain>

OPENAI_API_KEY=sk-...
OPENAI_REALTIME_MODEL=gpt-realtime-2
OPENAI_REALTIME_VOICE=marin
OPENAI_REALTIME_VAD_SILENCE_MS=450
# Optional; omit or leave blank unless you want a hard cap:
OPENAI_REALTIME_MAX_OUTPUT_TOKENS=

NOTION_API_KEY=ntn_...
ORDERS_DATA_SOURCE_ID=...
PRICING_DATA_SOURCE_ID=...
CALLBACKS_DATABASE_ID=...
CALLBACKS_DATA_SOURCE_ID=...
ARCHIVE_DATA_SOURCE_ID=...

SUPABASE_URL=https://...supabase.co
SUPABASE_SERVICE_ROLE_KEY=...

OWNER_PHONE_NUMBER=+1...
OWNER_NAME=Charlie
MAX_TURNS_PER_CALL=15
```

Important:

- Do not set `PORT` on Railway unless debugging. Railway injects it.
- `TWILIO_WEBHOOK_BASE` must be the exact public voice-server origin, with `https://` and no trailing slash.
- `BASE_URL` is not used by the voice server.
- `GEMINI_API_KEY` and `ANTHROPIC_API_KEY` are optional for this deploy because the active voice path is OpenAI Realtime. Gemini code remains in the repo as legacy reference.

## Railway Setup

1. Create a new Railway project or service from this GitHub repo.
2. Confirm Railway is using the root `railway.json`.
3. Add the variables above in the Railway service Variables tab.
4. Generate a Railway public domain under Networking.
5. Set `TWILIO_WEBHOOK_BASE` to that exact domain, for example:

   ```bash
   TWILIO_WEBHOOK_BASE=https://charlies-cleaners-voice.up.railway.app
   ```

6. Deploy the service.
7. Verify:

   ```bash
   curl https://<your-railway-domain>/health
   ```

   Expected response includes:

   ```json
   {
     "status": "ok",
     "nodeEnv": "production",
     "websocketPath": "/media-stream"
   }
   ```

## Twilio Console Changes

After Railway is live and `/health` passes:

1. Open the Twilio Console phone number used for Charlie's Cleaners.
2. Under Voice configuration, set "A call comes in" to:

   ```text
   https://<your-railway-domain>/voice
   ```

3. Set method to `POST`.
4. If a status callback is configured, use:

   ```text
   https://<your-railway-domain>/status
   ```

5. Save the phone number config.

Only place a controlled test call after approval. Use the owner phone first so owner-role routing can be verified.

## Verification Before Live Calls

Run locally before pushing/deploying:

```bash
npm run check
npm run build
env PORT=3101 npm start
curl -sS http://127.0.0.1:3101/health
```

After `npm run build`, verify the generated TwiML still streams to the production WebSocket path without calling `/voice` or touching Supabase:

```bash
node -e "console.log(require('./dist/utils/twiml').buildStreamTwiml())"
```

The stream URL should be `wss://<TWILIO_WEBHOOK_BASE-host>/media-stream`. A real `/voice` request also creates a Supabase call session, so do not use fake `/voice` requests against production credentials.

## Production Risks

- `NODE_ENV=production` enables Twilio request signature validation. `TWILIO_WEBHOOK_BASE` must exactly match the Twilio-configured URL origin.
- WebSocket connections can still drop during host maintenance or deploys. The server now closes sockets with code `1012` during shutdown and keeps the existing 8 second reconnect buffer.
- Run one replica until session handoff is externalized beyond the current Supabase bootstrap and in-process reconnect map.
- Railway healthchecks validate startup readiness only. Use Railway logs/metrics or an external uptime monitor for continuous monitoring.
