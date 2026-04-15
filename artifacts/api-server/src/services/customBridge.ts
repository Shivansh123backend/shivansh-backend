/**
 * Custom AI Calling Bridge — Deepgram STT + GPT-4o LLM + Cartesia TTS
 *
 * Architecture (identical to Vapi's internal stack):
 *   Telnyx µ-law 8kHz → Deepgram Nova-2 (STT) → GPT-4o (LLM) → Cartesia Sonic (TTS) → Telnyx
 *
 * Features:
 *   - Deepgram Nova-2 phonecall model: best accuracy on phone audio
 *   - GPT-4o streaming: fastest + smartest LLM for conversation
 *   - Cartesia Sonic-2: sub-100ms TTS latency, extremely natural voice
 *   - Barge-in: caller can interrupt mid-sentence, AI stops immediately
 *   - Sentence-level streaming: AI starts speaking within ~200ms of finishing a sentence
 */

import WebSocket from "ws";
import OpenAI from "openai";
import { logger } from "../lib/logger.js";

const DEEPGRAM_API_KEY  = process.env.DEEPGRAM_API_KEY ?? "";
const CARTESIA_API_KEY  = process.env.CARTESIA_API_KEY ?? "";
const CARTESIA_VERSION  = "2025-04-16";
const CARTESIA_MODEL    = "sonic-2";

// Default Cartesia voice — professional female, very natural on phone calls
// Override via CARTESIA_VOICE_ID env var
const DEFAULT_CARTESIA_VOICE =
  process.env.CARTESIA_VOICE_ID ?? "694f9389-aac1-45b6-b726-9d9369183238";

const openai = new OpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ?? undefined,
  apiKey:
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY ??
    process.env.OPENAI_API_KEY ??
    "placeholder",
});

// ── Types ───────────────────────────────────────────────────────────────────

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

interface BridgeState {
  callControlId: string;
  systemPrompt: string;
  firstMessage: string;
  cartesiaVoiceId: string;
  telnyxWs: WebSocket;
  deepgramWs: WebSocket | null;
  messages: Message[];
  isAiSpeaking: boolean;
  currentTurnId: number;           // increments on each new turn — barge-in detection
  isClosed: boolean;
  transcriptCallback?: (text: string) => void;
}

const bridges = new Map<string, BridgeState>();

// ── Audio helpers ────────────────────────────────────────────────────────────

/** Send base64-encoded µ-law audio back to Telnyx */
function injectAudio(state: BridgeState, ulawB64: string): void {
  if (state.isClosed || state.telnyxWs.readyState !== WebSocket.OPEN) return;
  state.telnyxWs.send(JSON.stringify({
    event: "media",
    media: { payload: ulawB64 },
  }));
}

// ── Cartesia TTS ─────────────────────────────────────────────────────────────

/**
 * Speak a text string via Cartesia and pipe audio to Telnyx.
 * Returns once the audio is fully played (or on barge-in).
 */
async function speakText(
  state: BridgeState,
  text: string,
  turnId: number,
  continueContext: boolean
): Promise<void> {
  if (state.isClosed || state.currentTurnId !== turnId || !text.trim()) return;

  try {
    const body = JSON.stringify({
      model_id: CARTESIA_MODEL,
      transcript: text,
      voice: { mode: "id", id: state.cartesiaVoiceId },
      output_format: {
        container: "raw",
        encoding: "pcm_mulaw",   // Telnyx-native format — zero conversion needed
        sample_rate: 8000,
      },
      context_id: `turn-${turnId}`,
      continue: continueContext,  // tells Cartesia more text is coming in this turn
    });

    const res = await fetch("https://api.cartesia.ai/tts/sse", {
      method: "POST",
      headers: {
        "X-API-Key": CARTESIA_API_KEY,
        "Cartesia-Version": CARTESIA_VERSION,
        "Content-Type": "application/json",
      },
      body,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => "");
      logger.warn({ status: res.status, errText }, "Cartesia TTS error");
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";

    while (true) {
      // Check for barge-in on every chunk
      if (state.isClosed || state.currentTurnId !== turnId) {
        reader.cancel().catch(() => {});
        return;
      }

      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr || jsonStr === "[DONE]") continue;

        try {
          const event = JSON.parse(jsonStr) as {
            type?: string;
            data?: string;
            done?: boolean;
          };

          if (event.type === "chunk" && event.data) {
            injectAudio(state, event.data);
          }
        } catch {
          // ignore parse errors
        }
      }
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      logger.error({ err: String(err) }, "Cartesia stream error");
    }
  }
}

// ── GPT-4o LLM ───────────────────────────────────────────────────────────────

/** Regex to detect sentence boundaries for streaming TTS */
const SENTENCE_END = /([.!?]["']?\s)|([.!?]["']?$)/;

/**
 * Generate GPT-4o response and stream it sentence-by-sentence to Cartesia.
 * Uses turn IDs for barge-in: if turnId changes mid-stream, we abort.
 */
async function generateAndSpeak(state: BridgeState, userText: string): Promise<void> {
  if (state.isClosed) return;

  state.messages.push({ role: "user", content: userText });
  state.isAiSpeaking = true;
  const turnId = ++state.currentTurnId;

  logger.info(
    { callControlId: state.callControlId, userText: userText.slice(0, 100) },
    "Custom bridge: GPT-4o turn"
  );

  let fullResponse = "";
  let textBuffer = "";

  try {
    const stream = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: state.messages,
      max_completion_tokens: 180,
      temperature: 0.82,
      stream: true,
    });

    for await (const chunk of stream) {
      if (state.isClosed || state.currentTurnId !== turnId) break;

      const delta = chunk.choices[0]?.delta?.content ?? "";
      if (!delta) continue;

      fullResponse += delta;
      textBuffer += delta;

      // Flush text to Cartesia at sentence boundaries for low latency
      const match = textBuffer.search(SENTENCE_END);
      if (match !== -1) {
        const sentence = textBuffer.slice(0, match + 1).trim();
        textBuffer = textBuffer.slice(match + 1).trim();
        if (sentence) {
          // continueContext=true means more text is coming (better prosody across sentences)
          await speakText(state, sentence, turnId, true);
        }
      }
    }

    // Flush remaining text
    if (textBuffer.trim() && !state.isClosed && state.currentTurnId === turnId) {
      await speakText(state, textBuffer.trim(), turnId, false);
    }

    if (fullResponse.trim()) {
      state.messages.push({ role: "assistant", content: fullResponse.trim() });
    }
  } catch (err) {
    logger.error({ err: String(err), callControlId: state.callControlId }, "GPT-4o error");
  } finally {
    if (state.currentTurnId === turnId) {
      state.isAiSpeaking = false;
    }
  }
}

// ── Deepgram STT ─────────────────────────────────────────────────────────────

function connectDeepgram(state: BridgeState): void {
  const params = new URLSearchParams({
    model: "nova-2-phonecall",
    encoding: "mulaw",
    sample_rate: "8000",
    channels: "1",
    endpointing: "400",          // 400ms silence = end of utterance
    interim_results: "true",
    smart_format: "true",
    punctuate: "true",
    no_delay: "true",            // reduce transcript latency
  });

  const dgWs = new WebSocket(
    `wss://api.deepgram.com/v1/listen?${params}`,
    { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } }
  );

  state.deepgramWs = dgWs;

  dgWs.on("open", () => {
    logger.info({ callControlId: state.callControlId }, "Deepgram connected");

    // Speak first message immediately as AI's opening line
    if (state.firstMessage.trim()) {
      state.messages.push({ role: "assistant", content: state.firstMessage });
      state.isAiSpeaking = true;
      const turnId = ++state.currentTurnId;
      speakText(state, state.firstMessage, turnId, false)
        .then(() => { if (state.currentTurnId === turnId) state.isAiSpeaking = false; })
        .catch(() => { state.isAiSpeaking = false; });
    }
  });

  dgWs.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString()) as {
        type?: string;
        channel?: { alternatives?: Array<{ transcript?: string; confidence?: number }> };
        speech_final?: boolean;
        is_final?: boolean;
      };

      if (msg.type !== "Results") return;

      const alt = msg.channel?.alternatives?.[0];
      const transcript = (alt?.transcript ?? "").trim();
      const confidence = alt?.confidence ?? 0;

      if (!transcript || confidence < 0.25) return;

      // speech_final = Deepgram is confident the utterance is complete
      if (msg.speech_final) {
        logger.info(
          { callControlId: state.callControlId, transcript, confidence },
          "Deepgram speech_final"
        );

        state.transcriptCallback?.(transcript);

        // Barge-in: cancel current AI speech by advancing turnId
        if (state.isAiSpeaking) {
          state.currentTurnId++;           // invalidates in-flight speakText calls
          state.isAiSpeaking = false;
          logger.info({ callControlId: state.callControlId }, "Barge-in — AI interrupted");
        }

        generateAndSpeak(state, transcript).catch((err) => {
          logger.error({ err: String(err) }, "generateAndSpeak failed");
        });
      }
    } catch {
      // ignore
    }
  });

  dgWs.on("error", (err) => {
    logger.warn({ err: String(err), callControlId: state.callControlId }, "Deepgram error");
  });

  dgWs.on("close", () => {
    logger.info({ callControlId: state.callControlId }, "Deepgram closed");
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export function isCustomBridgeAvailable(): boolean {
  return Boolean(DEEPGRAM_API_KEY && CARTESIA_API_KEY);
}

export function connectCustomBridge(
  callControlId: string,
  opts: {
    systemPrompt: string;
    firstMessage: string;
    cartesiaVoiceId?: string;
    telnyxWs: WebSocket;
    transcriptCallback?: (text: string) => void;
  }
): void {
  const state: BridgeState = {
    callControlId,
    systemPrompt: opts.systemPrompt,
    firstMessage: opts.firstMessage,
    cartesiaVoiceId: opts.cartesiaVoiceId ?? DEFAULT_CARTESIA_VOICE,
    telnyxWs: opts.telnyxWs,
    deepgramWs: null,
    messages: [{ role: "system", content: opts.systemPrompt }],
    isAiSpeaking: false,
    currentTurnId: 0,
    isClosed: false,
    transcriptCallback: opts.transcriptCallback,
  };

  bridges.set(callControlId, state);
  connectDeepgram(state);

  logger.info({ callControlId }, "Custom bridge started (Deepgram + GPT-4o + Cartesia)");
}

/** Forward Telnyx µ-law audio to Deepgram */
export function sendAudioToCustomBridge(callControlId: string, ulawB64: string): void {
  const state = bridges.get(callControlId);
  if (!state || state.isClosed || !state.deepgramWs) return;
  if (state.deepgramWs.readyState !== WebSocket.OPEN) return;

  const buf = Buffer.from(ulawB64, "base64");
  state.deepgramWs.send(buf);   // Deepgram accepts raw binary µ-law
}

export function closeCustomBridge(callControlId: string): void {
  const state = bridges.get(callControlId);
  if (!state) return;
  state.isClosed = true;
  state.currentTurnId++;        // abort any in-flight Cartesia streams
  state.deepgramWs?.close();
  bridges.delete(callControlId);
  logger.info({ callControlId }, "Custom bridge closed");
}
