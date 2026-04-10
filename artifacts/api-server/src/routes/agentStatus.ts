import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { usersTable, callsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { authenticate, requireRole } from "../middlewares/auth.js";
import { emitToSupervisors } from "../websocket/index.js";
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

// Get live calls for supervisor monitoring
router.get("/supervisor/live-calls", authenticate, requireRole("admin", "supervisor"), async (req, res): Promise<void> => {
  const liveCalls = await db
    .select()
    .from(callsTable)
    .where(
      eq(callsTable.status, "in_progress"),
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
