import { Router, type IRouter, type Request, type Response } from "express";
import { logger } from "../lib/logger.js";
import { db } from "@workspace/db";
import { callLogsTable, phoneNumbersTable } from "@workspace/db";
import { eq, or, and, isNull, desc } from "drizzle-orm";
import { removeActiveCall } from "../lib/redis.js";
import { vapiDirectCall, buildInboundAssistantForNumber } from "../services/vapiService.js";
import { authenticate, requireRole } from "../middlewares/auth.js";
import { emitToSupervisors } from "../websocket/index.js";

const router: IRouter = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Disposition mapper — collapses Vapi's verbose `endedReason` strings (and
// other free-form sources) onto our short, dashboard-friendly enum:
//   interested | not_interested | vm | no_answer | busy | connected
//   | transferred | disconnected | failed
//
// Keep this list as the single source of truth — UI, analytics, and follow-up
// engine all branch on these values. Anything unknown returns "disconnected"
// rather than null so the column is always populated for reporting.
// ─────────────────────────────────────────────────────────────────────────────
type Disposition =
  | "interested" | "not_interested" | "vm" | "no_answer" | "busy"
  | "connected" | "transferred" | "disconnected" | "failed";

export function normalizeDisposition(raw: string | null | undefined): Disposition {
  if (!raw) return "disconnected";
  const r = String(raw).toLowerCase().trim();

  // Already-clean enum values pass through
  const clean = new Set([
    "interested", "not_interested", "vm", "no_answer", "busy",
    "connected", "transferred", "disconnected", "failed",
  ]);
  if (clean.has(r)) return r as Disposition;

  // Vapi endedReason → enum
  if (r.includes("voicemail")) return "vm";
  if (r === "customer-busy" || r.includes("busy")) return "busy";
  if (
    r === "customer-did-not-answer" ||
    r === "customer-did-not-give-microphone-permission" ||
    r === "silence-timed-out" ||
    r.includes("no-answer") ||
    r.includes("did-not-answer")
  ) return "no_answer";
  if (r === "assistant-forwarded-call" || r.includes("transfer")) return "transferred";
  if (
    r === "customer-ended-call" ||
    r === "assistant-ended-call" ||
    r === "assistant-said-end-call-phrase" ||
    r === "customer-ended-call-after-message" ||
    r === "completed" || r === "successful" || r === "callback_requested"
  ) return "connected";
  if (
    r.startsWith("pipeline-error") ||
    r.startsWith("sip-") ||
    r.startsWith("phone-call-provider-bypass") ||
    r === "failed" || r === "error" || r === "unknown-error"
  ) return "failed";

  return "disconnected";
}

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

    // ── Inbound: Vapi asks us which assistant to run for this incoming call ──
    // Telnyx SIP-forwards inbound PSTN calls to sip.vapi.ai. Vapi looks up
    // the BYO number, then POSTs assistant-request to our serverUrl. We look
    // up the campaign assigned to the called number and return its assistant.
    if (type === "assistant-request") {
      const calledNumber: string =
        call?.phoneNumber?.number ??
        envelope?.phoneNumber?.number ??
        "";
      const callerNumber: string =
        call?.customer?.number ??
        envelope?.customer?.number ??
        "";
      const result = await buildInboundAssistantForNumber(calledNumber, callerNumber);
      if (result.assistant) {
        // Persist any monitor URLs Vapi gives us back for inbound, so the
        // supervisor "Listen" works on inbound calls too. Vapi includes
        // them on the assistant-request envelope when monitorPlan is set.
        const monitor = call?.monitor as { listenUrl?: string; controlUrl?: string } | undefined;
        if (callId && monitor && (monitor.listenUrl || monitor.controlUrl)) {
          try {
            const { setVapiMonitorUrls } = await import("../services/vapiMonitor.js");
            await setVapiMonitorUrls(callId, monitor);
          } catch { /* non-fatal */ }
        }
        // Notify live monitor that an inbound call is starting.
        // Use a stable pseudo-ID derived from the Vapi callId so the
        // live monitor can track this call without a DB row ID yet.
        const controlId = `vapi:${callId}`;
        const pseudoId = -(parseInt(callId.replace(/-/g, "").slice(-7), 16) % 9_000_000 + 1_000_000);
        emitToSupervisors("call:inbound", { callControlId: controlId, from: callerNumber, campaignId: result.campaignId });
        emitToSupervisors("call:started", {
          id: pseudoId,
          callControlId: controlId,
          phoneNumber: callerNumber,
          campaignId: result.campaignId,
          providerUsed: "vapi",
          selectedNumber: calledNumber,
        });
        return res.status(200).json({ assistant: result.assistant });
      }
      logger.warn({ calledNumber, callerNumber, err: result.error }, "Inbound assistant resolution failed — Vapi will reject the call");
      return res.status(200).json({ error: result.error ?? "no_assistant" });
    }

    if (type === "status-update") {
      const status: string = envelope.status ?? call.status ?? "";
      if ((status === "in-progress" || status === "in_progress") && callId) {
        // Emit call:started so live monitor picks up calls that started before
        // the supervisor opened the page (complements the /calls/live poll).
        // We query the call_logs row to fill in leadId and use the stored
        // phoneNumber as fallback if Vapi doesn't echo back customer.number.
        const customerNumber: string = call.customer?.number ?? "";
        const calledNumber: string = call?.phoneNumber?.number ?? "";
        const existing = await db
          .select({ id: callLogsTable.id, phoneNumber: callLogsTable.phoneNumber })
          .from(callLogsTable)
          .where(eq(callLogsTable.callControlId, callId))
          .limit(1);
        const resolvedPhone = customerNumber || existing[0]?.phoneNumber || undefined;
        emitToSupervisors("call:started", {
          id: existing[0]?.id,
          callControlId: `vapi:${callId}`,
          ...(resolvedPhone && { phoneNumber: resolvedPhone }),
          selectedNumber: calledNumber || undefined,
          campaignId,
          providerUsed: "vapi",
        });
      }
      if (status === "ended" && callId) {
        await removeActiveCall(`vapi:${callId}`).catch(() => {});
      }
    }

    // ── Live transcript relay ─────────────────────────────────────────────────
    // Vapi sends real-time transcript events so supervisors can read along.
    if (type === "transcript") {
      const role: string = envelope.role ?? "";
      const text: string = envelope.transcript ?? "";
      if (callId && text) {
        emitToSupervisors("call:transcription", {
          callControlId: `vapi:${callId}`,
          speaker: role === "user" ? "caller" : "agent",
          text,
          ts: Date.now(),
        });
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

      const disposition = normalizeDisposition(endedReason);
      // Status is the lifecycle column ("initiated" | "ringing" | "in-progress"
      // | "completed" | "failed"). Map dispositions onto it: anything that
      // actually connected → completed, anything that errored at the SIP/
      // pipeline level → failed, everything else → completed (the call ended
      // cleanly even if no human picked up).
      const normalizedStatus = disposition === "failed" ? "failed" : "completed";

      const answerType = disposition === "vm" ? "voicemail"
        : disposition === "no_answer" ? "no_answer"
        : disposition === "busy" ? "busy"
        : "human";
      const finalFields = {
        status: normalizedStatus,
        duration: Math.round(durationSeconds),
        transcript: transcript || null,
        summary: summary || null,
        recordingUrl: recordingUrl || null,
        disposition,
        answerType,
      };

      try {
        // Primary lookup: find the row by the Vapi call ID (set by campaigns.ts
        // after receiving the Vapi API response).
        const existing = await db
          .select({ id: callLogsTable.id, numberUsed: callLogsTable.numberUsed })
          .from(callLogsTable)
          .where(eq(callLogsTable.callControlId, callId))
          .limit(1);

        let rowId: number | null = existing[0]?.id ?? null;
        let numberUsed: string | null = existing[0]?.numberUsed ?? null;

        // Fallback: race condition — the end-of-call-report webhook sometimes
        // fires before campaigns.ts has written callControlId to the DB row.
        // Try to find the most recent "initiated" row for this campaign + phone
        // that still has a null callControlId and claim it.
        if (!rowId && customerNumber && campaignId) {
          const raceRow = await db
            .select({ id: callLogsTable.id, numberUsed: callLogsTable.numberUsed })
            .from(callLogsTable)
            .where(and(
              eq(callLogsTable.campaignId, campaignId),
              eq(callLogsTable.phoneNumber, customerNumber),
              eq(callLogsTable.status, "initiated"),
              or(isNull(callLogsTable.callControlId), eq(callLogsTable.callControlId, "")),
            ))
            .orderBy(desc(callLogsTable.id))
            .limit(1);

          if (raceRow.length > 0) {
            rowId = raceRow[0].id;
            numberUsed = raceRow[0].numberUsed;
            logger.info({ callId, rowId, campaignId, customerNumber }, "end-of-call-report: claimed race-condition row via phone+campaign fallback");
          }
        }

        if (rowId !== null) {
          await db
            .update(callLogsTable)
            .set({ ...finalFields, callControlId: callId })
            .where(eq(callLogsTable.id, rowId));

          // Release any locked from number (Vapi path normally skips
          // allocation, but this protects against stragglers).
          if (numberUsed && !numberUsed.startsWith("vapi:")) {
            await db
              .update(phoneNumbersTable)
              .set({ isBusy: false })
              .where(eq(phoneNumbersTable.phoneNumber, numberUsed))
              .catch(() => {});
          }
        } else {
          // Last resort: insert a fresh row (e.g. test-call flow with no prior log entry).
          if (!customerNumber) {
            logger.warn({ callId, campaignId }, "end-of-call-report: no existing row and no customer number — skipping insert");
          } else {
            await db.insert(callLogsTable).values({
              campaignId: campaignId ?? 0,
              phoneNumber: customerNumber,
              direction: "outbound",
              callControlId: callId,
              numberUsed: `vapi:${process.env.VAPI_PHONE_NUMBER_ID ?? "unknown"}`,
              ...finalFields,
            });
          }
        }
      } catch (e) {
        logger.warn({ err: e instanceof Error ? e.message : String(e), callId }, "Failed to persist Vapi call_log");
      }

      // Emit call:ended so live monitor removes the call card
      emitToSupervisors("call:ended", {
        callControlId: `vapi:${callId}`,
        disposition,
        duration: Math.round(durationSeconds),
      });
      // Notify CDR table to refresh
      emitToSupervisors("call_update", { source: "vapi", callId });

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
// GET /api/vapi/web-key — returns the Vapi public key for the browser SDK.
// Uses VAPI_PUBLIC_KEY if set, falls back to VAPI_API_KEY (works on most
// Vapi plans where private == public key).
// ─────────────────────────────────────────────────────────────────────────────
router.get("/vapi/web-key", authenticate, (_req: Request, res: Response) => {
  const key = process.env.VAPI_PUBLIC_KEY ?? process.env.VAPI_API_KEY ?? "";
  if (!key) {
    res.status(503).json({ error: "VAPI_API_KEY not configured" });
    return;
  }
  res.json({ publicKey: key });
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
