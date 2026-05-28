import WebSocket from "ws";
import twilio from "twilio";
import { config } from "../config";
import { getSession, completeSession } from "../services/supabase/sessions";
import { openRealtimeSession, RealtimeHandle } from "../services/openai/realtimeSession";

interface TwilioFrame {
  event: string;
  streamSid?: string;
  start?: { callSid: string; streamSid: string };
  media?: { payload: string };
  stop?: { callSid: string };
}

// Track pending finalizations so a Wi-Fi reconnect can cancel them
const pendingFinalizations = new Map<string, ReturnType<typeof setTimeout>>();

async function hangUpCall(callSid: string): Promise<void> {
  try {
    const client = twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);
    await client.calls(callSid).update({ status: "completed" });
  } catch (err) {
    console.error(`[${callSid}] Twilio hangup failed:`, err);
  }
}

export function handleMediaStream(ws: WebSocket): void {
  let callSid: string | null = null;
  let streamSid: string | null = null;
  let realtime: RealtimeHandle | null = null;
  let completed = false;

  async function finalize() {
    if (completed || !callSid) return;
    completed = true;
    pendingFinalizations.delete(callSid);
    realtime?.close();
    await completeSession(callSid, realtime?.actionsTaken ?? []).catch((err) =>
      console.error(`[${callSid}] completeSession error:`, err)
    );
  }

  ws.on("message", async (raw: Buffer) => {
    let frame: TwilioFrame;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (frame.event === "start" && frame.start) {
      callSid = frame.start.callSid;
      streamSid = frame.start.streamSid;

      // Cancel any pending finalization from a prior disconnect (Wi-Fi reconnect)
      const pending = pendingFinalizations.get(callSid);
      if (pending) {
        clearTimeout(pending);
        pendingFinalizations.delete(callSid);
      }

      const session = await getSession(callSid).catch((err) => {
        console.error(`[${callSid}] failed to load session:`, err);
        return null;
      });
      if (!session) {
        console.error(`[${callSid}] session not found — closing`);
        ws.close();
        return;
      }

      // Detect reconnect: session existed and was already interacted with
      const sessionAgeMs = Date.now() - new Date(session.created_at as string).getTime();
      const isResume = sessionAgeMs > 8000;

      realtime = await openRealtimeSession(
        session.caller_role,
        session.caller_phone,
        (base64Mulaw) => {
          if (ws.readyState === WebSocket.OPEN && streamSid) {
            ws.send(
              JSON.stringify({ event: "media", streamSid, media: { payload: base64Mulaw } })
            );
          }
        },
        (err) => {
          console.error(`[${callSid}] OpenAI Realtime error:`, err.message);
          ws.close();
        },
        session.outbound_context ?? undefined,
        // onClose: model session closed unexpectedly - hang up via Twilio REST API
        () => {
          if (!completed && callSid) {
            setTimeout(async () => {
              await finalize();
              await hangUpCall(callSid!);
            }, 500);
          }
        },
        // onHangup: AI called hangUp — give goodbye audio ~3.5s to play, then end call
        () => {
          setTimeout(async () => {
            if (!completed && callSid) {
              await finalize();
              await hangUpCall(callSid!);
            }
          }, 3500);
        },
        isResume
      ).catch((err) => {
        console.error(`[${callSid}] Failed to open OpenAI Realtime session:`, err);
        ws.close();
        return null;
      });
    }

    if (frame.event === "media" && frame.media && realtime) {
      realtime.sendAudio(frame.media.payload);
    }

    if (frame.event === "stop") {
      await finalize();
      ws.close();
    }
  });

  ws.on("close", () => {
    // Delay finalize to allow Wi-Fi reconnects — Twilio will send a new start event
    // with the same callSid if it reconnects within ~8 seconds
    if (!completed && callSid) {
      const timer = setTimeout(async () => {
        await finalize();
      }, 8000);
      pendingFinalizations.set(callSid, timer);
    }
  });

  ws.on("error", (err) => {
    console.error("MediaStream WS error:", err.message);
    finalize();
  });
}
