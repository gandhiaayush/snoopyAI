import WebSocket from "ws";
import { getSession, completeSession } from "../services/supabase/sessions";
import { openGeminiSession, GeminiHandle } from "../services/gemini/liveSession";

interface TwilioFrame {
  event: string;
  streamSid?: string;
  start?: { callSid: string; streamSid: string };
  media?: { payload: string };
  stop?: { callSid: string };
}

export function handleMediaStream(ws: WebSocket): void {
  let callSid: string | null = null;
  let streamSid: string | null = null;
  let gemini: GeminiHandle | null = null;
  let completed = false;

  async function finalize() {
    if (completed || !callSid) return;
    completed = true;
    gemini?.close();
    await completeSession(callSid, gemini?.actionsTaken ?? []).catch((err) =>
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

      const session = await getSession(callSid).catch(() => null);
      if (!session) {
        console.error(`[${callSid}] session not found — closing`);
        ws.close();
        return;
      }

      gemini = await openGeminiSession(
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
          console.error(`[${callSid}] Gemini error:`, err.message);
          ws.close();
        },
        session.outbound_context ?? undefined,
        // onClose: Gemini session ended unexpectedly — close call cleanly
        () => {
          setTimeout(() => { if (!completed) { finalize(); ws.close(); } }, 500);
        },
        // onHangup: AI called hangUp tool — wait for goodbye audio to finish, then close
        () => {
          setTimeout(() => { if (!completed) { finalize(); ws.close(); } }, 3500);
        }
      ).catch((err) => {
        console.error(`[${callSid}] Failed to open Gemini session:`, err);
        ws.close();
        return null;
      });
    }

    if (frame.event === "media" && frame.media && gemini) {
      gemini.sendAudio(frame.media.payload);
    }

    if (frame.event === "stop") {
      await finalize();
      ws.close();
    }
  });

  ws.on("close", () => finalize());
  ws.on("error", (err) => {
    console.error("MediaStream WS error:", err.message);
    finalize();
  });
}
