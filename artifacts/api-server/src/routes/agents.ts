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
  defaultVoiceId: z.number().optional(),
});

const addVoiceSchema = z.object({
  voiceId: z.number(),
  priority: z.number().default(1),
});

router.post("/agents/create", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const parsed = createAgentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [agent] = await db.insert(aiAgentsTable).values(parsed.data).returning();
  res.status(201).json(agent);
});

router.get("/agents", authenticate, async (req, res): Promise<void> => {
  const agents = await db.select().from(aiAgentsTable);
  res.json(agents);
});

router.post("/agents/:id/voices", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const agentId = parseInt(rawId, 10);
  if (isNaN(agentId)) {
    res.status(400).json({ error: "Invalid agent ID" });
    return;
  }

  const [agent] = await db.select().from(aiAgentsTable).where(eq(aiAgentsTable.id, agentId));
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const parsed = addVoiceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [agentVoice] = await db
    .insert(agentVoicesTable)
    .values({ agentId, voiceId: parsed.data.voiceId, priority: parsed.data.priority })
    .returning();

  res.status(201).json(agentVoice);
});

router.get("/agents/:id/voices", authenticate, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const agentId = parseInt(rawId, 10);
  if (isNaN(agentId)) {
    res.status(400).json({ error: "Invalid agent ID" });
    return;
  }

  const voices = await db
    .select({
      id: agentVoicesTable.id,
      agentId: agentVoicesTable.agentId,
      voiceId: agentVoicesTable.voiceId,
      priority: agentVoicesTable.priority,
      voice: voicesTable,
    })
    .from(agentVoicesTable)
    .innerJoin(voicesTable, eq(agentVoicesTable.voiceId, voicesTable.id))
    .where(eq(agentVoicesTable.agentId, agentId))
    .orderBy(agentVoicesTable.priority);

  res.json(voices);
});

export default router;
