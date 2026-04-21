import { db } from "@workspace/db";
import { usersTable, campaignAgentsTable, campaignsTable } from "@workspace/db";
import { eq, and, inArray, asc } from "drizzle-orm";
import { logger } from "../lib/logger.js";

// Per-campaign cursors (in-memory). Reset on process restart — fine because
// they're only used to keep rotation/sequential order roughly balanced.
const roundRobinIndex: Record<number, number> = {};
const sequentialIndex: Record<number, number> = {};

type Strategy = "round_robin" | "priority" | "sequential";

/**
 * Pick an available human agent for a campaign honoring the campaign's
 * configured `routingStrategy`:
 *   - round_robin: rotate through available agents (ignores priority)
 *   - priority:    always pick the available agent with the lowest priority
 *                  number; ties broken by agent id
 *   - sequential:  walk a fixed ordered list (sorted by priority asc,
 *                  then agent id) and pick the next available one,
 *                  resuming from the last position
 */
export async function findAvailableAgentForCampaign(
  campaignId: number,
): Promise<number | null> {
  // Look up the campaign's routing strategy (defaults to round_robin)
  const [campaign] = await db
    .select({ routingStrategy: campaignsTable.routingStrategy })
    .from(campaignsTable)
    .where(eq(campaignsTable.id, campaignId));
  const strategy: Strategy = (campaign?.routingStrategy as Strategy) ?? "round_robin";

  // Get all agents assigned to this campaign WITH their priority, ordered by
  // priority asc (so index 0 is the highest-priority assignment).
  const campaignAgents = await db
    .select({
      agentId:  campaignAgentsTable.agentId,
      priority: campaignAgentsTable.priority,
    })
    .from(campaignAgentsTable)
    .where(eq(campaignAgentsTable.campaignId, campaignId))
    .orderBy(asc(campaignAgentsTable.priority), asc(campaignAgentsTable.agentId));

  if (campaignAgents.length === 0) {
    logger.warn({ campaignId }, "No agents assigned to campaign");
    return null;
  }

  const agentIds = campaignAgents.map((a) => a.agentId);

  // Find which of those are currently available
  const availableRows = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(
      and(
        inArray(usersTable.id, agentIds),
        eq(usersTable.role, "agent"),
        eq(usersTable.status, "available"),
      ),
    );
  const availableSet = new Set(availableRows.map((r) => r.id));

  if (availableSet.size === 0) {
    logger.warn({ campaignId, strategy }, "No available agents for campaign");
    return null;
  }

  // The ordered list of (agentId, priority) tuples for this campaign,
  // already sorted asc by priority then id.
  const ordered = campaignAgents;
  const orderedAvailable = ordered.filter((a) => availableSet.has(a.agentId));

  let selectedId: number;

  switch (strategy) {
    case "priority": {
      // Pick the available agent with the lowest priority number.
      // Already first in orderedAvailable.
      selectedId = orderedAvailable[0]!.agentId;
      break;
    }

    case "sequential": {
      // Resume from the last position; pick the next available agent
      // walking the full ordered list (not just the available subset)
      // so the cursor truly advances one slot per call.
      const start = sequentialIndex[campaignId] ?? 0;
      let pick: number | null = null;
      for (let i = 0; i < ordered.length; i++) {
        const idx = (start + i) % ordered.length;
        const candidate = ordered[idx]!;
        if (availableSet.has(candidate.agentId)) {
          pick = candidate.agentId;
          sequentialIndex[campaignId] = (idx + 1) % ordered.length;
          break;
        }
      }
      // pick is guaranteed non-null because availableSet is non-empty
      selectedId = pick!;
      break;
    }

    case "round_robin":
    default: {
      // Rotate through available agents (ignoring priority entirely).
      const idx = roundRobinIndex[campaignId] ?? 0;
      const list = orderedAvailable;
      const chosen = list[idx % list.length]!;
      roundRobinIndex[campaignId] = (idx + 1) % list.length;
      selectedId = chosen.agentId;
      break;
    }
  }

  logger.info({ campaignId, strategy, selectedId, available: availableSet.size }, "Agent selected by routing strategy");
  return selectedId;
}

export async function updateAgentStatus(
  agentId: number,
  status: "available" | "busy" | "break" | "offline",
): Promise<void> {
  await db
    .update(usersTable)
    .set({ status })
    .where(eq(usersTable.id, agentId));

  logger.info({ agentId, status }, "Agent status updated");
}
