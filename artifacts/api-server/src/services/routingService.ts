import { db } from "@workspace/db";
import { usersTable, campaignAgentsTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { logger } from "../lib/logger.js";

let roundRobinIndex: Record<number, number> = {};

export async function findAvailableAgentForCampaign(
  campaignId: number,
): Promise<number | null> {
  // Get all agents assigned to this campaign
  const campaignAgents = await db
    .select({ agentId: campaignAgentsTable.agentId })
    .from(campaignAgentsTable)
    .where(eq(campaignAgentsTable.campaignId, campaignId));

  if (campaignAgents.length === 0) {
    logger.warn({ campaignId }, "No agents assigned to campaign");
    return null;
  }

  const agentIds = campaignAgents.map((a) => a.agentId);

  // Find agents that are available
  const availableAgents = await db
    .select()
    .from(usersTable)
    .where(
      and(
        inArray(usersTable.id, agentIds),
        eq(usersTable.role, "agent"),
        eq(usersTable.status, "available"),
      ),
    );

  if (availableAgents.length === 0) {
    logger.warn({ campaignId }, "No available agents for campaign");
    return null;
  }

  // Round-robin selection
  const idx = roundRobinIndex[campaignId] ?? 0;
  const selected = availableAgents[idx % availableAgents.length];
  roundRobinIndex[campaignId] = (idx + 1) % availableAgents.length;

  return selected.id;
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
