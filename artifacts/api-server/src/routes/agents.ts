import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { aiAgentsTable, agentVoicesTable, voicesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { authenticate, requireRole } from "../middlewares/auth.js";
import { z } from "zod";

const router: IRouter = Router();

const createAgentSchema = z.object({
  name: z.string().min(1),
  prompt: z.string().min(1),
  language: z.string().default("en"),
  defaultVoiceId: z.coerce.number().int().positive().optional().nullable(),
});

const updateAgentSchema = z.object({
  name: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  language: z.string().optional(),
  defaultVoiceId: z.coerce.number().int().positive().optional().nullable(),
});

const addVoiceSchema = z.object({
  voiceId: z.number(),
  priority: z.number().default(1),
});

function parseId(raw: string | string[]): number {
  return parseInt(Array.isArray(raw) ? raw[0] : raw, 10);
}

// ── /ai-agents ────────────────────────────────────────────────────────────────

router.get("/ai-agents", authenticate, async (_req, res): Promise<void> => {
  const agents = await db.select().from(aiAgentsTable);
  res.json(agents);
});

router.post("/ai-agents", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const parsed = createAgentSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [agent] = await db.insert(aiAgentsTable).values(parsed.data).returning();
  res.status(201).json(agent);
});

router.post("/ai-agents/create", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const parsed = createAgentSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [agent] = await db.insert(aiAgentsTable).values(parsed.data).returning();
  res.status(201).json(agent);
});

router.get("/ai-agents/:id", authenticate, async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid agent ID" }); return; }
  const [agent] = await db.select().from(aiAgentsTable).where(eq(aiAgentsTable.id, id));
  if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
  res.json(agent);
});

router.patch("/ai-agents/:id", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid agent ID" }); return; }
  const parsed = updateAgentSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [agent] = await db
    .update(aiAgentsTable)
    .set(parsed.data as Record<string, unknown>)
    .where(eq(aiAgentsTable.id, id))
    .returning();
  if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
  res.json(agent);
});

router.delete("/ai-agents/:id", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid agent ID" }); return; }
  const [deleted] = await db.delete(aiAgentsTable).where(eq(aiAgentsTable.id, id)).returning();
  if (!deleted) { res.status(404).json({ error: "Agent not found" }); return; }
  res.json({ success: true });
});

router.get("/ai-agents/:id/voices", authenticate, async (req, res): Promise<void> => {
  const agentId = parseId(req.params.id);
  if (isNaN(agentId)) { res.status(400).json({ error: "Invalid agent ID" }); return; }
  const voices = await db
    .select({ id: agentVoicesTable.id, agentId: agentVoicesTable.agentId, voiceId: agentVoicesTable.voiceId, priority: agentVoicesTable.priority, voice: voicesTable })
    .from(agentVoicesTable)
    .innerJoin(voicesTable, eq(agentVoicesTable.voiceId, voicesTable.id))
    .where(eq(agentVoicesTable.agentId, agentId))
    .orderBy(agentVoicesTable.priority);
  res.json(voices);
});

router.post("/ai-agents/:id/voices", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const agentId = parseId(req.params.id);
  if (isNaN(agentId)) { res.status(400).json({ error: "Invalid agent ID" }); return; }
  const [agent] = await db.select().from(aiAgentsTable).where(eq(aiAgentsTable.id, agentId));
  if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
  const parsed = addVoiceSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [agentVoice] = await db
    .insert(agentVoicesTable)
    .values({ agentId, voiceId: parsed.data.voiceId, priority: parsed.data.priority })
    .returning();
  res.status(201).json(agentVoice);
});

// ── /agents — mirrors /ai-agents for Lovable compatibility ────────────────────

router.get("/agents", authenticate, async (_req, res): Promise<void> => {
  const agents = await db.select().from(aiAgentsTable);
  res.json(agents);
});

router.post("/agents", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const parsed = createAgentSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [agent] = await db.insert(aiAgentsTable).values(parsed.data).returning();
  res.status(201).json(agent);
});

router.get("/agents/:id", authenticate, async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid agent ID" }); return; }
  const [agent] = await db.select().from(aiAgentsTable).where(eq(aiAgentsTable.id, id));
  if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
  res.json(agent);
});

router.patch("/agents/:id", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid agent ID" }); return; }
  const parsed = updateAgentSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [agent] = await db
    .update(aiAgentsTable)
    .set(parsed.data as Record<string, unknown>)
    .where(eq(aiAgentsTable.id, id))
    .returning();
  if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
  res.json(agent);
});

router.delete("/agents/:id", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid agent ID" }); return; }
  const [deleted] = await db.delete(aiAgentsTable).where(eq(aiAgentsTable.id, id)).returning();
  if (!deleted) { res.status(404).json({ error: "Agent not found" }); return; }
  res.json({ success: true });
});

router.get("/agents/:id/voices", authenticate, async (req, res): Promise<void> => {
  const agentId = parseId(req.params.id);
  if (isNaN(agentId)) { res.status(400).json({ error: "Invalid agent ID" }); return; }
  const voices = await db
    .select({ id: agentVoicesTable.id, agentId: agentVoicesTable.agentId, voiceId: agentVoicesTable.voiceId, priority: agentVoicesTable.priority, voice: voicesTable })
    .from(agentVoicesTable)
    .innerJoin(voicesTable, eq(agentVoicesTable.voiceId, voicesTable.id))
    .where(eq(agentVoicesTable.agentId, agentId))
    .orderBy(agentVoicesTable.priority);
  res.json(voices);
});

router.post("/agents/:id/voices", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const agentId = parseId(req.params.id);
  if (isNaN(agentId)) { res.status(400).json({ error: "Invalid agent ID" }); return; }
  const [agent] = await db.select().from(aiAgentsTable).where(eq(aiAgentsTable.id, agentId));
  if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
  const parsed = addVoiceSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [agentVoice] = await db
    .insert(agentVoicesTable)
    .values({ agentId, voiceId: parsed.data.voiceId, priority: parsed.data.priority })
    .returning();
  res.status(201).json(agentVoice);
});

export default router;
