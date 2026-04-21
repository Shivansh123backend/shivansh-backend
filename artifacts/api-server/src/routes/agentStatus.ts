import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { usersTable, callsTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { authenticate, requireRole } from "../middlewares/auth.js";
import { emitToSupervisors } from "../websocket/index.js";
import { getAllActiveBridges } from "../services/elevenBridge.js";
import { z } from "zod";

const router: IRouter = Router();

const updateStatusSchema = z.object({
  status: z.enum(["available", "busy", "break", "offline"]),
});

router.post("/agent/status", authenticate, requireRole("agent", "admin"), async (req, res): Promise<void> => {
  const parsed = updateStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const agentId = req.user!.userId;

  const [agent] = await db
    .update(usersTable)
    .set({ status: parsed.data.status })
    .where(eq(usersTable.id, agentId))
    .returning();

  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  emitToSupervisors("agent:status_update", {
    agentId,
    name: agent.name,
    status: parsed.data.status,
  });

  res.json({
    agentId,
    status: parsed.data.status,
  });
});

// Get live calls for supervisor monitoring.
// Source of truth = active in-memory bridges (real Telnyx call-control state).
// We then fetch the matching `calls` rows so the response keeps its original
// shape. Without this cross-reference the endpoint returned every row stuck in
// 'in_progress' (lost hangup webhooks, mid-call restarts, abnormal disconnects)
// and the dashboard accumulated phantom calls forever — supports calls of any
// duration without false negatives, since liveness is based on real bridge
// presence rather than a creation-time cutoff.
router.get("/supervisor/live-calls", authenticate, requireRole("admin", "supervisor"), async (req, res): Promise<void> => {
  const activeCallControlIds = getAllActiveBridges()
    .map(b => b.callControlId)
    .filter((id): id is string => Boolean(id));

  if (activeCallControlIds.length === 0) {
    res.json([]);
    return;
  }

  const liveCalls = await db
    .select()
    .from(callsTable)
    .where(
      and(
        eq(callsTable.status, "in_progress"),
        inArray(callsTable.externalCallId, activeCallControlIds),
      ),
    );

  res.json(liveCalls);
});

// Get available agents for routing
router.get("/agent/available", authenticate, requireRole("admin", "supervisor"), async (req, res): Promise<void> => {
  const agents = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      status: usersTable.status,
    })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.role, "agent"),
        eq(usersTable.status, "available"),
      ),
    );

  res.json(agents);
});

export default router;
