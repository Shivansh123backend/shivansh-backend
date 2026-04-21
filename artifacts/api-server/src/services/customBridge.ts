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
import { emitToSupervisors, getIO } from "../websocket/index.js";
import { getIO } from "../websocket/index.js";
import {
  filterTranscript,
  getFastResponse,
  classifyIntent,
  nextState,
  buildSystemPrompt,
  humanThinkDelay,
  logTurn,
  pickClarifyLine,
  pickSilenceLine,
  type ConversationState,
  type Intent,
} from "./aiPipeline.js";
import {
  createSupervisorMemory,
  observeUserTurn,
  observeAssistantTurn,
  observeSilence,
  deriveSignal,
  type SupervisorMemory,
} from "./aiSupervisor.js";
import { planIntervention, type InterventionPlan } from "./interventionEngine.js";
import { coachResponse } from "./coachEngine.js";
import { applyPacing, paceForEmotion } from "./voicePacing.js";
import {
  handleObjection,
  createObjectionMemory,
  type ObjectionMemory,
} from "./objectionEngine.js";

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
  accent?: string;
  paceMultiplier?: number;
  telnyxWs: WebSocket;
  deepgramWs: WebSocket | null;
  messages: Message[];
  isAiSpeaking: boolean;
  currentTurnId: number;            // increments on each turn — barge-in detection
  currentAbortCtrl: AbortController | null;   // aborts in-flight Cartesia fetch
  isClosed: boolean;
  pendingTransfer: boolean;
  conversationState: ConversationState;
  lastIntent: Intent;
  objectionMemory: ObjectionMemory;
  shouldEndAfterSpeech: boolean;
  lastClarifyAt: number;
  lastUserActivityAt: number;
  silencePromptCount: number;
  silenceTimer: NodeJS.Timeout | null;
  supervisorMemory: SupervisorMemory;
  pendingIntervention: InterventionPlan | null;
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

/** Send base64-encoded µ-law audio back to Telnyx media fork.
 *  Also pipes the same bytes to any supervisors listening live. */
function injectAudio(state: BridgeState, ulawB64: string): void {
  if (state.isClosed || state.telnyxWs.readyState !== WebSocket.OPEN) return;
  state.telnyxWs.send(JSON.stringify({
    event: "media",
    media: { payload: ulawB64 },
  }));

  // Stream AI (agent) audio to live listeners (cluster-synced via Redis adapter)
  try {
    const ioInst = getIO();
    const room = `listen:${state.callControlId}`;
    if ((ioInst.sockets.adapter.rooms.get(room)?.size ?? 0) > 0) {
      ioInst.to(room).emit("call:audio", {
        callControlId: state.callControlId,
        payload: ulawB64,
        side: "agent",
      });
    }
  } catch { /* not initialized yet */ }
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
  let cleanRaw = stripMarkdown(text);
  if (!cleanRaw.trim() || state.isClosed || state.currentTurnId !== turnId) return;
  // Apply accent tuning (US/UK phrasing) BEFORE pacing — failsafe.
  try {
    const accent = (state as unknown as { accent?: string }).accent;
    if (accent === "US" || accent === "UK") {
      const { applyAccent } = await import("./accentEngine.js");
      cleanRaw = applyAccent(cleanRaw, accent);
    }
  } catch { /* failsafe: skip accent on error */ }
  // Apply pacing transformations (geo-aware multiplier if set).
  const geoMult = (state as unknown as { paceMultiplier?: number }).paceMultiplier ?? 1;
  const clean = applyPacing(cleanRaw, { intensity: paceForEmotion(state.supervisorMemory.emotion.current) * geoMult });

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

/** Speak a pre-canned line (objection / fast-response) — bypasses LLM entirely. */
function speakInstant(
  state: BridgeState,
  userText: string,
  reply: string,
  onDone?: () => void,
): void {
  state.messages.push({ role: "user", content: userText });
  state.messages.push({ role: "assistant", content: reply });
  const turnId = ++state.currentTurnId;
  state.isAiSpeaking = true;
  // One-shot intervention applies to LLM turns only — clear it here so a
  // canned/instant assistant reply (objection, fast-response, silence prompt)
  // doesn't cause it to leak into a later LLM turn.
  try { observeAssistantTurn(state.supervisorMemory, reply); } catch { /* ignore */ }
  state.pendingIntervention = null;
  emitToSupervisors("call:transcription", {
    callControlId: state.callControlId,
    speaker: "agent",
    text: reply,
    ts: Date.now(),
  });
  // Fast/objection replies: speak immediately, no artificial delay
  speakText(state, reply, turnId)
    .then(() => {
      if (state.currentTurnId === turnId) state.isAiSpeaking = false;
      onDone?.();
    })
    .catch(() => { state.isAiSpeaking = false; });
}

/** Hard-stop the bridge cleanly (used after hard rejection). */
function endBridge(state: BridgeState): void {
  setTimeout(() => {
    if (state.isClosed) return;
    logger.info({ callControlId: state.callControlId }, "Ending bridge after hard rejection");
    state.isClosed = true;
    state.currentTurnId++;
    state.currentAbortCtrl?.abort();
    state.currentAbortCtrl = null;
    state.deepgramWs?.close();
    try { state.telnyxWs.close(1000, "hard_reject"); } catch { /* already closed */ }
  }, 1500);
}

// ── GPT-4o LLM ───────────────────────────────────────────────────────────────

const SENTENCE_END = /([.!?]["']?\s)|([.!?]["']?$)/;

/**
 * Run the coach over a single fragment about to be spoken.
 * Failsafe: if the coach throws, return the original fragment unchanged
 * so we never break the call. Returns "" if the coach blanks the fragment.
 */
function coachSafe(state: BridgeState, fragment: string): string {
  if (!fragment.trim()) return fragment;
  try {
    const out = coachResponse({
      reply: fragment,
      recentAssistantReplies: state.supervisorMemory.lastAssistantTexts,
      intervention: state.pendingIntervention,
      emotion: state.supervisorMemory.emotion.current,
    });
    return out.reply;
  } catch {
    return fragment;
  }
}

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
    // STEP 4 + 5: rebuild system prompt with current stage + intent on every turn.
    // If supervisor flagged an issue, append the intervention nudge so the LLM
    // adapts its strategy for this turn only.
    let dynamicSystem = buildSystemPrompt(
      state.systemPrompt,
      state.conversationState,
      state.lastIntent,
    );
    if (state.pendingIntervention?.promptAddition) {
      dynamicSystem = `${dynamicSystem}\n\nREAL-TIME INTERVENTION:\n${state.pendingIntervention.promptAddition}`;
    }
    const recentMsgs = state.messages.slice(1).slice(-13);
    const msgsForLLM: Message[] = [
      { role: "system", content: dynamicSystem },
      ...recentMsgs,
    ];

    const stream = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: msgsForLLM,
      max_completion_tokens: 160,
      temperature: 0.75,
      frequency_penalty: 0.7,  // discourages repeating exact phrases
      presence_penalty: 0.5,   // discourages re-raising already-covered topics
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
        const rawSentence = textBuffer.slice(0, match + 1).trim();
        textBuffer = textBuffer.slice(match + 1).trim();
        const coached = coachSafe(state, rawSentence);
        if (coached) await speakText(state, coached, turnId);
      }
    }

    // Flush any remaining text
    if (textBuffer.trim() && !state.isClosed && state.currentTurnId === turnId) {
      const coached = coachSafe(state, textBuffer.trim());
      if (coached) await speakText(state, coached, turnId);
    }

    if (fullResponse.trim()) {
      const finalText = fullResponse.trim();
      state.messages.push({ role: "assistant", content: finalText });

      // Supervisor: observe what we just said for repetition tracking, then clear
      // the one-shot intervention so it isn't re-applied on the next turn.
      try { observeAssistantTurn(state.supervisorMemory, finalText); } catch { /* ignore */ }
      state.pendingIntervention = null;

      // Emit agent transcript to live monitor
      emitToSupervisors("call:transcription", {
        callControlId: state.callControlId,
        speaker: "agent",
        text: finalText,
        ts: Date.now(),
      });
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
      if (!transcript) return;

      // Any real transcript = caller activity. Reset silence tracker.
      state.lastUserActivityAt = Date.now();
      state.silencePromptCount = 0;

      // ── Supervisor observation (additive — never blocks) ─────────────────
      try {
        observeUserTurn(state.supervisorMemory, transcript);
        const signal = deriveSignal(state.supervisorMemory);
        state.pendingIntervention = signal === "ok" ? null : planIntervention(signal);
        if (state.pendingIntervention) {
          logger.info({ callControlId: state.callControlId, signal, health: state.supervisorMemory.health }, "Supervisor flagged");
        }
      } catch (err) {
        logger.warn({ err: String(err), callControlId: state.callControlId }, "Supervisor observe failed — bypassed");
      }

      const isSpeechFinal = msg.speech_final === true;

      // ── Barge-in on ANY non-final result ────────────────────────────────
      // (only if confidence is high enough to be real speech, not noise)
      if (!isSpeechFinal && state.isAiSpeaking && confidence >= 0.6) {
        triggerBargeIn(state);
        return;
      }

      // ── Full response on speech_final ────────────────────────────────────
      if (!isSpeechFinal) return;

      // ── STEP 1: Input filtering ──────────────────────────────────────────
      const filter = filterTranscript(transcript, confidence);
      if (!filter.accept) {
        logTurn(state.callControlId, {
          transcript,
          confidence,
          filtered: filter.reason,
        });
        // Only ask for clarification on low confidence (real speech but unclear).
        // Silence/filler/too-short get ignored to avoid talking over breath sounds.
        if (filter.reason === "low_confidence" && !state.isAiSpeaking) {
          const ago = Date.now() - state.lastClarifyAt;
          if (ago > 8000) {  // throttle: at most one clarification per 8 s
            state.lastClarifyAt = Date.now();
            speakInstant(state, transcript, pickClarifyLine());
          }
        }
        return;
      }

      // ── STEP 3: Intent classification ────────────────────────────────────
      const intent = classifyIntent(transcript);
      const prevState = state.conversationState;
      const newState = nextState(prevState, intent);
      state.lastIntent = intent;
      state.conversationState = newState;

      logTurn(state.callControlId, {
        transcript,
        confidence,
        intent,
        state: prevState,
        nextState: newState,
      });

      state.transcriptCallback?.(transcript);
      emitToSupervisors("call:transcription", {
        callControlId: state.callControlId,
        speaker: "caller",
        text: transcript,
        ts: Date.now(),
      });

      if (state.isAiSpeaking) triggerBargeIn(state);

      // ── STEP 2: Fast-response cache (bypass LLM) ─────────────────────────
      const fast = getFastResponse(transcript);
      if (fast) {
        logTurn(state.callControlId, { transcript, fastResponse: true });
        speakInstant(state, transcript, fast);
        return;
      }

      // ── STEP 2b: Objection handling engine (bypass LLM) ──────────────────
      const objection = handleObjection(transcript, state.objectionMemory);
      if (objection.reply) {
        logger.info({
          callControlId: state.callControlId,
          objection: {
            type: objection.type,
            count: state.objectionMemory.objectionCount,
            firmTone: objection.firmTone,
            hardReject: objection.hardReject,
          },
        }, "Objection handled");

        if (objection.endCall) state.shouldEndAfterSpeech = true;
        speakInstant(state, transcript, objection.reply, () => {
          if (objection.endCall) endBridge(state);
        });
        return;
      }

      generateAndSpeak(state, transcript).catch((err) => {
        logger.error({ err: String(err) }, "generateAndSpeak failed");
      });
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
  const hasOpenAI = Boolean(
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||
    process.env.OPENAI_API_KEY
  );
  return Boolean(DEEPGRAM_API_KEY && CARTESIA_API_KEY && hasOpenAI);
}

export function connectCustomBridge(
  callControlId: string,
  opts: {
    systemPrompt: string;
    firstMessage: string;
    cartesiaVoiceId?: string;
    telnyxWs: WebSocket;
    accent?: string;
    region?: string;
    transcriptCallback?: (text: string) => void;
    onTransferRequested?: () => void;
  }
): void {
  // Derive geo-based pace multiplier (failsafe — defaults to 1.0)
  let paceMultiplier = 1;
  try {
    if (opts.region) {
      // Lazy import to avoid circular concerns; safe synchronous default if it fails
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { geoBehaviorFor } = require("./geoBehaviorEngine.js");
      paceMultiplier = geoBehaviorFor(opts.region).paceMultiplier ?? 1;
    }
  } catch { /* keep default 1.0 */ }

  const state: BridgeState = {
    callControlId,
    systemPrompt: opts.systemPrompt,
    firstMessage: opts.firstMessage,
    cartesiaVoiceId: opts.cartesiaVoiceId ?? DEFAULT_CARTESIA_VOICE,
    accent: opts.accent,
    paceMultiplier,
    telnyxWs: opts.telnyxWs,
    deepgramWs: null,
    messages: [{ role: "system", content: opts.systemPrompt }],
    isAiSpeaking: false,
    currentTurnId: 0,
    currentAbortCtrl: null,
    isClosed: false,
    pendingTransfer: false,
    conversationState: "INTRO",
    lastIntent: "neutral",
    objectionMemory: createObjectionMemory(),
    shouldEndAfterSpeech: false,
    lastClarifyAt: 0,
    lastUserActivityAt: Date.now(),
    silencePromptCount: 0,
    silenceTimer: null,
    supervisorMemory: createSupervisorMemory(),
    pendingIntervention: null,
    transcriptCallback: opts.transcriptCallback,
    onTransferRequested: opts.onTransferRequested,
  };

  bridges.set(callControlId, state);
  connectDeepgram(state);
  startSilenceWatchdog(state);

  logger.info({ callControlId }, "Custom bridge started (Deepgram + GPT-4o + Cartesia)");
}

/** Silence watchdog — every 1s checks if the caller has been silent for 4+ s while the AI is idle.
 *  After 3 consecutive prompts with no response, gives up and stops nudging. */
function startSilenceWatchdog(state: BridgeState): void {
  const SILENCE_MS = 4000;
  const MAX_PROMPTS = 3;
  state.silenceTimer = setInterval(() => {
    if (state.isClosed) return;
    if (state.isAiSpeaking || state.pendingTransfer) return;
    if (state.silencePromptCount >= MAX_PROMPTS) return;
    const idle = Date.now() - state.lastUserActivityAt;
    if (idle < SILENCE_MS) return;
    const line = pickSilenceLine(state.silencePromptCount);
    state.silencePromptCount += 1;
    state.lastUserActivityAt = Date.now(); // reset so we wait another window before re-prompting
    logger.info({ callControlId: state.callControlId, idle, count: state.silencePromptCount }, "Silence prompt");
    try { observeSilence(state.supervisorMemory); } catch { /* ignore */ }
    speakInstant(state, "[silence]", line);
  }, 1000);
}

/**
 * Read a snapshot of the supervisor/emotion state for a live or just-ended
 * call. Used by the call-end webhook to persist the dominant emotion. Returns
 * null if the bridge has already been torn down.
 */
export function getSupervisorSnapshot(callControlId: string): {
  health: number;
  emotion: SupervisorMemory["emotion"];
} | null {
  const state = bridges.get(callControlId);
  if (!state) return null;
  return { health: state.supervisorMemory.health, emotion: state.supervisorMemory.emotion };
}

/** Forward Telnyx µ-law audio to Deepgram. Also pipes to live listeners. */
export function sendAudioToCustomBridge(callControlId: string, ulawB64: string): void {
  const state = bridges.get(callControlId);
  if (!state || state.isClosed || !state.deepgramWs) return;
  if (state.deepgramWs.readyState !== WebSocket.OPEN) return;
  state.deepgramWs.send(Buffer.from(ulawB64, "base64"));

  // Stream caller audio to live listeners (cluster-synced via Redis adapter)
  try {
    const ioInst = getIO();
    const room = `listen:${callControlId}`;
    if ((ioInst.sockets.adapter.rooms.get(room)?.size ?? 0) > 0) {
      ioInst.to(room).emit("call:audio", { callControlId, payload: ulawB64, side: "caller" });
    }
  } catch { /* not initialized yet */ }
}

export function closeCustomBridge(callControlId: string): void {
  const state = bridges.get(callControlId);
  if (!state) return;
  state.isClosed = true;
  state.currentTurnId++;
  state.currentAbortCtrl?.abort();
  state.deepgramWs?.close();
  if (state.silenceTimer) { clearInterval(state.silenceTimer); state.silenceTimer = null; }
  bridges.delete(callControlId);
  logger.info({ callControlId }, "Custom bridge closed");
}
