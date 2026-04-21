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
import { getAllActiveBridges } from "../services/elevenBridge.js";
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

// ── GET /calls/cdr — unified CDR: outbound calls + inbound call_logs ──────────
router.get("/calls/cdr", authenticate, async (req, res): Promise<void> => {
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
    timestamp: string;
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
      recordingUrl: r.recordingUrl ?? null,
      transcript: r.transcript ?? null,
      summary: r.summary ?? null,
      timestamp: (r.createdAt ?? new Date()).toISOString(),
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
      recordingUrl: r.recordingUrl ?? null,
      transcript: r.transcript ?? null,
      summary: r.summary ?? null,
      timestamp: (r.timestamp ?? new Date()).toISOString(),
    })),
  ];

  // Sort by timestamp desc
  unified.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  res.json(unified.slice(0, limit));
});

// ── GET /calls/live — active calls snapshot ───────────────────────────────────
// Combines bridge-based in-progress calls (real-time) with queued calls from DB
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
      leadId: b.leadId,
      phoneNumber: b.callerNumber,
      providerUsed: "telnyx",
      status: "in_progress",
      startedAt: b.startedAt.toISOString(),
    };
  });

  // DB-queued calls not yet answered (ringing / queued)
  const queuedCalls = await db
    .select()
    .from(callsTable)
    .where(sql`status IN ('queued', 'ringing', 'initiated')`)
    .orderBy(desc(callsTable.createdAt))
    .limit(50);

  // Deduplicate: if DB has an in-progress call for same phone+campaign, bridge version wins
  const bridgePhones = new Set(bridgeCalls.map(b => b.phoneNumber));
  const filtered = queuedCalls.filter(c => !bridgePhones.has(c.selectedNumber ?? ""));

  res.json([...bridgeCalls, ...filtered]);
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
const TELNYX_WEBRTC_CONNECTION_ID = "2935198916355818730"; // aiagentshivansh credential connection

router.get("/calls/webrtc-token", authenticate, async (req, res): Promise<void> => {
  if (!TELNYX_API_KEY) {
    res.status(503).json({ error: "TELNYX_API_KEY not configured" });
    return;
  }
  try {
    const credRes = await fetch("https://api.telnyx.com/v2/telephony_credentials", {
      method: "POST",
      headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        connection_id: TELNYX_WEBRTC_CONNECTION_ID,
        name: `nexuscall-agent-${req.user!.userId}-${Date.now()}`,
      }),
    });
    if (!credRes.ok) {
      const err = await credRes.json() as { errors?: Array<{ detail: string }> };
      res.status(502).json({ error: err.errors?.[0]?.detail ?? "Failed to create Telnyx credential" });
      return;
    }
    const credData = await credRes.json() as { data: { id: string } };
    const credId = credData.data.id;

    const tokenRes = await fetch(`https://api.telnyx.com/v2/telephony_credentials/${credId}/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TELNYX_API_KEY}` },
    });
    if (!tokenRes.ok) {
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

router.post("/calls/:callControlId/conference", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const { callControlId } = req.params as { callControlId: string };

  const parsed = conferenceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
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

// ── POST /calls/:callControlId/hangup ─────────────────────────────────────────
// Force-end an in-progress call. Used by supervisors and the softphone.
router.post("/calls/:callControlId/hangup", authenticate, async (req, res): Promise<void> => {
  const { callControlId } = req.params as { callControlId: string };
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) { res.status(503).json({ error: "Telnyx not configured" }); return; }

  try {
    await axios.post(
      `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/hangup`,
      {},
      { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" } }
    );
    res.json({ ok: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: "Hangup failed", detail: msg });
  }
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
