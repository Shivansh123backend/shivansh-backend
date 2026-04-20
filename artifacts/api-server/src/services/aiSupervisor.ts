/**
 * AI Supervisor (Steps 13–14, 19 of enhancement plan).
 *
 * Lightweight, rule-based real-time sentiment/health tracker. Runs on every
 * caller transcript line. Updates a per-call SupervisorMemory the bridge can
 * read to decide whether to invoke the intervention engine.
 *
 * No extra LLM call — keeps the hot path fast.
 */

import {
  createEmotionState,
  observeEmotion,
  type Emotion,
  type EmotionState,
} from "./emotionEngine.js";

export type Sentiment = "positive" | "neutral" | "negative";

export interface SupervisorMemory {
  // Rolling sentiment trend (last N entries)
  sentimentHistory: Sentiment[];
  // Counters for warning signals
  confusionCount: number;
  frustrationCount: number;
  silenceCount: number;
  repeatCount: number;             // times the AI said something nearly identical to a prior turn
  // Aggregate health score (0–100, higher = healthier)
  health: number;
  // Last assistant texts for repetition detection
  lastAssistantTexts: string[];
  // Per-call emotion tracking
  emotion: EmotionState;
}

export function createSupervisorMemory(): SupervisorMemory {
  return {
    sentimentHistory: [],
    confusionCount: 0,
    frustrationCount: 0,
    silenceCount: 0,
    repeatCount: 0,
    health: 100,
    lastAssistantTexts: [],
    emotion: createEmotionState(),
  };
}

const POSITIVE = [
  /\bgreat\b/, /\bgood\b/, /\bsure\b/, /\byes\b/, /\bok(ay)?\b/,
  /\bsounds (good|great)\b/, /\binterested\b/, /\btell me more\b/,
  /\bawesome\b/, /\bperfect\b/, /\bthanks?\b/, /\bappreciate\b/,
];
const NEGATIVE = [
  /\bnot interested\b/, /\bno\b/, /\bstop\b/, /\bremove me\b/,
  /\bgo away\b/, /\bdon'?t call\b/, /\bbusy\b/, /\bfuck\b/, /\bhate\b/,
  /\bannoying\b/, /\bwaste\b/, /\bscam\b/,
];
const CONFUSION = [
  /\bwhat\??$/, /\bwhat do you mean\b/, /\bi don'?t understand\b/,
  /\brepeat\b/, /\bcome again\b/, /\bsay (that|it) again\b/,
  /\bnot sure what\b/, /\bconfused\b/, /\bhuh\??$/,
];
const FRUSTRATION = [
  /\bjust (tell|get) me\b/, /\benough\b/, /\bstop (calling|talking)\b/,
  /\bi (already|literally) said\b/, /\b(seriously|honestly)[,!.]/,
  /\bwasting (my )?time\b/, /\bget to the point\b/,
];

function classify(text: string): Sentiment {
  const t = text.toLowerCase();
  if (NEGATIVE.some((r) => r.test(t))) return "negative";
  if (POSITIVE.some((r) => r.test(t))) return "positive";
  return "neutral";
}

/** Process a caller transcript line. Returns updated memory. */
export function observeUserTurn(mem: SupervisorMemory, text: string): SupervisorMemory {
  const t = text.toLowerCase().trim();
  if (!t) return mem;

  // Sentiment
  const sent = classify(t);
  mem.sentimentHistory.push(sent);
  if (mem.sentimentHistory.length > 8) mem.sentimentHistory.shift();

  // Confusion / frustration
  if (CONFUSION.some((r) => r.test(t))) mem.confusionCount += 1;
  if (FRUSTRATION.some((r) => r.test(t))) mem.frustrationCount += 1;

  // Emotion (additive — never throws)
  observeEmotion(mem.emotion, { text });

  // Update health: each negative / confusion / frustration drops it,
  // each positive nudges it back up. Bounded 0–100.
  let delta = 0;
  if (sent === "negative") delta -= 8;
  if (sent === "positive") delta += 4;
  if (CONFUSION.some((r) => r.test(t))) delta -= 6;
  if (FRUSTRATION.some((r) => r.test(t))) delta -= 12;
  mem.health = Math.max(0, Math.min(100, mem.health + delta));

  return mem;
}

/** Called when a silence prompt fires. */
export function observeSilence(mem: SupervisorMemory): SupervisorMemory {
  mem.silenceCount += 1;
  mem.health = Math.max(0, mem.health - 5);
  return mem;
}

/** Called when the assistant produces a reply. Detects repetition vs prior turns. */
export function observeAssistantTurn(mem: SupervisorMemory, text: string): SupervisorMemory {
  const norm = text.toLowerCase().replace(/[^\w\s]/g, "").trim();
  if (!norm) return mem;
  const isRepeat = mem.lastAssistantTexts.some((prev) => similarity(prev, norm) >= 0.85);
  if (isRepeat) {
    mem.repeatCount += 1;
    mem.health = Math.max(0, mem.health - 6);
  }
  mem.lastAssistantTexts.push(norm);
  if (mem.lastAssistantTexts.length > 4) mem.lastAssistantTexts.shift();
  return mem;
}

/** Crude Jaccard similarity over word sets — fast, no deps. */
function similarity(a: string, b: string): number {
  const sa = new Set(a.split(/\s+/));
  const sb = new Set(b.split(/\s+/));
  const inter = [...sa].filter((w) => sb.has(w)).length;
  const union = new Set([...sa, ...sb]).size;
  return union === 0 ? 0 : inter / union;
}

/** Health classification used by the intervention engine. */
export type HealthSignal =
  | "ok"
  | "confused"
  | "frustrated"
  | "angry"
  | "hesitant"
  | "disengaged"
  | "degrading";

export function deriveSignal(mem: SupervisorMemory): HealthSignal {
  // Emotion takes priority — anger is the strongest signal
  if (mem.emotion.current === "angry") return "angry";
  if (mem.frustrationCount >= 1 || mem.emotion.current === "frustrated") return "frustrated";
  if (mem.confusionCount >= 2 || mem.emotion.current === "confused") return "confused";
  if (mem.silenceCount >= 2) return "disengaged";
  // Sentiment trend: 3 of last 4 negatives = degrading
  const recent = mem.sentimentHistory.slice(-4);
  const negs = recent.filter((s) => s === "negative").length;
  if (negs >= 3 || mem.health < 40 || mem.emotion.trend === "worsening") return "degrading";
  if (mem.emotion.current === "hesitant") return "hesitant";
  return "ok";
}

export type { Emotion };
