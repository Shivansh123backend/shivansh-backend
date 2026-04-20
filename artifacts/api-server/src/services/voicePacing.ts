/**
 * Voice Pacing Engine.
 *
 * Pure text transformer that runs immediately before each TTS chunk is sent
 * to Cartesia. Cartesia (and most modern TTS engines) honour ellipses ("…")
 * and explicit punctuation as natural prosodic pauses, so we can shape rhythm
 * with text alone — no extra audio plumbing, zero added latency.
 *
 * Rules:
 *   1. Insert a soft pause ("… ") after commas / semicolons that don't already
 *      have one.
 *   2. Insert a longer pause before "important" keywords (price, free, today,
 *      because, but, however, actually) so they land with weight.
 *   3. Cap consecutive run-ons: if the chunk has no internal punctuation but
 *      is long, inject a soft mid-pause at a natural word boundary.
 *   4. Optionally vary the trailing pause to break perfect cadence.
 *
 * Failsafe: any error returns the original text unchanged.
 */

const IMPORTANT_KEYWORDS = [
  "price", "pricing", "cost", "free", "today", "tomorrow",
  "because", "but", "however", "actually", "honestly",
  "important", "guarantee", "limited", "exclusive",
];

const RUN_ON_THRESHOLD = 90;   // chars without any punctuation
const RUN_ON_TARGET   = 60;    // place soft pause near this offset

export interface PacingOptions {
  /** Tighten or loosen pacing based on caller emotion / prediction. */
  intensity?: "calm" | "normal" | "energetic";
}

/** Apply pacing transformations and return the rewritten chunk. */
export function applyPacing(text: string, opts: PacingOptions = {}): string {
  try {
    const intensity = opts.intensity ?? "normal";
    let out = text;

    // 1. Soft pause after commas/semicolons
    out = out.replace(/([,;])\s+/g, "$1… ");

    // 2. Longer pause before important keywords (only when they're mid-sentence)
    const kwRe = new RegExp(`\\b(${IMPORTANT_KEYWORDS.join("|")})\\b`, "gi");
    out = out.replace(kwRe, (match, _kw, offset, full) => {
      // Skip if we're already at the start, after punctuation, or already preceded by ellipsis
      const prevChar = full[offset - 1] ?? "";
      if (offset === 0 || /[.!?…]/.test(prevChar)) return match;
      if (full.slice(Math.max(0, offset - 2), offset) === "… ") return match;
      return `… ${match}`;
    });

    // 3. Run-on splitting — break very long unpunctuated stretches at a word
    //    boundary so it doesn't sound like a single robotic burst.
    if (out.length > RUN_ON_THRESHOLD && !/[,.;!?…]/.test(out.slice(0, RUN_ON_THRESHOLD))) {
      const pivot = out.lastIndexOf(" ", RUN_ON_TARGET);
      if (pivot > 20) {
        out = out.slice(0, pivot) + "…" + out.slice(pivot);
      }
    }

    // 4. Calm intensity → add a tiny breath at the end so the next sentence
    //    doesn't crowd in. Energetic → no trailing pause.
    if (intensity === "calm" && !/[…!?]\s*$/.test(out)) {
      out = out.replace(/\s*$/, " …");
    }

    // Collapse any accidental double-ellipses created by the rules above
    out = out.replace(/(…\s*){2,}/g, "… ");

    return out;
  } catch {
    return text;  // never break TTS over a pacing bug
  }
}

/** Map an emotion / health hint to pacing intensity. */
export function paceForEmotion(emotion: string | undefined): PacingOptions["intensity"] {
  switch (emotion) {
    case "angry":
    case "frustrated":
    case "hesitant":
      return "calm";
    case "positive":
      return "energetic";
    default:
      return "normal";
  }
}
