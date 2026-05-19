import { Router, Request, Response } from "express";
import { twilioValidate } from "../middleware/twilioValidate";
import { getCallerRole, createSession } from "../services/supabase/sessions";
import { buildStreamTwiml, buildHangupTwiml } from "../utils/twiml";
import { normalizePhone } from "../utils/phone";

export const voiceRouter = Router();

voiceRouter.post("/", twilioValidate, async (req: Request, res: Response): Promise<void> => {
  const { CallSid, From, To } = req.body as { CallSid: string; From: string; To?: string };
  const isOutbound = req.query.outbound === "true";

  // For outbound calls, the customer is "To"; for inbound, the customer is "From"
  const callerPhone = normalizePhone(isOutbound && To ? To : From);

  try {
    if (isOutbound) {
      const customerName = decodeURIComponent((req.query.customerName as string) ?? "");
      const orderId      = decodeURIComponent((req.query.orderId      as string) ?? "");
      const callType     = decodeURIComponent((req.query.callType     as string) ?? "pickup");
      const reason       = decodeURIComponent((req.query.reason       as string) ?? "");
      const pageId       = decodeURIComponent((req.query.pageId       as string) ?? "");
      await createSession(CallSid, callerPhone, "consumer", { customerName, orderId, callType, reason, pageId });
    } else {
      const { role } = await getCallerRole(callerPhone);
      await createSession(CallSid, callerPhone, role);
    }

    res.type("text/xml").send(buildStreamTwiml());
  } catch (err) {
    console.error("Error in /voice:", err);
    res.type("text/xml").send(
      buildHangupTwiml("Sorry, we're having trouble right now. Please call back in a moment.")
    );
  }
});
