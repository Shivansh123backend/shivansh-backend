import { Router, type IRouter, type Request, type Response } from "express";
import { logger } from "../lib/logger.js";
import { db } from "@workspace/db";
import { callLogsTable, phoneNumbersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { removeActiveCall } from "../lib/redis.js";
import { vapiDirectCall } from "../services/vapiService.js";
import { authenticate, requireRole } from "../middlewares/auth.js";

const router: IRouter = Router();

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vapi/webhook — Vapi server-side webhook
//
// Vapi POSTs an event envelope of the form:
//   { message: { type, call, transcript?, endedReason?, summary?, ... } }
//
// SECURITY: Vapi authenticates server webhook requests by including the
// secret you configured on the assistant (`assistant.serverUrlSecret` —
// which we set to env VAPI_WEBHOOK_SECRET) in the `x-vapi-secret` header.
// We reject any request whose header does not match. If the env var is
// unset we fall through (dev only) but log a warning.
//
// We handle:
//   - status-update         : ringing → in-progress → ended (clears Redis)
//   - end-of-call-report    : finalize call_logs row (UPDATE by callControlId,
//                              fall back to INSERT) and release the from number
//   - hang                  : peer hangup notification
//   - function-call         : (future) tool calls e.g. transfer-to-human
// Returns 200 OK quickly — Vapi retries on non-2xx, so we only return 401
// on auth failure (the only case where we *want* Vapi to stop retrying).
// ─────────────────────────────────────────────────────────────────────────────
router.post("/vapi/webhook", async (req: Request, res: Response) => {
  // Authenticate the webhook. In production we *require* the secret to be
  // set — otherwise anyone could forge end-of-call events that mutate
  // call_logs and release allocated numbers.
  const expected = process.env.VAPI_WEBHOOK_SECRET;
  if (expected) {
    const provided = req.header("x-vapi-secret") ?? req.header("x-vapi-signature") ?? "";
    if (provided !== expected) {
      logger.warn({ ip: req.ip }, "Vapi webhook rejected — bad/missing secret");
      return res.status(401).json({ error: "unauthorized" });
    }
  } else if (process.env.NODE_ENV === "production") {
    logger.error("VAPI_WEBHOOK_SECRET not set in production — refusing unauthenticated webhook");
    return res.status(503).json({ error: "vapi_webhook_secret_not_configured" });
  } else {
    logger.warn("VAPI_WEBHOOK_SECRET not set — Vapi webhook is unauthenticated (dev only)");
  }

  try {
    const envelope = req.body?.message ?? req.body ?? {};
    const type: string = envelope.type ?? "unknown";
    const call = envelope.call ?? {};
    const callId: string = call.id ?? "";
    const meta = call.metadata ?? envelope.metadata ?? {};
    const campaignId = meta.campaignId ? parseInt(String(meta.campaignId), 10) : undefined;

    logger.info({ type, callId, campaignId }, "Vapi webhook event");

    if (type === "status-update") {
      const status: string = envelope.status ?? call.status ?? "";
      if (status === "ended" && callId) {
        await removeActiveCall(`vapi:${callId}`).catch(() => {});
      }
    }

    if (type === "end-of-call-report") {
      const endedReason: string = envelope.endedReason ?? "";
      const transcript: string =
        envelope.transcript ??
        (Array.isArray(envelope.messages)
          ? envelope.messages
              .map((m: { role?: string; message?: string }) => `${m.role ?? "?"}: ${m.message ?? ""}`)
              .join("\n")
          : "");
      const summary: string = envelope.summary ?? envelope.analysis?.summary ?? "";
      const recordingUrl: string = envelope.recordingUrl ?? envelope.artifact?.recordingUrl ?? "";
      const durationSeconds: number = envelope.durationSeconds ?? envelope.duration ?? 0;
      const customerNumber: string = call.customer?.number ?? "";

      const normalizedStatus =
        endedReason === "customer-ended-call" || endedReason === "assistant-ended-call"
          ? "completed"
          : endedReason || "unknown";

      try {
        // Prefer UPDATE of the existing row (created at dispatch time in
        // processLead) so we don't end up with two rows per call. Fall back
        // to INSERT if no row matches (e.g. test-call flow).
        const existing = await db
          .select({ id: callLogsTable.id, numberUsed: callLogsTable.numberUsed })
          .from(callLogsTable)
          .where(eq(callLogsTable.callControlId, callId))
          .limit(1);

        if (existing.length > 0) {
          await db
            .update(callLogsTable)
            .set({
              status: normalizedStatus,
              duration: Math.round(durationSeconds),
              transcript,
              summary,
              recordingUrl,
              disposition: endedReason || null,
              answerType: "human",
            })
            .where(eq(callLogsTable.id, existing[0].id));

          // Release any locked from number (Vapi path normally skips
          // allocation, but this protects against stragglers).
          if (existing[0].numberUsed && !existing[0].numberUsed.startsWith("vapi:")) {
            await db
              .update(phoneNumbersTable)
              .set({ isBusy: false })
              .where(eq(phoneNumbersTable.phoneNumber, existing[0].numberUsed))
              .catch(() => {});
          }
        } else {
          await db.insert(callLogsTable).values({
            campaignId: campaignId ?? 0,
            phoneNumber: customerNumber,
            direction: "outbound",
            status: normalizedStatus,
            duration: Math.round(durationSeconds),
            transcript,
            summary,
            recordingUrl,
            callControlId: callId,
            disposition: endedReason || null,
            answerType: "human",
            numberUsed: `vapi:${process.env.VAPI_PHONE_NUMBER_ID ?? "unknown"}`,
          });
        }
      } catch (e) {
        logger.warn({ err: e instanceof Error ? e.message : String(e), callId }, "Failed to persist Vapi call_log");
      }

      await removeActiveCall(`vapi:${callId}`).catch(() => {});
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, "Vapi webhook handler error");
    // Still 200 — never make Vapi retry on our parsing bug
    return res.status(200).json({ received: true, error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vapi/test-call — admin-only quick-test endpoint
// Body: { phone, voice?, voiceProvider?, prompt?, firstMessage? }
// Fires a single Vapi call without going through campaign machinery.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/vapi/test-call", authenticate, requireRole("admin"), async (req: Request, res: Response) => {
  const { phone, voice, voiceProvider, prompt, firstMessage } = req.body ?? {};
  if (!phone) {
    return res.status(400).json({ success: false, error: "phone is required (E.164)" });
  }
  const result = await vapiDirectCall({
    phone,
    agent_prompt:
      prompt ??
      "You are Riya, a friendly sales agent. Greet the customer warmly, ask one clear qualifying question at a time, and listen carefully. Keep responses under 2 sentences.",
    voice: voice ?? "21m00Tcm4TlvDq8ikWAM", // Rachel (ElevenLabs default)
    voice_provider: voiceProvider ?? "elevenlabs",
    campaign_id: "0",
    campaign_name: "Vapi Test Call",
    first_message: firstMessage,
  });
  return res.status(result.success ? 200 : 502).json(result);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vapi/status — admin-only health check (Vapi config sanity)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/vapi/status", authenticate, requireRole("admin"), (_req: Request, res: Response) => {
  res.json({
    configured: Boolean(process.env.VAPI_API_KEY),
    phoneNumberRegistered: Boolean(process.env.VAPI_PHONE_NUMBER_ID),
    webhookSecretSet: Boolean(process.env.VAPI_WEBHOOK_SECRET),
    webhookUrl: `${process.env.WEBHOOK_BASE_URL ?? "https://api.shivanshagent.cloudisoft.com"}/api/vapi/webhook`,
  });
});

export default router;
