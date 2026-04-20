/**
 * Optimization Engine (Step 7 of enhancement plan).
 *
 * Read-only analytics over recent calls. Surfaces:
 *   - average score
 *   - distribution of dispositions
 *   - top objections that hurt scores
 *   - excerpt of weak-call transcripts so an operator can refine the script
 *
 * Pure read path — does not auto-modify prompts or campaigns. Operators
 * review the insights and decide what to change.
 */

import { db, callLogsTable } from "@workspace/db";
import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";

export interface OptimizerInsights {
  windowDays: number;
  totalCalls: number;
  scoredCalls: number;
  averageScore: number | null;
  dispositionBreakdown: Record<string, number>;
  topObjections: Array<{ type: string; count: number }>;
  weakCalls: Array<{
    id: number;
    score: number;
    disposition: string | null;
    duration: number | null;
    objections: string[];
    transcriptExcerpt: string;
    timestamp: Date;
  }>;
}

const WEAK_THRESHOLD = 40;
const WEAK_SAMPLE_LIMIT = 10;

export async function computeInsights(opts: {
  windowDays?: number;
  campaignId?: number | null;
} = {}): Promise<OptimizerInsights> {
  const windowDays = opts.windowDays ?? 7;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const conditions = [gte(callLogsTable.timestamp, since)];
  if (opts.campaignId) conditions.push(eq(callLogsTable.campaignId, opts.campaignId));

  const rows = await db
    .select({
      id:          callLogsTable.id,
      score:       callLogsTable.score,
      disposition: callLogsTable.disposition,
      duration:    callLogsTable.duration,
      objections:  callLogsTable.objections,
      transcript:  callLogsTable.transcript,
      timestamp:   callLogsTable.timestamp,
    })
    .from(callLogsTable)
    .where(and(...conditions));

  const totalCalls = rows.length;
  const scored = rows.filter((r) => typeof r.score === "number");
  const scoredCalls = scored.length;
  const averageScore = scoredCalls
    ? Math.round(scored.reduce((s, r) => s + (r.score ?? 0), 0) / scoredCalls)
    : null;

  // Disposition breakdown
  const dispositionBreakdown: Record<string, number> = {};
  for (const r of rows) {
    const k = r.disposition ?? "unknown";
    dispositionBreakdown[k] = (dispositionBreakdown[k] ?? 0) + 1;
  }

  // Objection counts (parsed from JSON column)
  const objCounts = new Map<string, number>();
  for (const r of rows) {
    if (!r.objections) continue;
    let arr: string[] = [];
    try { arr = JSON.parse(r.objections); } catch { /* skip */ }
    for (const t of arr) objCounts.set(t, (objCounts.get(t) ?? 0) + 1);
  }
  const topObjections = [...objCounts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Weak calls — score < 40, sampled by lowest score first
  const weakCalls = scored
    .filter((r) => (r.score ?? 0) < WEAK_THRESHOLD)
    .sort((a, b) => (a.score ?? 0) - (b.score ?? 0))
    .slice(0, WEAK_SAMPLE_LIMIT)
    .map((r) => {
      let objections: string[] = [];
      if (r.objections) { try { objections = JSON.parse(r.objections); } catch { /* skip */ } }
      const t = r.transcript ?? "";
      const excerpt = t.length > 600 ? t.slice(0, 600) + "…" : t;
      return {
        id: r.id,
        score: r.score ?? 0,
        disposition: r.disposition,
        duration: r.duration,
        objections,
        transcriptExcerpt: excerpt,
        timestamp: r.timestamp,
      };
    });

  return {
    windowDays,
    totalCalls,
    scoredCalls,
    averageScore,
    dispositionBreakdown,
    topObjections,
    weakCalls,
  };
}

/** Lightweight aggregate score per day for charting. */
export async function dailyAverageScores(opts: { windowDays?: number; campaignId?: number | null } = {}) {
  const windowDays = opts.windowDays ?? 14;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const conditions = [gte(callLogsTable.timestamp, since), isNotNull(callLogsTable.score)];
  if (opts.campaignId) conditions.push(eq(callLogsTable.campaignId, opts.campaignId));

  const rows = await db
    .select({
      day:   sql<string>`date_trunc('day', ${callLogsTable.timestamp})`.as("day"),
      avg:   sql<number>`avg(${callLogsTable.score})`.as("avg"),
      count: sql<number>`count(*)`.as("count"),
    })
    .from(callLogsTable)
    .where(and(...conditions))
    .groupBy(sql`date_trunc('day', ${callLogsTable.timestamp})`)
    .orderBy(desc(sql`date_trunc('day', ${callLogsTable.timestamp})`));

  return rows.map((r) => ({
    day: r.day,
    averageScore: Math.round(Number(r.avg)),
    callCount: Number(r.count),
  }));
}
