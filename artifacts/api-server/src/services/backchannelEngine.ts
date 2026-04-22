/**
 * Backchannel / filler injection — masks the silence between the caller
 * finishing speaking and the AI's first reply word, the way a human
 * conversationalist drops in "mm-hmm" / "right" while thinking.
 *
 * How it works:
 *   1. On bridge start we lazily pre-render each phrase via Cartesia → mulaw
 *      8 kHz raw audio chunks, cached in memory keyed by voiceId+phrase.
 *   2. When the caller finishes speaking and we're about to invoke the LLM,
 *      we instantly write the cached chunks to Telnyx (synchronous send,
 *      no network round-trip) — so the caller hears "mm-hmm" within ~30 ms
 *      of finishing, hiding the 400-700 ms LLM+TTS round-trip.
 *   3. The main reply audio queues up right behind the backchannel on the
 *      same WebSocket, so the two play back-to-back with no gap.
 *
 * Throttling rules (avoid sounding robotic):
 *   - Min 7 s gap between consecutive backchannels
 *   - Never repeat the same phrase twice in a row
 *   - Skip if caller said <3 words (they're being terse — don't double-up)
 *   - Skip if cache miss (we kick off a background warm so next time works)
 *   - Skip if AI is already speaking (e.g. reply still streaming from prior turn)
 */

import { logger } from "../lib/logger.js";

const CARTESIA_API_KEY = process.env.CARTESIA_API_KEY ?? "";
const CARTESIA_VERSION = "2025-04-16";
const CARTESIA_MODEL   = "sonic-2";

const PHRASES = ["Mm-hmm.", "Right.", "Okay.", "Got it.", "I see.", "Sure."];

// voiceId:phrase -> ordered base64 mulaw chunks
const cache = new Map<string, string[]>();
// In-flight warming so we don't fire the same Cartesia request twice
const warming = new Map<string, Promise<void>>();

function key(voiceId: string, phrase: string): string {
  return `${voiceId}::${phrase}`;
}

async function synthesizeOne(voiceId: string, phrase: string): Promise<void> {
  const k = key(voiceId, phrase);
  if (cache.has(k)) return;
  const existing = warming.get(k);
  if (existing) return existing;

  const p = (async () => {
    try {
      const res = await fetch("https://api.cartesia.ai/tts/sse", {
        method: "POST",
        headers: {
          "X-API-Key": CARTESIA_API_KEY,
          "Cartesia-Version": CARTESIA_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model_id: CARTESIA_MODEL,
          transcript: phrase,
          voice: { mode: "id", id: voiceId },
          output_format: {
            container: "raw",
            encoding: "pcm_mulaw",
            sample_rate: 8000,
          },
        }),
      });

      if (!res.ok || !res.body) {
        logger.warn({ status: res.status, phrase }, "Backchannel synth failed");
        return;
      }

      const chunks: string[] = [];
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const json = line.slice(6).trim();
          if (!json || json === "[DONE]") continue;
          try {
            const ev = JSON.parse(json) as { type?: string; data?: string };
            if (ev.type === "chunk" && ev.data) chunks.push(ev.data);
          } catch { /* ignore */ }
        }
      }

      if (chunks.length > 0) {
        cache.set(k, chunks);
        logger.info({ voiceId, phrase, chunks: chunks.length }, "Backchannel cached");
      }
    } catch (err) {
      logger.warn({ err: String(err), phrase }, "Backchannel synth error");
    } finally {
      warming.delete(k);
    }
  })();

  warming.set(k, p);
  return p;
}

/** Fire-and-forget warm of every phrase for a given voice. Call once at bridge start. */
export function warmBackchannelCache(voiceId: string): void {
  if (!CARTESIA_API_KEY) return;
  for (const phrase of PHRASES) {
    synthesizeOne(voiceId, phrase).catch(() => { /* logged inside */ });
  }
}

export interface BackchannelContext {
  voiceId: string;
  send: (ulawB64: string) => void;
  isClosed: boolean;
  isAiSpeaking: boolean;
  lastBackchannelAt: number;
  lastBackchannelPhrase: string | null;
  userTurnCount: number;       // 1 = first user turn after greeting
}

/**
 * Returns the chosen phrase (for state bookkeeping) or null if skipped.
 * Caller is responsible for updating lastBackchannelAt/lastBackchannelPhrase
 * on the returned value.
 */
export function maybePlayBackchannel(
  ctx: BackchannelContext,
  userTranscript: string,
): { phrase: string; playedAt: number } | null {
  if (ctx.isClosed || ctx.isAiSpeaking) return null;

  // Allow backchannel from the FIRST user response onward. The first turn
  // (name confirmation: "Yes, this is me", "Speaking", etc.) is the single
  // most-noticeable LLM-latency gap in the call — masking it with a quick
  // "Got it." / "Great." feels human and shaves ~1.5 s of perceived wait.
  if (ctx.userTurnCount < 1) return null;

  // Skip if user was extremely terse (single word like "yes"/"no") — those
  // get a direct reply, no double-acknowledgement. 2+ words feel natural to
  // backchannel on the first turn ("yes that's me", "speaking yes", etc.).
  const wordCount = userTranscript.split(/\s+/).filter(Boolean).length;
  if (wordCount < 2) return null;

  // Throttle: 6 s minimum gap (was 7 s). Slightly tighter so the second
  // qualifying question after the greeting still gets acknowledged.
  const now = Date.now();
  if (ctx.lastBackchannelAt && now - ctx.lastBackchannelAt < 6000) return null;

  // Pick a phrase that isn't the previous one.
  const candidates = PHRASES.filter(p => p !== ctx.lastBackchannelPhrase);
  const phrase = candidates[Math.floor(Math.random() * candidates.length)];

  const chunks = cache.get(key(ctx.voiceId, phrase));
  if (!chunks || chunks.length === 0) {
    // Cold cache — kick off background warm so next turn has it.
    synthesizeOne(ctx.voiceId, phrase).catch(() => {});
    return null;
  }

  // Synchronous WS sends — completes in microseconds, queues before main reply.
  for (const chunk of chunks) {
    if (ctx.isClosed) return null;
    ctx.send(chunk);
  }

  return { phrase, playedAt: now };
}
