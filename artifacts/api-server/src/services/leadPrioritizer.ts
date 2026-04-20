/**
 * Lead Prioritizer.
 *
 * Wraps the ranking engine: given a raw list of pending leads, returns the
 * same list re-ordered by predicted call value (rank score desc, then existing
 * priority, then created date as a stable tiebreaker).
 *
 * Side-effects: persists the freshly computed rankScore back to each lead row
 * so the dashboard can surface it. Best-effort — errors are swallowed.
 *
 * Failsafe: if ranking fails, returns the input list unchanged (the caller's
 * existing priority order is preserved).
 */

import { rankLead, persistRankScore } from "./callRanking.js";
import { logger } from "../lib/logger.js";

export interface PrioritizableLead {
  id: number;
  phone: string;
  campaignId: number;
  priority?: number | null;
  retryCount?: number | null;
  lastCalledAt?: Date | null;
  createdAt?: Date;
  // The caller can carry any extra columns through unchanged.
  [key: string]: unknown;
}

export interface PrioritizedLead<T extends PrioritizableLead> {
  lead: T;
  rankScore: number;
  reasons: string[];
}

export async function prioritizeLeads<T extends PrioritizableLead>(
  leads: T[],
): Promise<T[]> {
  if (leads.length === 0) return leads;

  try {
    const ranked: PrioritizedLead<T>[] = [];
    for (const lead of leads) {
      const r = await rankLead({
        leadId: lead.id,
        phone: lead.phone,
        campaignId: lead.campaignId,
        retryCount: lead.retryCount ?? 0,
        lastCalledAt: lead.lastCalledAt ?? null,
      });
      ranked.push({ lead, rankScore: r.score, reasons: r.reasons });
      // Persist asynchronously — never block the dial loop on this
      void persistRankScore(lead.id, r.score);
    }

    ranked.sort((a, b) => {
      if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
      const pa = a.lead.priority ?? 0;
      const pb = b.lead.priority ?? 0;
      if (pb !== pa) return pb - pa;
      const ca = a.lead.createdAt ? new Date(a.lead.createdAt).getTime() : 0;
      const cb = b.lead.createdAt ? new Date(b.lead.createdAt).getTime() : 0;
      return ca - cb;
    });

    logger.info(
      { count: leads.length, top: ranked.slice(0, 3).map((r) => ({ id: r.lead.id, score: r.rankScore })) },
      "Leads prioritized",
    );

    return ranked.map((r) => r.lead);
  } catch (err) {
    logger.warn({ err: String(err) }, "Lead prioritization failed — falling back to input order");
    return leads;
  }
}
