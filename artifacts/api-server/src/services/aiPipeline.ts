/**
 * AI Conversation Pipeline — production quality controls.
 *
 * Layers (applied before/around the LLM call):
 *   1. Input filtering        — reject low-confidence / filler / too-short transcripts
 *   2. Fast-response cache    — instant canned answers for common questions (bypass LLM)
 *   3. Intent classifier      — keyword-based labels for the LLM
 *   4. State machine          — INTRO → QUALIFY → DISCOVER → PITCH → OBJECTION → CLOSE → END
 *   5. Output style guidance  — appended to the system prompt for natural, short responses
 *   6. Timing layer           — randomised 300–800 ms thinking delay before responding
 */

import { logger } from "../lib/logger.js";

// ── 1. Input filtering ──────────────────────────────────────────────────────

const FILLERS = new Set([
  "uh", "um", "hmm", "ah", "oh", "eh", "huh", "mm", "mhm", "uhm", "er",
  "ok", "okay", "yeah", "yep", "yup", "nope",
]);

export interface FilterResult {
  accept: boolean;
  reason?: "low_confidence" | "too_short" | "filler";
  promptResponse?: string;   // optional canned reply (e.g. "Hello, are you there?")
}

export function filterTranscript(transcript: string, confidence: number): FilterResult {
  const clean = transcript.trim().toLowerCase();
  if (confidence < 0.6) {
    return { accept: false, reason: "low_confidence" };
  }
  if (clean.length < 2) {
    return { accept: false, reason: "too_short" };
  }
  const words = clean.split(/\s+/);
  if (words.length <= 2 && words.every((w) => FILLERS.has(w.replace(/[.,!?]/g, "")))) {
    return { accept: false, reason: "filler" };
  }
  return { accept: true };
}

// ── 2. Fast-response cache ──────────────────────────────────────────────────

interface FastResponseRule {
  patterns: RegExp[];
  reply: string;
}

const FAST_RESPONSES: FastResponseRule[] = [
  {
    patterns: [
      /\bwhere are you (calling|phoning) from\b/,
      /\bwhich (company|firm|business)\b/,
      /\bwho do you (work|represent) for\b/,
    ],
    reply: "I'm calling from Cloudisoft regarding your earlier interest in our services.",
  },
  {
    patterns: [
      /\bwho is (this|calling|speaking)\b/,
      /\byour name\b/,
      /\bmay i (know|ask) (your name|who)\b/,
    ],
    reply: "This is John from Cloudisoft.",
  },
  {
    patterns: [
      /\bhow did you get my (number|contact|details)\b/,
      /\bwhere did you get\b/,
    ],
    reply: "You had previously shown interest in our services and shared your number with us.",
  },
  {
    patterns: [
      /\b(can you )?repeat( that)?\b/,
      /\bsay (that|it) again\b/,
      /\bsorry,? what\b/,
      /\bpardon\b/,
    ],
    reply: "Of course — let me say that again.",
  },
];

export function getFastResponse(transcript: string): string | null {
  const t = transcript.trim().toLowerCase();
  for (const rule of FAST_RESPONSES) {
    if (rule.patterns.some((p) => p.test(t))) return rule.reply;
  }
  return null;
}

// ── 3. Intent classifier ────────────────────────────────────────────────────

export type Intent =
  | "question"
  | "objection_price"
  | "objection_time"
  | "rejection"
  | "positive"
  | "neutral";

const PRICE_KEYWORDS = ["price", "cost", "expensive", "cheap", "afford", "fees", "charges", "pricing", "budget"];
const TIME_KEYWORDS = ["busy", "later", "not now", "call back", "another time", "no time"];
const REJECTION_KEYWORDS = [
  "not interested", "don't call", "stop calling", "remove me", "leave me alone",
  "no thanks", "no thank you", "fuck", "shut up", "go away",
];
const POSITIVE_KEYWORDS = [
  "yes", "sure", "okay", "ok", "great", "sounds good", "interested", "tell me more",
  "go ahead", "please do", "absolutely", "definitely",
];

export function classifyIntent(transcript: string): Intent {
  const t = transcript.trim().toLowerCase();
  if (t.endsWith("?") || /^(what|why|how|when|where|who|can|could|do|does|is|are)\b/.test(t)) {
    return "question";
  }
  if (REJECTION_KEYWORDS.some((k) => t.includes(k))) return "rejection";
  if (PRICE_KEYWORDS.some((k) => t.includes(k))) return "objection_price";
  if (TIME_KEYWORDS.some((k) => t.includes(k))) return "objection_time";
  if (POSITIVE_KEYWORDS.some((k) => new RegExp(`\\b${k}\\b`).test(t))) return "positive";
  return "neutral";
}

// ── 4. State machine ────────────────────────────────────────────────────────

export type ConversationState =
  | "INTRO"
  | "QUALIFY"
  | "DISCOVER"
  | "PITCH"
  | "OBJECTION"
  | "CLOSE"
  | "END";

const TRANSITIONS: Record<ConversationState, Partial<Record<Intent, ConversationState>>> = {
  INTRO:     { positive: "QUALIFY",  question: "QUALIFY",  rejection: "END",     objection_price: "OBJECTION", objection_time: "END",       neutral: "QUALIFY"  },
  QUALIFY:   { positive: "DISCOVER", question: "DISCOVER", rejection: "END",     objection_price: "OBJECTION", objection_time: "END",       neutral: "DISCOVER" },
  DISCOVER:  { positive: "PITCH",    question: "DISCOVER", rejection: "END",     objection_price: "OBJECTION", objection_time: "END",       neutral: "PITCH"    },
  PITCH:     { positive: "CLOSE",    question: "PITCH",    rejection: "OBJECTION", objection_price: "OBJECTION", objection_time: "END",     neutral: "PITCH"    },
  OBJECTION: { positive: "CLOSE",    question: "OBJECTION",rejection: "END",     objection_price: "OBJECTION", objection_time: "END",       neutral: "PITCH"    },
  CLOSE:     { positive: "END",      question: "CLOSE",    rejection: "OBJECTION", objection_price: "OBJECTION", objection_time: "END",     neutral: "CLOSE"    },
  END:       {},
};

export function nextState(current: ConversationState, intent: Intent): ConversationState {
  if (current === "END") return "END";
  return TRANSITIONS[current][intent] ?? current;
}

const STATE_GUIDANCE: Record<ConversationState, string> = {
  INTRO:     "Greet warmly, introduce yourself in one short sentence, and ask if it is a good time.",
  QUALIFY:   "Confirm you have the right person and briefly state the reason for the call.",
  DISCOVER:  "Ask one open-ended question to understand the prospect's need or current situation.",
  PITCH:     "Share one specific benefit relevant to what the prospect just said. One sentence.",
  OBJECTION: "Acknowledge their concern, then respond calmly with one reassuring point. Do not argue.",
  CLOSE:     "Propose a clear next step — a callback time, a meeting, or sending information.",
  END:       "Thank them politely and end the call in one short sentence.",
};

// ── 5. Output style guidance ────────────────────────────────────────────────

const OUTPUT_STYLE = `
RESPONSE RULES (always follow):
- Keep replies to 1–2 short sentences. Never use paragraphs or bullet lists.
- Sound natural, calm, confident — like a friendly human, not a script.
- Do not repeat what the user said. Do not repeat yourself across turns.
- Never use markdown, asterisks, emojis, or stage directions.
- If the user is rude or hostile, stay calm and polite, then offer to end the call.
- If the user asks a question you cannot answer, say so briefly and offer to follow up.
`.trim();

export function buildSystemPrompt(
  basePrompt: string,
  state: ConversationState,
  intent: Intent,
): string {
  return [
    basePrompt.trim(),
    "",
    OUTPUT_STYLE,
    "",
    `CURRENT CONVERSATION STAGE: ${state}`,
    `STAGE GOAL: ${STATE_GUIDANCE[state]}`,
    `LAST DETECTED INTENT: ${intent}`,
  ].join("\n");
}

// ── 6. Timing layer ─────────────────────────────────────────────────────────

export function humanThinkDelay(): Promise<void> {
  const ms = 300 + Math.floor(Math.random() * 500); // 300–800 ms
  return new Promise((r) => setTimeout(r, ms));
}

// ── 7. Logging helper ───────────────────────────────────────────────────────

export function logTurn(callControlId: string, info: {
  transcript?: string;
  confidence?: number;
  intent?: Intent;
  state?: ConversationState;
  nextState?: ConversationState;
  filtered?: string;
  fastResponse?: boolean;
}): void {
  logger.info({ callControlId, pipeline: info }, "AI turn");
}
