import {
  GoogleGenAI,
  Modality,
  StartSensitivity,
  EndSensitivity,
  type LiveServerMessage,
} from "@google/genai";
import { config } from "../../config";
import { CONSUMER_TOOLS, OWNER_TOOLS, executeTool } from "./tools";
import { CONSUMER_SYSTEM, OWNER_SYSTEM, buildOutboundSystem } from "./systemPrompt";
import { OutboundContext } from "../supabase/sessions";
import { twilioToGemini, geminiToTwilio } from "./audioConverter";

const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });

export interface GeminiHandle {
  sendAudio: (base64Mulaw: string) => void;
  actionsTaken: string[];
  close: () => void;
}

export async function openGeminiSession(
  callerRole: "owner" | "consumer",
  callerPhone: string,
  onAudio: (base64Mulaw: string) => void,
  onError: (err: Error) => void,
  outboundContext?: OutboundContext | null,
  onClose?: () => void,
  onHangup?: () => void
): Promise<GeminiHandle> {
  const tools = callerRole === "owner" ? OWNER_TOOLS : CONSUMER_TOOLS;
  const systemPrompt = outboundContext
    ? buildOutboundSystem(outboundContext.customerName, outboundContext.orderId)
    : callerRole === "owner" ? OWNER_SYSTEM : CONSUMER_SYSTEM;
  const actionsTaken: string[] = [];

  // Declared before connect so callbacks can reference it via closure
  let liveSession!: Awaited<ReturnType<typeof ai.live.connect>>;

  liveSession = await ai.live.connect({
    model: "gemini-3.1-flash-live-preview",
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      temperature: 0,
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
        languageCode: "en-US",
      },
      tools: [{ functionDeclarations: tools }],
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
          endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
          silenceDurationMs: 700,
        },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
    callbacks: {
      onmessage: (msg: LiveServerMessage) => {
        // Audio: use the .data getter (concatenates all inline data parts)
        if (msg.data) {
          onAudio(geminiToTwilio(msg.data));
        }

        // Tool calls — execute async and respond
        const functionCalls = msg.toolCall?.functionCalls;
        if (functionCalls?.length) {
          void (async () => {
            const responses = [];
            for (const fc of functionCalls) {
              try {
                const { result, action } = await executeTool(
                  fc.name ?? "",
                  (fc.args as Record<string, unknown>) ?? {},
                  "",
                  callerPhone,
                  onHangup
                );
                actionsTaken.push(action);
                responses.push({ id: fc.id, name: fc.name, response: result as Record<string, unknown> });
              } catch (err) {
                responses.push({ id: fc.id, name: fc.name, response: { result: `Error: ${String(err)}` } });
              }
            }
            liveSession.sendToolResponse({ functionResponses: responses });
          })();
        }
      },
      onerror: (err: unknown) => onError(err instanceof Error ? err : new Error(String(err))),
      onclose: () => { onClose?.(); },
    },
  });

  // Trigger opening greeting
  const openingCue = outboundContext
    ? `[Outbound call connected. Say exactly: "Hey, this is Charlie's Cleaners — is this ${outboundContext.customerName}? Your order ${outboundContext.orderId} is ready for pickup!" Then call getOrderById with orderId="${outboundContext.orderId}" to load the order details and answer any questions.]`
    : `[Call connected. Say exactly: "Hey, this is Charlie's Cleaners — how can I help you today?" — nothing else. Then wait for the customer to speak.]`;
  liveSession.sendRealtimeInput({ text: openingCue });

  return {
    sendAudio: (base64Mulaw: string) => {
      liveSession.sendRealtimeInput({
        audio: { data: twilioToGemini(base64Mulaw), mimeType: "audio/pcm;rate=16000" },
      });
    },
    actionsTaken,
    close: () => {
      try { liveSession.close(); } catch (_) {}
    },
  };
}
