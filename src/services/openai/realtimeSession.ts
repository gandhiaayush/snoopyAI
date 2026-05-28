import WebSocket from "ws";
import { config } from "../../config";
import { OutboundContext } from "../supabase/sessions";
import { CONSUMER_TOOLS, OWNER_TOOLS, executeTool } from "./tools";
import { CONSUMER_SYSTEM, OWNER_SYSTEM, buildOutboundSystem } from "./systemPrompt";

type CallerRole = "owner" | "consumer";

type RealtimeEvent = {
  type: string;
  [key: string]: unknown;
};

type FunctionCallEvent = {
  type: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  item?: {
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  };
};

function sendEvent(ws: WebSocket, event: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event));
  }
}

function buildSystemPrompt(
  callerRole: CallerRole,
  outboundContext?: OutboundContext | null
): string {
  if (outboundContext) {
    return buildOutboundSystem(outboundContext.customerName, outboundContext.orderId);
  }
  return callerRole === "owner" ? OWNER_SYSTEM : CONSUMER_SYSTEM;
}

function buildOpeningCue(outboundContext?: OutboundContext | null, isResume?: boolean): string {
  if (outboundContext) {
    return `Outbound call connected. Say exactly: "Hey, this is Charlie's Cleaners - is this ${outboundContext.customerName}? Your order ${outboundContext.orderId} is ready for pickup! Is there anything you'd like to know before you come in?" Then call getOrderById with orderId="${outboundContext.orderId}" to load the order details.`;
  }

  if (isResume) {
    return `Call reconnected after a brief disconnect. Do NOT re-introduce yourself. Simply say "Sorry about that - we got disconnected. Where were we?" and continue naturally.`;
  }

  return `Call connected. Say exactly: "Hey, this is Charlie's Cleaners - how can I help you today?" Then wait for the caller to speak.`;
}

function maybeParseJson(input: string | undefined): Record<string, unknown> {
  if (!input) return {};
  try {
    const parsed = JSON.parse(input);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function queueAssistantResponse(
  ws: WebSocket,
  instructions?: string
): void {
  const response: Record<string, unknown> = {
    modalities: ["audio"],
  };

  if (instructions) {
    response.instructions = instructions;
  }

  if (config.OPENAI_REALTIME_MAX_OUTPUT_TOKENS !== undefined) {
    response.max_output_tokens = config.OPENAI_REALTIME_MAX_OUTPUT_TOKENS;
  }

  sendEvent(ws, {
    type: "response.create",
    response,
  });
}

function extractFunctionCall(event: FunctionCallEvent): { callId: string; name: string; argumentsText: string } | null {
  if (event.type === "response.function_call_arguments.done" && event.call_id && event.name) {
    return {
      callId: event.call_id,
      name: event.name,
      argumentsText: event.arguments ?? "{}",
    };
  }

  if (event.type === "response.output_item.done" && event.item?.type === "function_call" && event.item.call_id && event.item.name) {
    return {
      callId: event.item.call_id,
      name: event.item.name,
      argumentsText: event.item.arguments ?? "{}",
    };
  }

  return null;
}

export interface RealtimeHandle {
  sendAudio: (base64Mulaw: string) => void;
  actionsTaken: string[];
  close: () => void;
}

export async function openRealtimeSession(
  callerRole: CallerRole,
  callerPhone: string,
  onAudio: (base64Mulaw: string) => void,
  onError: (err: Error) => void,
  outboundContext?: OutboundContext | null,
  onClose?: () => void,
  onHangup?: () => void,
  isResume?: boolean
): Promise<RealtimeHandle> {
  const tools = callerRole === "owner" ? OWNER_TOOLS : CONSUMER_TOOLS;
  const systemPrompt = buildSystemPrompt(callerRole, outboundContext);
  const openingCue = buildOpeningCue(outboundContext, isResume);
  const actionsTaken: string[] = [];
  const handledCalls = new Set<string>();

  return await new Promise<RealtimeHandle>((resolve, reject) => {
    let settled = false;
    let closing = false;

    const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.OPENAI_REALTIME_MODEL)}`, {
      headers: {
        Authorization: `Bearer ${config.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    const fail = (err: Error) => {
      if (!settled) {
        settled = true;
        reject(err);
        return;
      }
      onError(err);
    };

    ws.on("open", () => {
      const session: Record<string, unknown> = {
        instructions: systemPrompt,
        voice: config.OPENAI_REALTIME_VOICE,
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        tool_choice: "auto",
        tools,
        turn_detection: {
          type: "server_vad",
          create_response: true,
          interrupt_response: false,
          silence_duration_ms: config.OPENAI_REALTIME_VAD_SILENCE_MS,
          prefix_padding_ms: 250,
        },
      };

      if (config.OPENAI_REALTIME_MAX_OUTPUT_TOKENS !== undefined) {
        session.max_response_output_tokens = config.OPENAI_REALTIME_MAX_OUTPUT_TOKENS;
      }

      sendEvent(ws, { type: "session.update", session });
      queueAssistantResponse(ws, openingCue);

      settled = true;
      resolve({
        sendAudio: (base64Mulaw: string) => {
          sendEvent(ws, {
            type: "input_audio_buffer.append",
            audio: base64Mulaw,
          });
        },
        actionsTaken,
        close: () => {
          closing = true;
          try {
            ws.close();
          } catch {
            // Ignore close race errors.
          }
        },
      });
    });

    ws.on("message", (raw: WebSocket.RawData) => {
      let event: RealtimeEvent;
      try {
        event = JSON.parse(raw.toString()) as RealtimeEvent;
      } catch {
        return;
      }

      if (event.type === "error") {
        const err = new Error(String((event as { error?: { message?: string } }).error?.message ?? "OpenAI Realtime error"));
        fail(err);
        return;
      }

      if (event.type === "response.audio.delta" || event.type === "response.output_audio.delta") {
        const delta = (event as { delta?: string }).delta;
        if (delta) onAudio(delta);
        return;
      }

      const functionCall = extractFunctionCall(event as FunctionCallEvent);
      if (functionCall && !handledCalls.has(functionCall.callId)) {
        handledCalls.add(functionCall.callId);
        void (async () => {
          try {
            const { result, action } = await executeTool(
              functionCall.name,
              maybeParseJson(functionCall.argumentsText),
              onHangup
            );
            actionsTaken.push(action);
            sendEvent(ws, {
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: functionCall.callId,
                output: JSON.stringify(result),
              },
            });
          } catch (err) {
            sendEvent(ws, {
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: functionCall.callId,
                output: JSON.stringify({
                  error: err instanceof Error ? err.message : String(err),
                }),
              },
            });
          }

          queueAssistantResponse(ws);
        })();
      }
    });

    ws.on("close", () => {
      if (!settled) {
        settled = true;
        reject(new Error("OpenAI Realtime session closed before it became ready"));
        return;
      }
      if (!closing) {
        onClose?.();
      }
    });

    ws.on("error", (err) => {
      fail(err instanceof Error ? err : new Error(String(err)));
    });
  });
}
