/**
 * Follow-up orchestrator. Called after a call ends. Schedules a multi-step
 * sequence (SMS + email) into the follow_ups table for the scheduler to send.
 * Failsafe — never throws back to the caller.
 */
import { db } from "@workspace/db";
import { followUpsTable, leadsTable, campaignsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { sequenceFor, type Disposition } from "./followUpSequence.js";
import { detectIndustryFromText } from "./persuasionEngine.js";

export interface ScheduleAfterCallInput {
  leadId: number | null | undefined;
  campaignId: number;
  disposition: string;
  callSummary?: string | null;
  predictedLabel?: string | null;
}

export async function scheduleAfterCall(input: ScheduleAfterCallInput): Promise<void> {
  try {
    if (!input.leadId) return;

    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, input.leadId)).limit(1);
    if (!lead) return;

    const [campaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, input.campaignId)).limit(1);

    // Skip DNC and not_interested-without-email leads where no SMS path exists
    if (lead.dncFlag) {
      logger.info({ leadId: lead.id }, "Follow-up skipped — DNC flag set");
      return;
    }

    const steps = sequenceFor(input.disposition as Disposition);
    if (!steps.length) return;

    const now = Date.now();
    const industry = detectIndustryFromText(`${campaign?.name ?? ""} ${campaign?.agentPrompt ?? ""} ${campaign?.knowledgeBase ?? ""}`);

    const rows = steps
      .filter((s) => {
        // Skip email steps if lead has no email address
        if (s.channel === "email" && !lead.email) return false;
        // Skip SMS steps if no phone (shouldn't happen, but be safe)
        if (s.channel === "sms" && !lead.phone) return false;
        return true;
      })
      .map((s) => ({
        leadId: lead.id,
        campaignId: input.campaignId,
        channel: s.channel,
        sequenceStep: s.step,
        intent: s.intent,
        scheduledAt: new Date(now + s.delayMinutes * 60_000),
        status: "pending" as const,
        industry,
        disposition: input.disposition,
        callSummary: input.callSummary ?? null,
        predictedLabel: input.predictedLabel ?? null,
      }));

    if (!rows.length) {
      logger.info({ leadId: lead.id, disposition: input.disposition }, "No follow-up steps scheduled (no eligible channels)");
      return;
    }

    await db.insert(followUpsTable).values(rows);

    // Update lead lifecycle stage
    await db.update(leadsTable)
      .set({ lifecycleStage: input.disposition === "interested" ? "engaged" : "contacted" })
      .where(eq(leadsTable.id, lead.id))
      .catch(() => {});

    logger.info(
      { leadId: lead.id, campaignId: input.campaignId, steps: rows.length, disposition: input.disposition },
      "Follow-up sequence scheduled",
    );
  } catch (err) {
    logger.warn({ err: String(err), leadId: input.leadId }, "Follow-up scheduling failed — continuing");
  }
}
