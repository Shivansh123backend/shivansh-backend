import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  campaignsTable,
  campaignAgentsTable,
  leadsTable,
  usersTable,
  aiAgentsTable,
  voicesTable,
  phoneNumbersTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { authenticate, requireRole } from "../middlewares/auth.js";
import { createAuditLog } from "../lib/audit.js";
import { emitToSupervisors } from "../websocket/index.js";
import { triggerCall, delay } from "../services/workerService.js";
import { z } from "zod";

const router: IRouter = Router();

const DEMO_LEAD_LIMIT = 5;

const createCampaignSchema = z.object({
  name: z.string().min(1),
  agentId: z.number().optional(),
  type: z.enum(["outbound", "inbound"]).default("outbound"),
  routingType: z.enum(["ai", "human", "ai_then_human"]).default("ai"),
  maxConcurrentCalls: z.number().min(1).max(100).default(5),
  transferRules: z.string().optional(),
});

const assignAgentSchema = z.object({
  agentId: z.number(),
});

router.post("/campaigns/create", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const parsed = createCampaignSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [campaign] = await db.insert(campaignsTable).values(parsed.data).returning();

  await createAuditLog({
    userId: req.user?.userId,
    action: "create",
    resource: "campaign",
    resourceId: campaign.id,
  });

  res.status(201).json(campaign);
});

router.get("/campaigns", authenticate, async (req, res): Promise<void> => {
  const campaigns = await db.select().from(campaignsTable);
  res.json(campaigns);
});

router.post("/campaigns/start/:id", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid campaign ID" });
    return;
  }

  const [campaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, id));
  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }

  if (campaign.status === "active") {
    res.status(400).json({ error: "Campaign is already active" });
    return;
  }

  // Activate campaign first so frontend sees the state change immediately
  const [updated] = await db
    .update(campaignsTable)
    .set({ status: "active" })
    .where(eq(campaignsTable.id, id))
    .returning();

  emitToSupervisors("campaign:started", { campaignId: id, name: campaign.name });

  await createAuditLog({
    userId: req.user?.userId,
    action: "start",
    resource: "campaign",
    resourceId: id,
  });

  // Respond immediately — call triggering happens in background
  res.json(updated);

  // Background: trigger calls for outbound campaigns
  if (campaign.type === "outbound") {
    triggerCampaignCalls(id, campaign).catch((err) => {
      req.log.error({ err, campaignId: id }, "Background call triggering failed");
    });
  }
});

async function triggerCampaignCalls(campaignId: number, campaign: typeof campaignsTable.$inferSelect) {
  // Resolve agent, voice, and caller phone number
  const { script, voiceName, fromNumber } = await resolveCampaignAssets(campaignId, campaign);

  const pendingLeads = await db
    .select()
    .from(leadsTable)
    .where(and(eq(leadsTable.campaignId, campaignId), eq(leadsTable.status, "pending")))
    .limit(DEMO_LEAD_LIMIT);

  logger.info(`Campaign ${campaignId}: triggering calls to ${pendingLeads.length} leads (limit ${DEMO_LEAD_LIMIT})`);

  for (const lead of pendingLeads) {
    await triggerCall({
      to: lead.phone,
      from: fromNumber,
      script,
      voice: voiceName,
      transfer_number: campaign.transferRules ?? undefined,
    });

    // Mark lead as called regardless of worker outcome
    await db
      .update(leadsTable)
      .set({ status: "called" })
      .where(eq(leadsTable.id, lead.id));

    // Small delay between calls to avoid rate limits
    const jitter = 500 + Math.floor(Math.random() * 500);
    await delay(jitter);
  }

  logger.info(`Campaign ${campaignId}: finished dispatching ${pendingLeads.length} calls`);
}

async function resolveCampaignAssets(campaignId: number, campaign: typeof campaignsTable.$inferSelect) {
  let script = "Hello, this is an AI assistant calling on behalf of our team.";
  let voiceName = "default";
  let fromNumber = process.env.DEFAULT_FROM_NUMBER ?? "+10000000000";

  // Resolve AI agent script
  if (campaign.agentId) {
    const [agent] = await db
      .select()
      .from(aiAgentsTable)
      .where(eq(aiAgentsTable.id, campaign.agentId))
      .limit(1);

    if (agent) {
      script = agent.prompt;

      // Resolve default voice for this agent
      if (agent.defaultVoiceId) {
        const [voice] = await db
          .select()
          .from(voicesTable)
          .where(eq(voicesTable.id, agent.defaultVoiceId))
          .limit(1);

        if (voice) {
          voiceName = voice.voiceId;
        }
      }
    }
  }

  // Resolve caller phone number assigned to this campaign
  const [phoneRow] = await db
    .select()
    .from(phoneNumbersTable)
    .where(and(eq(phoneNumbersTable.campaignId, campaignId), eq(phoneNumbersTable.status, "active")))
    .limit(1);

  if (phoneRow) {
    fromNumber = phoneRow.phoneNumber;
  }

  return { script, voiceName, fromNumber };
}

// Shared logger (pino-style simple wrapper)
const logger = {
  info: (msg: string) => console.log(JSON.stringify({ level: "info", msg, time: Date.now() })),
  error: (msg: string) => console.error(JSON.stringify({ level: "error", msg, time: Date.now() })),
};

router.post("/campaigns/stop/:id", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid campaign ID" });
    return;
  }

  const [campaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, id));
  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }

  const [updated] = await db
    .update(campaignsTable)
    .set({ status: "paused" })
    .where(eq(campaignsTable.id, id))
    .returning();

  emitToSupervisors("campaign:stopped", { campaignId: id, name: campaign.name });

  await createAuditLog({
    userId: req.user?.userId,
    action: "stop",
    resource: "campaign",
    resourceId: id,
  });

  res.json(updated);
});

router.post("/campaigns/:id/agents", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const campaignId = parseInt(rawId, 10);
  if (isNaN(campaignId)) {
    res.status(400).json({ error: "Invalid campaign ID" });
    return;
  }

  const parsed = assignAgentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [agent] = await db
    .select()
    .from(usersTable)
    .where(and(eq(usersTable.id, parsed.data.agentId), eq(usersTable.role, "agent")));

  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const [assignment] = await db
    .insert(campaignAgentsTable)
    .values({ campaignId, agentId: parsed.data.agentId })
    .returning();

  res.status(201).json(assignment);
});

router.get("/campaigns/:id/agents", authenticate, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const campaignId = parseInt(rawId, 10);
  if (isNaN(campaignId)) {
    res.status(400).json({ error: "Invalid campaign ID" });
    return;
  }

  const agents = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      status: usersTable.status,
    })
    .from(campaignAgentsTable)
    .innerJoin(usersTable, eq(campaignAgentsTable.agentId, usersTable.id))
    .where(eq(campaignAgentsTable.campaignId, campaignId));

  res.json(agents);
});

export default router;
