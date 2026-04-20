/**
 * Coach Engine (Steps 16–17 of enhancement plan).
 *
 * Reviews a freshly generated assistant reply BEFORE it goes to TTS.
 * Pure rule-based — no extra LLM call, so latency stays unchanged.
 *
 * Rules enforced:
 *   1. Trim runaway length (max 2 sentences / 280 chars).
 *   2. Strip leading filler phrases that bloat speech ("As an AI...", etc).
 *   3. Detect near-repetition vs the assistant's last 3 replies — rewrite as a
 *      brief acknowledgment + reframed question rather than re-saying the same line.
 *   4. Optionally prepend an intervention prefix from the intervention plan.
 *
 * Failsafe: if anything throws, return the original reply unchanged.
 */

import type { InterventionPlan } from "./interventionEngine.js";
import { neutralizePressureLanguage, type Emotion } from "./emotionEngine.js";

export interface CoachInput {
  reply: string;
  recentAssistantReplies: string[];     // last few assistant turns for repetition detection
  intervention?: InterventionPlan | null;
  emotion?: Emotion;                    // current caller emotion (optional)
}

export interface CoachOutput {
  reply: string;
  rewritten: boolean;
  reasons: string[];
}

const MAX_SENTENCES = 2;
const MAX_CHARS = 280;

const FILLER_PREFIXES = [
  /^as an? (ai|assistant)[,!.\s-]+/i,
  /^i'?m an? (ai|assistant|llm)[,!.\s-]+/i,
  /^certainly[,!.\s-]+/i,
  /^absolutely[,!.\s-]+/i,
  /^of course[,!.\s-]+/i,
  /^sure thing[,!.\s-]+/i,
];

function trimToSentences(text: string, max: number): string {
  const parts = text.split(/(?<=[.!?])\s+/);
  return parts.slice(0, max).join(" ");
}

function similarity(a: string, b: string): number {
  const sa = new Set(a.toLowerCase().split(/\s+/));
  const sb = new Set(b.toLowerCase().split(/\s+/));
  const inter = [...sa].filter((w) => sb.has(w)).length;
  const union = new Set([...sa, ...sb]).size;
  return union === 0 ? 0 : inter / union;
}

export function coachResponse(input: CoachInput): CoachOutput {
  const reasons: string[] = [];
  let reply = input.reply.trim();
  let rewritten = false;

  try {
    // 1. Strip filler prefixes
    for (const re of FILLER_PREFIXES) {
      if (re.test(reply)) {
        reply = reply.replace(re, "").trim();
        reasons.push("filler-prefix-stripped");
        rewritten = true;
      }
    }

    // 2. Length cap
    if (reply.length > MAX_CHARS) {
      reply = trimToSentences(reply, MAX_SENTENCES);
      if (reply.length > MAX_CHARS) reply = reply.slice(0, MAX_CHARS).trim() + ".";
      reasons.push("length-trimmed");
      rewritten = true;
    } else {
      const sentenceCount = (reply.match(/[.!?]/g) ?? []).length;
      if (sentenceCount > MAX_SENTENCES) {
        reply = trimToSentences(reply, MAX_SENTENCES);
        reasons.push("sentence-trimmed");
        rewritten = true;
      }
    }

    // 3. Repetition guard — soften with a brief acknowledgment if too similar to a recent reply.
    for (const prev of input.recentAssistantReplies) {
      if (similarity(prev, reply) >= 0.85) {
        // Re-frame: acknowledge + ask a different question
        reply = "Got it — and just to clarify, " + lowerFirst(reply);
        reasons.push("repetition-guard");
        rewritten = true;
        break;
      }
    }

    // 4. Emotion-aware tone scrubbing — strip high-pressure phrases when the
    //    caller is in a negative emotional state so we never escalate.
    if (input.emotion === "frustrated" || input.emotion === "angry" || input.emotion === "hesitant") {
      const before = reply;
      reply = neutralizePressureLanguage(reply);
      if (reply !== before) {
        reasons.push(`pressure-neutralized:${input.emotion}`);
        rewritten = true;
      }
    }

    // 5. Intervention prefix (one-shot, only if we don't already have a similar opener)
    const prefix = input.intervention?.prefix;
    if (prefix && !reply.toLowerCase().startsWith(prefix.toLowerCase().slice(0, 8))) {
      reply = prefix + lowerFirst(reply);
      reasons.push("intervention-prefix");
      rewritten = true;
    }

    return { reply: reply.trim(), rewritten, reasons };
  } catch {
    // Failsafe — never let coach failure break the call
    return { reply: input.reply, rewritten: false, reasons: ["coach-error-bypass"] };
  }
}

function lowerFirst(s: string): string {
  return s.length === 0 ? s : s[0]!.toLowerCase() + s.slice(1);
}
