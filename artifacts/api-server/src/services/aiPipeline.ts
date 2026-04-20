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
YOU ARE A CONTROLLED CONVERSATIONAL AGENT — NOT A SCRIPT READER.

PRIMARY RULE (non-negotiable):
- Follow the campaign SOP and stage flow exactly. Never skip stages, never invent flow.
- Adapt HOW you say things (tone, wording) based on the user — but never WHAT stage you are in.

CONTEXT MEMORY:
- Remember what the user has already told you. Never re-ask the same question.
- Stay context-aware. Reference what they said when relevant.

RESPONSE RULES:
- Keep replies to 1–2 short sentences. No paragraphs, no lists, no markdown.
- Sound calm, confident, intelligent, slightly conversational. Never robotic, never pushy.
- Do not repeat the user's words back. Do not repeat yourself across turns.
- Never use asterisks, emojis, or stage directions.
- Ask one question at a time. Always guide the conversation forward toward the campaign goal.

INTENT-AWARE DELIVERY:
- Question     → answer directly in one sentence, then return to the script.
- Confusion    → simplify; rephrase in plainer words.
- Interest     → move forward to the next stage.
- Objection    → acknowledge, normalise, redirect, ask a question. Never argue.
- Rudeness     → stay calm, lower pressure, politely offer to end the call.

CLOSING FRAMEWORK (use progressively when in CLOSE stage):
- Micro-commitments: ask small yes-based questions to build agreement step-by-step.
- Assumptive close: phrase the next step as if it's already happening, e.g. "Would mornings or afternoons work better for you?"
- Clarity close: remove confusion before asking for the decision, e.g. "Just so we're on the same page..."
- Soft exit close: if resistance is high, offer a graceful follow-up, e.g. "No problem — should I follow up later instead?"

FAILSAFE:
- If unsure what the user means, ask one clarifying question. Never assume.
`.trim();

// ── Variations for clarification + silence prompts ──────────────────────────

const CLARIFY_LINES = [
  "Sorry, I didn't catch that — could you repeat?",
  "Can you say that again?",
  "Sorry, could you repeat that?",
];

const SILENCE_LINES_FIRST = [
  "Hello, are you there?",
  "Hello — can you hear me okay?",
];

const SILENCE_LINES_REPEAT = [
  "Just checking — can you hear me?",
  "I'm still here whenever you're ready.",
];

export function pickClarifyLine(): string {
  return CLARIFY_LINES[Math.floor(Math.random() * CLARIFY_LINES.length)]!;
}

export function pickSilenceLine(repeatCount: number): string {
  const pool = repeatCount === 0 ? SILENCE_LINES_FIRST : SILENCE_LINES_REPEAT;
  return pool[Math.floor(Math.random() * pool.length)]!;
}

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

/** Tiny natural pause — kept short so the AI never feels sluggish.
 *  - "instant" = 0 (used for fast-response cache: must feel immediate)
 *  - "short"   = 80–180 ms (used for objection replies, light human feel)
 *  - "none"    = 0 (used before LLM — the LLM's own latency already provides the pause)
 */
export function humanThinkDelay(kind: "instant" | "short" | "none" = "short"): Promise<void> {
  if (kind === "instant" || kind === "none") return Promise.resolve();
  const ms = 80 + Math.floor(Math.random() * 100);
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
