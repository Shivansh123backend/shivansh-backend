import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { phoneNumbersTable, campaignsTable, aiAgentsTable, callLogsTable, leadsTable, voicesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import axios from "axios";
import OpenAI from "openai";
import { randomUUID } from "node:crypto";

const router: IRouter = Router();

// ── OpenAI client ─────────────────────────────────────────────────────────────
// Replit AI Integration proxy (localhost:1106) works in both dev and production.
// Fall back to direct OpenAI if the integration isn't set up.
const openai = new OpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ?? undefined,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? "placeholder",
});

// Configurable model — default to gpt-4o-mini which is fast and widely available
const AI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

const TELNYX_API_BASE = "https://api.telnyx.com/v2";
const MAX_TURNS = 12;
const BACKEND_WEBHOOK_URL = process.env.WEBHOOK_BASE_URL ?? "https://shivanshbackend.replit.app";

// ── ElevenLabs TTS ─────────────────────────────────────────────────────────────
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
// Rachel — natural, warm female voice; fallback when no agent voice configured
const DEFAULT_ELEVEN_VOICE = "21m00Tcm4TlvDq8ikWAM";

// In-memory audio cache: id → { buffer, expires }
// Telnyx fetches the URL once; we expire entries after 3 min to stay lean.
const audioCache = new Map<string, { buffer: Buffer; expires: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of audioCache.entries()) {
    if (entry.expires < now) audioCache.delete(id);
  }
}, 60_000);

// ── Ambient background sounds ─────────────────────────────────────────────────
// Reliable CDN-hosted royalty-free loops.
const AMBIENT_SOUNDS: Record<string, string> = {
  office: "https://assets.mixkit.co/sfx/preview/mixkit-office-ambience-447.mp3",
  typing: "https://assets.mixkit.co/sfx/preview/mixkit-typing-on-keyboard-2583.mp3",
  cafe:   "https://assets.mixkit.co/sfx/preview/mixkit-restaurant-ambience-255.mp3",
};

// ── Per-call conversation state ───────────────────────────────────────────────
interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

type CallStage =
  | "waiting_for_pickup"   // outbound: waiting for caller to say anything
  | "confirming_name"      // outbound: asked "Is this [Name]?" — waiting for yes/no
  | "conversation"         // normal AI conversation loop
  ;

interface CallState {
  campaignId: number;
  campaignName: string;
  agentName: string;
  agentPrompt: string;
  callerNumber: string;
  calledNumber: string;
  messages: Message[];
  turnCount: number;
  startedAt: Date;
  recordingUrl?: string;
  direction: "inbound" | "outbound";
  stage: CallStage;
  leadName?: string;
  leadId?: number;
  pendingHangup?: boolean;    // hang up gracefully after current speech ends
  pendingTransfer?: string;   // phone number to transfer to after current speech ends
  transferNumber?: string;    // campaign-level transfer number
  backgroundSound?: string;   // ambient sound key ("office", "typing", etc.)
  voiceId: string;            // ElevenLabs voice ID used for this call
}

const activeCalls = new Map<string, CallState>();
// Keep backward-compat alias used in some helpers
type InboundCallState = CallState;

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
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
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

async function speak(callControlId: string, text: string): Promise<void> {
  await telnyxAction(callControlId, "speak", {
    payload: text,
    payload_type: "text",
    voice: "female",
    language: "en-US",
  });
}

async function gatherSpeech(callControlId: string): Promise<void> {
  // speech_type: "cloud" is REQUIRED — without it Telnyx defaults to DTMF (keypad)
  // mode and completely ignores voice input. gather_timeout is in SECONDS.
  await telnyxAction(callControlId, "gather", {
    gather_after_silence: 2000,   // 2s of silence after speech = end of utterance (ms)
    gather_timeout: 30,           // 30 seconds max wait for speech to start (seconds)
    speech_type: "cloud",         // CRITICAL: enables cloud-based speech-to-text
    language: "en-US",
  });
}

// ── ElevenLabs TTS — generates natural-sounding audio, served from our URL ────
// Falls back to Telnyx speak if ElevenLabs is unavailable.
async function speakEleven(
  callControlId: string,
  text: string,
  voiceId: string = DEFAULT_ELEVEN_VOICE
): Promise<void> {
  if (!ELEVENLABS_API_KEY) {
    return speak(callControlId, text);
  }

  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_turbo_v2",
          voice_settings: { stability: 0.45, similarity_boost: 0.80, style: 0.0, use_speaker_boost: true },
        }),
      }
    );

    if (!res.ok) {
      throw new Error(`ElevenLabs HTTP ${res.status}: ${await res.text()}`);
    }

    const audioId = randomUUID();
    audioCache.set(audioId, {
      buffer: Buffer.from(await res.arrayBuffer()),
      expires: Date.now() + 3 * 60 * 1000,
    });

    // Correct Telnyx action name is "playback_start" (not "play_audio")
    await telnyxAction(callControlId, "playback_start", {
      audio_url: `${BACKEND_WEBHOOK_URL}/api/audio/${audioId}`,
      loop: false,
      overlay: false,
    });

    logger.info({ callControlId, voiceId, chars: text.length }, "ElevenLabs TTS played");
  } catch (err) {
    logger.warn({ err: String(err), callControlId }, "ElevenLabs TTS failed — using Telnyx speak fallback");
    await speak(callControlId, text);
  }
}

// ── Start ambient background audio loop (overlay, infinite) ──────────────────
async function startBackgroundAudio(callControlId: string, soundKey: string): Promise<void> {
  const url = AMBIENT_SOUNDS[soundKey];
  if (!url) {
    logger.warn({ callControlId, soundKey }, "Unknown background sound key — skipping");
    return;
  }
  try {
    // "playback_start" is the correct Telnyx action name (not "play_audio")
    await telnyxAction(callControlId, "playback_start", {
      audio_url: url,
      loop: true,    // loop indefinitely
      overlay: true, // plays under the AI voice without interrupting it
    });
    logger.info({ callControlId, soundKey }, "Background ambient audio started");
  } catch (err) {
    logger.warn({ err: String(err), callControlId, soundKey }, "Background audio start failed — continuing without it");
  }
}

// ── Serve ElevenLabs audio buffers to Telnyx ──────────────────────────────────
router.get("/api/audio/:id", (req, res): void => {
  const entry = audioCache.get(req.params.id as string);
  if (!entry || entry.expires < Date.now()) {
    res.status(404).end();
    return;
  }
  res.set("Content-Type", "audio/mpeg");
  res.set("Content-Length", String(entry.buffer.length));
  res.set("Cache-Control", "no-store");
  res.send(entry.buffer);
});

// ── Human-Like Mode instructions ─────────────────────────────────────────────
// Injected into the system prompt when humanLikeMode is enabled for the agent/campaign.
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
=== END HUMAN-LIKE STYLE ===`;

// ── System prompt builder ─────────────────────────────────────────────────────
// Used for inbound calls and outbound fallback. Wraps rawPrompt with identity,
// human-like style (if enabled), and critical phone-call rules.
function buildNaturalSystemPrompt(
  rawPrompt: string,
  campaignName: string,
  agentName = "AI Assistant",
  leadName?: string,
  transferNumber?: string,
  humanLikeMode = true
): string {
  const identity = leadName
    ? `You are ${agentName}, right now on a live phone call with ${leadName} on behalf of "${campaignName}".`
    : `You are ${agentName}, on a live inbound phone call on behalf of "${campaignName}".`;

  const transferInstruction = transferNumber
    ? `HUMAN TRANSFER: If the caller asks to speak with a human, wants to move forward, or asks to be transferred — say EXACTLY: "Let me connect you with one of our agents right now — one moment please!" and nothing else.`
    : `HUMAN TRANSFER: If the caller asks for a human, tell them a team member will follow up shortly and wrap up warmly.`;

  const coreScript = rawPrompt?.trim()
    || `Be helpful, warm, and professional. Guide the conversation naturally. Ask one question at a time.`;

  const humanLikeSection = humanLikeMode ? HUMAN_LIKE_PROMPT_ADDON.trim() : "";

  return `${identity}

${humanLikeSection ? humanLikeSection + "\n\n" : ""}${coreScript}

CRITICAL PHONE CALL RULES (always enforce these):
- This is a LIVE phone call. Every response must be 1-3 sentences MAX. Never write paragraphs.
- After the caller confirms who they are, IMMEDIATELY proceed to your call purpose — don't stall.
- Ask ONE question at a time. Wait for their answer before asking the next one.
- React naturally to what they just said BEFORE moving to your next point.
- Never say "As an AI..." unless they directly ask if you're a bot.
- If they want to opt out: "Absolutely, so sorry for the interruption — have a great day!" then stop.
- Use natural speech: "Sure", "Got it", "Of course", "Makes sense", "Totally understand".
- If they want a callback: confirm their preferred time warmly.
${transferInstruction}`;
}

// ── OpenAI helpers ────────────────────────────────────────────────────────────
async function generateAiResponse(messages: Message[]): Promise<string> {
  const response = await openai.chat.completions.create({
    model: AI_MODEL,
    max_tokens: 500,
    temperature: 0.7,   // slightly creative for natural responses
    messages,
  });
  const content = response.choices[0]?.message?.content?.trim();
  if (!content) return "Sorry, could you say that again?";
  return content;
}

async function generateSummaryAndDisposition(
  messages: Message[],
  campaignName: string
): Promise<{ summary: string; disposition: string; transcript: string }> {
  // Build readable transcript from conversation
  const transcript = messages
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role === "assistant" ? "AI Agent" : "Caller"}: ${m.content}`)
    .join("\n");

  if (!transcript.trim()) {
    return { summary: "No conversation recorded.", disposition: "no_answer", transcript: "" };
  }

  try {
    const response = await openai.chat.completions.create({
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
Choose disposition based on: interested=caller wants product/service, not_interested=caller declined, vm=voicemail, callback_requested=wants callback later, connected=brief conversation, completed=full successful interaction.
Return ONLY valid JSON, no markdown.`,
        },
        {
          role: "user",
          content: `CALL TRANSCRIPT:\n${transcript}`,
        },
      ],
    });

    const raw = response.choices[0]?.message?.content?.trim() ?? "{}";
    const parsed = JSON.parse(raw);
    return {
      summary: parsed.summary ?? "Call completed.",
      disposition: parsed.disposition ?? "connected",
      transcript,
    };
  } catch {
    return {
      summary: "Call completed successfully.",
      disposition: "connected",
      transcript,
    };
  }
}

// ── Goodbye detection ─────────────────────────────────────────────────────────
function isGoodbye(text: string): boolean {
  const lower = text.toLowerCase();
  return ["goodbye", "bye", "hang up", "that's all", "no thanks", "i'm done", "end call", "thanks bye", "have a good day"].some(
    (phrase) => lower.includes(phrase)
  );
}

// ── Transfer intent detection ─────────────────────────────────────────────────
const TRANSFER_PHRASES = [
  "transferring you", "transfer you", "transfer your call",
  "connecting you", "connect you with", "put you through",
  "let me get a", "getting someone", "bring in a",
  "one of our agents", "one of our specialists", "a human agent",
  "a live agent", "a team member", "speak with someone",
  "forward your call",
];

function isTransferIntent(text: string): boolean {
  const lower = text.toLowerCase();
  return TRANSFER_PHRASES.some((phrase) => lower.includes(phrase));
}

// ── Execute Telnyx transfer (bridge to human) ─────────────────────────────────
const DEFAULT_HOLD_MUSIC = "https://s3.amazonaws.com/com.twilio.music.classical/BusyStrings.mp3";

async function executeTransfer(
  callControlId: string,
  toNumber: string,
  fromNumber: string
): Promise<void> {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) throw new Error("TELNYX_API_KEY not configured");

  await axios.post(
    `${TELNYX_API_BASE}/calls/${callControlId}/actions/transfer`,
    {
      to: toNumber,
      from: fromNumber,
      audio_url: DEFAULT_HOLD_MUSIC,
      webhook_url: `${BACKEND_WEBHOOK_URL}/api/webhooks/telnyx`,
      webhook_api_version: "2",
    },
    {
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      timeout: 10_000,
    }
  );
}

// ── Campaign lookup by called number ─────────────────────────────────────────
async function getCampaignByNumber(toNumber: string) {
  const [phoneRow] = await db
    .select()
    .from(phoneNumbersTable)
    .where(and(eq(phoneNumbersTable.phoneNumber, toNumber), eq(phoneNumbersTable.status, "active")))
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
  // Campaign humanLike ("true"/"false" string) takes precedence; agent.humanLikeMode is fallback.
  // Default: enabled (true)
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
      // If campaign doesn't override humanLike, use the agent's humanLikeMode
      if (campaign.humanLike === null || campaign.humanLike === undefined) {
        humanLikeMode = agent.humanLikeMode ?? true;
      }

      // Resolve voice: agent's defaultVoiceId → voices table → ElevenLabs voice ID
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

  // Direct campaign voice field takes priority (stored as raw ElevenLabs voice ID)
  if (campaign.voice && campaign.voice !== "default") {
    resolvedVoiceId = campaign.voice;
  }

  const systemPrompt = buildNaturalSystemPrompt(
    agentPrompt,
    campaign.name,
    agentName,
    undefined,
    campaign.transferNumber ?? undefined,
    humanLikeMode
  );

  return { campaign, agentName, systemPrompt, voiceId: resolvedVoiceId };
}

// ── Finalize inbound call — save to DB with all data ─────────────────────────
async function finalizeInboundCall(
  callControlId: string,
  state: InboundCallState,
  recordingUrl?: string
): Promise<void> {
  try {
    const durationSecs = Math.round((Date.now() - state.startedAt.getTime()) / 1000);
    const { summary, disposition, transcript } = await generateSummaryAndDisposition(
      state.messages,
      state.campaignName
    );

    await db.insert(callLogsTable).values({
      phoneNumber: state.callerNumber,
      campaignId: state.campaignId,
      status: "completed",
      disposition,
      direction: "inbound",
      duration: durationSecs,
      recordingUrl: recordingUrl ?? state.recordingUrl ?? null,
      transcript,
      summary,
      callControlId,
    });

    logger.info(
      { callControlId, campaignId: state.campaignId, disposition, durationSecs, turns: state.turnCount },
      "Inbound call finalized and saved to DB"
    );
  } catch (err) {
    logger.error({ err, callControlId }, "Failed to finalize inbound call");
  }
}

// ── Outbound client_state decoder ────────────────────────────────────────────
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
    const parsed = JSON.parse(json);
    if (parsed?.type === "outbound") return parsed as OutboundClientState;
    return null;
  } catch {
    return null;
  }
}

// ── Finalize outbound call — save to DB + update lead ──────────────────────────
async function finalizeOutboundCall(
  callControlId: string,
  state: InboundCallState,
  disposition?: string
): Promise<void> {
  try {
    const durationSecs = Math.round((Date.now() - state.startedAt.getTime()) / 1000);
    const { summary, disposition: detectedDisposition, transcript } = await generateSummaryAndDisposition(
      state.messages,
      state.campaignName
    );

    const finalDisposition = disposition ?? detectedDisposition;

    await db.insert(callLogsTable).values({
      phoneNumber: state.callerNumber,
      campaignId: state.campaignId,
      status: "completed",
      disposition: finalDisposition,
      direction: "outbound",
      duration: durationSecs,
      recordingUrl: state.recordingUrl ?? null,
      transcript,
      summary,
      callControlId,
    });

    // Mark the lead as called so it doesn't get called again
    const leadStatus = finalDisposition === "callback_requested" ? "callback" : "called";
    await db
      .update(leadsTable)
      .set({
        status: leadStatus as "called" | "callback",
        metadata: JSON.stringify({ lastCallSummary: summary, lastDisposition: finalDisposition }),
      })
      .where(and(
        eq(leadsTable.phone, state.callerNumber),
        eq(leadsTable.campaignId, state.campaignId)
      ));

    logger.info(
      { callControlId, campaignId: state.campaignId, disposition: finalDisposition, durationSecs, leadStatus },
      "Outbound call finalized and lead updated"
    );
  } catch (err) {
    logger.error({ err, callControlId }, "Failed to finalize outbound call");
  }
}

// ── POST /webhooks/telnyx ─────────────────────────────────────────────────────
router.post("/webhooks/telnyx", async (req, res): Promise<void> => {
  // Always respond 200 immediately
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
    // ── 0. Outbound: AMD result — hang up on voicemail ───────────────────────
    // Telnyx sends "call.machine.premium.detection.ended" for premium AMD
    if (eventType === "call.machine.detection.ended" || eventType === "call.machine.premium.detection.ended") {
      const result: string = payload.result ?? "";
      logger.info({ callControlId, result }, "AMD result");

      if (result === "machine_start" || result === "machine_end_beep" || result === "machine_end_silence") {
        // Voicemail detected — hang up and log as vm
        try { await telnyxAction(callControlId, "hangup", {}); } catch { /* already hung up */ }

        const state = activeCalls.get(callControlId);
        if (state) {
          const durationSecs = Math.round((Date.now() - state.startedAt.getTime()) / 1000);
          await db.insert(callLogsTable).values({
            phoneNumber: state.callerNumber,
            campaignId: state.campaignId,
            status: "completed",
            disposition: "vm",
            direction: "outbound",
            duration: durationSecs,
            callControlId,
          }).catch(() => {});
          activeCalls.delete(callControlId);
        }
      }
      // If human detected — call.answered will fire; nothing to do here
      return;
    }

    // ── 1a. Outbound call answered by human ──────────────────────────────────
    // Telnyx sends call.answered with direction="" (not "outgoing"), so we
    // detect outbound calls by the presence of our client_state payload.
    if (eventType === "call.answered") {
      const ctx = clientStateRaw ? decodeClientState(clientStateRaw) : null;

      // If no client_state → this is an inbound answered call; skip (handled by call.initiated)
      if (!ctx) {
        logger.info({ callControlId, direction }, "call.answered without client_state — inbound or unknown, skipping");
        return;
      }

      const campaignId = parseInt(ctx.campaignId, 10);

      // Look up lead for personalization
      const [lead] = await db
        .select({ name: leadsTable.name, id: leadsTable.id })
        .from(leadsTable)
        .where(and(eq(leadsTable.phone, ctx.phone), eq(leadsTable.campaignId, campaignId)))
        .limit(1);

      // Look up campaign's AI agent name
      const [campaign] = await db
        .select({ agentId: campaignsTable.agentId })
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

      const leadName = lead?.name;
      const naturalScript = buildNaturalSystemPrompt(ctx.script, ctx.campaignName, agentName, leadName, ctx.transferNumber ?? undefined);

      // Build a natural opening greeting (VAPI-style: AI speaks first immediately)
      const firstName = leadName?.split(" ")[0];
      const greeting = firstName
        ? `Hi, is this ${firstName}? This is ${agentName} calling from ${ctx.campaignName}.`
        : `Hello! This is ${agentName} calling from ${ctx.campaignName}.`;

      const backgroundSound = ctx.backgroundSound ?? undefined;
      // ctx.voice is the raw ElevenLabs voice ID set during campaign dispatch
      const callVoiceId = (ctx.voice && ctx.voice !== "default") ? ctx.voice : DEFAULT_ELEVEN_VOICE;

      activeCalls.set(callControlId, {
        campaignId,
        campaignName: ctx.campaignName,
        agentName,
        agentPrompt: naturalScript,
        callerNumber: ctx.phone,
        calledNumber: fromNumber,
        messages: [
          { role: "system", content: naturalScript },
          { role: "assistant", content: greeting },
        ],
        turnCount: 0,
        startedAt: new Date(),
        direction: "outbound",
        stage: "conversation",  // Start directly in conversation — AI speaks first
        leadName,
        leadId: lead?.id,
        transferNumber: ctx.transferNumber ?? undefined,
        backgroundSound,
        voiceId: callVoiceId,
      });

      logger.info({ callControlId, campaignId, phone: ctx.phone, leadName, agentName, greeting, backgroundSound, voiceId: callVoiceId }, "Outbound call answered — AI speaking first");

      await startRecording(callControlId).catch((err) =>
        logger.warn({ err, callControlId }, "Outbound recording start failed — continuing")
      );

      // Start ambient background audio before greeting if configured
      if (backgroundSound && backgroundSound !== "none") {
        await startBackgroundAudio(callControlId, backgroundSound);
      }

      // Speak the greeting immediately (VAPI-style) — no waiting for caller to speak first
      await speakEleven(callControlId, greeting, callVoiceId);
      return;
    }

    // ── 1b. Inbound call arrives ──────────────────────────────────────────────
    if (eventType === "call.initiated" && direction === "incoming") {
      const result = await getCampaignByNumber(toNumber);

      if (!result) {
        await answerCall(callControlId);
        await speak(callControlId, "Thank you for calling. We are unable to connect your call at this time. Goodbye.");
        return;
      }

      const { campaign, agentName, systemPrompt, voiceId: inboundVoiceId } = result;
      const greeting = `Thank you for calling ${campaign.name}. This is ${agentName}. How may I help you today?`;

      const inboundBgSound = campaign.backgroundSound ?? undefined;

      activeCalls.set(callControlId, {
        campaignId: campaign.id,
        campaignName: campaign.name,
        agentName,
        agentPrompt: systemPrompt,
        callerNumber: fromNumber,
        calledNumber: toNumber,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "assistant", content: greeting },
        ],
        turnCount: 0,
        startedAt: new Date(),
        direction: "inbound",
        stage: "conversation",
        transferNumber: campaign.transferNumber ?? undefined,
        backgroundSound: inboundBgSound,
        voiceId: inboundVoiceId,
      });

      logger.info({ callControlId, campaignId: campaign.id, agentName, backgroundSound: inboundBgSound, voiceId: inboundVoiceId }, "Answering inbound call");

      await answerCall(callControlId);
      await startRecording(callControlId).catch((err) =>
        logger.warn({ err, callControlId }, "Recording start failed — continuing without recording")
      );

      // Start ambient background if configured
      if (inboundBgSound && inboundBgSound !== "none") {
        await startBackgroundAudio(callControlId, inboundBgSound);
      }

      await speakEleven(callControlId, greeting, inboundVoiceId);
      return;
    }

    // ── 2. AI finished speaking → listen or wrap up ─────────────────────────
    // call.speak.ended  → Telnyx TTS (fallback)
    // call.playback.ended → ElevenLabs play_audio (primary)
    if (eventType === "call.speak.ended" || eventType === "call.playback.ended") {
      const state = activeCalls.get(callControlId);
      if (!state) return;

      // Graceful hangup requested (e.g. wrong number, opt-out, max turns)
      if (state.pendingHangup) {
        try { await telnyxAction(callControlId, "hangup", {}); } catch { /* already gone */ }
        if (state.direction === "outbound") {
          await finalizeOutboundCall(callControlId, state);
        } else {
          await finalizeInboundCall(callControlId, state);
        }
        activeCalls.delete(callControlId);
        return;
      }

      // Transfer requested — execute after AI finished speaking bridge announcement
      if (state.pendingTransfer) {
        const transferTo = state.pendingTransfer;
        logger.info({ callControlId, transferTo }, "Executing transfer after speak");
        try {
          await executeTransfer(callControlId, transferTo, state.calledNumber || state.callerNumber);
          // Finalize the call log as "transferred" — the call control is handed off
          await finalizeOutboundCall(callControlId, state, "transferred");
        } catch (err) {
          logger.error({ err, callControlId, transferTo }, "Transfer failed — hanging up instead");
          await speakEleven(callControlId, "I'm sorry, I was unable to connect you. Please try calling back. Goodbye!", state.voiceId);
          state.pendingHangup = true;
        }
        activeCalls.delete(callControlId);
        return;
      }

      // Max turns reached — wrap up naturally
      if (state.turnCount >= MAX_TURNS) {
        const bye = "It was really great talking with you. Have a wonderful day, take care!";
        state.messages.push({ role: "assistant", content: bye });
        state.pendingHangup = true;
        await speakEleven(callControlId, bye, state.voiceId);
        return;
      }

      // Listen for next caller input
      await gatherSpeech(callControlId);
      return;
    }

    // ── 3. Caller spoke → handle based on conversation stage ────────────────
    if (eventType === "call.gather.ended") {
      const state = activeCalls.get(callControlId);
      if (!state) return;

      // Telnyx sends speech as either a plain string OR an object:
      // { results: [{ transcript: "Hello", confidence: 0.98 }], is_final: true }
      // We must handle both — never assume it's a plain string.
      const rawSpeech = payload.speech;
      let speechText = "";
      if (typeof rawSpeech === "string") {
        speechText = rawSpeech.trim();
      } else if (rawSpeech && typeof rawSpeech === "object") {
        const results = (rawSpeech as { results?: Array<{ transcript?: string }> }).results;
        if (Array.isArray(results) && results.length > 0) {
          speechText = (results[0]?.transcript ?? "").trim();
        } else if (typeof (rawSpeech as Record<string, unknown>).transcript === "string") {
          speechText = ((rawSpeech as Record<string, unknown>).transcript as string).trim();
        }
      }

      const digits: string = payload.digits ?? "";
      const reason: string = payload.reason ?? "";
      const callerInput = speechText || (digits ? `Pressed ${digits}` : "");

      logger.info(
        { callControlId, callerInput, speechText, reason, stage: state.stage, turn: state.turnCount, rawSpeechType: typeof rawSpeech },
        "call.gather.ended received"
      );

      // ── Stage 0: waiting for caller to say anything ("hello", "hi", etc.) ──
      if (state.stage === "waiting_for_pickup") {
        if (!callerInput) {
          // Silence — nudge once, then give up
          if (state.turnCount === 0) {
            state.turnCount++;
            await speakEleven(callControlId, "Hello?", state.voiceId);
          } else {
            await finalizeOutboundCall(callControlId, state, "no_answer");
            activeCalls.delete(callControlId);
          }
          return;
        }

        logger.info({ callControlId, callerInput }, "Caller picked up — confirming identity");
        state.messages.push({ role: "user", content: callerInput });
        state.turnCount++;

        if (state.leadName) {
          // Confirm we have the right person
          const firstName = state.leadName.split(" ")[0];
          const nameCheck = `Is this ${firstName}?`;
          state.messages.push({ role: "assistant", content: nameCheck });
          state.stage = "confirming_name";
          await speakEleven(callControlId, nameCheck, state.voiceId);
        } else {
          // No lead name — go straight to intro
          const intro = `Hi, this is ${state.agentName} calling from ${state.campaignName}. How are you doing today?`;
          state.messages.push({ role: "assistant", content: intro });
          state.stage = "conversation";
          await speakEleven(callControlId, intro, state.voiceId);
        }
        return;
      }

      // ── Stage 1: caller confirmed (or denied) their name ────────────────────
      if (state.stage === "confirming_name") {
        state.messages.push({ role: "user", content: callerInput });
        state.turnCount++;

        const lower = callerInput.toLowerCase();
        const denied = ["no", "wrong", "not me", "different", "nobody", "who"].some(w => lower.includes(w));

        if (denied || !callerInput) {
          const sorry = "Oh, I'm so sorry for the confusion! Seems I have the wrong number. Have a great day!";
          state.messages.push({ role: "assistant", content: sorry });
          state.pendingHangup = true;
          await speakEleven(callControlId, sorry, state.voiceId);
          return;
        }

        // They confirmed — now give the full intro
        const firstName = state.leadName?.split(" ")[0] ?? "";
        const intro = `Hi ${firstName}, this is ${state.agentName} calling from ${state.campaignName}. How are you doing today?`;
        state.messages.push({ role: "assistant", content: intro });
        state.stage = "conversation";
        await speakEleven(callControlId, intro, state.voiceId);
        return;
      }

      // ── Stage 2: normal AI conversation ────────────────────────────────────
      if (!callerInput) {
        if (reason === "timeout") {
          if (state.turnCount >= 2) {
            const bye = "Seems like you stepped away. I'll let you go — have a great day!";
            state.messages.push({ role: "assistant", content: bye });
            state.pendingHangup = true;
            await speakEleven(callControlId, bye, state.voiceId);
          } else {
            state.turnCount++;
            await speakEleven(callControlId, "Sorry, I didn't catch that — could you say that again?", state.voiceId);
          }
          return;
        }
        // Empty gather for any other reason (noise, short silence, etc.) — keep listening
        await gatherSpeech(callControlId);
        return;
      }

      logger.info({ callControlId, callerInput, turn: state.turnCount, stage: state.stage }, "Caller input");

      if (isGoodbye(callerInput)) {
        state.messages.push({ role: "user", content: callerInput });
        const bye = "Great talking with you! Take care and have a wonderful day. Goodbye!";
        state.messages.push({ role: "assistant", content: bye });
        state.pendingHangup = true;
        await speakEleven(callControlId, bye, state.voiceId);
        return;
      }

      state.messages.push({ role: "user", content: callerInput });
      state.turnCount++;

      let aiResponse: string;
      try {
        aiResponse = await generateAiResponse(state.messages);
      } catch (err) {
        logger.error({ err, callControlId }, "OpenAI response failed");
        aiResponse = "Sorry, I missed that — could you say it again?";
      }

      state.messages.push({ role: "assistant", content: aiResponse });
      logger.info({ callControlId, aiResponse, turn: state.turnCount }, "AI response");

      // ── Transfer intent: if AI says "transferring you" etc. and a number exists ──
      if (isTransferIntent(aiResponse) && state.transferNumber) {
        logger.info({ callControlId, transferNumber: state.transferNumber }, "Transfer intent detected — will transfer after speak");
        state.pendingTransfer = state.transferNumber;
      }

      await speakEleven(callControlId, aiResponse, state.voiceId);
      return;
    }

    // ── 4. Transfer bridged — log completion ─────────────────────────────────
    if (eventType === "call.bridged") {
      logger.info({ callControlId, to: toNumber, from: fromNumber }, "Call bridged to human agent — transfer successful");
      return;
    }

    // ── 5. Recording saved — update DB record ────────────────────────────────
    if (eventType === "call.recording.saved") {
      const recordingUrl: string = payload.recording_urls?.mp3 ?? payload.public_recording_urls?.mp3 ?? "";
      logger.info({ callControlId, recordingUrl }, "Recording saved");

      if (recordingUrl) {
        // Update existing call log if it exists
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
          logger.info({ callControlId, callLogId: existing.id }, "Recording URL saved to DB");
        } else {
          // Store on active call state so it gets saved when call ends
          const state = activeCalls.get(callControlId);
          if (state) state.recordingUrl = recordingUrl;
        }
      }
      return;
    }

    // ── 5. Call hung up — finalize (inbound or outbound) ─────────────────────
    if (eventType === "call.hangup") {
      const state = activeCalls.get(callControlId);
      if (state) {
        // Outbound calls always have client_state encoded on them
        if (clientStateRaw) {
          logger.info({ callControlId, campaignId: state.campaignId, turns: state.turnCount }, "Outbound call ended");
          await finalizeOutboundCall(callControlId, state);
        } else {
          logger.info({ callControlId, campaignId: state.campaignId, turns: state.turnCount }, "Inbound call ended");
          await finalizeInboundCall(callControlId, state);
        }
        activeCalls.delete(callControlId);
      }
      return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ eventType, callControlId, err: msg }, "Error handling Telnyx webhook");
  }
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
