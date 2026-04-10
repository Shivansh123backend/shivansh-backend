import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { callsTable, leadsTable, campaignsTable, aiAgentsTable, phoneNumbersTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { authenticate, requireRole } from "../middlewares/auth.js";
import { enqueueCall } from "../queue/callQueue.js";
import { selectVoice, selectPhoneNumber, selectProvider } from "../services/selectionService.js";
import { findAvailableAgentForCampaign } from "../services/routingService.js";
import { callWithFallback } from "../providers/registry.js";
import { emitToSupervisors, emitToAgent } from "../websocket/index.js";
import { createAuditLog } from "../lib/audit.js";
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

export default router;
