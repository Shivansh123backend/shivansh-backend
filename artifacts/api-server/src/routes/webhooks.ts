/**
 * Telnyx Webhooks — ElevenLabs Conversational AI Bridge Edition
 *
 * Flow:
 *   Outbound: workerService dials → call.answered → fork_start → ElevenLabs ConvAI
 *   Inbound:  call.initiated → answer → fork_start → ElevenLabs ConvAI
 *   Both:     ElevenLabs handles STT + LLM + TTS in real-time over the fork WebSocket
 *   End:      call.hangup → finalize (summary via OpenAI on ElevenLabs transcript)
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

// ── Human-Like Style prompt addon ─────────────────────────────────────────────
const HUMAN_LIKE_PROMPT_ADDON = `
=== HUMAN-LIKE SPEECH STYLE (ENABLED) ===
NATURAL FILLERS — use these to sound human, not robotic:
- Use "Hmm", "Let me see", "Right", "Yeah", "Got it", "Totally", "Of course" naturally
- Occasionally start with a small affirmation: "Oh, I see", "Ah, great!", "Sure thing"
- Mirror the caller: if they're casual, be casual; if formal, stay professional

EMPATHY FIRST:
- Before proceeding, acknowledge what they said: "That makes total sense", "I completely understand"
- If they sound busy: "I'll keep this really brief, I promise"
- If they express frustration: "I really appreciate your patience" before continuing

PACING & PAUSES:
- Don't rush — leave natural space for the caller to think
- After asking a question, STOP and wait — don't fill every gap
- If they seem confused, rephrase simply rather than repeating word-for-word

AVOID:
- Never say "Certainly!", "Absolutely!", "Of course!" as a hollow opener every single time
- Never sound like you're reading a script — vary your phrasing each turn
=== END HUMAN-LIKE STYLE ===`.trim();

// ── System prompt builder ─────────────────────────────────────────────────────
function buildSystemPrompt(
  rawPrompt: string,
  campaignName: string,
  agentName = "AI Assistant",
  leadName?: string,
  transferNumber?: string,
  humanLikeMode = true
): string {
  const identity = leadName
    ? `You are ${agentName}, right now on a live phone call with ${leadName} on behalf of "${campaignName}".`
    : `You are ${agentName}, on a live phone call on behalf of "${campaignName}".`;

  const transferInstruction = transferNumber
    ? `HUMAN TRANSFER: If the caller asks to speak with a human, wants to move forward, or asks to be transferred — say EXACTLY: "Let me connect you with one of our agents right now — one moment please!" and nothing else.`
    : `HUMAN TRANSFER: If the caller asks for a human, tell them a team member will follow up shortly and wrap up warmly.`;

  const coreScript =
    rawPrompt?.trim() ||
    `Be helpful, warm, and professional. Guide the conversation naturally. Ask one question at a time.`;

  const humanSection = humanLikeMode ? HUMAN_LIKE_PROMPT_ADDON + "\n\n" : "";

  return `${identity}

${humanSection}${coreScript}

CRITICAL PHONE CALL RULES (always enforce these):
- This is a LIVE phone call. Every response must be 1-3 sentences MAX. Never write paragraphs.
- Ask ONE question at a time. Wait for their answer before asking the next one.
- React naturally to what they just said BEFORE moving to your next point.
- Never say "As an AI..." unless they directly ask if you're a bot.
- If they want to opt out: "Absolutely, so sorry for the interruption — have a great day!" then stop talking.
- Use natural speech: "Sure", "Got it", "Of course", "Makes sense", "Totally understand".
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
const callMessages  = new Map<string, ConvMessage[]>();   // callControlId → chat history
const aiSpeaking    = new Set<string>();                  // callControlId → AI currently speaking
const callOwnNumber = new Map<string, string>();          // callControlId → our campaign phone #

function makeAudioToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Call ElevenLabs TTS HTTP API, cache the MP3, return a publicly reachable URL */
async function generateTTS(voiceId: string, text: string): Promise<string> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not configured");

  const resp = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      text,
      model_id: "eleven_turbo_v2_5",
      voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.0 },
    },
    {
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      responseType: "arraybuffer",
      timeout: 15_000,
    }
  );

  const token = makeAudioToken();
  audioCache.set(token, {
    data: Buffer.from(resp.data as ArrayBuffer),
    contentType: "audio/mpeg",
    expiresAt: Date.now() + 10 * 60_000, // 10 min TTL
  });
  return `${BACKEND_WEBHOOK_URL}/api/audio/${token}`;
}

/** Start the AI conversation: turn on Telnyx transcription + play the first greeting */
async function startAIConversation(callControlId: string): Promise<void> {
  const bridge = getBridgeInfo(callControlId);
  if (!bridge) throw new Error("No bridge for " + callControlId);

  // Seed conversation history with system prompt + first message
  const history: ConvMessage[] = [
    { role: "system",    content: bridge.systemPrompt },
    { role: "assistant", content: bridge.firstMessage },
  ];
  callMessages.set(callControlId, history);
  bridge.transcript.push(`AI Agent: ${bridge.firstMessage}`);

  // Start Telnyx real-time transcription (final results only)
  await telnyxAction(callControlId, "transcription_start", {
    transcription_engine: "A",
    language: "en",
    interim_results: false,
  }).catch((err) =>
    logger.warn({ err: String(err), callControlId }, "transcription_start failed — voice input disabled")
  );

  // Generate + play ElevenLabs greeting
  const audioUrl = await generateTTS(bridge.voiceId, bridge.firstMessage);
  aiSpeaking.add(callControlId);
  await telnyxAction(callControlId, "playback_start", { audio_url: audioUrl, loop: false });
  logger.info({ callControlId, text: bridge.firstMessage }, "AI greeting sent via ElevenLabs TTS");
}

/** Process a final transcription from the caller and speak the AI's response */
async function handleCallerTurn(callControlId: string, callerText: string): Promise<void> {
  const bridge = getBridgeInfo(callControlId);
  if (!bridge) return;

  const clean = callerText.trim();
  if (clean.length < 2) return;

  // Don't process while AI is speaking — avoids echo
  if (aiSpeaking.has(callControlId)) {
    logger.debug({ callControlId, callerText }, "Transcription during AI speech — skipped");
    return;
  }

  if (bridge.pendingTransfer) return;

  logger.info({ callControlId, callerText }, "Caller turn — generating AI response");
  bridge.transcript.push(`Caller: ${clean}`);

  const history = callMessages.get(callControlId) ?? [{ role: "system" as const, content: bridge.systemPrompt }];
  history.push({ role: "user", content: clean });
  callMessages.set(callControlId, history);

  // GPT completion (keep last 20 turns to stay within token limit)
  const completion = await openai.chat.completions.create({
    model: AI_MODEL,
    max_tokens: 200,
    temperature: 0.8,
    messages: history.slice(-20) as Parameters<typeof openai.chat.completions.create>[0]["messages"],
  });

  const aiText = (completion.choices[0]?.message?.content ?? "").trim();
  if (!aiText) return;

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

    try {
      const audioUrl = await generateTTS(bridge.voiceId, aiText);
      aiSpeaking.add(callControlId);
      await telnyxAction(callControlId, "playback_start", { audio_url: audioUrl, loop: false });
    } catch { /* playback not critical — proceed to transfer */ }

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

  // Normal TTS response
  try {
    const audioUrl = await generateTTS(bridge.voiceId, aiText);
    aiSpeaking.add(callControlId);
    await telnyxAction(callControlId, "playback_start", { audio_url: audioUrl, loop: false });
    logger.info({ callControlId, aiText }, "AI response sent via ElevenLabs TTS");
  } catch (err) {
    logger.error({ err: String(err), callControlId }, "TTS / playback failed");
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

      // First message the AI says as soon as the call connects
      const firstMessage = firstName
        ? `Hi, is this ${firstName}? This is ${agentName} calling from ${ctx.campaignName}.`
        : `Hello! This is ${agentName} calling from ${ctx.campaignName}.`;

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
      });

      // Store our campaign phone number (needed if transfer is requested)
      callOwnNumber.set(callControlId, fromNumber);

      await startRecording(callControlId).catch((err) =>
        logger.warn({ err: String(err), callControlId }, "Recording start failed — continuing")
      );

      // Start AI conversation: Telnyx transcription + ElevenLabs TTS playback
      await startAIConversation(callControlId);
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
      });

      await answerCall(callControlId);

      // Store our campaign phone number (needed if transfer is requested)
      callOwnNumber.set(callControlId, toNumber);

      await startRecording(callControlId).catch((err) =>
        logger.warn({ err: String(err), callControlId }, "Inbound recording start failed — continuing")
      );

      // Start AI conversation: Telnyx transcription + ElevenLabs TTS playback
      await startAIConversation(callControlId);
      return;
    }

    // ── 2. Transfer bridged ───────────────────────────────────────────────────
    if (eventType === "call.bridged") {
      logger.info({ callControlId, to: toNumber, from: fromNumber }, "Call bridged — transfer successful");
      return;
    }

    // ── 2b. Caller transcription — run the AI response turn ──────────────────
    if (eventType === "call.transcription") {
      const items = (payload.transcription_data ?? []) as Array<{ transcript?: string; is_final?: boolean }>;
      for (const item of items) {
        if (item.is_final && item.transcript?.trim()) {
          await handleCallerTurn(callControlId, item.transcript.trim());
        }
      }
      return;
    }

    // ── 2c. AI audio playback finished — open the mic again ──────────────────
    if (eventType === "call.playback.ended" || eventType === "call.speak.ended") {
      aiSpeaking.delete(callControlId);
      logger.debug({ callControlId, eventType }, "AI speech ended — ready for caller input");
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

      closeBridge(callControlId);
      // Clean up per-call state
      callMessages.delete(callControlId);
      aiSpeaking.delete(callControlId);
      callOwnNumber.delete(callControlId);
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
