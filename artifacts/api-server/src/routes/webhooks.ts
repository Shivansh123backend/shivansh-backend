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
  humanAgentsTable,
  queuesTable,
  queueMembersTable,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
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
import {
  audioCache,
  generateTTSWithFallback,
  type VoiceProvider,
} from "../services/voiceRegistry.js";

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

// ── Hold music URLs — served through our own audio proxy so Telnyx can fetch
// them reliably with proper browser-like User-Agent headers.
const HOLD_MUSIC_URLS: Record<string, string> = {
  none:      `${BACKEND_WEBHOOK_URL}/api/audio/hold/default`,
  jazz:      `${BACKEND_WEBHOOK_URL}/api/audio/hold/jazz`,
  corporate: `${BACKEND_WEBHOOK_URL}/api/audio/hold/corporate`,
  smooth:    `${BACKEND_WEBHOOK_URL}/api/audio/hold/smooth`,
  classical: `${BACKEND_WEBHOOK_URL}/api/audio/hold/classical`,
};
const DEFAULT_HOLD_MUSIC_URL = HOLD_MUSIC_URLS.corporate!;

function resolveHoldMusicUrl(holdMusic?: string | null): string {
  if (!holdMusic || holdMusic === "none") return DEFAULT_HOLD_MUSIC_URL;
  return HOLD_MUSIC_URLS[holdMusic] ?? DEFAULT_HOLD_MUSIC_URL;
}

// Background sound URLs — played as overlay:true so they mix beneath the AI voice.
// Served via our audio proxy so Telnyx can reliably fetch actual ambient sounds.
const BACKGROUND_SOUND_URLS: Record<string, string> = {
  office:  `${BACKEND_WEBHOOK_URL}/api/audio/ambient/office`,
  typing:  `${BACKEND_WEBHOOK_URL}/api/audio/ambient/typing`,
  cafe:    `${BACKEND_WEBHOOK_URL}/api/audio/ambient/cafe`,
};

// System-prompt context injected so the AI's language matches the selected environment
const BACKGROUND_CONTEXT_MAP: Record<string, string> = {
  office: "ENVIRONMENT NOTE: You are calling from a busy professional call center. Keyboards and colleague conversations may be faintly audible.",
  typing: "ENVIRONMENT NOTE: You are in a modern open-plan workspace. Light keyboard typing sounds are in the background.",
  cafe:   "ENVIRONMENT NOTE: You are making this call from a coffee shop. Gentle background conversations and espresso machine sounds are present.",
};

// Track calls where background audio has been injected (so we can ignore its playback.ended event)
const backgroundSoundActive = new Set<string>(); // callControlId

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
- Rude / profanity / dismissive → stay warm: "I completely understand, I'll let you go — have a great day!" and stop.
- "Stop calling / remove me / not interested" → "Absolutely, I'll take note of that straight away. Really sorry to bother you — have a wonderful day!" then end.
- Aggressive but still engaging → lower your tone, validate briefly ("That's completely fair"), then offer help or move on gracefully.`;

  const objectionHandling = `OBJECTION HANDLING — smart, natural, never defensive:

IDENTITY:
- "Who are you?" → "I'm ${agentName} from ${campaignName}. We help people with [campaign purpose — infer from script]. Just wanted a quick two-minute chat — is now okay?"
- "Is this a bot?" / "Are you real?" → Deflect warmly first: "Ha, fair question! I'm ${agentName} — very much here with you. Let me just quickly explain why I'm calling..." If pushed again: "Honestly, I'm an AI assistant for ${campaignName}, but everything I'm sharing is real and genuine."
- "Are you human?" (once) → "I'm ${agentName} — a voice here for ${campaignName}! Just a couple of quick things to cover if that's alright?"

TRUST / AUTHORITY:
- "Why should I trust you?" → "Honestly, I love that you ask that — it's the right attitude. ${campaignName} has been helping people like yourself with [benefit]. I'm happy to send you something in writing to verify, or you can check us online. What would work for you?"
- "Why do you need my details?" → "Totally fair. All I need is to confirm I'm speaking with the right person so we don't waste your time. Everything's confidential — you're in full control of what you share."

PRIVACY:
- "How did you get my number?" → "Your details came through [a partner / an enquiry / a registration]. If you'd rather not be contacted, just say the word — I'll remove you right now, no questions asked."
- "Is this legal / GDPR?" → "Absolutely — we're fully compliant. You have every right to opt out at any moment. Shall I remove you, or shall we carry on?"
- "I never signed up" → "I'm genuinely sorry — that's the last thing we want. I'll remove your number right now. Really sorry for the interruption, and have a great day!"

SCEPTICISM:
- "This sounds like a scam" → "I completely get that — there are so many dodgy calls out there and your caution is smart. I'm genuinely from ${campaignName}. Is there a way I can help verify that for you before we continue?"
- "I'm not giving personal info" → "Totally respected. The only thing I needed was [minimal thing]. If you'd prefer not to, that's absolutely fine — shall I let you go?"

GENERAL PUSHBACK:
- "I'm busy" → "Of course — I'll be under a minute, or I can call at a better time. What suits you?"
- "Send an email" → "Absolutely — what's the best address for you?"
- "Not interested" → "Understood! Just so we don't bother you again — is it more the timing, or the topic itself?"
- "Get to the point" → "You're right, sorry — [jump directly to the key point, skip all preamble]"
- "I've heard this before" → "Ha, I bet you have! Most people are surprised when they hear [specific differentiator]. This one's genuinely a bit different — give me thirty seconds?"`;

  const smartConversation = `SMART CONVERSATION — think like a trusted advisor, not a script reader:

USE REAL-SOUNDING EXAMPLES (make them feel genuine and relatable):
- When explaining a benefit: "For example, a lot of people we speak to — teachers, business owners, even retirees — find that [specific relatable outcome]. It's one of those things that doesn't sound like much until you see the numbers."
- When validating a concern: "That's actually the number one thing people say to me. Honestly, if I were in your position I'd probably feel the same way. The thing that usually changes the picture is [insight]."
- When bridging to the next question: "Right, and actually that leads perfectly to what I was going to ask next..."

USE ANALOGIES WHEN HELPFUL:
- "It's a bit like switching energy providers — sounds annoying, takes about five minutes, and then you wonder why you waited so long."
- "Think of it the same way you'd think about [familiar relatable thing]. The principle's the same."

SHOW GENUINE CURIOSITY:
- When they share a detail: dig into it. "Oh really — how long has that been going on?" / "That's interesting — is that something you've been trying to fix for a while?"
- Reference back to what they said earlier: "You mentioned earlier that [X] — that's actually directly relevant to this next part."

BE SPECIFIC, NOT VAGUE:
- Bad: "We can help you save money." 
- Good: "Depending on what you told me about your situation, people in similar positions typically see [specific outcome]. Obviously it varies, but that's the ballpark most people land in."

INTELLIGENT FLOW — read the subtext:
- If they hesitate: "Take your time — I'm not going anywhere."
- If they sound surprised: "Yeah, most people react the same way when they hear that!"
- If they sound relieved: "Exactly — that's usually the reaction. It's simpler than people expect."
- If they give a short answer: match it. Don't over-explain.
- If they volunteer extra info: acknowledge it genuinely before moving on.

NEVER:
- Say "Great question!" (sounds robotic)
- Repeat back their answer word-for-word ("So you said you're interested in X...")
- Use corporate jargon ("synergies", "leverage", "going forward", "touch base")
- Start three responses in a row the same way`;

  const nameConfirmation = firstName
    ? `NAME CONFIRMATION (FIRST STEP — do this before anything else):
- Your very first task is to confirm you're speaking with ${firstName}.
- You already said "Hi, is this ${firstName}?" — if they said yes/correct/speaking/sure/yep/that's me, they've confirmed. DO NOT ask again.
- Once confirmed: use "${firstName}" naturally throughout ("Got it, ${firstName}!", "Thanks ${firstName}!") — never say {{FirstName}} literally.
- If they say no or give a different name: say "Oh, I'm so sorry! Is this a good time?" and adapt.`
    : "";

  const progressionRules = `CONVERSATION PROGRESSION — STRICT RULES:
- ANY response from the caller counts as a valid answer. "Yes", "no", "yeah", "mm-hmm", "ok", "sure", "fine", "I guess" — ALL of these are complete answers. Accept them and move forward.
- NEVER re-ask any question you've already asked, under any circumstances.
- Do NOT ask multiple questions in the same turn. One turn = one main point or one question.
- NEVER ask the same question twice. If you already asked it, skip it and advance.
- If they go off-topic briefly: gently steer back with "Absolutely, and just on that — " then continue.

ENRICHMENT — make the conversation feel genuinely helpful, not just an interrogation:
- After the caller answers a question, briefly react to their answer with a genuine acknowledgment, relevant insight, or helpful comment BEFORE moving to the next question.
  Example: If they say they're interested in savings → "Great, people are seeing quite a difference with this — especially on the monthly side." then ask the next question.
- If they share something personal (tough situation, need, worry) — acknowledge it warmly before continuing.
- Look for natural moments to offer value: a relevant tip, a short benefit they might not know, or a relatable example.
- Upsell or cross-sell naturally if relevant: "By the way, a lot of people in similar situations also find [X] really helpful — is that something worth knowing about?"
- Vary your fillers and transitions: "That makes a lot of sense", "Honestly, that's one of the most common things we hear", "You'd be surprised how many people feel the same way", "Really good point actually", etc.
- After the script questions are done, do NOT immediately transfer. Have one genuine closing moment: summarise what you've learned, give the caller one key takeaway or reassurance, THEN trigger transfer.`;

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

  const humanSection = humanLikeMode ? `HOW TO SPEAK — this is the most important section. Read it carefully.

You are on a live phone call. You must write your responses EXACTLY how a real person would say them out loud — not how they'd write an email or a script.

─── PAUSE MARKERS — use these in every response ───
Write "..." (three dots) wherever a natural pause would occur — between thoughts, after an opener, before a question. ElevenLabs renders these as real breathing pauses.
Write " — " (space-dash-dash-space) for a mid-sentence pause or thought continuation.
Examples of how to write with pauses:
  "Yeah... so that makes a lot of sense actually."
  "Hmm... okay. And how long has that been going on — roughly?"
  "Right, right... I hear you. So just to make sure I've got this — you said [X]?"
  "Oh interesting... yeah, we see that a lot actually."

─── WHAT YOU SAY — sound like a real person, not a script ───
ALWAYS use contractions: "I'm", "it's", "that's", "we've", "you're", "don't", "can't", "won't", "I'd"
START with a natural filler/reaction: "Yeah...", "Oh...", "Hmm...", "Right...", "Okay so...", "Got it...", "Ah...", "Sure...", "Well..."
USE informal connectors: "So basically...", "The thing is...", "Here's the deal...", "What I'd say is...", "Honestly...", "Look..."
USE sentence fragments naturally: "Makes total sense." / "Absolutely." / "Good to know." / "Exactly, yeah."
NEVER start two consecutive replies with the same word.

─── GOOD VS BAD — internalize these ───
BAD  → "That is a great point. I completely understand your situation. Could you please tell me more about your current circumstances?"
GOOD → "Yeah... totally get that. So what's actually going on at the moment — like what's the main thing you're trying to sort out?"

BAD  → "Thank you for sharing that information. I would like to ask you a question about your current provider."
GOOD → "Ah okay... so who are you with at the moment then?"

BAD  → "I understand. Let me now proceed to the next question."
GOOD → "Right... okay. And one more thing — "

─── RHYTHM & PACING ───
- Maximum 2 short sentences per reply. One thought, then stop or ask one question.
- Never stack two questions. Never write a paragraph.
- After asking a question — stop completely. Write nothing else. Wait.
- If they gave a short answer → match their brevity. Don't over-explain.
- If they gave a long answer → acknowledge it warmly before moving on.

─── REACTIONS — make them feel heard ───
When they answer: react first, then proceed.
  "Oh nice... so [next point or question]"
  "Ah right, yeah... and [next]"
  "Hmm, interesting... okay so [next]"
  "Yeah, that makes sense... so [next]"
Vary your reactions. Never use the same one twice in a row.

─── TRANSFER SENSITIVITY ───
If the caller says anything like "speak to a person", "real human", "transfer me", "get an agent", "talk to someone" — calmly say the transfer phrase immediately. Do not ask them to confirm.\n\n` : "";

  return `${identity}

${humanSection}${nameConfirmation ? nameConfirmation + "\n\n" : ""}CAMPAIGN SCRIPT — follow this closely:
${coreScript}

${progressionRules}

${smartConversation}

${objectionHandling}

${rudeHandling}

ABSOLUTE RULES:
- This is a LIVE phone call. Keep responses conversational — 1–3 sentences max. No monologues.
- Never say "As an AI" or "I'm an AI" — just be helpful and natural.
- If they want to opt out: "Absolutely, so sorry for the interruption — have a great day!" then stop.
- If they want a callback: confirm their preferred time warmly and end.
${transferInstruction}

SCRIPT COMPLETION — MANDATORY:
- Once you have asked ALL campaign questions and received an answer to each one:
  1. Give the caller ONE brief closing acknowledgement — 1 sentence summarising what they told you or a quick reassurance.
  2. THEN say EXACTLY this phrase (word for word): "Let me transfer you to an expert who can help you further — one moment please!"
  3. Say NOTHING else after that. Stop completely. The transfer will happen automatically.
- This final transfer step is REQUIRED — do not skip it, do not ask for confirmation, do not ask another question.
- Do NOT loop back to any question already answered.`;
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

// ── Per-call conversation history & state ────────────────────────────────────
interface ConvMessage { role: "system" | "user" | "assistant"; content: string; }
const callMessages              = new Map<string, ConvMessage[]>();   // callControlId → chat history
const aiSpeaking                = new Set<string>();                  // callControlId → AI currently speaking
const processingTurn            = new Set<string>();                  // callControlId → turn processing in-flight (race guard)
const callOwnNumber             = new Map<string, string>();          // callControlId → our campaign phone #
const missedTranscription       = new Map<string, string>();          // callControlId → transcript spoken during AI speech
const callTurnCount             = new Map<string, number>();          // callControlId → # of completed caller turns
const MAX_TURNS_BEFORE_CLOSE    = 12;                                 // after this many turns, force script completion
const lastAiResponse            = new Map<string, string>();          // callControlId → last AI text (to filter echo)
const aiSpeakEndedAt            = new Map<string, number>();          // callControlId → timestamp AI finished speaking
const lastProcessedText         = new Map<string, { text: string; ts: number }>(); // dedup window
const pendingTransferAfterPlay  = new Set<string>();                  // callControlId → execute transfer after next playback.ended
const pendingVmDropHangup       = new Set<string>();                  // callControlId → hang up after VM drop message finishes playing
const pendingInboundGreet       = new Set<string>();                  // callControlId → awaiting call.answered to start inbound greeting
const AI_SPEAK_COOLDOWN_MS      = 1000;                               // ignore transcriptions this many ms after AI speaks

/** Stable numeric ID from a callControlId string (for live monitor without DB row) */
function syntheticId(callControlId: string): number {
  let h = 0;
  for (let i = 0; i < callControlId.length; i++) {
    h = (Math.imul(31, h) + callControlId.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 9_000_000 + 1_000_000;
}

// makeAudioToken, audioCache, generateTTSWithFallback — imported from voiceRegistry

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
    transcription_engine: "B",
    interim_results: false,
  });

  // If a background sound is selected, inject it as an overlay audio track.
  // overlay:true mixes the audio underneath the call rather than replacing it.
  // We delay 500 ms so the greeting TTS goes out first and the overlay doesn't
  // race with the initial playback_start for the greeting audio.
  // loop:true keeps the ambient sound cycling for the entire call duration.
  const bgSound = bridge.backgroundSound;
  if (bgSound && bgSound !== "none" && BACKGROUND_SOUND_URLS[bgSound]) {
    backgroundSoundActive.add(callControlId);
    setTimeout(() => {
      telnyxAction(callControlId, "playback_start", {
        audio_url: BACKGROUND_SOUND_URLS[bgSound],
        overlay: true,
        loop: true,
      }).then(() => {
        logger.info({ callControlId, bgSound }, "Background sound overlay started");
      }).catch((err) => {
        logger.warn({ callControlId, bgSound, err: String(err) }, "Background sound injection failed (non-fatal)");
        backgroundSoundActive.delete(callControlId);
      });
    }, 500);
  }

  // Speak the greeting via ElevenLabs TTS
  aiSpeaking.add(callControlId);
  try {
    const audioUrl = await generateTTSWithFallback(bridge.firstMessage, bridge.voiceId, (bridge.voiceProvider ?? "elevenlabs") as VoiceProvider);
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
  // ── Race guard: if a turn is already processing for this call, buffer and skip ──
  if (processingTurn.has(callControlId)) {
    logger.info({ callControlId, callerText: callerText.slice(0, 60) }, "Turn already processing — buffering");
    const prev = missedTranscription.get(callControlId) ?? "";
    if (callerText.trim().length > prev.trim().length) {
      missedTranscription.set(callControlId, callerText.trim());
    }
    return;
  }
  processingTurn.add(callControlId); // lock this call for the duration of the turn

  try {
    await _handleCallerTurnInner(callControlId, callerText);
  } finally {
    processingTurn.delete(callControlId); // always release the lock
  }
}

async function _handleCallerTurnInner(callControlId: string, callerText: string): Promise<void> {
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

  // Emit live transcription to supervisor panel
  const callId = syntheticId(callControlId);
  emitToSupervisors("call:transcription", {
    callId,
    callControlId,
    speaker: "caller",
    text: clean,
    ts: Date.now(),
  });

  const history = callMessages.get(callControlId) ?? [{ role: "system" as const, content: bridge.systemPrompt }];
  history.push({ role: "user", content: clean });
  callMessages.set(callControlId, history);

  // Track turns to detect script completion / prevent infinite loops
  const turnCount = (callTurnCount.get(callControlId) ?? 0) + 1;
  callTurnCount.set(callControlId, turnCount);
  logger.debug({ callControlId, turnCount }, "Turn count updated");

  // After MAX_TURNS force the AI to wrap up — prevents infinite looping
  if (turnCount >= MAX_TURNS_BEFORE_CLOSE && bridge.transferNumber && !bridge.pendingTransfer) {
    history.push({
      role: "system",
      content: `[SYSTEM OVERRIDE — turn ${turnCount}]: You have completed the script. Wrap up in ONE sentence that references something positive from the call, then IMMEDIATELY say: "Let me get one of our team members on the line for you — one moment!" — nothing else after that.`,
    });
    logger.info({ callControlId, turnCount }, "MAX_TURNS reached — injecting forced transfer instruction");
  }

  // GPT completion — short tokens to enforce 1-2 sentence rule
  let aiText: string;
  try {
    const completion = await openai.chat.completions.create({
      model: AI_MODEL,
      max_tokens: 160,
      temperature: 0.7,
      messages: history.slice(-14) as Parameters<typeof openai.chat.completions.create>[0]["messages"],
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
  lastAiResponse.set(callControlId, aiText); // used by echo filter in call.transcription handler

  // Emit AI turn to supervisor panel
  emitToSupervisors("call:transcription", {
    callId,
    callControlId,
    speaker: "agent",
    text: aiText,
    ts: Date.now(),
  });

  // Detect transfer phrase — broader match to catch all variants
  const TRANSFER_TRIGGERS = [
    "connect you with",
    "transfer you",
    "one moment please",
    "one moment!",
    "let me connect",
    "putting you through",
    "connect you now",
    "bring in a",
    "get an agent",
    "one of our agents",
    "one of our team",
    "get one of our",
    "team member on the line",
  ];
  const aiLower = aiText.toLowerCase();
  const wantsTransfer =
    bridge.transferNumber &&
    !bridge.pendingTransfer &&
    TRANSFER_TRIGGERS.some((phrase) => aiLower.includes(phrase));

  if (wantsTransfer) {
    bridge.pendingTransfer = true;
    logger.info({ callControlId, transferTo: bridge.transferNumber }, "Transfer phrase detected — playing TTS then transferring after playback.ended");

    // Play the transfer announcement, then execute the actual transfer once
    // call.playback.ended fires (so Telnyx isn't mid-playback during transfer).
    pendingTransferAfterPlay.add(callControlId);
    aiSpeaking.add(callControlId);
    try {
      const audioUrl = await generateTTSWithFallback(aiText, bridge.voiceId, (bridge.voiceProvider ?? "elevenlabs") as VoiceProvider);
      await playWithFallback(callControlId, audioUrl, aiText);
    } catch (err) {
      aiSpeaking.delete(callControlId);
      pendingTransferAfterPlay.delete(callControlId);
      logger.warn({ callControlId, err: String(err) }, "Transfer TTS failed — executing transfer immediately");
      // TTS failed — fall back to immediate transfer
      const ownNum = callOwnNumber.get(callControlId) ?? "";
      await executeTransfer(callControlId, bridge.transferNumber!, ownNum, bridge.holdMusicUrl).catch((e) =>
        logger.error({ err: String(e), callControlId }, "Immediate transfer fallback also failed")
      );
      await telnyxAction(callControlId, "transcription_stop", {}).catch(() => {});
    }
    return;
  }

  // Generate TTS (multi-provider with fallback) and play via playback_start
  aiSpeaking.add(callControlId);
  try {
    const audioUrl = await generateTTSWithFallback(aiText, bridge.voiceId, (bridge.voiceProvider ?? "elevenlabs") as VoiceProvider);
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

  // Only answer inbound calls for numbers configured as inbound or both
  if (phoneRow.direction === "outbound") {
    logger.info({ toNumber, direction: phoneRow.direction }, "Inbound call on outbound-only number — not answering");
    return null;
  }

  // Only answer inbound calls for campaigns set to inbound or both
  if (campaign.type !== "inbound" && campaign.type !== "both") {
    logger.info({ campaignId: campaign.id, type: campaign.type, toNumber }, "Inbound call received but campaign is outbound-only — not answering");
    return null;
  }

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

  // ── Resolve effective transfer number (priority order) ──────────────────
  // 1. Direct forwardNumber on the number (E.164 override)
  // 2. Specific human agent assigned to the number
  // 3. Queue assigned to the number (pick best available agent by strategy)
  // 4. Campaign's transferNumber fallback
  let effectiveTransferNumber: string | null = null;

  if (phoneRow.forwardNumber) {
    effectiveTransferNumber = phoneRow.forwardNumber;
  } else if (phoneRow.humanAgentId) {
    const [agent] = await db
      .select({ phoneNumber: humanAgentsTable.phoneNumber })
      .from(humanAgentsTable)
      .where(eq(humanAgentsTable.id, phoneRow.humanAgentId));
    effectiveTransferNumber = agent?.phoneNumber ?? null;
    logger.info({ humanAgentId: phoneRow.humanAgentId, phone: effectiveTransferNumber }, "Inbound: routing to direct agent");
  } else if (phoneRow.queueId) {
    const [queue] = await db
      .select()
      .from(queuesTable)
      .where(and(eq(queuesTable.id, phoneRow.queueId), eq(queuesTable.status, "active")));

    if (queue) {
      // Fetch queue members with their agent details, ordered by priority
      const members = await db
        .select({
          humanAgentId: queueMembersTable.humanAgentId,
          priority:     queueMembersTable.priority,
          agentPhone:   humanAgentsTable.phoneNumber,
          agentStatus:  humanAgentsTable.status,
        })
        .from(queueMembersTable)
        .innerJoin(humanAgentsTable, eq(queueMembersTable.humanAgentId, humanAgentsTable.id))
        .where(eq(queueMembersTable.queueId, phoneRow.queueId))
        .orderBy(queueMembersTable.priority);

      // Filter to available agents
      const available = members.filter(m => m.agentStatus === "available");
      const pool = available.length > 0 ? available : members; // fallback to all if none available

      if (pool.length > 0) {
        let chosen: typeof pool[0];
        if (queue.strategy === "round-robin") {
          // Simple round-robin: pick based on current minute as a rotation seed
          chosen = pool[Math.floor(Date.now() / 30_000) % pool.length];
        } else if (queue.strategy === "priority") {
          chosen = pool[0]; // already sorted by priority
        } else {
          // least-busy: pick first available (future: track active calls per agent)
          chosen = pool[0];
        }
        effectiveTransferNumber = chosen.agentPhone;
        logger.info({ queueId: phoneRow.queueId, strategy: queue.strategy, chosen: chosen.agentPhone }, "Inbound: routing via queue");
      }
    }
  }

  // Fallback to campaign's transfer number
  if (!effectiveTransferNumber) {
    effectiveTransferNumber = campaign.transferNumber ?? null;
  }

  return { campaign, agentName, systemPrompt, voiceId: resolvedVoiceId, holdMusicUrl, effectiveTransferNumber };
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
  voiceProvider?: string;
  phone: string;
  transferNumber: string | null;
  backgroundSound: string | null;
}

interface ConferenceBridgeClientState {
  type: "conference_bridge";
  originalCallControlId: string; // leg A — the call we're adding a 3rd party to
}

type AnyClientState = OutboundClientState | ConferenceBridgeClientState;

function decodeClientState(raw: string): AnyClientState | null {
  try {
    const json = Buffer.from(raw, "base64").toString("utf-8");
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (parsed?.type === "outbound")          return parsed as unknown as OutboundClientState;
    if (parsed?.type === "conference_bridge") return parsed as unknown as ConferenceBridgeClientState;
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
        const bridge = getBridgeInfo(callControlId);

        // Voicemail drop: if campaign has a vmDropMessage and we heard a beep, leave the message
        if (result === "machine_end_beep" && bridge?.campaignId) {
          const [camp] = await db
            .select({ vmDropMessage: campaignsTable.vmDropMessage, voice: campaignsTable.voice })
            .from(campaignsTable)
            .where(eq(campaignsTable.id, bridge.campaignId));

          if (camp?.vmDropMessage) {
            logger.info({ callControlId, campaignId: bridge.campaignId }, "AMD: voicemail beep — leaving VM drop message");
            try {
              const voiceId = bridge.voiceId ?? DEFAULT_ELEVEN_VOICE;
              const audioUrl = await generateTTSWithFallback(camp.vmDropMessage, voiceId, (bridge.voiceProvider ?? "elevenlabs") as VoiceProvider);
              await telnyxAction(callControlId, "playback_start", {
                audio_url: audioUrl,
                overlay: false,
                stop_condition: "detecting_silence",
              });
              // Hang up after playback — handled by playback.ended event
              pendingVmDropHangup.add(callControlId);
              bridge.transcript.push(`AI Agent (VM Drop): ${camp.vmDropMessage}`);
              logger.info({ callControlId }, "VM drop message playing — will hang up on playback.ended");
              return; // Don't hang up immediately; let playback.ended do it
            } catch (err) {
              logger.warn({ err: String(err), callControlId }, "VM drop TTS failed — falling back to hangup");
            }
          }
        }

        // Default: hang up immediately on voicemail
        try { await telnyxAction(callControlId, "hangup", {}); } catch { /* already gone */ }

        if (bridge) {
          const durationSecs = Math.round(
            (Date.now() - bridge.startedAt.getTime()) / 1000
          );
          const numberUsed = callOwnNumber.get(callControlId) ?? null;
          await db.insert(callLogsTable).values({
            phoneNumber: bridge.callerNumber,
            campaignId: bridge.campaignId,
            status: "completed",
            disposition: "vm",
            direction: "outbound",
            duration: durationSecs,
            callControlId,
            numberUsed,
            answerType: "voicemail",
          }).catch(() => {});
          closeBridge(callControlId);
          callOwnNumber.delete(callControlId);
        }
      }
      return;
    }

    // ── 1a. Outbound call answered by human ───────────────────────────────────
    if (eventType === "call.answered") {
      const ctx = clientStateRaw ? decodeClientState(clientStateRaw) : null;

      // ── Conference bridge: third party answered — bridge legs together ───────
      if (ctx?.type === "conference_bridge") {
        const { originalCallControlId } = ctx;
        logger.info({ callControlId, originalCallControlId }, "Conference leg answered — bridging to original call");
        try {
          await telnyxAction(callControlId, "bridge", { call_control_id: originalCallControlId });
          logger.info({ callControlId, originalCallControlId }, "Conference bridge executed");
        } catch (err) {
          logger.error({ err: String(err), callControlId, originalCallControlId }, "Conference bridge failed");
        }
        return;
      }

      if (!ctx) {
        // No client_state means this is an inbound call we answered.
        // If it's in our pending inbound greet queue, now start transcription + greeting.
        if (pendingInboundGreet.has(callControlId)) {
          pendingInboundGreet.delete(callControlId);
          logger.info({ callControlId }, "call.answered (inbound) — starting recording + transcription + greeting");
          // Start recording first, then transcription + greeting
          await startRecording(callControlId).catch((err) =>
            logger.warn({ err: String(err), callControlId }, "Inbound recording start failed — continuing")
          );
          startTranscriptionAndGreet(callControlId).catch((err) =>
            logger.error({ err: String(err), callControlId }, "startTranscriptionAndGreet failed for inbound call")
          );
        } else {
          logger.info({ callControlId, direction }, "call.answered without client_state — skipping (no pending inbound greet)");
        }
        return;
      }

      // At this point ctx must be an OutboundClientState (conference_bridge and null cases returned above)
      const outboundCtx = ctx as OutboundClientState;

      const campaignId = parseInt(outboundCtx.campaignId, 10);

      // Look up lead name
      const [lead] = await db
        .select({ name: leadsTable.name, id: leadsTable.id })
        .from(leadsTable)
        .where(and(eq(leadsTable.phone, outboundCtx.phone), eq(leadsTable.campaignId, campaignId)))
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
        outboundCtx.voice && outboundCtx.voice !== "default" ? outboundCtx.voice : DEFAULT_ELEVEN_VOICE;

      // Build system prompt, then append background sound context if set
      let systemPrompt = buildSystemPrompt(
        outboundCtx.script,
        outboundCtx.campaignName,
        agentName,
        leadName,
        outboundCtx.transferNumber ?? undefined
      );
      const bgKey = outboundCtx.backgroundSound && outboundCtx.backgroundSound !== "none" ? outboundCtx.backgroundSound : null;
      if (bgKey && BACKGROUND_CONTEXT_MAP[bgKey]) {
        systemPrompt = `${systemPrompt}\n\n${BACKGROUND_CONTEXT_MAP[bgKey]}`;
      }

      // First message — warm, natural, with pause markers for human-like delivery
      const firstMessage = firstName
        ? `Hey... is that ${firstName}?`
        : `Hey there... is this a good time for a quick call? I'm ${agentName} from ${outboundCtx.campaignName}.`;

      logger.info(
        { callControlId, campaignId, phone: outboundCtx.phone, leadName, agentName, voiceId: callVoiceId, backgroundSound: outboundCtx.backgroundSound },
        "Outbound call answered — starting ElevenLabs ConvAI bridge"
      );

      // Register bridge state
      initBridge(callControlId, {
        campaignId,
        campaignName: outboundCtx.campaignName,
        agentName,
        callerNumber: outboundCtx.phone,
        direction: "outbound",
        startedAt: new Date(),
        leadId: lead?.id,
        transferNumber: outboundCtx.transferNumber ?? undefined,
        holdMusicUrl: outboundHoldMusicUrl,
        backgroundSound: outboundCtx.backgroundSound ?? undefined,
        voiceProvider: outboundCtx.voiceProvider ?? "elevenlabs",
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
        phoneNumber: outboundCtx.phone,
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

      const { campaign, agentName, systemPrompt, voiceId: inboundVoiceId, holdMusicUrl: inboundHoldMusicUrl, effectiveTransferNumber } = result;
      const firstMessage = `Hey... thanks for calling ${campaign.name}. I'm ${agentName} — how can I help you today?`;

      logger.info(
        { callControlId, campaignId: campaign.id, agentName, voiceId: inboundVoiceId, effectiveTransferNumber },
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
        transferNumber: effectiveTransferNumber ?? undefined,  // per-number override > campaign default
        holdMusicUrl: inboundHoldMusicUrl,
        voiceProvider: campaign.voiceProvider ?? "elevenlabs",
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

      // Mark as waiting for call.answered before starting transcription + greeting.
      // Telnyx must confirm the call is established before we can start STT/TTS.
      pendingInboundGreet.add(callControlId);
      logger.info({ callControlId }, "Inbound answered — waiting for call.answered to start greeting");

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
      const transcript: string = (td.transcript ?? "").trim();
      const isFinal: boolean = td.is_final === true || td.is_final === "true";

      if (!isFinal || transcript.length < 3) return;

      // ── Guard 1: cooldown window — ignore transcriptions that arrive right
      //    after the AI finishes speaking (catches AI-voice echo from Telnyx STT)
      const speakEndMs = aiSpeakEndedAt.get(callControlId) ?? 0;
      if (Date.now() - speakEndMs < AI_SPEAK_COOLDOWN_MS) {
        logger.debug({ callControlId, transcript: transcript.slice(0, 60) }, "Transcription in AI cooldown window — dropping");
        return;
      }

      // ── Guard 2: AI echo filter — drop if transcript closely matches last AI reply
      const lastAi = lastAiResponse.get(callControlId) ?? "";
      if (lastAi.length > 5) {
        const tLow = transcript.toLowerCase();
        const aLow = lastAi.toLowerCase();
        // Check if caller text appears inside AI text or vice versa (overlap > 60%)
        const overlap = (a: string, b: string) => {
          const shorter = a.length < b.length ? a : b;
          const longer  = a.length < b.length ? b : a;
          return shorter.length > 8 && longer.includes(shorter.substring(0, Math.min(30, shorter.length)));
        };
        if (overlap(tLow, aLow)) {
          logger.debug({ callControlId, transcript: transcript.slice(0, 60) }, "Transcription looks like AI echo — dropping");
          return;
        }
      }

      // ── Guard 3: deduplication — drop exact duplicate within 5 s
      const prev = lastProcessedText.get(callControlId);
      if (prev && prev.text === transcript && Date.now() - prev.ts < 5_000) {
        logger.debug({ callControlId, transcript: transcript.slice(0, 60) }, "Duplicate transcription — dropping");
        return;
      }
      lastProcessedText.set(callControlId, { text: transcript, ts: Date.now() });

      logger.info({ callControlId, transcript: transcript.slice(0, 100) }, "Final transcription accepted");
      handleCallerTurn(callControlId, transcript).catch((err) =>
        logger.error({ err: String(err), callControlId }, "handleCallerTurn error")
      );
      return;
    }

    // ── 3b. Speak/playback ended — clear speaking flag & replay missed ────────
    if (eventType === "call.speak.ended" || eventType === "call.playback.ended") {
      // If this event is from the background sound overlay ending, ignore it —
      // it must not clear aiSpeaking or trigger a caller-turn replay.
      if (eventType === "call.playback.ended" && backgroundSoundActive.has(callControlId)) {
        backgroundSoundActive.delete(callControlId);
        logger.info({ callControlId }, "Background sound ended — ignoring playback.ended (not AI speech)");
        return;
      }

      logger.info({ callControlId, eventType }, "AI speech finished");
      aiSpeaking.delete(callControlId);
      aiSpeakEndedAt.set(callControlId, Date.now()); // start cooldown window

      // ── If this was a VM drop message, hang up now ───────────────────────────
      if (pendingVmDropHangup.has(callControlId)) {
        pendingVmDropHangup.delete(callControlId);
        logger.info({ callControlId }, "VM drop message finished — hanging up");
        try { await telnyxAction(callControlId, "hangup", {}); } catch { /* already gone */ }
        return;
      }

      // ── If a transfer is pending, execute it now that TTS has finished ──────
      if (pendingTransferAfterPlay.has(callControlId)) {
        pendingTransferAfterPlay.delete(callControlId);
        const bridge = getBridgeInfo(callControlId);
        const ownNum = callOwnNumber.get(callControlId) ?? "";
        if (bridge?.transferNumber) {
          logger.info({ callControlId, to: bridge.transferNumber }, "TTS done — executing pending transfer");
          executeTransfer(callControlId, bridge.transferNumber, ownNum, bridge.holdMusicUrl)
            .then(() => telnyxAction(callControlId, "transcription_stop", {}).catch(() => {}))
            .catch((err) => logger.error({ err: String(err), callControlId }, "Transfer after playback.ended failed"));
        }
        return; // never replay missed speech after a transfer
      }

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

      // Clean up background sound tracking
      backgroundSoundActive.delete(callControlId);

      const durationSecs = Math.round(
        (Date.now() - bridge.startedAt.getTime()) / 1000
      );
      const transcript = bridge.transcript.join("\n");

      const { summary, disposition } = await generateSummaryAndDisposition(
        transcript,
        bridge.campaignName
      );

      // Resolve the from-number used for this call
      const numberUsed = callOwnNumber.get(callControlId) ?? null;

      // Derive answerType from disposition
      const answerType = disposition === "vm" ? "voicemail"
        : disposition === "no_answer" ? "no_answer"
        : "human";

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
          numberUsed,
          answerType,
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
          numberUsed,
          answerType,
        }).catch((err) =>
          logger.error({ err: String(err), callControlId }, "Failed to insert inbound call log")
        );

        logger.info(
          { callControlId, campaignId: bridge.campaignId, disposition, durationSecs },
          "Inbound call finalized"
        );
      }

      // ── Number pool release ────────────────────────────────────────────────
      // Mark number available, increment usageCount, bump spamScore on vm/no_answer
      if (numberUsed) {
        const isUnproductive = disposition === "no_answer" || disposition === "vm";
        await db
          .update(phoneNumbersTable)
          .set({
            isBusy: false,
            lastUsedAt: new Date(),
            usageCount: sql`${phoneNumbersTable.usageCount} + 1`,
            spamScore: isUnproductive
              ? sql`LEAST(${phoneNumbersTable.spamScore} + 1, 100)`
              : phoneNumbersTable.spamScore,
          })
          .where(eq(phoneNumbersTable.phoneNumber, numberUsed))
          .catch((err) => logger.warn({ err: String(err), numberUsed }, "Number pool release failed"));

        logger.info({ numberUsed, disposition, isUnproductive }, "Number released to pool");
      }

      // Live monitor: call ended
      emitToSupervisors("call:ended", {
        id: syntheticId(callControlId),
        callControlId,
        disposition,
        duration: durationSecs,
      });

      // Signal all connected clients to refresh per-agent stats
      emitToSupervisors("agent:stats:refresh", { ts: Date.now() });

      // Stop transcription cleanly
      await telnyxAction(callControlId, "transcription_stop", {}).catch(() => {});

      closeBridge(callControlId);
      // Clean up per-call state
      callMessages.delete(callControlId);
      aiSpeaking.delete(callControlId);
      callOwnNumber.delete(callControlId);
      missedTranscription.delete(callControlId);
      callTurnCount.delete(callControlId);
      lastAiResponse.delete(callControlId);
      aiSpeakEndedAt.delete(callControlId);
      lastProcessedText.delete(callControlId);
      processingTurn.delete(callControlId);
      pendingTransferAfterPlay.delete(callControlId);
      pendingInboundGreet.delete(callControlId);
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
