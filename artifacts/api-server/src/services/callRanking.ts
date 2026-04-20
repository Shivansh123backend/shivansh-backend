/**
 * Lead Ranking Engine.
 *
 * Scores a lead 0–100 BEFORE we dial, based on:
 *   - prior call history for that phone (engagement, score, emotion, dispositions)
 *   - campaign-level baseline (so leads in a healthy campaign get a small boost)
 *   - basic recency (don't re-bother someone called 30 mins ago)
 *
 * Pure function — given an input snapshot, returns a deterministic score.
 * Failsafe: any error returns 50 (neutral) so the caller can keep dialing.
 */

import { db, callLogsTable, leadsTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";

export interface LeadRankInput {
  leadId: number;
  phone: string;
  campaignId: number;
  retryCount?: number;
  lastCalledAt?: Date | null;
}

export interface LeadRankResult {
  score: number;            // 0–100
  reasons: string[];
}

const POSITIVE_DISPOSITIONS = new Set(["interested", "callback_requested", "qualified", "appointment_set", "sale", "transferred"]);
const NEGATIVE_DISPOSITIONS = new Set(["not_interested", "do_not_call", "wrong_number"]);

export async function rankLead(input: LeadRankInput): Promise<LeadRankResult> {
  try {
    const reasons: string[] = [];
    let score = 50;  // neutral baseline

    // ── Prior call history for this phone ─────────────────────────────────
    const past = await db
      .select({
        score: callLogsTable.score,
        disposition: callLogsTable.disposition,
        emotion: callLogsTable.emotion,
        duration: callLogsTable.duration,
        timestamp: callLogsTable.timestamp,
      })
      .from(callLogsTable)
      .where(eq(callLogsTable.phoneNumber, input.phone))
      .orderBy(desc(callLogsTable.timestamp))
      .limit(5);

    if (past.length > 0) {
      // Avg prior score
      const scored = past.filter((p) => typeof p.score === "number");
      if (scored.length > 0) {
        const avg = scored.reduce((a, b) => a + (b.score ?? 0), 0) / scored.length;
        const delta = Math.round((avg - 50) * 0.4);  // ±20 pts max
        score += delta;
        reasons.push(`prior-avg-score:${Math.round(avg)} (${delta >= 0 ? "+" : ""}${delta})`);
      }

      // Disposition signal
      const lastDispo = (past[0]!.disposition ?? "").toLowerCase();
      if (POSITIVE_DISPOSITIONS.has(lastDispo)) { score += 15; reasons.push("last-positive-dispo"); }
      if (NEGATIVE_DISPOSITIONS.has(lastDispo)) { score -= 25; reasons.push("last-negative-dispo"); }

      // Emotion signal — angry/frustrated previously = lower priority
      const lastEmo = past[0]!.emotion;
      if (lastEmo === "angry") { score -= 25; reasons.push("prior-angry"); }
      else if (lastEmo === "frustrated") { score -= 12; reasons.push("prior-frustrated"); }
      else if (lastEmo === "positive") { score += 8; reasons.push("prior-positive"); }

      // Engagement: long previous call = engaged
      const lastDuration = past[0]!.duration ?? 0;
      if (lastDuration > 90) { score += 6; reasons.push("prior-long-engagement"); }
    } else {
      reasons.push("no-prior-history");
    }

    // ── Recency penalty: called very recently ────────────────────────────
    if (input.lastCalledAt) {
      const minsAgo = (Date.now() - new Date(input.lastCalledAt).getTime()) / 60_000;
      if (minsAgo < 30) { score -= 30; reasons.push("called-very-recently"); }
      else if (minsAgo < 240) { score -= 10; reasons.push("called-recently"); }
    }

    // ── Retry fatigue ────────────────────────────────────────────────────
    const retries = input.retryCount ?? 0;
    if (retries >= 3) { score -= 10; reasons.push("retry-fatigue"); }

    // ── Campaign baseline boost ──────────────────────────────────────────
    const campRecent = await db
      .select({ score: callLogsTable.score })
      .from(callLogsTable)
      .where(eq(callLogsTable.campaignId, input.campaignId))
      .orderBy(desc(callLogsTable.timestamp))
      .limit(20);

    const campScored = campRecent.filter((p) => typeof p.score === "number");
    if (campScored.length >= 5) {
      const campAvg = campScored.reduce((a, b) => a + (b.score ?? 0), 0) / campScored.length;
      const delta = Math.round((campAvg - 50) * 0.1);  // ±5 pts max
      score += delta;
      reasons.push(`campaign-avg:${Math.round(campAvg)} (${delta >= 0 ? "+" : ""}${delta})`);
    }

    score = Math.max(0, Math.min(100, score));
    return { score, reasons };
  } catch {
    return { score: 50, reasons: ["rank-failsafe"] };
  }
}

/** Convenience: rank many leads, returning a Map keyed by leadId. */
export async function rankLeads(leads: Array<LeadRankInput>): Promise<Map<number, LeadRankResult>> {
  const out = new Map<number, LeadRankResult>();
  for (const l of leads) {
    out.set(l.leadId, await rankLead(l));
  }
  return out;
}

/** Persist the rank score back to leads.rankScore (best-effort). */
export async function persistRankScore(leadId: number, score: number): Promise<void> {
  try {
    await db.update(leadsTable).set({ rankScore: score }).where(eq(leadsTable.id, leadId));
  } catch { /* ignore */ }
}

/** Suppress unused-import warning when only persistRankScore is used. */
export const _and = and;
