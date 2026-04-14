import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { queuesTable, queueMembersTable, humanAgentsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { authenticate, requireRole } from "../middlewares/auth.js";
import { z } from "zod";

const router: IRouter = Router();

// ── GET /queues ───────────────────────────────────────────────────────────────
router.get("/queues", authenticate, async (_req, res): Promise<void> => {
  const queues = await db.select().from(queuesTable).orderBy(queuesTable.name);

  // Enrich each queue with its members
  const enriched = await Promise.all(
    queues.map(async (q) => {
      const members = await db
        .select({
          id:           queueMembersTable.id,
          queueId:      queueMembersTable.queueId,
          humanAgentId: queueMembersTable.humanAgentId,
          priority:     queueMembersTable.priority,
          agentName:    humanAgentsTable.name,
          agentPhone:   humanAgentsTable.phoneNumber,
          agentStatus:  humanAgentsTable.status,
        })
        .from(queueMembersTable)
        .innerJoin(humanAgentsTable, eq(queueMembersTable.humanAgentId, humanAgentsTable.id))
        .where(eq(queueMembersTable.queueId, q.id))
        .orderBy(queueMembersTable.priority);

      return { ...q, members };
    })
  );

  res.json(enriched);
});

// ── GET /queues/:id ───────────────────────────────────────────────────────────
router.get("/queues/:id", authenticate, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid queue ID" }); return; }

  const [queue] = await db.select().from(queuesTable).where(eq(queuesTable.id, id));
  if (!queue) { res.status(404).json({ error: "Queue not found" }); return; }

  const members = await db
    .select({
      id:           queueMembersTable.id,
      queueId:      queueMembersTable.queueId,
      humanAgentId: queueMembersTable.humanAgentId,
      priority:     queueMembersTable.priority,
      agentName:    humanAgentsTable.name,
      agentPhone:   humanAgentsTable.phoneNumber,
      agentStatus:  humanAgentsTable.status,
    })
    .from(queueMembersTable)
    .innerJoin(humanAgentsTable, eq(queueMembersTable.humanAgentId, humanAgentsTable.id))
    .where(eq(queueMembersTable.queueId, id))
    .orderBy(queueMembersTable.priority);

  res.json({ ...queue, members });
});

// ── POST /queues ──────────────────────────────────────────────────────────────
const createQueueSchema = z.object({
  name:        z.string().min(1),
  description: z.string().optional(),
  strategy:    z.enum(["round-robin", "least-busy", "priority"]).default("round-robin"),
  status:      z.enum(["active", "inactive"]).default("active"),
});

router.post("/queues", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const parsed = createQueueSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const [queue] = await db.insert(queuesTable).values(parsed.data).returning();
  res.status(201).json({ ...queue, members: [] });
});

// ── PATCH /queues/:id ─────────────────────────────────────────────────────────
router.patch("/queues/:id", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid queue ID" }); return; }

  const updateSchema = z.object({
    name:        z.string().optional(),
    description: z.union([z.string(), z.null()]).optional(),
    strategy:    z.enum(["round-robin", "least-busy", "priority"]).optional(),
    status:      z.enum(["active", "inactive"]).optional(),
  });

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const [updated] = await db
    .update(queuesTable)
    .set(parsed.data)
    .where(eq(queuesTable.id, id))
    .returning();

  if (!updated) { res.status(404).json({ error: "Queue not found" }); return; }
  res.json(updated);
});

// ── DELETE /queues/:id ────────────────────────────────────────────────────────
router.delete("/queues/:id", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid queue ID" }); return; }

  // Remove members first
  await db.delete(queueMembersTable).where(eq(queueMembersTable.queueId, id));
  await db.delete(queuesTable).where(eq(queuesTable.id, id));
  res.json({ ok: true });
});

// ── POST /queues/:id/members — add an agent to a queue ───────────────────────
const addMemberSchema = z.object({
  humanAgentId: z.number().int().positive(),
  priority:     z.number().default(1),
});

router.post("/queues/:id/members", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const queueId = parseInt(req.params.id, 10);
  if (isNaN(queueId)) { res.status(400).json({ error: "Invalid queue ID" }); return; }

  const parsed = addMemberSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  // Verify agent exists
  const [agent] = await db
    .select()
    .from(humanAgentsTable)
    .where(eq(humanAgentsTable.id, parsed.data.humanAgentId));
  if (!agent) { res.status(404).json({ error: "Human agent not found" }); return; }

  // Verify queue exists
  const [queue] = await db.select().from(queuesTable).where(eq(queuesTable.id, queueId));
  if (!queue) { res.status(404).json({ error: "Queue not found" }); return; }

  const [member] = await db
    .insert(queueMembersTable)
    .values({ queueId, ...parsed.data })
    .returning();

  res.status(201).json({
    ...member,
    agentName:   agent.name,
    agentPhone:  agent.phoneNumber,
    agentStatus: agent.status,
  });
});

// ── DELETE /queues/:id/members/:memberId ─────────────────────────────────────
router.delete("/queues/:id/members/:memberId", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const queueId  = parseInt(req.params.id, 10);
  const memberId = parseInt(req.params.memberId, 10);
  if (isNaN(queueId) || isNaN(memberId)) {
    res.status(400).json({ error: "Invalid IDs" });
    return;
  }

  await db
    .delete(queueMembersTable)
    .where(and(eq(queueMembersTable.id, memberId), eq(queueMembersTable.queueId, queueId)));

  res.json({ ok: true });
});

export default router;
