/**
 * Conversion Predictor.
 *
 * Given a freshly ranked lead and its campaign, predicts the probability that
 * the upcoming call will end with a "positive" disposition (interested,
 * callback, qualified, appointment, sale, transferred).
 *
 * Pure rule-based regression — no ML model, no extra LLM call. Combines:
 *   - lead rank score
 *   - campaign positive-disposition rate over the last 50 calls
 *
 * Returns probability (0–1) and a high/medium/low label. Failsafe to medium/0.5.
 */

import { db, callLogsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";

export type ConversionLabel = "high" | "medium" | "low";

export interface ConversionPrediction {
  probability: number;      // 0–1
  label: ConversionLabel;
  reasons: string[];
}

const POSITIVE_DISPOSITIONS = new Set(["interested", "callback_requested", "qualified", "appointment_set", "sale", "transferred"]);

export async function predictConversion(opts: {
  campaignId: number;
  rankScore: number;        // 0–100
}): Promise<ConversionPrediction> {
  try {
    const reasons: string[] = [];

    // 1. Lead-side base probability — map 0–100 score to 0.05–0.95
    const fromRank = clamp01(0.05 + (opts.rankScore / 100) * 0.9);

    // 2. Campaign-side rate over recent 50 calls
    let campaignRate = 0.2;  // sensible default before we have data
    const recent = await db
      .select({ disposition: callLogsTable.disposition })
      .from(callLogsTable)
      .where(eq(callLogsTable.campaignId, opts.campaignId))
      .orderBy(desc(callLogsTable.timestamp))
      .limit(50);
    if (recent.length >= 5) {
      const wins = recent.filter((r) => POSITIVE_DISPOSITIONS.has((r.disposition ?? "").toLowerCase())).length;
      campaignRate = wins / recent.length;
      reasons.push(`campaign-rate:${(campaignRate * 100).toFixed(0)}%`);
    } else {
      reasons.push("campaign-rate:default");
    }
    reasons.push(`rank-base:${(fromRank * 100).toFixed(0)}%`);

    // 3. Weighted blend — lead history dominates, campaign trend modulates
    const probability = clamp01(fromRank * 0.7 + campaignRate * 0.3);

    let label: ConversionLabel = "medium";
    if (probability >= 0.6) label = "high";
    else if (probability < 0.3) label = "low";

    return { probability, label, reasons };
  } catch {
    return { probability: 0.5, label: "medium", reasons: ["predictor-failsafe"] };
  }
}

/** Map a prediction label to a strategy hint the bridge / coach can act on. */
export function strategyFor(label: ConversionLabel): {
  promptAddition: string;
  pacing: "calm" | "normal" | "energetic";
  pressure: "soft" | "balanced" | "confident";
} {
  switch (label) {
    case "high":
      return {
        promptAddition: "HIGH-CONVERSION LEAD. Move toward the close faster. Be confident and concrete. Ask the next step directly.",
        pacing: "energetic",
        pressure: "confident",
      };
    case "low":
      return {
        promptAddition: "LOW-CONVERSION LEAD. Be soft and exploratory. No commitment language. Prioritise rapport over the close.",
        pacing: "calm",
        pressure: "soft",
      };
    case "medium":
    default:
      return {
        promptAddition: "MEDIUM-CONVERSION LEAD. Balanced approach — friendly, informative, gentle ask once interest is shown.",
        pacing: "normal",
        pressure: "balanced",
      };
  }
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
