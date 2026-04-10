import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { callsTable, callLogsTable, usersTable, campaignsTable } from "@workspace/db";
import { eq, and, count, sql } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { getAllActiveCalls } from "../lib/redis.js";

const router: IRouter = Router();

// ── GET /dashboard/summary ──────────────────────────────────────────────────
// Returns total_calls, active_calls, completed_calls
// Uses call_logs (worker callbacks) as primary source of truth for totals,
// and Redis for live active-call count (falls back to DB when Redis absent).
router.get("/dashboard/summary", authenticate, async (req, res): Promise<void> => {
  // Aggregate call_logs table
  const [logStats] = await db
    .select({
      total: count(),
      completed: sql<number>`cast(sum(case when status = 'completed' then 1 else 0 end) as int)`,
    })
    .from(callLogsTable);

  // Aggregate richer calls table for statuses not in call_logs
  const [callStats] = await db
    .select({
      total: count(),
      active: sql<number>`cast(sum(case when status in ('ringing','initiated','in_progress') then 1 else 0 end) as int)`,
      completed: sql<number>`cast(sum(case when status = 'completed' then 1 else 0 end) as int)`,
    })
    .from(callsTable);

  // Redis gives real-time active count; fall back to DB count
  const redisActive = await getAllActiveCalls();
  const activeCallsCount = redisActive.length > 0
    ? redisActive.length
    : (callStats.active ?? 0);

  const totalCalls = (logStats.total ?? 0) + (callStats.total ?? 0);
  const completedCalls = (logStats.completed ?? 0) + (callStats.completed ?? 0);

  res.json({
    total_calls: totalCalls,
    active_calls: activeCallsCount,
    completed_calls: completedCalls,
  });
});

// ── GET /dashboard/live-calls ───────────────────────────────────────────────
// Returns real-time call list: phone_number, campaign, status
// Redis is primary (live); DB is fallback.
router.get("/dashboard/live-calls", authenticate, async (req, res): Promise<void> => {
  const redisActive = await getAllActiveCalls();

  if (redisActive.length > 0) {
    res.json(
      redisActive.map((c) => ({
        phone_number: c.phone_number,
        campaign: c.campaign_name ?? `Campaign #${c.campaign_id}`,
        status: c.status,
        started_at: c.started_at,
      }))
    );
    return;
  }

  // Fallback: query DB for calls in active states, join campaign name
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
    .where(
      sql`${callsTable.status} in ('ringing', 'initiated', 'in_progress')`
    )
    .orderBy(callsTable.createdAt)
    .limit(100);

  res.json(
    liveCalls.map((c) => ({
      phone_number: c.phone_number ?? "unknown",
      campaign: c.campaign_name ?? `Campaign #${c.campaign_id}`,
      status: c.status === "in_progress" ? "in-call" : c.status,
      started_at: c.started_at,
    }))
  );
});

// ── GET /dashboard/agents ───────────────────────────────────────────────────
// Returns human agents (users with role=agent or admin) with their status
// and assigned campaign (if any active campaign has them enrolled).
router.get("/dashboard/agents", authenticate, async (req, res): Promise<void> => {
  const agents = await db
    .select({
      agent_id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      status: usersTable.status,
    })
    .from(usersTable)
    .where(
      sql`${usersTable.role} in ('agent', 'admin')`
    )
    .orderBy(usersTable.name);

  // Fetch active campaigns to map agent → campaign
  const activeCampaigns = await db
    .select({
      id: campaignsTable.id,
      name: campaignsTable.name,
      agentId: campaignsTable.agentId,
    })
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
        assigned_campaign: assigned ? { id: assigned.id, name: assigned.name } : null,
        status: a.status === "busy" ? "busy" : "available",
      };
    })
  );
});

export default router;
