import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { callsTable, callLogsTable, usersTable, campaignsTable } from "@workspace/db";
import { eq, count, sql } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import {
  getAllActiveCalls,
  updateActiveCall,
  setAgentStatus,
} from "../lib/redis.js";
import { emitToSupervisors } from "../websocket/index.js";
import { logger } from "../lib/logger.js";
import { z } from "zod";

const router: IRouter = Router();

const TERMINAL_STATUSES = new Set(["completed", "failed", "no_answer", "busy", "cancelled"]);

// ── GET /dashboard/summary ───────────────────────────────────────────────────
router.get("/dashboard/summary", authenticate, async (req, res): Promise<void> => {
  const [logStats] = await db
    .select({
      total: count(),
      completed: sql<number>`cast(sum(case when status = 'completed' then 1 else 0 end) as int)`,
    })
    .from(callLogsTable);

  const [callStats] = await db
    .select({
      total: count(),
      active: sql<number>`cast(sum(case when status in ('ringing','initiated','in_progress') then 1 else 0 end) as int)`,
      completed: sql<number>`cast(sum(case when status = 'completed' then 1 else 0 end) as int)`,
    })
    .from(callsTable);

  const redisActive = await getAllActiveCalls();
  const activeCallsCount = redisActive.length > 0
    ? redisActive.length
    : (callStats.active ?? 0);

  res.json({
    total_calls: (logStats.total ?? 0) + (callStats.total ?? 0),
    active_calls: activeCallsCount,
    completed_calls: (logStats.completed ?? 0) + (callStats.completed ?? 0),
  });
});

// ── GET /dashboard/live-calls ────────────────────────────────────────────────
// Redis is primary source (real-time). Falls back to DB when Redis is absent.
router.get("/dashboard/live-calls", authenticate, async (req, res): Promise<void> => {
  const redisActive = await getAllActiveCalls();

  if (redisActive.length > 0) {
    res.json(
      redisActive.map((c) => ({
        phone_number: c.phone_number,
        campaign_id: c.campaign_id,
        campaign_name: c.campaign_name ?? null,
        status: c.status,
        started_at: c.started_at,
      }))
    );
    return;
  }

  // DB fallback for when Redis is not configured
  const liveCalls = await db
    .select({
      phone_number: callsTable.selectedNumber,
      campaign_id: callsTable.campaignId,
      campaign_name: campaignsTable.name,
      status: callsTable.status,
      started_at: callsTable.startedAt,
    })
    .from(callsTable)
    .leftJoin(campaignsTable, eq(callsTable.campaignId, campaignsTable.id))
    .where(sql`${callsTable.status} in ('ringing', 'initiated', 'in_progress')`)
    .orderBy(callsTable.createdAt)
    .limit(100);

  res.json(
    liveCalls.map((c) => ({
      phone_number: c.phone_number ?? "unknown",
      campaign_id: c.campaign_id,
      campaign_name: c.campaign_name ?? null,
      status: c.status === "in_progress" ? "in-call" : c.status,
      started_at: c.started_at,
    }))
  );
});

// ── GET /dashboard/agents ────────────────────────────────────────────────────
// Returns users with role agent/admin. Status and current_call from Redis when available.
router.get("/dashboard/agents", authenticate, async (req, res): Promise<void> => {
  const agents = await db
    .select({
      agent_id: usersTable.id,
      name: usersTable.name,
      status: usersTable.status,
    })
    .from(usersTable)
    .where(sql`${usersTable.role} in ('agent', 'admin')`)
    .orderBy(usersTable.name);

  const activeCampaigns = await db
    .select({ id: campaignsTable.id, name: campaignsTable.name, agentId: campaignsTable.agentId })
    .from(campaignsTable)
    .where(eq(campaignsTable.status, "active"));

  const campaignByAgent = new Map<number, { id: number; name: string }>();
  for (const c of activeCampaigns) {
    if (c.agentId) campaignByAgent.set(c.agentId, { id: c.id, name: c.name });
  }

  res.json(
    agents.map((a) => {
      const assigned = campaignByAgent.get(a.agent_id);
      return {
        agent_id: a.agent_id,
        name: a.name,
        assigned_campaign: assigned ?? null,
        status: a.status === "busy" ? "busy" : "available",
      };
    })
  );
});

// ── POST /dashboard/update ───────────────────────────────────────────────────
// Worker webhook — no auth required.
// Updates the call's status in Redis, emits a WebSocket event to supervisors,
// and cleans up the key if the call is in a terminal state.
const updateSchema = z.object({
  call_id: z.string().min(1),
  phone_number: z.string().optional(),
  status: z.string().min(1),
  agent_id: z.number().int().positive().optional(), // optional: which human agent is on the call
});

router.post("/dashboard/update", async (req, res): Promise<void> => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "call_id and status are required" });
    return;
  }

  const { call_id, phone_number, status, agent_id } = parsed.data;
  const isTerminal = TERMINAL_STATUSES.has(status);

  // Determine the normalised status for our ActiveCallRecord
  const callStatus = isTerminal
    ? "completed"
    : status === "in-call" || status === "in_progress"
    ? "in-call"
    : "ringing";

  // Update Redis active_calls key
  let updatedRecord = await updateActiveCall(call_id, callStatus);

  // If call wasn't in Redis yet (race or cold start), build a minimal record for the event
  if (!updatedRecord && phone_number) {
    updatedRecord = {
      call_id,
      phone_number,
      campaign_id: 0,
      status: callStatus,
      started_at: new Date().toISOString(),
    };
  }

  // Update agent_status key if an agent is linked to this call
  if (agent_id) {
    if (isTerminal) {
      await setAgentStatus({ agent_id, status: "available", updated_at: new Date().toISOString() });
    } else {
      await setAgentStatus({ agent_id, status: "busy", current_call: call_id, updated_at: new Date().toISOString() });
    }
    // Emit agent status event
    emitToSupervisors("agent_status", {
      agent_id,
      status: isTerminal ? "available" : "busy",
      current_call: isTerminal ? null : call_id,
    });
  }

  // Emit call_update event to all supervisors
  if (updatedRecord) {
    emitToSupervisors("call_update", {
      call_id,
      phone_number: updatedRecord.phone_number,
      campaign_id: updatedRecord.campaign_id,
      status,
      is_terminal: isTerminal,
    });
  }

  logger.info({ call_id, status, isTerminal }, "Dashboard update processed");
  res.json({ ok: true, call_id, status, is_terminal: isTerminal });
});

export default router;
