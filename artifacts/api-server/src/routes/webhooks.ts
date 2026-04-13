/**
 * Telnyx Webhooks — ElevenLabs TTS + OpenAI + Telnyx Transcription Edition
 *
 * Flow:
 *   Outbound: workerService dials → call.answered → transcription_start + ElevenLabs greeting
 *   Inbound:  call.initiated → answer → transcription_start + ElevenLabs greeting
 *   Both:     call.transcription → OpenAI → ElevenLabs TTS → playback_start (fallback: speak)
 *   End:      call.hangup → finalize (summary via OpenAI on accumulated transcript)
 */

import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  phoneNumbersTable,
  campaignsTable,
  aiAgentsTable,
  callLogsTable,
  leadsTable,
  voicesTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import axios from "axios";
import OpenAI from "openai";
import {
  initBridge,
  getBridgeInfo,
  closeBridge,
  setRecordingUrl,
} from "../services/elevenBridge.js";
import { emitToSupervisors } from "../websocket/index.js";

const router: IRouter = Router();

// ── OpenAI — used only for post-call summary & disposition ─────────────────────
const openai = new OpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ?? undefined,
  apiKey:
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY ??
    process.env.OPENAI_API_KEY ??
    "placeholder",
});
const AI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

const TELNYX_API_BASE = "https://api.telnyx.com/v2";
const BACKEND_WEBHOOK_URL =
  process.env.WEBHOOK_BASE_URL ?? "https://shivanshbackend.replit.app";

// Default ElevenLabs voice (Rachel)
const DEFAULT_ELEVEN_VOICE = "21m00Tcm4TlvDq8ikWAM";

// ── Hold music URLs for transfer (royalty-free, Pixabay CDN) ──────────────────
const HOLD_MUSIC_URLS: Record<string, string> = {
  none:      "https://cdn.pixabay.com/download/audio/2022/08/02/audio_884fe92c21.mp3",
  jazz:      "https://cdn.pixabay.com/download/audio/2022/03/10/audio_c6b38e0e2e.mp3",
  corporate: "https://cdn.pixabay.com/download/audio/2022/08/02/audio_884fe92c21.mp3",
  smooth:    "https://cdn.pixabay.com/download/audio/2021/04/07/audio_9f72b85a8a.mp3",
  classical: "https://cdn.pixabay.com/download/audio/2022/01/20/audio_d0c6ff1fca.mp3",
};
const DEFAULT_HOLD_MUSIC_URL = HOLD_MUSIC_URLS.corporate!;

function resolveHoldMusicUrl(holdMusic?: string | null): string {
  if (!holdMusic || holdMusic === "none") return DEFAULT_HOLD_MUSIC_URL;
  return HOLD_MUSIC_URLS[holdMusic] ?? DEFAULT_HOLD_MUSIC_URL;
}

// ── Template variable substitution ────────────────────────────────────────────
function substituteVars(
  template: string,
  vars: Record<string, string>
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    // Try exact match first, then lowercase
    const val = vars[key] ?? vars[key.toLowerCase()];
    return val !== undefined ? val : "";   // blank out unfilled placeholders
  });
}

// ── System prompt builder ─────────────────────────────────────────────────────
function buildSystemPrompt(
  rawPrompt: string,
  campaignName: string,
  agentName = "AI Assistant",
  leadName?: string,
  transferNumber?: string,
  humanLikeMode = true
): string {
  const firstName = leadName?.split(" ")[0];
  const lastName  = leadName?.split(" ").slice(1).join(" ") || "";

  const identity = leadName
    ? `You are ${agentName}, right now on a LIVE phone call with ${leadName} on behalf of "${campaignName}". The caller's name is ${firstName}. Use their name naturally throughout the conversation (e.g. "Thanks, ${firstName}!") — but do not overdo it.`
    : `You are ${agentName}, on a LIVE phone call on behalf of "${campaignName}".`;

  const transferInstruction = transferNumber
    ? `HUMAN TRANSFER: If the caller asks to speak with a human agent, or wants to be transferred — say EXACTLY: "Let me connect you with one of our agents right now — one moment please!" and nothing else. Then stop.`
    : `HUMAN TRANSFER: If the caller asks for a human, tell them a team member will follow up shortly and wrap up warmly.`;

  const rudeHandling = `HANDLING RUDE OR DIFFICULT CALLERS:
- If the caller is rude, uses profanity, or is dismissive — remain calm and warm. Say something like "I completely understand, I'll let you go — have a great day!" and stop talking. Never argue.
- If they say "stop calling", "remove me", "not interested" — acknowledge immediately: "Absolutely, I'll make a note of that right away. Have a wonderful day!" then end the call.
- If they're aggressive but still engaging — soften your tone, acknowledge their frustration briefly, then offer to help or move on.`;

  const nameConfirmation = firstName
    ? `NAME CONFIRMATION (FIRST STEP — do this before anything else):
- Your very first task is to confirm you're speaking with ${firstName}.
- You already said "Hi, is this ${firstName}?" — if they said yes/correct/speaking/sure/yep/that's me, they've confirmed. DO NOT ask again.
- Once confirmed: use "${firstName}" naturally throughout ("Got it, ${firstName}!", "Thanks ${firstName}!") — never say {{FirstName}} literally.
- If they say no or give a different name: say "Oh, I'm so sorry! Is this a good time?" and adapt.`
    : "";

  const progressionRules = `CONVERSATION PROGRESSION (CRITICAL):
- After each question, STOP and wait for the caller's answer.
- When they answer (even "yes", "no", "yeah", "uh huh", "sure") — ACCEPT it and MOVE to the next question immediately.
- NEVER repeat the same question twice. If unclear: move on with "Got it!" and the next point.
- Keep track of what questions you've already asked. Do not loop back.
- Treat any short response ("yes", "yeah", "ok", "fine") as confirmation and ADVANCE.
- If they go off-topic: briefly acknowledge, then bring back: "That makes sense! Just quickly…"`;

  // Substitute {{FirstName}}, {{LastName}}, {{Name}}, {{CampaignName}}, etc. in the campaign script
  const templateVars: Record<string, string> = {
    FirstName: firstName ?? "",
    Firstname: firstName ?? "",
    firstname: firstName ?? "",
    first_name: firstName ?? "",
    LastName: lastName,
    Lastname: lastName,
    lastname: lastName,
    last_name: lastName,
    Name: leadName ?? "",
    name: leadName ?? "",
    FullName: leadName ?? "",
    fullname: leadName ?? "",
    full_name: leadName ?? "",
    CampaignName: campaignName,
    campaignname: campaignName,
    campaign_name: campaignName,
    Campaign: campaignName,
    campaign: campaignName,
    AgentName: agentName,
    agentname: agentName,
    agent_name: agentName,
  };

  const coreScript = substituteVars(
    rawPrompt?.trim() ||
    `Be helpful, warm, and professional. Guide the conversation naturally. Ask one question at a time.`,
    templateVars
  );

  const humanSection = humanLikeMode ? `SPEECH STYLE — sound human, not robotic:
- Use natural fillers: "Hmm", "Right", "Got it", "Totally", "Of course", "Makes sense"
- Vary your openers — don't start every reply the same way
- Mirror the caller's energy: casual if they're casual, professional if they're formal
- Keep it brief: 1–2 sentences per response maximum\n\n` : "";

  return `${identity}

${humanSection}${nameConfirmation ? nameConfirmation + "\n\n" : ""}CAMPAIGN SCRIPT — follow this closely:
${coreScript}

${progressionRules}

${rudeHandling}

ABSOLUTE RULES:
- This is a LIVE phone call. 1–2 sentences MAX per response. Never write paragraphs.
- Never say "As an AI" or "I'm an AI" — just be helpful and natural.
- If they want to opt out: "Absolutely, so sorry — have a great day!" then stop.
- If they want a callback: confirm their preferred time warmly.
${transferInstruction}`;
}

// ── Telnyx Call Control helpers ───────────────────────────────────────────────
async function telnyxAction(
  callControlId: string,
  action: string,
  payload: Record<string, unknown> = {}
): Promise<void> {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) throw new Error("TELNYX_API_KEY not configured");
  await axios.post(
    `${TELNYX_API_BASE}/calls/${callControlId}/actions/${action}`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 10_000,
    }
  );
}

async function answerCall(callControlId: string): Promise<void> {
  await telnyxAction(callControlId, "answer", {});
}

async function startRecording(callControlId: string): Promise<void> {
  await telnyxAction(callControlId, "record_start", {
    format: "mp3",
    channels: "dual",
    play_beep: false,
  });
}

// ── In-memory TTS audio cache (served at /api/audio/:token) ─────────────────
interface CachedAudio { data: Buffer; contentType: string; expiresAt: number; }
const audioCache = new Map<string, CachedAudio>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of audioCache) if (v.expiresAt < now) audioCache.delete(k);
}, 30_000);

// ── Per-call conversation history & state ────────────────────────────────────
interface ConvMessage { role: "system" | "user" | "assistant"; content: string; }
const callMessages         = new Map<string, ConvMessage[]>();   // callControlId → chat history
const aiSpeaking           = new Set<string>();                  // callControlId → AI currently speaking
const callOwnNumber        = new Map<string, string>();          // callControlId → our campaign phone #
const missedTranscription  = new Map<string, string>();          // callControlId → transcript spoken during AI speech

/** Stable numeric ID from a callControlId string (for live monitor without DB row) */
function syntheticId(callControlId: string): number {
  let h = 0;
  for (let i = 0; i < callControlId.length; i++) {
    h = (Math.imul(31, h) + callControlId.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 9_000_000 + 1_000_000;
}

function makeAudioToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Call ElevenLabs TTS HTTP API, cache the MP3, return a publicly reachable URL */
async function generateTTS(voiceId: string, text: string): Promise<string> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not configured");

  let resp;
  try {
    resp = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        text,
        model_id: "eleven_turbo_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      },
      {
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        responseType: "arraybuffer",
        timeout: 20_000,
      }
    );
  } catch (err) {
    if (axios.isAxiosError(err) && err.response) {
      const body = Buffer.from(err.response.data as ArrayBuffer).toString("utf-8").slice(0, 300);
      logger.error({ voiceId, status: err.response.status, body }, "ElevenLabs TTS failed");
    }
    throw err;
  }

  const token = makeAudioToken();
  audioCache.set(token, {
    data: Buffer.from(resp.data as ArrayBuffer),
    contentType: "audio/mpeg",
    expiresAt: Date.now() + 10 * 60_000, // 10 min TTL
  });
  return `${BACKEND_WEBHOOK_URL}/api/audio/${token}`;
}

/**
 * Play audio via Telnyx playback_start (ElevenLabs TTS URL).
 * Falls back to Telnyx native speak if playback_start returns an error.
 */
async function playWithFallback(
  callControlId: string,
  audioUrl: string,
  text: string
): Promise<void> {
  try {
    await telnyxAction(callControlId, "playback_start", {
      audio_url: audioUrl,
    });
    logger.info({ callControlId }, "ElevenLabs audio playing via playback_start");
  } catch (err) {
    const status = axios.isAxiosError(err) ? err.response?.status : null;
    logger.warn({ callControlId, status, err: String(err) }, "playback_start failed — falling back to Telnyx speak");
    await telnyxAction(callControlId, "speak", {
      payload: text,
      payload_type: "text",
      voice: "female",
      language: "en-US",
    });
  }
}

/**
 * Start Telnyx transcription and play the AI's greeting via ElevenLabs TTS.
 * This replaces the fork_start approach — no inbound WebSocket needed.
 */
async function startTranscriptionAndGreet(callControlId: string): Promise<void> {
  const bridge = getBridgeInfo(callControlId);
  if (!bridge) return;

  // Start Telnyx real-time transcription (STT)
  await telnyxAction(callControlId, "transcription_start", {
    language: "en",
    transcription_engine: "A",
    interim_results: false,
  });

  // Speak the greeting via ElevenLabs TTS
  aiSpeaking.add(callControlId);
  try {
    const audioUrl = await generateTTS(bridge.voiceId, bridge.firstMessage);
    await playWithFallback(callControlId, audioUrl, bridge.firstMessage);
    bridge.transcript.push(`AI Agent: ${bridge.firstMessage}`);
  } catch (err) {
    aiSpeaking.delete(callControlId);
    logger.error({ err: String(err), callControlId }, "Failed to generate/play greeting — falling back to speak");
    try {
      await telnyxAction(callControlId, "speak", {
        payload: bridge.firstMessage,
        payload_type: "text",
        voice: "female",
        language: "en-US",
      });
      bridge.transcript.push(`AI Agent: ${bridge.firstMessage}`);
    } catch (speakErr) {
      aiSpeaking.delete(callControlId);
      logger.error({ err: String(speakErr), callControlId }, "Speak fallback also failed");
    }
  }
}

/** Process a final transcription from the caller and speak the AI's response */
async function handleCallerTurn(callControlId: string, callerText: string): Promise<void> {
  const bridge = getBridgeInfo(callControlId);
  if (!bridge) {
    logger.warn({ callControlId, callerText }, "handleCallerTurn: no bridge — skipping");
    return;
  }

  const clean = callerText.trim();
  if (clean.length < 2) {
    logger.debug({ callControlId, clean }, "handleCallerTurn: text too short — skipping");
    return;
  }

  // Don't process while AI is speaking — but save for replay after speak.ended
  if (aiSpeaking.has(callControlId)) {
    logger.info({ callControlId, callerText }, "Transcription during AI speech — buffered for replay");
    // Keep the latest, longest utterance spoken during AI turn
    const prev = missedTranscription.get(callControlId) ?? "";
    if (clean.length > prev.trim().length) {
      missedTranscription.set(callControlId, clean);
    }
    return;
  }

  if (bridge.pendingTransfer) {
    logger.debug({ callControlId }, "handleCallerTurn: pending transfer — skipping");
    return;
  }

  logger.info({ callControlId, callerText }, "Caller turn — generating AI response");
  bridge.transcript.push(`Caller: ${clean}`);

  const history = callMessages.get(callControlId) ?? [{ role: "system" as const, content: bridge.systemPrompt }];
  history.push({ role: "user", content: clean });
  callMessages.set(callControlId, history);

  // GPT completion — short tokens to enforce 1-2 sentence rule
  let aiText: string;
  try {
    const completion = await openai.chat.completions.create({
      model: AI_MODEL,
      max_tokens: 150,
      temperature: 0.7,
      messages: history.slice(-20) as Parameters<typeof openai.chat.completions.create>[0]["messages"],
    });
    aiText = (completion.choices[0]?.message?.content ?? "").trim();
    logger.info({ callControlId, aiText: aiText.slice(0, 80) }, "OpenAI response received");
  } catch (err) {
    const detail = axios.isAxiosError(err) && err.response
      ? JSON.stringify(err.response.data).slice(0, 400)
      : String(err);
    logger.error({ callControlId, detail }, "OpenAI completion failed");
    return;
  }

  if (!aiText) {
    logger.warn({ callControlId }, "OpenAI returned empty response");
    return;
  }

  history.push({ role: "assistant", content: aiText });
  bridge.transcript.push(`AI Agent: ${aiText}`);

  // Detect transfer phrase before playing TTS
  const wantsTransfer =
    bridge.transferNumber &&
    !bridge.pendingTransfer &&
    (aiText.toLowerCase().includes("connect you with") || aiText.toLowerCase().includes("transfer you"));

  if (wantsTransfer) {
    bridge.pendingTransfer = true;
    const ownNum = callOwnNumber.get(callControlId) ?? "";
    logger.info({ callControlId, transferTo: bridge.transferNumber }, "Transfer phrase detected");

    aiSpeaking.add(callControlId);
    try {
      const audioUrl = await generateTTS(bridge.voiceId, aiText);
      await playWithFallback(callControlId, audioUrl, aiText);
    } catch (err) {
      aiSpeaking.delete(callControlId);
      logger.warn({ callControlId, err: String(err) }, "Transfer TTS failed — proceeding to transfer anyway");
    }

    setTimeout(async () => {
      try {
        await executeTransfer(callControlId, bridge.transferNumber!, ownNum, bridge.holdMusicUrl);
        await telnyxAction(callControlId, "transcription_stop", {}).catch(() => {});
      } catch (err) {
        logger.error({ err: String(err), callControlId }, "Transfer failed");
      }
    }, 2_500);
    return;
  }

  // Generate ElevenLabs TTS and play via playback_start (fallback to speak)
  aiSpeaking.add(callControlId);
  try {
    const audioUrl = await generateTTS(bridge.voiceId, aiText);
    await playWithFallback(callControlId, audioUrl, aiText);
    logger.info({ callControlId, aiText: aiText.slice(0, 80) }, "AI response playing via ElevenLabs TTS");
  } catch (err) {
    aiSpeaking.delete(callControlId);
    const detail = axios.isAxiosError(err) && err.response
      ? JSON.stringify(err.response.data).slice(0, 400)
      : String(err);
    logger.error({ callControlId, detail }, "ElevenLabs TTS + playback failed");
  }
}

async function speak(callControlId: string, text: string): Promise<void> {
  await telnyxAction(callControlId, "speak", {
    payload: text,
    payload_type: "text",
    voice: "female",
    language: "en-US",
  });
}

async function executeTransfer(
  callControlId: string,
  toNumber: string,
  fromNumber: string,
  holdMusicUrl?: string
): Promise<void> {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) throw new Error("TELNYX_API_KEY not configured");

  const musicUrl = holdMusicUrl ?? DEFAULT_HOLD_MUSIC_URL;
  logger.info({ callControlId, to: toNumber, from: fromNumber, holdMusicUrl: musicUrl }, "Executing Telnyx transfer");

  await axios.post(
    `${TELNYX_API_BASE}/calls/${callControlId}/actions/transfer`,
    {
      to: toNumber,
      from: fromNumber,
      audio_url: musicUrl,       // hold music plays to caller while ringing human
      timeout_secs: 30,          // ring for max 30s before giving up
      webhook_url: `${BACKEND_WEBHOOK_URL}/api/webhooks/telnyx`,
      webhook_api_version: "2",
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 15_000,
    }
  );

  logger.info({ callControlId, to: toNumber }, "Telnyx transfer initiated — hold music active, ringing human agent");

  // Live monitor: notify supervisors of transfer
  emitToSupervisors("call:transferred", {
    callId: syntheticId(callControlId),
    callControlId,
    transferTo: toNumber,
  });
}

// ── Campaign lookup by called number ─────────────────────────────────────────
async function getCampaignByNumber(toNumber: string) {
  const [phoneRow] = await db
    .select()
    .from(phoneNumbersTable)
    .where(
      and(
        eq(phoneNumbersTable.phoneNumber, toNumber),
        eq(phoneNumbersTable.status, "active")
      )
    )
    .limit(1);

  if (!phoneRow?.campaignId) return null;

  const [campaign] = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.id, phoneRow.campaignId))
    .limit(1);

  if (!campaign) return null;

  let agentName = "AI Assistant";
  let agentPrompt: string = campaign.agentPrompt ?? "";
  let resolvedVoiceId: string = DEFAULT_ELEVEN_VOICE;
  let humanLikeMode = campaign.humanLike !== "false";

  if (campaign.agentId) {
    const [agent] = await db
      .select()
      .from(aiAgentsTable)
      .where(eq(aiAgentsTable.id, campaign.agentId))
      .limit(1);
    if (agent) {
      agentName = agent.name;
      if (!agentPrompt) agentPrompt = agent.prompt;
      if (campaign.humanLike == null) humanLikeMode = agent.humanLikeMode ?? true;

      if (agent.defaultVoiceId) {
        const [voice] = await db
          .select({ voiceId: voicesTable.voiceId, provider: voicesTable.provider })
          .from(voicesTable)
          .where(eq(voicesTable.id, agent.defaultVoiceId))
          .limit(1);
        if (voice?.provider === "elevenlabs" && voice.voiceId) {
          resolvedVoiceId = voice.voiceId;
        }
      }
    }
  }

  if (campaign.voice && campaign.voice !== "default") {
    resolvedVoiceId = campaign.voice;
  }

  const systemPrompt = buildSystemPrompt(
    agentPrompt,
    campaign.name,
    agentName,
    undefined,
    campaign.transferNumber ?? undefined,
    humanLikeMode
  );

  const holdMusicUrl = resolveHoldMusicUrl(campaign.holdMusic);

  return { campaign, agentName, systemPrompt, voiceId: resolvedVoiceId, holdMusicUrl };
}

// ── Post-call summary & disposition (OpenAI on ElevenLabs transcript) ─────────
async function generateSummaryAndDisposition(
  transcript: string,
  campaignName: string
): Promise<{ summary: string; disposition: string }> {
  if (!transcript.trim()) {
    return { summary: "No conversation recorded.", disposition: "no_answer" };
  }
  try {
    const res = await openai.chat.completions.create({
      model: AI_MODEL,
      max_tokens: 500,
      messages: [
        {
          role: "system",
          content: `You are a call center quality analyst. Analyze this phone call transcript for campaign "${campaignName}" and return a JSON object with exactly these fields:
{
  "summary": "2-3 sentence summary of what was discussed and outcome",
  "disposition": one of: "interested" | "not_interested" | "vm" | "no_answer" | "busy" | "connected" | "callback_requested" | "transferred" | "completed"
}
Return ONLY valid JSON, no markdown.`,
        },
        { role: "user", content: `CALL TRANSCRIPT:\n${transcript}` },
      ],
    });
    const raw = res.choices[0]?.message?.content?.trim() ?? "{}";
    const parsed = JSON.parse(raw) as { summary?: string; disposition?: string };
    return {
      summary: parsed.summary ?? "Call completed.",
      disposition: parsed.disposition ?? "connected",
    };
  } catch {
    return { summary: "Call completed successfully.", disposition: "connected" };
  }
}

// ── Outbound client_state decoder ─────────────────────────────────────────────
interface OutboundClientState {
  type: "outbound";
  campaignId: string;
  campaignName: string;
  script: string;
  voice: string;
  phone: string;
  transferNumber: string | null;
  backgroundSound: string | null;
}

function decodeClientState(raw: string): OutboundClientState | null {
  try {
    const json = Buffer.from(raw, "base64").toString("utf-8");
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (parsed?.type === "outbound") return parsed as unknown as OutboundClientState;
    return null;
  } catch {
    return null;
  }
}

// ── POST /webhooks/telnyx ─────────────────────────────────────────────────────
router.post("/webhooks/telnyx", async (req, res): Promise<void> => {
  res.status(200).json({ received: true });

  const event = req.body?.data;
  if (!event) return;

  const eventType: string = event.event_type ?? "";
  const payload = event.payload ?? {};
  const callControlId: string = payload.call_control_id ?? "";
  const direction: string = payload.direction ?? "";
  const toNumber: string = payload.to ?? "";
  const fromNumber: string = payload.from ?? "";
  const clientStateRaw: string = payload.client_state ?? "";

  logger.info({ eventType, direction, to: toNumber, from: fromNumber, callControlId }, "Telnyx event");

  try {
    // ── 0. AMD result — hang up on voicemail ──────────────────────────────────
    if (
      eventType === "call.machine.detection.ended" ||
      eventType === "call.machine.premium.detection.ended"
    ) {
      const result: string = payload.result ?? "";
      logger.info({ callControlId, result }, "AMD result");

      if (
        result === "machine_start" ||
        result === "machine_end_beep" ||
        result === "machine_end_silence"
      ) {
        try { await telnyxAction(callControlId, "hangup", {}); } catch { /* already gone */ }

        const bridge = getBridgeInfo(callControlId);
        if (bridge) {
          const durationSecs = Math.round(
            (Date.now() - bridge.startedAt.getTime()) / 1000
          );
          await db.insert(callLogsTable).values({
            phoneNumber: bridge.callerNumber,
            campaignId: bridge.campaignId,
            status: "completed",
            disposition: "vm",
            direction: "outbound",
            duration: durationSecs,
            callControlId,
          }).catch(() => {});
          closeBridge(callControlId);
        }
      }
      return;
    }

    // ── 1a. Outbound call answered by human ───────────────────────────────────
    if (eventType === "call.answered") {
      const ctx = clientStateRaw ? decodeClientState(clientStateRaw) : null;
      if (!ctx) {
        logger.info({ callControlId, direction }, "call.answered without client_state — inbound, skipping");
        return;
      }

      const campaignId = parseInt(ctx.campaignId, 10);

      // Look up lead name
      const [lead] = await db
        .select({ name: leadsTable.name, id: leadsTable.id })
        .from(leadsTable)
        .where(and(eq(leadsTable.phone, ctx.phone), eq(leadsTable.campaignId, campaignId)))
        .limit(1);

      // Look up agent name + hold music
      const [campaign] = await db
        .select({ agentId: campaignsTable.agentId, holdMusic: campaignsTable.holdMusic })
        .from(campaignsTable)
        .where(eq(campaignsTable.id, campaignId))
        .limit(1);

      let agentName = "Nexus";
      if (campaign?.agentId) {
        const [agent] = await db
          .select({ name: aiAgentsTable.name })
          .from(aiAgentsTable)
          .where(eq(aiAgentsTable.id, campaign.agentId))
          .limit(1);
        if (agent?.name) agentName = agent.name;
      }

      const outboundHoldMusicUrl = resolveHoldMusicUrl(campaign?.holdMusic);

      const leadName = lead?.name;
      const firstName = leadName?.split(" ")[0];
      const callVoiceId =
        ctx.voice && ctx.voice !== "default" ? ctx.voice : DEFAULT_ELEVEN_VOICE;

      const systemPrompt = buildSystemPrompt(
        ctx.script,
        ctx.campaignName,
        agentName,
        leadName,
        ctx.transferNumber ?? undefined
      );

      // First message — short name-check greeting; system prompt handles the rest
      const firstMessage = firstName
        ? `Hi, is this ${firstName}?`
        : `Hello! This is ${agentName} calling from ${ctx.campaignName}. Is this a good time?`;

      logger.info(
        { callControlId, campaignId, phone: ctx.phone, leadName, agentName, voiceId: callVoiceId },
        "Outbound call answered — starting ElevenLabs ConvAI bridge"
      );

      // Register bridge state
      initBridge(callControlId, {
        campaignId,
        campaignName: ctx.campaignName,
        agentName,
        callerNumber: ctx.phone,
        direction: "outbound",
        startedAt: new Date(),
        leadId: lead?.id,
        transferNumber: ctx.transferNumber ?? undefined,
        holdMusicUrl: outboundHoldMusicUrl,
        voiceId: callVoiceId,
        systemPrompt,
        firstMessage,
        onTransferRequested: async (transferTo) => {
          try {
            const bridge = getBridgeInfo(callControlId);
            await executeTransfer(callControlId, transferTo, fromNumber, bridge?.holdMusicUrl);
            logger.info({ callControlId, transferTo }, "Outbound transfer executed — hold music active, stopping media fork");
            await telnyxAction(callControlId, "fork_stop", {}).catch(() => {});
          } catch (err) {
            logger.error({ err: String(err), callControlId }, "Outbound transfer failed in bridge callback");
          }
        },
        onCallEnded: () => {
          logger.info({ callControlId }, "ElevenLabs ended outbound call — hanging up Telnyx");
          telnyxAction(callControlId, "hangup", {}).catch(() => {});
        },
      });

      // Store our campaign phone number (needed if transfer is requested)
      callOwnNumber.set(callControlId, fromNumber);

      await startRecording(callControlId).catch((err) =>
        logger.warn({ err: String(err), callControlId }, "Recording start failed — continuing")
      );

      // Start transcription + play ElevenLabs greeting
      await startTranscriptionAndGreet(callControlId);

      // Live monitor: announce active call to supervisors
      emitToSupervisors("call:started", {
        id: syntheticId(callControlId),
        callControlId,
        campaignId,
        leadId: lead?.id,
        phoneNumber: ctx.phone,
        providerUsed: "telnyx",
        status: "in_progress",
        startedAt: new Date().toISOString(),
      });
      return;
    }

    // ── 1b. Inbound call arrives ──────────────────────────────────────────────
    if (eventType === "call.initiated" && direction === "incoming") {
      const result = await getCampaignByNumber(toNumber);

      if (!result) {
        await answerCall(callControlId);
        await speak(
          callControlId,
          "Thank you for calling. We are unable to connect your call at this time. Goodbye."
        );
        return;
      }

      const { campaign, agentName, systemPrompt, voiceId: inboundVoiceId, holdMusicUrl: inboundHoldMusicUrl } = result;
      const firstMessage = `Thank you for calling ${campaign.name}. This is ${agentName}. How may I help you today?`;

      logger.info(
        { callControlId, campaignId: campaign.id, agentName, voiceId: inboundVoiceId },
        "Inbound call — starting ElevenLabs ConvAI bridge"
      );

      // Register bridge state before answering
      initBridge(callControlId, {
        campaignId: campaign.id,
        campaignName: campaign.name,
        agentName,
        callerNumber: fromNumber,
        direction: "inbound",
        startedAt: new Date(),
        transferNumber: campaign.transferNumber ?? undefined,
        holdMusicUrl: inboundHoldMusicUrl,
        voiceId: inboundVoiceId,
        systemPrompt,
        firstMessage,
        onTransferRequested: async (transferTo) => {
          try {
            const bridge = getBridgeInfo(callControlId);
            await executeTransfer(callControlId, transferTo, toNumber, bridge?.holdMusicUrl);
            logger.info({ callControlId, transferTo }, "Inbound transfer executed — hold music active, stopping media fork");
            await telnyxAction(callControlId, "fork_stop", {}).catch(() => {});
          } catch (err) {
            logger.error({ err: String(err), callControlId }, "Inbound transfer failed in bridge callback");
          }
        },
        onCallEnded: () => {
          logger.info({ callControlId }, "ElevenLabs ended inbound call — hanging up Telnyx");
          telnyxAction(callControlId, "hangup", {}).catch(() => {});
        },
      });

      await answerCall(callControlId);

      // Store our campaign phone number (needed if transfer is requested)
      callOwnNumber.set(callControlId, toNumber);

      await startRecording(callControlId).catch((err) =>
        logger.warn({ err: String(err), callControlId }, "Inbound recording start failed — continuing")
      );

      // Start transcription + play ElevenLabs greeting
      await startTranscriptionAndGreet(callControlId);

      // Live monitor: notify supervisors of inbound call
      const inboundId = syntheticId(callControlId);
      emitToSupervisors("call:inbound", {
        callId: inboundId,
        callControlId,
        from: fromNumber,
        campaignId: campaign.id,
      });
      emitToSupervisors("call:started", {
        id: inboundId,
        callControlId,
        campaignId: campaign.id,
        phoneNumber: fromNumber,
        providerUsed: "telnyx",
        status: "in_progress",
        startedAt: new Date().toISOString(),
      });
      return;
    }

    // ── 2. Transfer bridged ───────────────────────────────────────────────────
    if (eventType === "call.bridged") {
      logger.info({ callControlId, to: toNumber, from: fromNumber }, "Call bridged — transfer successful");
      return;
    }

    // ── 3. Recording saved ────────────────────────────────────────────────────
    if (eventType === "call.recording.saved") {
      const recordingUrl: string =
        payload.recording_urls?.mp3 ?? payload.public_recording_urls?.mp3 ?? "";
      logger.info({ callControlId, recordingUrl }, "Recording saved");

      if (recordingUrl) {
        setRecordingUrl(callControlId, recordingUrl);

        const [existing] = await db
          .select({ id: callLogsTable.id })
          .from(callLogsTable)
          .where(eq(callLogsTable.callControlId, callControlId))
          .limit(1);

        if (existing) {
          await db
            .update(callLogsTable)
            .set({ recordingUrl })
            .where(eq(callLogsTable.id, existing.id));
          logger.info({ callControlId }, "Recording URL saved to DB");
        }
      }
      return;
    }

    // ── 3a. Transcription result — drive the conversation ─────────────────────
    if (eventType === "call.transcription") {
      const td = payload.transcription_data ?? {};
      const transcript: string = td.transcript ?? "";
      const isFinal: boolean = td.is_final === true || td.is_final === "true";

      if (!isFinal || transcript.trim().length < 2) return;

      logger.info({ callControlId, transcript: transcript.slice(0, 100) }, "Final transcription received");
      handleCallerTurn(callControlId, transcript).catch((err) =>
        logger.error({ err: String(err), callControlId }, "handleCallerTurn error")
      );
      return;
    }

    // ── 3b. Speak/playback ended — clear speaking flag & replay missed ────────
    if (eventType === "call.speak.ended" || eventType === "call.playback.ended") {
      logger.info({ callControlId, eventType }, "AI speech finished");
      aiSpeaking.delete(callControlId);

      // Replay any caller speech that arrived while AI was talking
      const missed = missedTranscription.get(callControlId);
      if (missed) {
        missedTranscription.delete(callControlId);
        logger.info({ callControlId, missed: missed.slice(0, 80) }, "Replaying buffered caller speech");
        handleCallerTurn(callControlId, missed).catch((err) =>
          logger.error({ err: String(err), callControlId }, "handleCallerTurn (replay) error")
        );
      }
      return;
    }

    // ── 4. Call hung up — finalize ────────────────────────────────────────────
    if (eventType === "call.hangup") {
      const bridge = getBridgeInfo(callControlId);
      if (!bridge) return;

      const durationSecs = Math.round(
        (Date.now() - bridge.startedAt.getTime()) / 1000
      );
      const transcript = bridge.transcript.join("\n");

      const { summary, disposition } = await generateSummaryAndDisposition(
        transcript,
        bridge.campaignName
      );

      if (bridge.direction === "outbound") {
        await db.insert(callLogsTable).values({
          phoneNumber: bridge.callerNumber,
          campaignId: bridge.campaignId,
          status: "completed",
          disposition,
          direction: "outbound",
          duration: durationSecs,
          recordingUrl: bridge.recordingUrl ?? null,
          transcript,
          summary,
          callControlId,
        }).catch((err) =>
          logger.error({ err: String(err), callControlId }, "Failed to insert outbound call log")
        );

        // Update lead status
        const leadStatus = disposition === "callback_requested" ? "callback" : "called";
        await db
          .update(leadsTable)
          .set({
            status: leadStatus as "called" | "callback",
            metadata: JSON.stringify({ lastCallSummary: summary, lastDisposition: disposition }),
          })
          .where(
            and(
              eq(leadsTable.phone, bridge.callerNumber),
              eq(leadsTable.campaignId, bridge.campaignId)
            )
          )
          .catch(() => {});

        logger.info(
          { callControlId, campaignId: bridge.campaignId, disposition, durationSecs },
          "Outbound call finalized"
        );
      } else {
        await db.insert(callLogsTable).values({
          phoneNumber: bridge.callerNumber,
          campaignId: bridge.campaignId,
          status: "completed",
          disposition,
          direction: "inbound",
          duration: durationSecs,
          recordingUrl: bridge.recordingUrl ?? null,
          transcript,
          summary,
          callControlId,
        }).catch((err) =>
          logger.error({ err: String(err), callControlId }, "Failed to insert inbound call log")
        );

        logger.info(
          { callControlId, campaignId: bridge.campaignId, disposition, durationSecs },
          "Inbound call finalized"
        );
      }

      // Live monitor: call ended
      emitToSupervisors("call:ended", {
        id: syntheticId(callControlId),
        callControlId,
        disposition,
        duration: durationSecs,
      });

      // Stop transcription cleanly
      await telnyxAction(callControlId, "transcription_stop", {}).catch(() => {});

      closeBridge(callControlId);
      // Clean up per-call state
      callMessages.delete(callControlId);
      aiSpeaking.delete(callControlId);
      callOwnNumber.delete(callControlId);
      missedTranscription.delete(callControlId);
      return;
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ eventType, callControlId, err: msg }, "Error handling Telnyx webhook");
  }
});

// ── GET /audio/:token — serve cached TTS audio to Telnyx playback_start ──────
router.get("/audio/:token", (req, res): void => {
  const cached = audioCache.get(req.params.token ?? "");
  if (!cached || cached.expiresAt < Date.now()) {
    res.status(404).send("Audio not found or expired");
    return;
  }
  res.setHeader("Content-Type", cached.contentType);
  res.setHeader("Content-Length", cached.data.length);
  res.setHeader("Cache-Control", "no-store");
  res.end(cached.data);
});

// ── GET /webhooks/telnyx/config ───────────────────────────────────────────────
router.get("/webhooks/telnyx/config", async (_req, res): Promise<void> => {
  res.json({
    webhookUrl: "https://shivanshbackend.replit.app/api/webhooks/telnyx",
    instructions: [
      "1. Log in to Telnyx Mission Control Portal (portal.telnyx.com)",
      "2. Go to Numbers → My Numbers → select your phone number",
      "3. Under Voice Settings, set Connection to 'Call Control'",
      "4. Paste the webhook URL above into the 'Webhook URL' field",
      "5. Set Webhook API Version to v2 and save",
      "6. Assign the number to an Inbound campaign in the dashboard",
    ],
  });
});

export default router;
