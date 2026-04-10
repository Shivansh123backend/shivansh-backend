import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { humanAgentsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { authenticate, requireRole } from "../middlewares/auth.js";
import { getAgentStatus, setAgentStatus } from "../lib/redis.js";
import { emitToSupervisors } from "../websocket/index.js";
import { z } from "zod";

const router: IRouter = Router();

const createHumanAgentSchema = z.object({
  name: z.string().min(1),
  phone_number: z.string().min(7),
  status: z.enum(["available", "busy"]).default("available"),
});

const updateStatusSchema = z.object({
  id: z.number().int().positive(),
  status: z.enum(["available", "busy"]),
});

// POST /agents/create — create a human agent in the pool
router.post("/agents/create", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const parsed = createHumanAgentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const [agent] = await db
      .insert(humanAgentsTable)
      .values({
        name: parsed.data.name,
        phoneNumber: parsed.data.phone_number,
        status: parsed.data.status,
      })
      .returning();

    res.status(201).json({
      id: agent.id,
      name: agent.name,
      phone_number: agent.phoneNumber,
      status: agent.status,
      created_at: agent.createdAt,
    });
  } catch (err: unknown) {
    // Check for PG unique-violation error code 23505 on any error in the chain
    const isUniqueViolation =
      isDuplicateKeyError(err) || isDuplicateKeyError((err as { cause?: unknown })?.cause);
    if (isUniqueViolation) {
      res.status(409).json({ error: "Phone number already registered to another agent" });
      return;
    }
    throw err;
  }
});

// POST /agents/status — update a human agent's status (DB + Redis)
router.post("/agents/status", authenticate, async (req, res): Promise<void> => {
  const parsed = updateStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [updated] = await db
    .update(humanAgentsTable)
    .set({ status: parsed.data.status })
    .where(eq(humanAgentsTable.id, parsed.data.id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  // Mirror status to Redis for real-time dashboard
  await setAgentStatus({
    agent_id: updated.id,
    status: parsed.data.status,
    updated_at: new Date().toISOString(),
  });

  // Broadcast to supervisors via WebSocket
  emitToSupervisors("agent_status", {
    agent_id: updated.id,
    name: updated.name,
    status: parsed.data.status,
    current_call: null,
  });

  res.json({
    id: updated.id,
    name: updated.name,
    phone_number: updated.phoneNumber,
    status: updated.status,
  });
});

// GET /agents/available — return the first available agent (used for call transfers)
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

  const agent = agents[0];
  res.json({
    id: agent.id,
    name: agent.name,
    phone_number: agent.phoneNumber,
    status: agent.status,
    available: true,
  });
});

// GET /agents — list all human agents with live Redis status + current_call
router.get("/agents", authenticate, async (req, res): Promise<void> => {
  const agents = await db.select().from(humanAgentsTable);

  // Enrich each agent with real-time status from Redis (falls back to DB status)
  const enriched = await Promise.all(
    agents.map(async (a) => {
      const redisStatus = await getAgentStatus(a.id);
      return {
        id: a.id,
        name: a.name,
        phone_number: a.phoneNumber,
        status: redisStatus?.status ?? a.status,
        current_call: redisStatus?.current_call ?? null,
      };
    })
  );

  res.json(enriched);
});

export default router;

// Detect PostgreSQL unique-violation errors (code 23505) at any depth in the chain
function isDuplicateKeyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  // pg driver sets `code` directly on the error
  if (e.code === "23505") return true;
  // Drizzle wraps it: the message contains the pg error code description
  if (typeof e.message === "string" && e.message.includes("unique constraint")) return true;
  return false;
}
