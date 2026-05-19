import { createClient } from "@supabase/supabase-js";
import { config } from "../../config";

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY);

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface OutboundContext {
  customerName: string;
  orderId: string;
  callType?: string;   // "pickup" | "callback" | "order"
  reason?: string;
  pageId?: string;
}

export interface Session {
  call_sid: string;
  caller_phone: string;
  caller_role: "owner" | "consumer";
  messages: Message[];
  turn_count: number;
  status: "active" | "completed" | "error";
  is_outbound: boolean;
  outbound_context: OutboundContext | null;
}

export async function getCallerRole(phone: string): Promise<{ role: "owner" | "consumer"; name: string | null }> {
  const { data } = await supabase
    .from("callers")
    .select("role, name")
    .eq("phone_number", phone)
    .single();

  return data ?? { role: "consumer", name: null };
}

export async function createSession(
  callSid: string,
  callerPhone: string,
  callerRole: "owner" | "consumer",
  outboundContext?: OutboundContext
): Promise<void> {
  await supabase.from("call_sessions").insert({
    call_sid: callSid,
    caller_phone: callerPhone,
    caller_role: callerRole,
    messages: [],
    turn_count: 0,
    status: "active",
    is_outbound: !!outboundContext,
    outbound_context: outboundContext ?? null,
  });
}

export async function getSession(callSid: string): Promise<Session | null> {
  const { data } = await supabase
    .from("call_sessions")
    .select("*")
    .eq("call_sid", callSid)
    .single();

  return data ?? null;
}

export async function updateSession(callSid: string, messages: Message[], turnCount: number): Promise<void> {
  await supabase
    .from("call_sessions")
    .update({ messages, turn_count: turnCount, updated_at: new Date().toISOString() })
    .eq("call_sid", callSid);
}

export async function completeSession(callSid: string, actionsTaken: string[]): Promise<void> {
  const { data: session } = await supabase
    .from("call_sessions")
    .select("caller_phone, caller_role, turn_count")
    .eq("call_sid", callSid)
    .single();

  await supabase
    .from("call_sessions")
    .update({ status: "completed", updated_at: new Date().toISOString() })
    .eq("call_sid", callSid);

  if (session) {
    await supabase.from("audit_logs").insert({
      call_sid: callSid,
      caller_phone: session.caller_phone,
      caller_role: session.caller_role,
      turn_count: session.turn_count,
      actions_taken: actionsTaken,
    });
  }
}
