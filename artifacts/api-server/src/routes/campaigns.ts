import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { campaignsTable, campaignAgentsTable, leadsTable, usersTable } from "@workspace/db";
import { eq, and, count } from "drizzle-orm";
import { authenticate, requireRole } from "../middlewares/auth.js";
import { createAuditLog } from "../lib/audit.js";
import { getCallQueue, pauseQueue, resumeQueue } from "../queue/callQueue.js";
import { emitToSupervisors } from "../websocket/index.js";
import { z } from "zod";

const router: IRouter = Router();

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

  // Set active
  const [updated] = await db
    .update(campaignsTable)
    .set({ status: "active" })
    .where(eq(campaignsTable.id, id))
    .returning();

  // For outbound campaigns, get pending leads and enqueue jobs
  if (campaign.type === "outbound") {
    const pendingLeads = await db
      .select()
      .from(leadsTable)
      .where(and(eq(leadsTable.campaignId, id), eq(leadsTable.status, "pending")));

    req.log.info({ campaignId: id, leadCount: pendingLeads.length }, "Campaign started, leads ready for processing");
  }

  emitToSupervisors("campaign:started", { campaignId: id, name: campaign.name });

  await createAuditLog({
    userId: req.user?.userId,
    action: "start",
    resource: "campaign",
    resourceId: id,
  });

  res.json(updated);
});

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
