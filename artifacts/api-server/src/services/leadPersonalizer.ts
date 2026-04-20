/**
 * Adjust live call phrasing/strategy hints based on predicted intent.
 * Pure helper used by supervisor + coach engines (failsafe — never throws).
 */
import type { IntentLabel } from "./personalizationEngine.js";

export interface LeadStrategy {
  approach: "direct" | "balanced" | "soft";
  paceMultiplier: number;     // 1.0 neutral, >1 faster, <1 slower
  closingStyle: "assumptive" | "neutral" | "soft";
  systemHint: string;          // single-line hint to inject into LLM prompt
}

export function strategyForIntent(intent: IntentLabel | string | null | undefined): LeadStrategy {
  switch ((intent ?? "medium") as IntentLabel) {
    case "high":
      return {
        approach: "direct",
        paceMultiplier: 1.05,
        closingStyle: "assumptive",
        systemHint: "Caller is high-intent. Be direct, skip long discovery, move toward a concrete next step.",
      };
    case "low":
      return {
        approach: "soft",
        paceMultiplier: 0.95,
        closingStyle: "soft",
        systemHint: "Caller is low-intent. Use soft tone, more discovery, no pressure. Offer information first.",
      };
    default:
      return {
        approach: "balanced",
        paceMultiplier: 1.0,
        closingStyle: "neutral",
        systemHint: "Caller is medium-intent. Balanced pace, qualify naturally, then propose next step.",
      };
  }
}

/** Quick adjective shorthand used by coachEngine when building phrasing tweaks. */
export function toneFor(intent: IntentLabel | string | null | undefined): string {
  if (intent === "high") return "confident, direct";
  if (intent === "low") return "gentle, exploratory";
  return "warm, professional";
}
