import { db } from "@workspace/db";
import { agentVoicesTable, voicesTable, phoneNumbersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "../lib/logger.js";

export async function selectVoice(agentId: number): Promise<{ voiceId: string; voiceName: string; provider: string } | null> {
  // Get all voices for this agent ordered by priority
  const agentVoices = await db
    .select({
      agentVoiceId: agentVoicesTable.id,
      voiceId: voicesTable.voiceId,
      voiceName: voicesTable.name,
      provider: voicesTable.provider,
      priority: agentVoicesTable.priority,
    })
    .from(agentVoicesTable)
    .innerJoin(voicesTable, eq(agentVoicesTable.voiceId, voicesTable.id))
    .where(eq(agentVoicesTable.agentId, agentId))
    .orderBy(agentVoicesTable.priority);

  if (agentVoices.length === 0) return null;

  // Priority-based selection with random tie-breaking
  const topPriority = agentVoices[0].priority;
  const topVoices = agentVoices.filter((v) => v.priority === topPriority);
  const selected = topVoices[Math.floor(Math.random() * topVoices.length)];

  return {
    voiceId: selected.voiceId,
    voiceName: selected.voiceName,
    provider: selected.provider,
  };
}

let phoneNumberRoundRobinIndex: Record<number, number> = {};

export async function selectPhoneNumber(
  campaignId: number,
): Promise<{ phoneNumber: string; provider: string } | null> {
  const numbers = await db
    .select()
    .from(phoneNumbersTable)
    .where(
      and(
        eq(phoneNumbersTable.campaignId, campaignId),
        eq(phoneNumbersTable.status, "active"),
      ),
    )
    .orderBy(phoneNumbersTable.priority);

  if (numbers.length === 0) {
    logger.warn({ campaignId }, "No active phone numbers for campaign");
    return null;
  }

  // Round-robin selection
  const currentIndex = phoneNumberRoundRobinIndex[campaignId] ?? 0;
  const selected = numbers[currentIndex % numbers.length];
  phoneNumberRoundRobinIndex[campaignId] = (currentIndex + 1) % numbers.length;

  return {
    phoneNumber: selected.phoneNumber,
    provider: selected.provider,
  };
}

export function selectProvider(
  phoneProvider: string,
): "voip" | "telnyx" | "twilio" {
  const validProviders = ["voip", "telnyx", "twilio"] as const;
  if (validProviders.includes(phoneProvider as (typeof validProviders)[number])) {
    return phoneProvider as "voip" | "telnyx" | "twilio";
  }
  return "voip";
}
