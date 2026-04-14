import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { aiAgentsTable, agentVoicesTable, voicesTable, humanAgentsTable, callsTable } from "@workspace/db";
import { eq, and, gte, isNotNull, sql as drizzleSql } from "drizzle-orm";
import { authenticate, requireRole } from "../middlewares/auth.js";
import { getAgentStatus } from "../lib/redis.js";
import { z } from "zod";

const router: IRouter = Router();

const createAgentSchema = z.object({
  name: z.string().min(1),
  prompt: z.string().min(1),
  language: z.string().default("en"),
  defaultVoiceId: z.coerce.number().int().positive().optional().nullable(),
  humanLikeMode: z.boolean().default(true).optional(),
});

const updateAgentSchema = z.object({
  name: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  language: z.string().optional(),
  defaultVoiceId: z.coerce.number().int().positive().optional().nullable(),
  humanLikeMode: z.boolean().optional(),
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

// ── GET /agents/available ─────────────────────────────────────────────────────
// Returns the first available human agent (for call transfers and routing).
// MUST be before GET /agents/:id to avoid :id capturing "available" as a param.
router.get("/agents/available", authenticate, async (req, res): Promise<void> => {
  const agents = await db
    .select()
    .from(humanAgentsTable)
    .where(eq(humanAgentsTable.status, "available"))
    .limit(1);

  if (agents.length === 0) {
    res.status(404).json({ error: "No agents available", available: false });
    return;
  }

  const agent = agents[0]!;
  res.json({
    id:           agent.id,
    name:         agent.name,
    phone_number: agent.phoneNumber,
    status:       agent.status,
    available:    true,
  });
});

// ── GET /agents/stats ─────────────────────────────────────────────────────────
// Per-human-agent call stats for today (callsToday, avgDuration, dispositions).
// MUST be before GET /agents/:id to avoid :id capturing "stats" as a param.
router.get("/agents/stats", authenticate, async (req, res): Promise<void> => {
  const agentIdRaw = req.query.agentId;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const humanAgents = await db.select().from(humanAgentsTable);

  const statsRows = await db
    .select({
      humanAgentId: callsTable.humanAgentId,
      disposition:  callsTable.disposition,
      calls:        drizzleSql<number>`count(*)::int`,
      avgDuration:  drizzleSql<number>`coalesce(avg(${callsTable.duration}), 0)::int`,
    })
    .from(callsTable)
    .where(
      and(
        gte(callsTable.createdAt, todayStart),
        isNotNull(callsTable.humanAgentId),
        ...(agentIdRaw
          ? [eq(callsTable.humanAgentId, parseInt(String(agentIdRaw), 10))]
          : [])
      )
    )
    .groupBy(callsTable.humanAgentId, callsTable.disposition);

  const agentMap = new Map<number, { callsToday: number; avgDuration: number; dispositions: Record<string, number> }>();
  for (const row of statsRows) {
    if (row.humanAgentId == null) continue;
    const entry = agentMap.get(row.humanAgentId) ?? { callsToday: 0, avgDuration: 0, dispositions: {} };
    entry.callsToday += row.calls;
    entry.avgDuration = row.avgDuration;
    if (row.disposition) entry.dispositions[row.disposition] = (entry.dispositions[row.disposition] ?? 0) + row.calls;
    agentMap.set(row.humanAgentId, entry);
  }

  const result = await Promise.all(
    humanAgents
      .filter((a) => agentIdRaw ? a.id === parseInt(String(agentIdRaw), 10) : true)
      .map(async (a) => {
        const stats = agentMap.get(a.id) ?? { callsToday: 0, avgDuration: 0, dispositions: {} };
        const redisStatus = await getAgentStatus(a.id);
        return {
          id:           a.id,
          name:         a.name,
          phone_number: a.phoneNumber,
          status:       redisStatus?.status ?? a.status,
          current_call: redisStatus?.current_call ?? null,
          stats: {
            callsToday:   stats.callsToday,
            avgDuration:  stats.avgDuration,
            dispositions: stats.dispositions,
          },
        };
      })
  );

  res.json(result);
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
