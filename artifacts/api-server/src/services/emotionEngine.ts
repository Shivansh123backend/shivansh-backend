/**
 * Emotion Engine — text-based emotion detection for live calls.
 *
 * Pure rule-based, zero added latency, zero extra LLM cost.
 *   - Looks at keywords, punctuation, capitalisation, hedging words.
 *   - Optional speech-rate proxy via wordsPerSecond when timing is supplied.
 *
 * Returns one of six labels and a 0–1 intensity. Tracks a rolling history so
 * we can compute a trend (improving / worsening / stable) and a "dominant"
 * emotion to persist with the call log at end-of-call.
 *
 * Failsafe: every public function returns a safe default ("neutral") on error
 * so a detection bug can never break the call pipeline.
 */

export type Emotion =
  | "neutral"
  | "positive"
  | "confused"
  | "frustrated"
  | "angry"
  | "hesitant";

export type EmotionTrend = "improving" | "worsening" | "stable";

export interface EmotionState {
  current: Emotion;
  intensity: number;          // 0–1
  trend: EmotionTrend;
  history: Emotion[];          // rolling window (last ~10 turns)
}

export function createEmotionState(): EmotionState {
  return { current: "neutral", intensity: 0, trend: "stable", history: [] };
}

// ── Keyword + pattern dictionaries ────────────────────────────────────────────
const POSITIVE_RX = [
  /\b(great|good|nice|awesome|perfect|excellent|cool|love|like|interested|sounds good|tell me more|please do|sure|of course|yeah sure|absolutely)\b/,
];
const CONFUSED_RX = [
  /\b(what\??$|huh\??$|come again|what do you mean|don'?t (get|understand)|confused|not sure what|how (do|does) that|repeat|say (it|that) again)\b/,
];
const FRUSTRATED_RX = [
  /\b(just (tell|get) me|get to the point|enough|seriously\b|wasting (my )?time|already (told|said)|i (already|literally) said|stop calling|how many times)\b/,
];
const ANGRY_RX = [
  /\b(fuck|shit|damn|piss off|go to hell|shut up|asshole|bullshit|fucking|hell no)\b/,
  /\b(scam|fraud|harassing|harassment|sue|lawyer|report you)\b/,
];
const HESITANT_RX = [
  /\b(maybe|i guess|kind of|sort of|i'?m not sure|i don'?t know|let me think|hmm|uh|um|well\.\.\.|i suppose)\b/,
  /\b(probably|possibly|might|could be)\b/,
];

const PRESSURE_PHRASES = [
  /\b(you really should|you need to|you have to|you must|don'?t miss|last chance|today only|right now)\b/gi,
];

/** Returns a tone-cleaned reply with high-pressure phrases neutralised. */
export function neutralizePressureLanguage(reply: string): string {
  let out = reply;
  for (const re of PRESSURE_PHRASES) {
    out = out.replace(re, "you might consider");
  }
  return out;
}

/** Classify a single utterance. */
export function detectEmotion(opts: {
  text: string;
  wordsPerSecond?: number;       // optional speech-rate proxy
}): { emotion: Emotion; intensity: number } {
  try {
    const raw = (opts.text ?? "").trim();
    if (!raw) return { emotion: "neutral", intensity: 0 };
    const t = raw.toLowerCase();

    // Anger first (strongest), then frustration, confusion, hesitation, positive
    if (ANGRY_RX.some((r) => r.test(t))) {
      return { emotion: "angry", intensity: intensityFrom(raw, 0.85) };
    }
    if (FRUSTRATED_RX.some((r) => r.test(t))) {
      return { emotion: "frustrated", intensity: intensityFrom(raw, 0.7) };
    }
    if (CONFUSED_RX.some((r) => r.test(t))) {
      return { emotion: "confused", intensity: intensityFrom(raw, 0.55) };
    }
    if (HESITANT_RX.some((r) => r.test(t))) {
      return { emotion: "hesitant", intensity: intensityFrom(raw, 0.45) };
    }
    if (POSITIVE_RX.some((r) => r.test(t))) {
      return { emotion: "positive", intensity: intensityFrom(raw, 0.6) };
    }

    // Speech-rate proxy: very fast or very slow shifts neutral toward stress/hesitation.
    if (typeof opts.wordsPerSecond === "number") {
      if (opts.wordsPerSecond > 4.0) return { emotion: "frustrated", intensity: 0.4 };
      if (opts.wordsPerSecond > 0 && opts.wordsPerSecond < 1.2) return { emotion: "hesitant", intensity: 0.4 };
    }

    return { emotion: "neutral", intensity: 0.2 };
  } catch {
    return { emotion: "neutral", intensity: 0 };
  }
}

/** Heuristic intensity: punctuation + caps boost. Capped at 1. */
function intensityFrom(raw: string, base: number): number {
  const exclaims = (raw.match(/!/g) ?? []).length;
  const caps = raw.replace(/[^A-Z]/g, "").length;
  const capRatio = raw.length > 0 ? caps / raw.length : 0;
  let i = base + Math.min(0.15, exclaims * 0.05) + (capRatio > 0.4 ? 0.15 : 0);
  return Math.max(0, Math.min(1, i));
}

const NEGATIVE_SET = new Set<Emotion>(["frustrated", "angry"]);
const POSITIVE_SET = new Set<Emotion>(["positive"]);

function score(e: Emotion): number {
  if (POSITIVE_SET.has(e)) return 1;
  if (e === "neutral" || e === "hesitant") return 0;
  if (e === "confused") return -1;
  if (NEGATIVE_SET.has(e)) return -2;
  return 0;
}

/** Update emotion state with a new utterance. Mutates and returns memory. */
export function observeEmotion(state: EmotionState, opts: {
  text: string;
  wordsPerSecond?: number;
}): EmotionState {
  try {
    const { emotion, intensity } = detectEmotion(opts);
    state.current = emotion;
    state.intensity = intensity;
    state.history.push(emotion);
    if (state.history.length > 10) state.history.shift();

    const recent = state.history.slice(-4);
    const earlier = state.history.slice(-8, -4);
    if (recent.length >= 2 && earlier.length >= 2) {
      const r = recent.reduce((a, e) => a + score(e), 0) / recent.length;
      const p = earlier.reduce((a, e) => a + score(e), 0) / earlier.length;
      if (r > p + 0.3) state.trend = "improving";
      else if (r < p - 0.3) state.trend = "worsening";
      else state.trend = "stable";
    }
    return state;
  } catch {
    return state;  // never throw
  }
}

/** Pick the emotion that appeared most often (used at call end for storage). */
export function dominantEmotion(state: EmotionState | null | undefined): Emotion {
  try {
    if (!state || !Array.isArray(state.history) || state.history.length === 0) return "neutral";
    const counts = new Map<Emotion, number>();
    for (const e of state.history) counts.set(e, (counts.get(e) ?? 0) + 1);
    let best: Emotion = "neutral";
    let max = -1;
    for (const [e, c] of counts) if (c > max) { best = e; max = c; }
    return best;
  } catch {
    return "neutral";
  }
}
