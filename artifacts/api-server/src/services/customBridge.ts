/**
 * Custom AI Calling Bridge — Deepgram STT + GPT-4o LLM + Cartesia TTS
 *
 * Architecture (identical to Vapi's internal stack):
 *   Telnyx µ-law 8kHz → Deepgram Nova-2 (STT) → GPT-4o (LLM) → Cartesia Sonic-2 (TTS) → Telnyx
 *
 * Fixes in this version:
 *   - Barge-in on INTERIM results (caller speaks → AI stops immediately, not after 400ms silence)
 *   - AbortController cancels in-flight Cartesia fetch on barge-in
 *   - Transfer phrase detection → calls onTransferRequested + stops bridge before music plays
 *   - Markdown stripped before sending to Cartesia (no more "asterisk asterisk")
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

// Transfer trigger phrases — any of these in the AI response triggers a transfer
const TRANSFER_TRIGGERS = [
  "connect you with",
  "transfer you",
  "one moment please",
  "one moment!",
  "let me connect",
  "putting you through",
  "connect you now",
  "one of our agents",
  "one of our team",
  "get one of our",
  "team member on the line",
  "expert who can help",
];

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
  currentTurnId: number;            // increments on each turn — barge-in detection
  currentAbortCtrl: AbortController | null;   // aborts in-flight Cartesia fetch
  isClosed: boolean;
  pendingTransfer: boolean;
  transcriptCallback?: (text: string) => void;
  onTransferRequested?: () => void;  // called when AI says transfer phrase
}

const bridges = new Map<string, BridgeState>();

// ── Text helpers ─────────────────────────────────────────────────────────────

/**
 * Strip markdown formatting so Cartesia reads clean text, not "asterisk asterisk".
 * Removes bold, italic, headers, bullets, code, links.
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")   // **bold**
    .replace(/\*(.+?)\*/g, "$1")        // *italic*
    .replace(/^#{1,6}\s+/gm, "")        // ## headers
    .replace(/^\s*[-*+]\s+/gm, "")      // bullet points
    .replace(/`(.+?)`/g, "$1")          // `code`
    .replace(/\[(.+?)\]\(.+?\)/g, "$1") // [links](url)
    .replace(/_{1,2}(.+?)_{1,2}/g, "$1")// __underline__
    .replace(/\n{2,}/g, ". ")           // paragraph breaks → short pause
    .replace(/\n/g, " ")
    .trim();
}

// ── Audio helpers ─────────────────────────────────────────────────────────────

/** Send base64-encoded µ-law audio back to Telnyx media fork */
function injectAudio(state: BridgeState, ulawB64: string): void {
  if (state.isClosed || state.telnyxWs.readyState !== WebSocket.OPEN) return;
  state.telnyxWs.send(JSON.stringify({
    event: "media",
    media: { payload: ulawB64 },
  }));
}

// ── Cartesia TTS ─────────────────────────────────────────────────────────────

/**
 * Speak a text string via Cartesia SSE and pipe µ-law audio to Telnyx.
 * Respects turnId for barge-in and uses AbortController to cancel mid-stream.
 */
async function speakText(
  state: BridgeState,
  text: string,
  turnId: number,
): Promise<void> {
  const clean = stripMarkdown(text);
  if (!clean.trim() || state.isClosed || state.currentTurnId !== turnId) return;

  const ctrl = new AbortController();
  state.currentAbortCtrl = ctrl;

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
        transcript: clean,
        voice: { mode: "id", id: state.cartesiaVoiceId },
        output_format: {
          container: "raw",
          encoding: "pcm_mulaw",  // Telnyx-native, zero conversion needed
          sample_rate: 8000,
        },
        context_id: `turn-${turnId}`,
      }),
      signal: ctrl.signal,
    });

    if (!res.ok || !res.body) {
      logger.warn({ status: res.status }, "Cartesia TTS error");
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";

    while (true) {
      // Barge-in check before every read
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
          const event = JSON.parse(jsonStr) as { type?: string; data?: string };
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
  } finally {
    if (state.currentAbortCtrl === ctrl) {
      state.currentAbortCtrl = null;
    }
  }
}

// ── Barge-in helper ─────────────────────────────────────────────────────────

function triggerBargeIn(state: BridgeState): void {
  if (!state.isAiSpeaking) return;
  logger.info({ callControlId: state.callControlId }, "Barge-in — stopping AI speech");
  state.currentTurnId++;              // invalidates all in-flight speakText calls
  state.currentAbortCtrl?.abort();    // cancel the in-flight Cartesia fetch
  state.currentAbortCtrl = null;
  state.isAiSpeaking = false;
}

// ── GPT-4o LLM ───────────────────────────────────────────────────────────────

const SENTENCE_END = /([.!?]["']?\s)|([.!?]["']?$)/;

async function generateAndSpeak(state: BridgeState, userText: string): Promise<void> {
  if (state.isClosed || state.pendingTransfer) return;

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
      max_completion_tokens: 250,   // enough for natural objection handling without monologuing
      temperature: 0.88,
      stream: true,
    });

    for await (const chunk of stream) {
      if (state.isClosed || state.currentTurnId !== turnId) break;

      const delta = chunk.choices[0]?.delta?.content ?? "";
      if (!delta) continue;

      fullResponse += delta;
      textBuffer += delta;

      // Flush at sentence boundaries for lowest TTS latency
      const match = textBuffer.search(SENTENCE_END);
      if (match !== -1) {
        const sentence = textBuffer.slice(0, match + 1).trim();
        textBuffer = textBuffer.slice(match + 1).trim();
        if (sentence) await speakText(state, sentence, turnId);
      }
    }

    // Flush any remaining text
    if (textBuffer.trim() && !state.isClosed && state.currentTurnId === turnId) {
      await speakText(state, textBuffer.trim(), turnId);
    }

    if (fullResponse.trim()) {
      state.messages.push({ role: "assistant", content: fullResponse.trim() });
    }

    // ── Transfer detection ────────────────────────────────────────────────────
    const lower = fullResponse.toLowerCase();
    const wantsTransfer =
      state.onTransferRequested &&
      !state.pendingTransfer &&
      TRANSFER_TRIGGERS.some((t) => lower.includes(t));

    if (wantsTransfer) {
      state.pendingTransfer = true;
      logger.info({ callControlId: state.callControlId }, "Transfer phrase detected in custom bridge");

      // Let Cartesia finish speaking the transfer line (short natural pause)
      await new Promise<void>((r) => setTimeout(r, 800));

      // ── Hard-stop the bridge before executing the transfer ───────────────
      // Order matters:
      //   1. Mark closed so no new audio is enqueued
      //   2. Abort any in-flight Cartesia fetch (stops new bytes)
      //   3. Close Deepgram (no more STT)
      //   4. Close the Telnyx media fork WebSocket — THIS is the key step:
      //      while the fork WebSocket stays open, Telnyx routes audio through
      //      it and CANNOT play the hold music to the caller. Closing it tells
      //      Telnyx "the fork is done" so it can play audio_url to the caller
      //      while the agent's phone is ringing, then bridge cleanly.
      state.isClosed = true;
      state.currentTurnId++;
      state.currentAbortCtrl?.abort();
      state.currentAbortCtrl = null;
      state.deepgramWs?.close();

      // Close the media fork WebSocket — allows Telnyx to play hold music
      try { state.telnyxWs.close(1000, "transfer"); } catch { /* already closed */ }

      // Fire the transfer (executeTransfer + fork_stop are called in the callback)
      state.onTransferRequested!();
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
    endpointing: "300",          // 300ms silence = utterance complete
    interim_results: "true",     // used for barge-in detection
    smart_format: "true",
    punctuate: "true",
    no_delay: "true",
  });

  const dgWs = new WebSocket(
    `wss://api.deepgram.com/v1/listen?${params}`,
    { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } }
  );

  state.deepgramWs = dgWs;

  dgWs.on("open", () => {
    logger.info({ callControlId: state.callControlId }, "Deepgram connected");

    // Speak the opening line immediately
    if (state.firstMessage.trim()) {
      state.messages.push({ role: "assistant", content: state.firstMessage });
      state.isAiSpeaking = true;
      const turnId = ++state.currentTurnId;
      speakText(state, state.firstMessage, turnId)
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

      if (!transcript || confidence < 0.2) return;

      const isSpeechFinal = msg.speech_final === true;

      // ── Barge-in on ANY non-final result ────────────────────────────────
      // Deepgram sends two types of pre-final messages:
      //   is_final=false  → interim (classic)
      //   is_final=true, speech_final=false → partial final (utterance chunk done but speech continuing)
      // Both should interrupt the AI immediately — we were previously only catching is_final=false.
      if (!isSpeechFinal && state.isAiSpeaking) {
        triggerBargeIn(state);
        return;  // Wait for speech_final to build the full response
      }

      // ── Full response on speech_final ────────────────────────────────────
      if (isSpeechFinal) {
        logger.info(
          { callControlId: state.callControlId, transcript, confidence },
          "Deepgram speech_final"
        );

        state.transcriptCallback?.(transcript);

        // Belt-and-suspenders: if AI is still speaking (e.g. very fast speech_final), stop it
        if (state.isAiSpeaking) triggerBargeIn(state);

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
    onTransferRequested?: () => void;
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
    currentAbortCtrl: null,
    isClosed: false,
    pendingTransfer: false,
    transcriptCallback: opts.transcriptCallback,
    onTransferRequested: opts.onTransferRequested,
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
  state.deepgramWs.send(Buffer.from(ulawB64, "base64"));
}

export function closeCustomBridge(callControlId: string): void {
  const state = bridges.get(callControlId);
  if (!state) return;
  state.isClosed = true;
  state.currentTurnId++;
  state.currentAbortCtrl?.abort();
  state.deepgramWs?.close();
  bridges.delete(callControlId);
  logger.info({ callControlId }, "Custom bridge closed");
}
