import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { callsTable, callLogsTable, leadsTable, campaignsTable, aiAgentsTable, phoneNumbersTable } from "@workspace/db";
import { eq, and, desc, gte, count, sql } from "drizzle-orm";
import { authenticate, requireRole } from "../middlewares/auth.js";
import { enqueueCall } from "../queue/callQueue.js";
import axios from "axios";
import { selectVoice, selectPhoneNumber, selectProvider } from "../services/selectionService.js";
import { findAvailableAgentForCampaign } from "../services/routingService.js";
import { callWithFallback } from "../providers/registry.js";
import { emitToSupervisors, emitToAgent } from "../websocket/index.js";
import { createAuditLog } from "../lib/audit.js";
import { getAllActiveBridges, closeBridge } from "../services/elevenBridge.js";
import { removeActiveCall } from "../lib/redis.js";
import { logger } from "../lib/logger.js";
import { z } from "zod";

const router: IRouter = Router();

const initiateCallSchema = z.object({
  leadId: z.number(),
  campaignId: z.number(),
  overrideProvider: z.enum(["voip", "telnyx", "twilio"]).optional(),
});

const updateCallSchema = z.object({
  status: z.enum(["queued", "initiated", "ringing", "in_progress", "transferred", "completed", "failed", "no_answer", "busy"]).optional(),
  disposition: z.enum(["interested", "not_interested", "vm", "no_answer", "busy", "connected", "transferred", "disconnected"]).optional(),
  duration: z.number().optional(),
  recordingUrl: z.string().optional(),
  transcript: z.string().optional(),
  summary: z.string().optional(),
  transferStatus: z.enum(["pending", "completed", "failed"]).optional(),
  externalCallId: z.string().optional(),
});

const transferSchema = z.object({
  callId: z.number(),
  campaignId: z.number(),
});

router.post("/calls/initiate", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const parsed = initiateCallSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { leadId, campaignId, overrideProvider } = parsed.data;

  // Validate lead and campaign exist
  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  const [campaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, campaignId));
  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }

  if (campaign.status !== "active") {
    res.status(400).json({ error: "Campaign is not active" });
    return;
  }

  // ── DNC + spam check on the destination number ─────────────────────────────
  // Mirrors the campaign-runner protection so direct softphone dials and one-off
  // re-tries from the dashboard get the same TCPA / spam safety guarantees.
  try {
    const { getSpamProfile } = await import("../services/spamCheck.js");
    const profile = await getSpamProfile(lead.phone);
    if (profile.blocked) {
      logger.warn(
        { leadId, phone: lead.phone, spamScore: profile.spamScore, reason: profile.reason },
        "Outbound /calls/initiate REFUSED — spam/DNC match (lead status NOT changed)",
      );
      // NOTE: do NOT auto-flip the lead to do_not_call here. A one-off softphone
      // dial being refused must not poison the lead for the campaign engine —
      // operators were ending up with whole campaigns silently emptied. The
      // dashboard caller can override by adding the number to manual DNC if
      // they truly want to block it permanently.
      res.status(409).json({
        error: "Number blocked by DNC / spam policy",
        spam_score: profile.spamScore,
        line_type: profile.lineType,
        reason: profile.reason,
      });
      return;
    }
  } catch (err) {
    logger.debug({ err: String(err), leadId }, "Spam pre-check errored — proceeding (fail-open)");
  }

  // Select voice
  let selectedVoice = "default";
  if (campaign.agentId) {
    const voice = await selectVoice(campaign.agentId);
    if (voice) selectedVoice = `${voice.provider}:${voice.voiceId}`;
  }

  // Select phone number
  const phoneSelection = await selectPhoneNumber(campaignId);
  if (!phoneSelection) {
    res.status(400).json({ error: "No active phone numbers for this campaign" });
    return;
  }

  const provider = overrideProvider ?? selectProvider(phoneSelection.provider);

  // Create call record
  const [call] = await db.insert(callsTable).values({
    leadId,
    campaignId,
    agentId: campaign.agentId,
    providerUsed: provider,
    selectedVoice,
    selectedNumber: phoneSelection.phoneNumber,
    status: "queued",
  }).returning();

  // Enqueue the call job
  await enqueueCall({
    leadId,
    campaignId,
    phone: lead.phone,
    selectedVoice,
    selectedNumber: phoneSelection.phoneNumber,
    provider,
    agentId: campaign.agentId ?? 0,
    callId: call.id,
  });

  // Update lead status
  await db.update(leadsTable).set({ status: "called" }).where(eq(leadsTable.id, leadId));

  emitToSupervisors("call:queued", {
    callId: call.id,
    leadId,
    campaignId,
    phone: lead.phone,
  });

  await createAuditLog({
    userId: req.user?.userId,
    action: "initiate",
    resource: "call",
    resourceId: call.id,
  });

  res.status(201).json(call);
});

router.get("/calls", authenticate, async (req, res): Promise<void> => {
  const campaignIdRaw = req.query.campaignId;
  const limitRaw = req.query.limit;
  const limit = limitRaw ? parseInt(String(limitRaw), 10) : 100;

  let query = db.select().from(callsTable).orderBy(desc(callsTable.createdAt)).limit(limit);

  if (campaignIdRaw) {
    const campaignId = parseInt(String(campaignIdRaw), 10);
    if (!isNaN(campaignId)) {
      const calls = await db
        .select()
        .from(callsTable)
        .where(eq(callsTable.campaignId, campaignId))
        .orderBy(desc(callsTable.createdAt))
        .limit(limit);
      res.json(calls);
      return;
    }
  }

  const calls = await query;
  res.json(calls);
});

// ── GET /recordings/:id/play — fetch a fresh signed Telnyx URL and 302 redirect
// Telnyx-hosted recording URLs are pre-signed S3 links that expire after 10
// minutes, so the URL captured in the `call.recording.saved` webhook is dead by
// the time anyone clicks Play in the dashboard. This endpoint fetches a fresh
// signed URL on demand using the stored Telnyx recording_id.
//
// Auth: same Bearer token the dashboard already sends. We support both header
// auth and a `?token=` query param so plain <audio src="..."> tags work too.
router.get("/recordings/:id/play", async (req, res): Promise<void> => {
  // Allow the JWT in either header or query (audio elements can't set headers)
  const queryToken = typeof req.query.token === "string" ? req.query.token : null;
  if (queryToken && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${queryToken}`;
  }
  // Re-run the auth middleware inline
  await new Promise<void>((resolve) => authenticate(req, res, () => resolve()));
  if (res.headersSent) return;

  const recordingId = req.params.id;
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "TELNYX_API_KEY not configured" });
    return;
  }

  try {
    const tx = await axios.get(
      `https://api.telnyx.com/v2/recordings/${encodeURIComponent(recordingId)}`,
      { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 8000 },
    );
    const data = tx.data?.data ?? {};
    const url: string | undefined =
      data.download_urls?.mp3 ??
      data.download_urls?.wav ??
      data.recording_urls?.mp3 ??
      data.public_recording_urls?.mp3;
    if (!url) {
      res.status(404).json({ error: "Recording has no playable URL", detail: data });
      return;
    }
    res.redirect(302, url);
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status ?? 502;
    const detail = (err as { response?: { data?: unknown } })?.response?.data ?? String(err);
    logger.warn({ recordingId, status, detail }, "Failed to fetch fresh Telnyx recording URL");
    res.status(status === 404 ? 404 : 502).json({
      error: status === 404 ? "Recording not found on Telnyx" : "Telnyx recording API failed",
      detail,
    });
  }
});

// ── GET /calls/cdr — unified CDR: outbound calls + inbound call_logs ──────────
router.get("/calls/cdr", authenticate, async (req, res): Promise<void> => {
  // The dashboard plays recordings via plain <audio src="..."> tags which
  // cannot send Authorization headers. To make playback work, we append the
  // caller's existing Bearer token to every recording proxy URL as ?token=.
  // The /recordings/:id/play endpoint already accepts that query param.
  const authHeader = req.headers.authorization ?? "";
  const callerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  // Build an ABSOLUTE URL so the recording works from frontends hosted on a
  // different origin (e.g. the Lovable-hosted dashboard). Honors the proxy's
  // forwarded headers, with PUBLIC_API_URL as an explicit override.
  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0] ?? req.protocol ?? "https";
  const host  = (req.headers["x-forwarded-host"]  as string)?.split(",")[0] ?? req.headers.host ?? "";
  const apiBase = (process.env.PUBLIC_API_URL || (host ? `${proto}://${host}` : "")).replace(/\/$/, "");
  const buildPlayUrl = (recId: string) =>
    `${apiBase}/api/recordings/${recId}/play${callerToken ? `?token=${encodeURIComponent(callerToken)}` : ""}`;
  const campaignIdRaw = req.query.campaignId;
  const directionRaw  = req.query.direction as string | undefined;
  const limitRaw      = req.query.limit;
  const limit         = limitRaw ? Math.min(parseInt(String(limitRaw), 10), 500) : 200;

  const campaignId = campaignIdRaw ? parseInt(String(campaignIdRaw), 10) : null;

  // Outbound records — historically split between `calls` and `call_logs`. The
  // active outbound writer (webhooks.ts) writes finalized rows to `call_logs`,
  // so we read from both and merge to be safe across legacy + current data.
  let outboundFromCalls: typeof callsTable.$inferSelect[] = [];
  if (!directionRaw || directionRaw === "outbound") {
    if (campaignId && !isNaN(campaignId)) {
      outboundFromCalls = await db.select().from(callsTable)
        .where(eq(callsTable.campaignId, campaignId))
        .orderBy(desc(callsTable.createdAt)).limit(limit);
    } else {
      outboundFromCalls = await db.select().from(callsTable)
        .orderBy(desc(callsTable.createdAt)).limit(limit);
    }
  }

  // ALL rows from call_logs (both inbound and outbound) — filtered by the
  // requested direction (or unfiltered if `directionRaw` is empty).
  let logRows: typeof callLogsTable.$inferSelect[] = [];
  {
    const conds = [];
    if (directionRaw === "inbound" || directionRaw === "outbound") {
      conds.push(eq(callLogsTable.direction, directionRaw));
    }
    if (campaignId && !isNaN(campaignId)) {
      conds.push(eq(callLogsTable.campaignId, campaignId));
    }
    const whereClause = conds.length > 1 ? and(...conds) : conds[0];
    const baseQuery = db.select().from(callLogsTable);
    logRows = await (whereClause ? baseQuery.where(whereClause) : baseQuery)
      .orderBy(desc(callLogsTable.timestamp))
      .limit(limit);
  }

  // Normalise to a unified shape
  type CdrRow = {
    id: string;
    source: "calls" | "call_logs";
    direction: "outbound" | "inbound";
    phoneNumber: string | null;
    campaignId: number | null;
    leadId: number | null;
    providerUsed: string | null;
    status: string;
    disposition: string | null;
    duration: number | null;
    recordingUrl: string | null;
    transcript: string | null;
    summary: string | null;
    // We expose the same ISO string under multiple keys so any frontend wins:
    // `timestamp` (legacy), `dialedAt` (CDR convention), `createdAt` (Drizzle name).
    timestamp: string;
    dialedAt: string;
    createdAt: string;
  };

  // Dedupe: webhook handler mirrors finalized state from call_logs into calls,
  // so the same physical call can exist in both. call_logs has the more complete
  // post-call data, so drop any `calls` row whose externalCallId matches a
  // call_logs row's callControlId.
  const logCallControlIds = new Set(
    logRows.map(r => r.callControlId).filter((x): x is string => !!x),
  );
  const dedupedOutbound = outboundFromCalls.filter(
    r => !r.externalCallId || !logCallControlIds.has(r.externalCallId),
  );

  const unified: CdrRow[] = [
    ...dedupedOutbound.map(r => ({
      id: `c-${r.id}`,
      source: "calls" as const,
      direction: "outbound" as const,
      phoneNumber: null,                 // calls table joins via leadId; phone resolved client-side
      campaignId: r.campaignId ?? null,
      leadId: r.leadId ?? null,
      providerUsed: r.providerUsed ?? null,
      status: r.status,
      disposition: r.disposition ?? null,
      duration: r.duration ?? null,
      // Prefer the fresh-URL proxy when we have a recording_id; fall back to the
      // raw (likely-expired) S3 URL only for legacy rows captured before we
      // started persisting recording_id.
      recordingUrl: r.recordingId ? buildPlayUrl(r.recordingId) : (r.recordingUrl ?? null),
      transcript: r.transcript ?? null,
      summary: r.summary ?? null,
      timestamp: (r.createdAt ?? new Date()).toISOString(),
      dialedAt:  (r.createdAt ?? new Date()).toISOString(),
      createdAt: (r.createdAt ?? new Date()).toISOString(),
    })),
    ...logRows.map(r => ({
      id: `l-${r.id}`,
      source: "call_logs" as const,
      direction: (r.direction === "inbound" ? "inbound" : "outbound") as "inbound" | "outbound",
      phoneNumber: r.phoneNumber ?? null,
      campaignId: r.campaignId ?? null,
      leadId: null,
      providerUsed: "telnyx",
      status: r.status,
      disposition: r.disposition ?? null,
      duration: r.duration ?? null,
      recordingUrl: r.recordingId ? buildPlayUrl(r.recordingId) : (r.recordingUrl ?? null),
      transcript: r.transcript ?? null,
      summary: r.summary ?? null,
      timestamp: (r.timestamp ?? new Date()).toISOString(),
      dialedAt:  (r.timestamp ?? new Date()).toISOString(),
      createdAt: (r.timestamp ?? new Date()).toISOString(),
    })),
  ];

  // Sort by timestamp desc
  unified.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  res.json(unified.slice(0, limit));
});

// ── GET /calls/live — active calls snapshot ───────────────────────────────────
// Combines bridge-based in-progress calls (real-time) with queued calls from DB
// and active Vapi calls from call_logs
router.get("/calls/live", authenticate, async (req, res): Promise<void> => {
  // Bridge-based calls: actively connected via ElevenLabs ConvAI
  const bridgeCalls = getAllActiveBridges().map(b => {
    let h = 0;
    for (let i = 0; i < b.callControlId.length; i++) {
      h = (Math.imul(31, h) + b.callControlId.charCodeAt(i)) | 0;
    }
    return {
      id: Math.abs(h) % 9_000_000 + 1_000_000,
      callControlId: b.callControlId,
      campaignId: b.campaignId,
      campaignName: b.campaignName ?? null,
      agentName: b.agentName ?? null,
      leadId: b.leadId,
      phoneNumber: b.callerNumber,
      direction: b.direction ?? "outbound",
      providerUsed: "telnyx",
      status: "in_progress",
      startedAt: b.startedAt.toISOString(),
    };
  });

  // DB-queued calls not yet answered (ringing / queued).
  const queuedCalls = await db
    .select()
    .from(callsTable)
    .where(sql`status IN ('queued', 'ringing', 'initiated') AND created_at > NOW() - INTERVAL '90 seconds'`)
    .orderBy(desc(callsTable.createdAt))
    .limit(50);

  // Vapi in-progress calls: call_logs rows with 'initiated' status from last 10 min
  // (Vapi calls are never updated to in_progress — they go initiated → completed/failed)
  const vapiCalls = await db
    .select()
    .from(callLogsTable)
    .where(sql`status = 'initiated' AND timestamp > NOW() - INTERVAL '10 minutes'`)
    .orderBy(desc(callLogsTable.timestamp))
    .limit(50);

  const vapiLiveCalls = vapiCalls.map(row => ({
    id: row.id,
    callControlId: row.callControlId ? `vapi:${row.callControlId}` : undefined,
    campaignId: row.campaignId,
    phoneNumber: row.phoneNumber,
    direction: row.direction,
    providerUsed: "vapi",
    status: "initiated",
    startedAt: row.timestamp.toISOString(),
  }));

  // Deduplicate: bridge version wins over DB rows for same phone
  const bridgePhones = new Set(bridgeCalls.map(b => b.phoneNumber));
  const vapiPhones = new Set(vapiLiveCalls.map(v => v.phoneNumber));
  const filtered = queuedCalls.filter(c =>
    !bridgePhones.has(c.selectedNumber ?? "") && !vapiPhones.has(c.selectedNumber ?? ""),
  );

  res.json([...bridgeCalls, ...vapiLiveCalls, ...filtered]);
});

// ── GET /calls/stats/today — today's call stats ───────────────────────────────
router.get("/calls/stats/today", authenticate, async (req, res): Promise<void> => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  // Count from call_logs table (webhook-driven calls finalize here)
  const logRows = await db
    .select({ status: callLogsTable.status, cnt: count() })
    .from(callLogsTable)
    .where(gte(callLogsTable.timestamp, startOfDay))
    .groupBy(callLogsTable.status);

  let total = 0;
  let completed = 0;
  let failed = 0;
  for (const r of logRows) {
    total += Number(r.cnt);
    if (r.status === "completed") completed += Number(r.cnt);
    if (r.status === "failed" || r.status === "no_answer") failed += Number(r.cnt);
  }

  // Also add currently active bridge calls to total
  total += getAllActiveBridges().length;

  res.json({ total, completed, failed, successRate: total > 0 ? Math.round((completed / total) * 100) : 0 });
});

// ── Telnyx WebRTC token — must be before /:id ──────────────────────────────
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
// Dedicated WebRTC credential connection — overridable via env so it can be
// changed without a redeploy if the Telnyx account is restructured.
const TELNYX_WEBRTC_CONNECTION_ID =
  process.env.TELNYX_WEBRTC_CONNECTION_ID ??
  process.env.TELNYX_SIP_CONNECTION_ID ??
  "2935198916355818730"; // aiagentshivansh credential connection

router.get("/calls/webrtc-token", authenticate, async (req, res): Promise<void> => {
  if (!TELNYX_API_KEY) {
    res.status(503).json({ error: "TELNYX_API_KEY not configured" });
    return;
  }

  // Try creating a credential with the WebRTC connection ID, then fall back to
  // the main TELNYX_CONNECTION_ID if that fails (e.g. connection type mismatch).
  const connectionIds = [
    TELNYX_WEBRTC_CONNECTION_ID,
    process.env.TELNYX_CONNECTION_ID,
  ].filter(Boolean) as string[];

  // De-duplicate (in case both env vars point to same ID)
  const uniqueIds = [...new Set(connectionIds)];

  let credId: string | null = null;
  let lastTelnyxError = "Failed to create Telnyx credential";

  for (const connId of uniqueIds) {
    const credRes = await fetch("https://api.telnyx.com/v2/telephony_credentials", {
      method: "POST",
      headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        connection_id: connId,
        name: `shivansh-agent-${req.user!.userId}-${Date.now()}`,
      }),
    });

    if (credRes.ok) {
      const credData = await credRes.json() as { data: { id: string } };
      credId = credData.data.id;
      break;
    }

    // Log the actual Telnyx error so it's visible in PM2 logs
    let errBody: unknown;
    try { errBody = await credRes.json(); } catch { errBody = await credRes.text().catch(() => credRes.status); }
    logger.warn({ connId, status: credRes.status, body: errBody }, "webrtc-token: Telnyx credential creation failed — trying next connection ID");
    const errDetail = (errBody as { errors?: Array<{ detail: string }> })?.errors?.[0]?.detail;
    lastTelnyxError = errDetail ?? `Telnyx returned ${credRes.status}`;
  }

  // Fallback: if dynamic credential creation failed, try to get a token for a
  // pre-existing telephony credential looked up by SIP username from env.
  if (!credId) {
    const sipUsername = process.env.TELNYX_SIP_USERNAME;
    if (sipUsername) {
      try {
        const listRes = await fetch(
          `https://api.telnyx.com/v2/telephony_credentials?filter[sip_username]=${encodeURIComponent(sipUsername)}&page[size]=1`,
          { headers: { Authorization: `Bearer ${TELNYX_API_KEY}` } },
        );
        if (listRes.ok) {
          const listData = await listRes.json() as { data?: Array<{ id: string }> };
          if (listData.data?.[0]?.id) {
            credId = listData.data[0].id;
            logger.info({ credId, sipUsername }, "webrtc-token: using pre-existing SIP credential");
          }
        }
      } catch (lookupErr) {
        logger.warn({ lookupErr }, "webrtc-token: SIP credential lookup failed");
      }
    }
  }

  if (!credId) {
    res.status(502).json({ error: lastTelnyxError });
    return;
  }

  try {
    const tokenRes = await fetch(`https://api.telnyx.com/v2/telephony_credentials/${credId}/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TELNYX_API_KEY}` },
    });
    if (!tokenRes.ok) {
      const body = await tokenRes.text().catch(() => "");
      logger.warn({ credId, status: tokenRes.status, body }, "webrtc-token: Telnyx token fetch failed");
      res.status(502).json({ error: "Failed to get Telnyx WebRTC token" });
      return;
    }
    const token = await tokenRes.text();
    res.json({ token });
  } catch (err) {
    logger.error({ err }, "webrtc-token error");
    res.status(500).json({ error: "Internal error generating WebRTC token" });
  }
});

router.get("/calls/:id", authenticate, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid call ID" });
    return;
  }

  const [call] = await db.select().from(callsTable).where(eq(callsTable.id, id));
  if (!call) {
    res.status(404).json({ error: "Call not found" });
    return;
  }

  res.json(call);
});

// Called by VPS workers to update call status
router.patch("/calls/:id", authenticate, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid call ID" });
    return;
  }

  const parsed = updateCallSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [call] = await db
    .update(callsTable)
    .set({
      ...parsed.data,
      ...(parsed.data.status === "in_progress" ? { startedAt: new Date() } : {}),
      ...(["completed", "failed", "no_answer", "busy"].includes(parsed.data.status ?? "") ? { endedAt: new Date() } : {}),
    })
    .where(eq(callsTable.id, id))
    .returning();

  if (!call) {
    res.status(404).json({ error: "Call not found" });
    return;
  }

  // Emit real-time events
  if (parsed.data.status === "in_progress") {
    emitToSupervisors("call:started", call);
  } else if (parsed.data.status === "completed" || parsed.data.status === "failed") {
    emitToSupervisors("call:ended", call);
  }

  res.json(call);
});

// ── DELETE /calls/:id — remove a CDR entry from history ──────────────────────
router.delete("/calls/:id", authenticate, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid call ID" }); return; }

  const [deleted] = await db
    .delete(callsTable)
    .where(eq(callsTable.id, id))
    .returning({ id: callsTable.id });

  if (!deleted) { res.status(404).json({ error: "Call not found" }); return; }

  res.json({ ok: true, id: deleted.id });
});

// Transfer to human agent
router.post("/calls/transfer", authenticate, async (req, res): Promise<void> => {
  const parsed = transferSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { callId, campaignId } = parsed.data;

  const availableAgentId = await findAvailableAgentForCampaign(campaignId);
  if (!availableAgentId) {
    res.status(503).json({ error: "No agents available for transfer" });
    return;
  }

  const [call] = await db
    .update(callsTable)
    .set({
      humanAgentId: availableAgentId,
      transferStatus: "pending",
      status: "transferred",
    })
    .where(eq(callsTable.id, callId))
    .returning();

  if (!call) {
    res.status(404).json({ error: "Call not found" });
    return;
  }

  // Notify the agent of incoming transfer
  emitToAgent(availableAgentId, "agent:incoming_call", {
    callId,
    campaignId,
    transferType: "ai_transfer",
  });

  emitToSupervisors("call:transferred", { callId, agentId: availableAgentId });

  res.json({ callId, assignedAgentId: availableAgentId, transferStatus: "pending" });
});

// Inbound call routing
router.post("/calls/inbound", authenticate, async (req, res): Promise<void> => {
  const inboundSchema = z.object({
    callerPhone: z.string().min(1),
    calledNumber: z.string().min(1),
    externalCallId: z.string().optional(),
  });

  const parsed = inboundSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { callerPhone, calledNumber } = parsed.data;

  // Find campaign by called number
  const [phoneRecord] = await db
    .select()
    .from(phoneNumbersTable)
    .where(and(eq(phoneNumbersTable.phoneNumber, calledNumber), eq(phoneNumbersTable.status, "active")));

  if (!phoneRecord?.campaignId) {
    res.status(404).json({ error: "No campaign found for this number" });
    return;
  }

  const [campaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, phoneRecord.campaignId));
  if (!campaign || campaign.status !== "active") {
    res.status(503).json({ error: "Campaign is not active" });
    return;
  }

  // Route based on campaign routing type
  let routedTo: "ai" | "human" = "ai";
  let assignedAgentId: number | null = null;

  if (campaign.routingType === "human" || campaign.routingType === "ai_then_human") {
    assignedAgentId = await findAvailableAgentForCampaign(campaign.id);
    if (assignedAgentId || campaign.routingType === "human") {
      routedTo = "human";
    }
  }

  // Create call record for inbound call
  const [call] = await db.insert(callsTable).values({
    leadId: 0, // Inbound calls don't have a lead_id initially
    campaignId: campaign.id,
    agentId: campaign.agentId,
    humanAgentId: assignedAgentId ?? undefined,
    providerUsed: phoneRecord.provider,
    selectedNumber: calledNumber,
    status: "ringing",
    externalCallId: parsed.data.externalCallId,
  }).returning();

  if (routedTo === "human" && assignedAgentId) {
    emitToAgent(assignedAgentId, "agent:incoming_call", {
      callId: call.id,
      callerPhone,
      campaignId: campaign.id,
    });
  }

  emitToSupervisors("call:inbound", {
    callId: call.id,
    callerPhone,
    campaignId: campaign.id,
    routedTo,
  });

  res.json({ callId: call.id, routedTo, assignedAgentId, campaignId: campaign.id });
});

// ── POST /calls/:callControlId/conference ─────────────────────────────────────
// Dials a third party and bridges them into the active call (3-way calling).
// Body: { to: E.164 phone number, from?: E.164 (optional; uses campaign default) }
//
// SECURITY: admin-only + strict E.164 to prevent toll-fraud / arbitrary dial-out.
const E164_RE = /^\+[1-9]\d{6,14}$/;
const conferenceSchema = z.object({
  to:   z.string().regex(E164_RE, "to must be E.164 format (e.g. +12035551234)"),
  from: z.string().regex(E164_RE).optional(),
});

// Disallowed prefixes for outbound conference dialing — protects against the
// most common toll-fraud destinations (premium-rate, satellite, audio-text).
// Add country codes / N11 patterns as needed.
const CONFERENCE_BLOCKED_PREFIXES = [
  "+1900", "+1976",       // US premium rate
  "+881", "+882", "+883", // Global / inmarsat satellite
  "+979",                  // Intl premium rate
  "+808",                  // Intl shared cost — high abuse rate
];

router.post("/calls/:callControlId/conference", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const { callControlId } = req.params as { callControlId: string };

  const parsed = conferenceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    return;
  }

  // ── Toll-fraud guard ──────────────────────────────────────────────────────
  const to = parsed.data.to;
  if (CONFERENCE_BLOCKED_PREFIXES.some((p) => to.startsWith(p))) {
    res.status(403).json({ error: "Destination prefix is not permitted for conference dial-out" });
    return;
  }

  // ── Ownership/active-call check ───────────────────────────────────────────
  // Only allow bridging into a callControlId that we actually originated and
  // that is still in flight. Prevents using a leaked/guessed callControlId
  // to mint outbound legs on our Telnyx account.
  const [callRow] = await db
    .select({ id: callsTable.id, status: callsTable.status })
    .from(callsTable)
    .where(eq(callsTable.externalCallId, callControlId))
    .limit(1);
  if (!callRow) {
    res.status(404).json({ error: "Unknown callControlId — no matching call found" });
    return;
  }
  const liveStatuses = ["queued", "initiated", "ringing", "in_progress"];
  if (!liveStatuses.includes(callRow.status)) {
    res.status(409).json({ error: `Call is not active (status=${callRow.status})` });
    return;
  }

  const apiKey       = process.env.TELNYX_API_KEY;
  const connectionId = process.env.TELNYX_CONNECTION_ID ?? "2935188068224730263";
  const webhookUrl   = `${process.env.WEBHOOK_BASE_URL ?? "https://api.shivanshagent.cloudisoft.com"}/api/webhooks/telnyx`;

  if (!apiKey) { res.status(503).json({ error: "Telnyx not configured" }); return; }

  // Build client_state encoding that the webhook will decode on call.answered
  // to know it should bridge this new leg into the original call.
  const clientState = Buffer.from(
    JSON.stringify({ type: "conference_bridge", originalCallControlId: callControlId })
  ).toString("base64");

  try {
    // Dial the third party. When they answer, our webhook decodes the
    // conference_bridge client_state and executes a `bridge` action linking
    // the two call legs together.
    const { data: newCallData } = await axios.post(
      "https://api.telnyx.com/v2/calls",
      {
        connection_id:               connectionId,
        to:                          parsed.data.to,
        ...(parsed.data.from ? { from: parsed.data.from } : {}),
        webhook_url:                 webhookUrl,
        answering_machine_detection: "disabled",
        client_state:                clientState,
      },
      {
        headers: {
          Authorization:  `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    const thirdPartyCallControlId = (newCallData as { data?: { call_control_id?: string } })?.data?.call_control_id ?? null;

    res.json({
      thirdPartyCallControlId,
      originalCallControlId: callControlId,
      message: "Third party is being dialed — will be bridged when they answer",
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: "Conference dial failed", detail: msg });
  }
});

// ── POST /calls/:callControlId/whisper ────────────────────────────────────────
// Inject a real-time supervisor note into the AI's context via Vapi's control
// WebSocket. The message is added as a "system" role turn so only the AI sees
// it — the caller never hears it. This is the Vapi equivalent of whisper-coaching.
// Body: { message: string }
router.post("/calls/:callControlId/whisper", authenticate, requireRole("admin", "supervisor"), async (req, res): Promise<void> => {
  const { callControlId } = req.params as { callControlId: string };
  const { message } = req.body as { message?: string };

  if (!message || typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  if (!callControlId.startsWith("vapi:")) {
    res.status(400).json({ error: "Whisper is only supported for Vapi calls (callControlId must start with vapi:)" });
    return;
  }

  const vapiCallId = callControlId.slice("vapi:".length);
  const vapiApiKey = process.env.VAPI_API_KEY;
  if (!vapiApiKey) { res.status(503).json({ error: "VAPI_API_KEY not configured" }); return; }

  const { getVapiMonitorUrls } = await import("../services/vapiMonitor.js");
  const urls = await getVapiMonitorUrls(vapiCallId);

  if (!urls?.controlUrl) {
    logger.warn({ callControlId, vapiCallId }, "Whisper: no controlUrl on file — call may have ended");
    res.status(404).json({ error: "No control URL found for this call — it may have ended or monitoring is disabled" });
    return;
  }

  // Open a short-lived WebSocket to Vapi's control endpoint and send the message.
  // Vapi's controlUrl accepts: { type: "add-message", message: { role, content } }
  // This injects a system-role turn into the AI's context mid-call.
  try {
    const { default: WebSocket } = await import("ws");
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(urls.controlUrl as string, { perMessageDeflate: false });
      const timeout = setTimeout(() => {
        try { ws.close(); } catch { /**/ }
        reject(new Error("controlUrl WebSocket timed out (5s)"));
      }, 5000);

      ws.once("open", () => {
        ws.send(JSON.stringify({
          type: "add-message",
          message: { role: "system", content: message.trim() },
        }));
        clearTimeout(timeout);
        setTimeout(() => { try { ws.close(); } catch { /**/ } resolve(); }, 200);
      });

      ws.once("error", (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    logger.info({ callControlId, msg: message.trim() }, "Whisper sent to Vapi call");
    res.json({ ok: true, message: "Whisper injected into call context" });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ callControlId, err: msg }, "Whisper WebSocket delivery failed");
    res.status(502).json({ error: "Whisper delivery failed", detail: msg });
  }
});

// ── POST /calls/:callControlId/hangup ─────────────────────────────────────────
// Force-end an in-progress call. Supports both Vapi calls (callControlId starts
// with "vapi:") and legacy Telnyx calls. Used by supervisors and the softphone.
router.post("/calls/:callControlId/hangup", authenticate, requireRole("admin", "supervisor", "agent"), async (req, res): Promise<void> => {
  const { callControlId } = req.params as { callControlId: string };

  // ── Vapi call (callControlId = "vapi:{vapiCallId}") ──────────────────────
  if (callControlId.startsWith("vapi:")) {
    const vapiCallId = callControlId.slice(5); // strip "vapi:" prefix
    const vapiApiKey = process.env.VAPI_API_KEY;
    if (!vapiApiKey) { res.status(503).json({ error: "VAPI_API_KEY not configured" }); return; }

    // Verify we know about this call (IDOR protection)
    const [logRow] = await db
      .select({ id: callLogsTable.id })
      .from(callLogsTable)
      .where(eq(callLogsTable.callControlId, vapiCallId))
      .limit(1);
    if (!logRow) {
      // Not in DB yet (call just started) — still attempt hangup via Vapi API
      // so the call doesn't ring forever. Log it and proceed.
      logger.warn({ vapiCallId }, "Hangup requested for unknown Vapi call — attempting anyway");
    }

    // Tell Vapi to end the call. 4xx means already ended → clean up. 5xx → fail.
    let vapiOk = false;
    let vapiFatal = false;
    try {
      await axios.delete(`https://api.vapi.ai/call/${encodeURIComponent(vapiCallId)}`, {
        headers: { Authorization: `Bearer ${vapiApiKey}` },
      });
      vapiOk = true;
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status && status >= 400 && status < 500) {
        // Call already ended on Vapi's side — safe to clean up locally.
        vapiOk = true;
      } else {
        vapiFatal = true;
        logger.warn({ vapiCallId, err: String(err) }, "Vapi hangup failed (5xx/network) — leaving local state intact");
      }
    }

    if (vapiFatal) {
      res.status(502).json({ error: "Vapi hangup failed — call may still be active" });
      return;
    }

    // Clean up: mark log row completed + drop from Redis
    try {
      await db
        .update(callLogsTable)
        .set({ status: "completed" })
        .where(eq(callLogsTable.callControlId, vapiCallId));
    } catch (err) { logger.warn({ vapiCallId, err: String(err) }, "Vapi hangup DB cleanup failed"); }

    try { await removeActiveCall(callControlId); } catch { /* non-fatal */ }
    try { await removeActiveCall(vapiCallId); } catch { /* non-fatal */ }

    try {
      emitToSupervisors("call:ended", { id: logRow?.id, callControlId, disposition: "manual_drop" });
      emitToSupervisors("call_update", { callId: logRow?.id, call_id: callControlId, status: "completed", is_terminal: true });
    } catch { /* non-fatal */ }

    logger.info({ vapiCallId }, "Vapi call hung up via API");
    res.json({ ok: true });
    return;
  }

  // ── Legacy Telnyx call ────────────────────────────────────────────────────
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) { res.status(503).json({ error: "Telnyx not configured" }); return; }

  // 1. Verify the callControlId matches a known call (IDOR protection).
  const [callRow] = await db
    .select({ id: callsTable.id, status: callsTable.status })
    .from(callsTable)
    .where(eq(callsTable.externalCallId, callControlId))
    .limit(1);
  const knownInBridge = !!getAllActiveBridges().find(b => b.callControlId === callControlId);
  if (!callRow && !knownInBridge) {
    res.status(404).json({ error: "Unknown callControlId" });
    return;
  }

  // 2. Tell Telnyx to hang up.
  let telnyxOk = false;
  let telnyxFatal = false;
  try {
    await axios.post(
      `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/hangup`,
      {},
      { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" } }
    );
    telnyxOk = true;
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status && status >= 400 && status < 500) {
      telnyxOk = true;
    } else {
      telnyxFatal = true;
      logger.warn({ callControlId, err: String(err) }, "Telnyx hangup failed (5xx/network) — leaving local state intact");
    }
  }

  if (telnyxFatal) {
    res.status(502).json({ error: "Telnyx hangup failed — call may still be active" });
    return;
  }

  // 3. Close in-memory bridge.
  try { closeBridge(callControlId); } catch { /* not active */ }

  // 4. Mark completed in DB.
  try {
    await db
      .update(callsTable)
      .set({ status: "completed", endedAt: new Date() })
      .where(eq(callsTable.externalCallId, callControlId));
  } catch (err) {
    logger.warn({ callControlId, err: String(err) }, "Hangup DB cleanup failed");
  }

  // 5. Drop from Redis.
  try { await removeActiveCall(callControlId); } catch { /* non-fatal */ }

  // 6. Notify dashboards.
  try {
    emitToSupervisors("call:ended", { id: callRow?.id, callControlId, disposition: "manual_drop" });
    emitToSupervisors("call_update", { callId: callRow?.id, call_id: callControlId, status: "completed", is_terminal: true });
  } catch { /* non-fatal */ }

  res.json({ ok: true });
});

// ── POST /calls/:callControlId/hold ───────────────────────────────────────────
// Place the remote leg on hold (silence + optional hold music).
router.post("/calls/:callControlId/hold", authenticate, async (req, res): Promise<void> => {
  const { callControlId } = req.params as { callControlId: string };
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) { res.status(503).json({ error: "Telnyx not configured" }); return; }

  // Telnyx doesn't have a native "hold" — we simulate by muting both directions
  // via stop_audio + a no-op. Concretely: stop any playing audio and start a
  // looped tone (or silence). We use playback_stop + playback_start with a 1s
  // silent payload looped indefinitely.
  try {
    await axios.post(
      `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/playback_start`,
      {
        audio_url: "https://api.shivanshagent.cloudisoft.com/static/hold-music.mp3",
        loop: "infinity",
        target_legs: "self",
      },
      { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" } }
    );
    res.json({ ok: true, held: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: "Hold failed", detail: msg });
  }
});

// ── POST /calls/:callControlId/unhold ─────────────────────────────────────────
router.post("/calls/:callControlId/unhold", authenticate, async (req, res): Promise<void> => {
  const { callControlId } = req.params as { callControlId: string };
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) { res.status(503).json({ error: "Telnyx not configured" }); return; }

  try {
    await axios.post(
      `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/playback_stop`,
      {},
      { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" } }
    );
    res.json({ ok: true, held: false });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: "Unhold failed", detail: msg });
  }
});

// ── POST /calls/:callControlId/transfer ───────────────────────────────────────
// Blind transfer: move the caller to a new destination (E.164) and drop the AI.
const transferToSchema = z.object({ to: z.string().regex(E164_RE, "to must be E.164") });
router.post("/calls/:callControlId/transfer", authenticate, async (req, res): Promise<void> => {
  const { callControlId } = req.params as { callControlId: string };
  const parsed = transferToSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message }); return; }

  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) { res.status(503).json({ error: "Telnyx not configured" }); return; }

  try {
    await axios.post(
      `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/transfer`,
      { to: parsed.data.to },
      { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" } }
    );
    res.json({ ok: true, transferredTo: parsed.data.to });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: "Transfer failed", detail: msg });
  }
});

export default router;
