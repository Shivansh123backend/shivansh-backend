/**
 * Lightweight message personalization. Replaces tokens and tunes phrasing
 * based on lead intent / objections. Pure helper — no I/O.
 */

export type IntentLabel = "high" | "medium" | "low";

export interface PersonalizationContext {
  leadName?: string | null;
  agentName?: string;
  campaignName?: string;
  intent?: IntentLabel;
  objections?: string[];
  lastTopic?: string | null;
}

const TOKEN_RE = /\{\{(\w+)\}\}/g;

export function fillTokens(template: string, ctx: PersonalizationContext): string {
  if (!template) return "";
  const data: Record<string, string> = {
    name: ctx.leadName ?? "there",
    firstName: (ctx.leadName ?? "there").split(/\s+/)[0],
    agent: ctx.agentName ?? "your representative",
    campaign: ctx.campaignName ?? "our team",
    topic: ctx.lastTopic ?? "what we discussed",
  };
  return template.replace(TOKEN_RE, (_, k: string) => data[k] ?? "");
}

export function tuneByIntent(text: string, intent: IntentLabel | undefined): string {
  if (!text) return text;
  switch (intent) {
    case "high":
      // Faster close, more direct
      return text.replace(/\bWould you like\b/g, "Want")
                 .replace(/\bperhaps\b/gi, "")
                 .trim();
    case "low":
      // Softer, more permission-seeking
      if (!/no pressure|when you have a moment|whenever/.test(text)) {
        return `${text} (No pressure — only if it's helpful.)`;
      }
      return text;
    default:
      return text;
  }
}

export function personalize(template: string, ctx: PersonalizationContext): string {
  try {
    return tuneByIntent(fillTokens(template, ctx), ctx.intent);
  } catch {
    return template;
  }
}
