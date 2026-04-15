/**
 * ElevenLabs Conversational AI ↔ Telnyx Media Bridge
 *
 * Architecture:
 *   Telnyx fork_start → wss://.../ws/eleven/:callControlId (our raw WS)
 *     → ElevenLabs Conversational AI WebSocket (STT + LLM + TTS all in one)
 *     → Audio injected back via Telnyx fork WebSocket
 *
 * Audio format:
 *   Telnyx sends:  µ-law 8kHz (G.711 u-law), base64-encoded JSON frames
 *   ElevenLabs in: PCM 16kHz signed 16-bit LE, base64
 *   ElevenLabs out: PCM 16kHz signed 16-bit LE, base64
 *   Telnyx expects: µ-law 8kHz, base64
 */

import WebSocket from "ws";
import { type IncomingMessage } from "http";
import { logger } from "../lib/logger.js";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY ?? "";
const ELEVEN_WS_BASE = "wss://api.elevenlabs.io/v1/convai/conversation";

// ── µ-law decode table (G.711 u-law) ──────────────────────────────────────────
const ULAW_TO_LINEAR: Int16Array = (() => {
  const tbl = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    let u = ~i & 0xff;
    const sign = u & 0x80;
    const exp  = (u >> 4) & 0x07;
    const mant = u & 0x0f;
    let val = ((mant << 3) + 132) << exp;
    if (sign) val = -val;
    tbl[i] = val;
  }
  return tbl;
})();

function ulawToLinear(u: number): number {
  return ULAW_TO_LINEAR[u & 0xff]!;
}

function linearToUlaw(pcm: number): number {
  if (pcm > 32767)  pcm =  32767;
  if (pcm < -32768) pcm = -32768;
  const sign = pcm < 0 ? 0x80 : 0;
  if (pcm < 0) pcm = -pcm;
  pcm += 132;
  if (pcm > 32767) pcm = 32767;
  let exp = 7;
  let mask = 0x4000;
  while (exp > 0 && (pcm & mask) === 0) { exp--; mask >>= 1; }
  const mant = (pcm >> (exp + 3)) & 0x0f;
  return (~(sign | (exp << 4) | mant)) & 0xff;
}

/** µ-law 8 kHz Buffer → PCM 16 kHz Buffer (Int16 LE) */
function ulawToPcm16(src: Buffer): Buffer {
  const samples8k = new Int16Array(src.length);
  for (let i = 0; i < src.length; i++) samples8k[i] = ulawToLinear(src[i]!);

  // Linear upsample 8 kHz → 16 kHz (each sample becomes 2)
  const samples16k = new Int16Array(src.length * 2);
  for (let i = 0; i < src.length; i++) {
    const cur  = samples8k[i]!;
    const next = samples8k[i + 1] ?? cur;
    samples16k[i * 2]     = cur;
    samples16k[i * 2 + 1] = Math.round((cur + next) / 2);
  }
  return Buffer.from(samples16k.buffer);
}

/** PCM 16 kHz Buffer (Int16 LE) → µ-law 8 kHz Buffer */
function pcm16ToUlaw(src: Buffer): Buffer {
  const samples16k = new Int16Array(src.buffer, src.byteOffset, src.length >> 1);
  const len8k = samples16k.length >> 1;
  const out = Buffer.allocUnsafe(len8k);
  for (let i = 0; i < len8k; i++) {
    const avg = Math.round(((samples16k[i * 2] ?? 0) + (samples16k[i * 2 + 1] ?? 0)) / 2);
    out[i] = linearToUlaw(avg);
  }
  return out;
}

// ── Bridge state ───────────────────────────────────────────────────────────────

export interface BridgeInfo {
  callControlId: string;
  campaignId: number;
  campaignName: string;
  agentName: string;
  callerNumber: string;
  direction: "inbound" | "outbound";
  startedAt: Date;
  leadId?: number;
  recordingUrl?: string;
  transferNumber?: string;
  holdMusicUrl?: string;
  backgroundSound?: string;    // "office" | "typing" | "cafe" | "none" | undefined
  voiceProvider?: string;      // "elevenlabs" | "deepgram" | "cartesia"
  transcript: string[];
  voiceId: string;
  systemPrompt: string;
  firstMessage: string;
  pendingTransfer: boolean;    // true once transfer is scheduled — prevents double-execution
  onTransferRequested?: (to: string) => void;
  onCallEnded?: () => void;
}

type BridgeEntry = BridgeInfo & { elevenWs: WebSocket | null; sessionToken: string };

const activeBridges = new Map<string, BridgeEntry>();               // callControlId → bridge
const sessionIndex = new Map<string, string>();                      // sessionToken → callControlId

/** Generate a URL-safe random token with no special characters */
function makeSessionToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Return the session token for a given callControlId (used to build the fork URL) */
export function getBridgeSessionToken(callControlId: string): string | undefined {
  return activeBridges.get(callControlId)?.sessionToken;
}

// ── ElevenLabs Agent ID ────────────────────────────────────────────────────────
// Priority:
//   1. ELEVENLABS_AGENT_ID env var (set this in Secrets — recommended)
//   2. Auto-discover the first agent on the account (needs convai_read)
//   3. Auto-create a base agent (needs convai_write — paid tier)
let cachedBaseAgentId: string | null = null;

async function getBaseAgentId(): Promise<string> {
  if (cachedBaseAgentId) return cachedBaseAgentId;
  if (!ELEVENLABS_API_KEY) throw new Error("ELEVENLABS_API_KEY not set");

  // 1. Env var takes priority
  const envAgentId = process.env.ELEVENLABS_AGENT_ID;
  if (envAgentId) {
    cachedBaseAgentId = envAgentId;
    logger.info({ agentId: cachedBaseAgentId }, "Using ELEVENLABS_AGENT_ID from env");
    return cachedBaseAgentId;
  }

  // 2. Try to find an existing agent on the account
  try {
    const listRes = await fetch(
      "https://api.elevenlabs.io/v1/convai/agents?page_size=50",
      { headers: { "xi-api-key": ELEVENLABS_API_KEY } }
    );
    if (listRes.ok) {
      const data = await listRes.json() as { agents?: { agent_id: string; name: string }[] };
      // Prefer one named "Shivansh Base Agent", fall back to any
      const found =
        data.agents?.find((a) => a.name === "Shivansh Base Agent") ??
        data.agents?.[0];
      if (found) {
        cachedBaseAgentId = found.agent_id;
        logger.info({ agentId: cachedBaseAgentId, name: found.name }, "Using existing ElevenLabs agent");
        return cachedBaseAgentId;
      }
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "Could not list ElevenLabs agents — trying to create");
  }

  // 3. Create a base agent (requires convai_write permission)
  logger.info("No existing ElevenLabs agent found — attempting to create one");
  const createRes = await fetch(
    "https://api.elevenlabs.io/v1/convai/agents/create",
    {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Shivansh Base Agent",
        conversation_config: {
          agent: {
            prompt: { prompt: "You are a professional AI calling agent." },
            first_message: "Hello, how can I help you?",
            language: "en",
          },
          tts: {
            model_id: "eleven_turbo_v2_5",
            voice_id: "21m00Tcm4TlvDq8ikWAM",
          },
          asr: {
            quality: "high",
            provider: "elevenlabs",
            keywords: [],
          },
          turn: {
            turn_timeout: 15,
            silence_end_call_timeout: 20,
            mode: "silence",
            endpointing_ms: 800,
          },
        },
      }),
    }
  );

  if (!createRes.ok) {
    const txt = await createRes.text();
    throw new Error(
      `ElevenLabs agent creation failed (${createRes.status}): ${txt}\n` +
      `→ Fix: Create an agent in your ElevenLabs dashboard (elevenlabs.io/app/conversational-ai) ` +
      `and set ELEVENLABS_AGENT_ID in Secrets.`
    );
  }

  const created = await createRes.json() as { agent_id: string };
  cachedBaseAgentId = created.agent_id;
  logger.info({ agentId: cachedBaseAgentId }, "Created ElevenLabs base agent");
  return cachedBaseAgentId;
}

// ── Connect bridge to ElevenLabs Conversational AI ────────────────────────────
async function connectToElevenLabs(
  callControlId: string,
  telnyxWs: WebSocket
): Promise<void> {
  const bridge = activeBridges.get(callControlId);
  if (!bridge) return;

  const agentId = await getBaseAgentId();
  const url = `${ELEVEN_WS_BASE}?agent_id=${agentId}`;

  logger.info({ callControlId, agentId }, "Connecting to ElevenLabs Conversational AI");

  const elevenWs = new WebSocket(url, {
    headers: { "xi-api-key": ELEVENLABS_API_KEY },
  });
  bridge.elevenWs = elevenWs;

  elevenWs.on("open", () => {
    logger.info({ callControlId }, "ElevenLabs WebSocket open — sending config override");

    // Override voice + prompt + first message per call
    const backendUrl =
      process.env.BACKEND_URL?.replace(/\/$/, "") ??
      "https://shivanshbackend.replit.app";
    elevenWs.send(JSON.stringify({
      type: "conversation_initiation_client_data",
      conversation_config_override: {
        agent: {
          prompt: { prompt: bridge.systemPrompt },
          first_message: bridge.firstMessage,
          language: "en",
          // Route LLM calls through GPT-4o for Vapi-level conversation quality
          llm: {
            model_id: "custom",
            custom_llm_url: `${backendUrl}/api/llm`,
          },
        },
        tts: {
          voice_id: bridge.voiceId,
          model_id: "eleven_turbo_v2_5",
          // 0=off 1=light 2=medium 3=max
          optimize_streaming_latency: 1,
          voice_settings: {
            stability: 0.38,          // LOW = more natural pitch variation (high = robotic monotone)
            similarity_boost: 0.80,
            style: 0.35,              // moderate expressiveness — emotion without rushing
            use_speaker_boost: true,
            speed: 0.85,              // natural conversational pace — not too slow, not rushed
          },
        },
        asr: {
          quality: "high",
          provider: "elevenlabs",
          user_input_audio_format: "pcm_16000",
          keywords: [],
        },
        turn: {
          turn_timeout: 15,           // seconds of total silence before AI speaks again (gave more room)
          silence_end_call_timeout: 35,
          mode: "silence",            // explicit silence-based VAD (more predictable than default)
          endpointing_ms: 800,        // wait 800ms of speech-pause before deciding user is done talking
        },
      },
    }));
  });

  elevenWs.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      const type = msg["type"] as string | undefined;

      // ── ping/pong ──────────────────────────────────────────────────────────
      if (type === "ping") {
        const pingEvt = msg["ping_event"] as { event_id?: number } | undefined;
        elevenWs.send(JSON.stringify({ type: "pong", event_id: pingEvt?.event_id }));
        return;
      }

      // ── AI audio → relay to Telnyx ─────────────────────────────────────────
      if (type === "audio") {
        const audioEvt = msg["audio_event"] as { audio_base_64?: string } | undefined;
        const b64 = audioEvt?.audio_base_64;
        if (!b64) return;

        // ElevenLabs output is PCM 16kHz → convert to µ-law 8kHz for Telnyx
        const pcmBuf = Buffer.from(b64, "base64");
        const ulawBuf = pcm16ToUlaw(pcmBuf);

        if (telnyxWs.readyState === WebSocket.OPEN) {
          telnyxWs.send(JSON.stringify({
            event: "media",
            media: { payload: ulawBuf.toString("base64") },
          }));
        }
        return;
      }

      // ── Transcript events — accumulate for call log ────────────────────────
      if (type === "transcript") {
        const te = msg["transcript_event"] as { speaker?: string; message?: string } | undefined;
        if (te?.speaker && te?.message) {
          const label = te.speaker === "user" ? "Caller" : "AI Agent";
          bridge.transcript.push(`${label}: ${te.message}`);
          logger.debug({ callControlId, speaker: te.speaker, msg: te.message }, "ElevenLabs transcript");

          // ── Detect caller asking for human transfer directly ───────────────
          // Triggers even if the AI hasn't said the transfer phrase yet
          if (te.speaker === "user" && !bridge.pendingTransfer && bridge.transferNumber) {
            const CALLER_TRANSFER_PHRASES = [
              "speak to a human", "talk to a human", "speak to a person",
              "talk to a person", "real person", "actual person",
              "speak to someone", "talk to someone", "speak with someone",
              "get a human", "get a person", "get an agent",
              "transfer me", "transfer to", "put me through",
              "speak to an agent", "talk to an agent", "connect me to",
              "i want a human", "i need a human", "i want to speak",
              "let me speak to", "can i speak to", "can i talk to",
            ];
            const lowerMsg = te.message.toLowerCase();
            if (CALLER_TRANSFER_PHRASES.some((p) => lowerMsg.includes(p))) {
              bridge.pendingTransfer = true;
              logger.info({ callControlId, message: te.message }, "Caller requested human — triggering transfer in 3s");
              setTimeout(() => {
                const cb = activeBridges.get(callControlId);
                if (!cb) return;
                cb.onTransferRequested?.(cb.transferNumber!);
                if (elevenWs.readyState === WebSocket.OPEN) elevenWs.close(1000, "caller_requested_human");
                if (telnyxWs.readyState === WebSocket.OPEN) telnyxWs.send(JSON.stringify({ event: "clear" }));
              }, 3_000);
            }
          }
        }
        return;
      }

      // ── Agent response text ────────────────────────────────────────────────
      if (type === "agent_response") {
        const are = msg["agent_response_event"] as { agent_response?: string } | undefined;
        const text = are?.agent_response ?? "";
        if (text && !bridge.pendingTransfer) {
          const TRANSFER_PHRASES = [
            "transfer you to", "transferring you", "transfer to an expert",
            "connect you with", "connect you to", "one of our agents",
            "one moment please", "putting you through", "let me get a",
            "a live agent", "a team member", "bring in a specialist",
            "get an expert", "to an expert", "to a specialist",
            "let me transfer",
          ];
          const lower = text.toLowerCase();
          if (TRANSFER_PHRASES.some((p) => lower.includes(p)) && bridge.transferNumber) {
            bridge.pendingTransfer = true;
            logger.info({ callControlId, transferNumber: bridge.transferNumber, text }, "Transfer phrase detected — waiting 4s for AI to finish speaking");

            // Wait for AI to finish saying the transfer phrase before bridging
            setTimeout(() => {
              const currentBridge = activeBridges.get(callControlId);
              if (!currentBridge) return;
              logger.info({ callControlId }, "Executing transfer after speech delay");

              // Fire the transfer on Telnyx
              currentBridge.onTransferRequested?.(currentBridge.transferNumber!);

              // Close ElevenLabs — human agent is taking over
              if (elevenWs.readyState === WebSocket.OPEN) {
                elevenWs.close(1000, "transferred");
              }

              // Mute Telnyx fork so no further AI audio leaks to the caller
              if (telnyxWs.readyState === WebSocket.OPEN) {
                telnyxWs.send(JSON.stringify({ event: "clear" }));
              }
            }, 4_000);
          }
        }
        return;
      }

      // ── Interruption — clear Telnyx audio buffer ──────────────────────────
      if (type === "interruption") {
        if (telnyxWs.readyState === WebSocket.OPEN) {
          telnyxWs.send(JSON.stringify({ event: "clear" }));
        }
        return;
      }

      // ── Conversation ended on ElevenLabs side ─────────────────────────────
      if (type === "conversation_ended" || type === "end_call") {
        // If a transfer is pending, the ElevenLabs WS was deliberately closed
        // by the transfer path — do NOT hang up or it will kill the transferred call.
        if (bridge.pendingTransfer) {
          logger.info({ callControlId }, "ElevenLabs ended — transfer pending, skipping hangup");
          return;
        }
        logger.info({ callControlId }, "ElevenLabs signalled conversation end");
        bridge.onCallEnded?.();
        return;
      }

      if (type === "conversation_initiation_metadata") {
        const meta = msg["conversation_initiation_metadata_event"] as {
          conversation_id?: string;
          agent_output_audio_format?: string;
        } | undefined;
        logger.info({ callControlId, conversationId: meta?.conversation_id, audioFmt: meta?.agent_output_audio_format }, "ElevenLabs conversation initiated");
        return;
      }

    } catch (err) {
      logger.warn({ err: String(err), callControlId }, "Failed to parse ElevenLabs WS message");
    }
  });

  elevenWs.on("error", (err) => {
    logger.error({ err: String(err), callControlId }, "ElevenLabs WebSocket error");
  });

  elevenWs.on("close", (code, reason) => {
    logger.info({ callControlId, code, reason: reason.toString() }, "ElevenLabs WebSocket closed");
    const b = activeBridges.get(callControlId);
    if (b) b.elevenWs = null;
  });
}

// ── Telnyx media fork WebSocket handler ───────────────────────────────────────
// Called by index.ts for every upgrade request to /ws/eleven/:callControlId

export function handleTelnyxMediaSocket(ws: WebSocket, req: IncomingMessage): void {
  // URL format: /ws/eleven/:sessionToken  (hex token maps to callControlId — no special chars)
  const urlParts = (req.url ?? "").split("/");
  const sessionToken = urlParts[urlParts.length - 1] ?? "";
  const callControlId = sessionIndex.get(sessionToken) ?? "";

  logger.info({ sessionToken, callControlId, url: req.url }, "Telnyx media fork WebSocket connected");

  ws.on("message", async (raw: Buffer) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      return; // ignore non-JSON (binary RTP etc.)
    }

    const event = msg["event"] as string | undefined;

    // ── connected: Telnyx stream handshake ────────────────────────────────────
    if (event === "connected") {
      logger.info({ callControlId }, "Telnyx fork stream connected");
      return;
    }

    // ── start: stream metadata → connect to ElevenLabs ────────────────────────
    if (event === "start") {
      const bridge = activeBridges.get(callControlId);
      if (!bridge) {
        logger.warn({ callControlId }, "No bridge state for fork start — closing");
        ws.close();
        return;
      }
      try {
        await connectToElevenLabs(callControlId, ws);
      } catch (err) {
        logger.error({ err: String(err), callControlId }, "Failed to connect to ElevenLabs");
        ws.close();
      }
      return;
    }

    // ── media: caller audio → forward to ElevenLabs ───────────────────────────
    if (event === "media") {
      const bridge = activeBridges.get(callControlId);
      if (!bridge?.elevenWs || bridge.elevenWs.readyState !== WebSocket.OPEN) return;

      const mediaPayload = (msg["media"] as Record<string, unknown> | undefined);
      const payload = mediaPayload?.["payload"] as string | undefined;
      if (!payload) return;

      // Telnyx sends µ-law 8kHz → convert to PCM 16kHz for ElevenLabs
      const ulawBuf = Buffer.from(payload, "base64");
      const pcmBuf  = ulawToPcm16(ulawBuf);

      bridge.elevenWs.send(JSON.stringify({
        user_audio_chunk: pcmBuf.toString("base64"),
      }));
      return;
    }

    // ── stop: fork ended ──────────────────────────────────────────────────────
    if (event === "stop") {
      logger.info({ callControlId }, "Telnyx fork stream stopped");
      closeBridge(callControlId);
      return;
    }
  });

  ws.on("close", () => {
    logger.info({ callControlId }, "Telnyx fork WebSocket closed");
    closeBridge(callControlId);
  });

  ws.on("error", (err) => {
    logger.error({ err: String(err), callControlId }, "Telnyx fork WebSocket error");
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export function initBridge(
  callControlId: string,
  info: Omit<BridgeInfo, "transcript" | "pendingTransfer" | "callControlId">
): void {
  const sessionToken = makeSessionToken();
  activeBridges.set(callControlId, {
    ...info,
    callControlId,        // always populate so getAllActiveBridges() can return it
    transcript: [],
    pendingTransfer: false,
    elevenWs: null,
    sessionToken,
  });
  sessionIndex.set(sessionToken, callControlId);
  logger.info({ callControlId, sessionToken, direction: info.direction, voiceId: info.voiceId }, "Bridge registered");
}

export function getBridgeInfo(callControlId: string): BridgeInfo | undefined {
  return activeBridges.get(callControlId);
}

export function setRecordingUrl(callControlId: string, url: string): void {
  const b = activeBridges.get(callControlId);
  if (b) b.recordingUrl = url;
}

export function closeBridge(callControlId: string): void {
  const bridge = activeBridges.get(callControlId);
  if (!bridge) return;
  if (bridge.elevenWs && bridge.elevenWs.readyState === WebSocket.OPEN) {
    bridge.elevenWs.close();
  }
  sessionIndex.delete(bridge.sessionToken);
  activeBridges.delete(callControlId);
  logger.info({ callControlId }, "Bridge closed");
}

/** Return a snapshot of all currently active bridges (for live monitor) */
export function getAllActiveBridges(): BridgeInfo[] {
  return Array.from(activeBridges.values());
}

/**
 * Patch the ElevenLabs agent to use our backend as a custom LLM.
 * This routes all conversation LLM calls through GPT-4o instead of ElevenLabs' built-in model.
 */
async function patchAgentCustomLlm(agentId: string): Promise<void> {
  const backendUrl =
    process.env.BACKEND_URL?.replace(/\/$/, "") ??
    "https://shivanshbackend.replit.app";
  const customLlmUrl = `${backendUrl}/api/llm`;

  const patchRes = await fetch(
    `https://api.elevenlabs.io/v1/convai/agents/${agentId}`,
    {
      method: "PATCH",
      headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_config: {
          agent: {
            llm: {
              model_id: "custom",
              custom_llm_url: customLlmUrl,
              temperature: 0.85,
            },
          },
        },
      }),
    }
  );

  if (patchRes.ok) {
    logger.info({ agentId, customLlmUrl }, "ElevenLabs agent patched with custom GPT-4o LLM");
  } else {
    const txt = await patchRes.text();
    logger.warn(
      { agentId, status: patchRes.status, body: txt },
      "Could not patch ElevenLabs agent LLM — falling back to built-in model"
    );
  }
}

/** Pre-warm: ensure the base ElevenLabs agent exists on server start */
export async function warmupElevenAgent(): Promise<void> {
  if (!ELEVENLABS_API_KEY) {
    logger.warn("ELEVENLABS_API_KEY not set — ElevenLabs ConvAI bridge disabled");
    return;
  }
  try {
    const id = await getBaseAgentId();
    logger.info({ agentId: id }, "ElevenLabs base agent ready");
    // Patch the agent to use GPT-4o as its LLM (Vapi-style quality)
    await patchAgentCustomLlm(id);
  } catch (err) {
    logger.error({ err: String(err) }, "ElevenLabs warmup failed");
  }
}
