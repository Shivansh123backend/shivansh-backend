/**
 * Retargeting engine — finds dead leads (no_answer, dropped, not_interested, vm)
 * after a cool-off and schedules a fresh follow-up sequence under a different angle.
 * Polls hourly. Failsafe.
 */
import { db } from "@workspace/db";
import { leadsTable, callLogsTable, followUpsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { sequenceFor, type Disposition } from "./followUpSequence.js";
import { detectIndustryFromText } from "./persuasionEngine.js";

const POLL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const RETARGET_COOLOFF_HOURS = 24;
const RETARGET_MAX_ATTEMPTS = 3;

let _timer: NodeJS.Timeout | null = null;
let _running = false;

const RETARGETABLE_DISPOSITIONS: Disposition[] = ["no_answer", "busy", "vm", "dropped", "not_interested"];

async function findRetargetCandidates(): Promise<Array<{ leadId: number; campaignId: number; lastDisposition: string }>> {
  // Leads whose last call was >24h ago, ended in retargetable disposition,
  // not DNC, not converted/dead/retargeted.
  const cutoff = new Date(Date.now() - RETARGET_COOLOFF_HOURS * 3600_000);
  // Parameterized array binding for dispositions (safe + correct).
  const rows = await db.execute(sql`
    SELECT DISTINCT ON (l.id)
      l.id AS lead_id,
      l.campaign_id,
      cl.disposition AS last_disposition
    FROM leads l
    JOIN call_logs cl ON cl.phone_number = l.phone AND cl.campaign_id = l.campaign_id
    WHERE l.dnc_flag = false
      AND COALESCE(l.lifecycle_stage, '') NOT IN ('converted', 'dead', 'retargeted')
      AND cl.timestamp <= ${cutoff}
      AND cl.disposition = ANY(${RETARGETABLE_DISPOSITIONS as unknown as string[]})
    ORDER BY l.id, cl.timestamp DESC
    LIMIT 50
  `);
  const list = ((rows as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? []) as Array<{ lead_id: number; campaign_id: number; last_disposition: string }>;
  return list.map((r) => ({ leadId: Number(r.lead_id), campaignId: Number(r.campaign_id), lastDisposition: String(r.last_disposition) }));
}

async function alreadyRetargetedRecently(leadId: number): Promise<boolean> {
  // True if the lead has reached RETARGET_MAX_ATTEMPTS retarget follow-ups, OR
  // if there is any retarget follow-up created within the cool-off window.
  const cutoff = new Date(Date.now() - RETARGET_COOLOFF_HOURS * 3600_000);
  const rows = await db.select({ id: followUpsTable.id, createdAt: followUpsTable.createdAt })
    .from(followUpsTable)
    .where(and(eq(followUpsTable.leadId, leadId), eq(followUpsTable.retarget, true)));
  if (rows.length >= RETARGET_MAX_ATTEMPTS) return true;
  return rows.some((r) => r.createdAt && new Date(r.createdAt).getTime() >= cutoff.getTime());
}

async function scheduleRetarget(leadId: number, campaignId: number, lastDisposition: string): Promise<void> {
  try {
    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId)).limit(1);
    if (!lead || lead.dncFlag) return;

    const steps = sequenceFor(lastDisposition as Disposition);
    if (!steps.length) return;

    // Use a fresh angle: only the value_add steps to avoid re-thanking.
    const valueSteps = steps.filter((s) => s.intent === "value_add" || s.intent === "final");
    if (!valueSteps.length) return;

    const now = Date.now();
    const rows = valueSteps
      .filter((s) => (s.channel === "email" ? Boolean(lead.email) : Boolean(lead.phone)))
      .map((s) => ({
        leadId,
        campaignId,
        channel: s.channel,
        sequenceStep: s.step,
        intent: s.intent,
        scheduledAt: new Date(now + s.delayMinutes * 60_000),
        status: "pending" as const,
        industry: detectIndustryFromText(""),
        disposition: lastDisposition,
        callSummary: null,
        predictedLabel: null,
        retarget: true,
      }));
    if (!rows.length) return;
    await db.insert(followUpsTable).values(rows);
    await db.update(leadsTable).set({ lifecycleStage: "retargeted" }).where(eq(leadsTable.id, leadId)).catch(() => {});
    logger.info({ leadId, campaignId, steps: rows.length, lastDisposition }, "Retarget sequence scheduled");
  } catch (err) {
    logger.warn({ err: String(err), leadId }, "Retarget scheduling failed");
  }
}

async function runOnce(): Promise<void> {
  if (_running) return;
  _running = true;
  try {
    const candidates = await findRetargetCandidates();
    if (!candidates.length) return;
    logger.info({ count: candidates.length }, "Retargeting engine — found candidates");
    for (const c of candidates) {
      const tooMany = await alreadyRetargetedRecently(c.leadId).catch(() => false);
      if (tooMany) continue;
      await scheduleRetarget(c.leadId, c.campaignId, c.lastDisposition);
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "Retargeting engine run failed");
  } finally {
    _running = false;
  }
}

export function startRetargetingEngine(): void {
  if (_timer) return;
  logger.info("Retargeting engine started (1h poll)");
  // Delay first run by 5 min so server warms up first
  setTimeout(() => { runOnce().catch(() => {}); }, 5 * 60_000);
  _timer = setInterval(() => { runOnce().catch(() => {}); }, POLL_INTERVAL_MS);
}

export function stopRetargetingEngine(): void {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
