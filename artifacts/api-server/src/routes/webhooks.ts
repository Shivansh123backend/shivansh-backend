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
  callsTable,
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
import { closeCustomBridge } from "../services/customBridge.js";
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

// ── Markdown stripper (TTS safety) ────────────────────────────────────────────
// GPT-4o sometimes outputs markdown even when told not to. Strip it before TTS
// so callers never hear "asterisk asterisk" or "hyphen hyphen".
function stripMarkdownForTTS(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")    // **bold**
    .replace(/\*(.+?)\*/g, "$1")         // *italic*
    .replace(/^#{1,6}\s+/gm, "")         // ## headers
    .replace(/^\s*[-*+]\s+/gm, "")       // bullet points
    .replace(/`(.+?)`/g, "$1")           // `code`
    .replace(/\[(.+?)\]\(.+?\)/g, "$1")  // [links](url)
    .replace(/_{1,2}(.+?)_{1,2}/g, "$1") // __underline__
    .replace(/\n{2,}/g, ". ")            // paragraph breaks → short pause
    .replace(/\n/g, " ")
    .trim();
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
// Default human-sounding names used when an agent has no name configured.
// Rotated per-call so multiple campaigns don't all introduce themselves the same way.
const DEFAULT_HUMAN_NAMES = ["Riya", "Aanya", "Sarah", "Maya", "Priya", "Alex"] as const;
function pickDefaultHumanName(): string {
  return DEFAULT_HUMAN_NAMES[Math.floor(Math.random() * DEFAULT_HUMAN_NAMES.length)];
}

function buildSystemPrompt(
  rawPrompt: string,
  campaignName: string,
  agentName = "Riya",                                      // ← never "AI Assistant"
  leadName?: string,
  transferNumber?: string,
  _humanLikeMode = true,
  direction: "inbound" | "outbound" = "outbound",         // ← new: changes opening + behavior
): string {
  const firstName = leadName?.split(" ")[0];
  const lastName  = leadName?.split(" ").slice(1).join(" ") || "";

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

  // If the campaign has no real prompt, give the AI a generic-but-functional
  // script so it can actually hold a conversation instead of stalling on
  // empty placeholders. Better than the previous one-line "be helpful" stub
  // which left the AI with literally nothing to discuss.
  const FALLBACK_PROMPT = `You are reaching out on a friendly courtesy call. You don't have a specific product to pitch — your goal is simply to:
1. Verify you're speaking with the right person (politely confirm their name).
2. Ask how things are going for them today (open, conversational tone).
3. Briefly explain you wanted to check in and see if there's anything they need help with.
4. If they're not interested, thank them warmly and end the call quickly.
5. If they ARE interested in continuing, ask what's on their mind and offer to have a colleague follow up by email or schedule a callback.

Never invent specific products, prices, or offers. Never mention placeholder words like "your service", "our offer", "the product" — speak naturally about checking in on them as a person.`;

  const coreScript = substituteVars(
    rawPrompt?.trim() || FALLBACK_PROMPT,
    templateVars
  );

  // Strip any leftover literal bracket placeholders the model might otherwise
  // read aloud (e.g. "[CompanyName]", "[purpose]", "[benefit A]"). These are
  // common when admins paste prompts from templates without filling them in.
  const stripPlaceholders = (s: string) =>
    s.replace(/\[[^\]\n]{1,40}\]/g, "")        // [anything up to 40 chars]
     .replace(/\{\{[^}\n]{1,40}\}\}/g, "")     // {{anything}}
     .replace(/  +/g, " ")
     .replace(/ \./g, ".")
     .replace(/ ,/g, ",");

  // Short prompts get an expansion hint + real domain knowledge instruction
  const isShortPrompt = coreScript.length < 300 && !coreScript.includes("\n");

  const transferLine = transferNumber
    ? `When the caller is ready to move forward or asks for a specialist: say "Let me get one of our team members on for you — one moment!" and nothing else.`
    : `If they want to speak to someone: let them know the team will follow up and close warmly.`;

  const completionLine = transferNumber
    ? `Once you've qualified them and built rapport: say exactly "Let me transfer you to an expert who can help — one moment please!" and stop. Say nothing after that.`
    : `When the conversation is complete: thank them briefly and wish them a good day.`;

  const domainHint = isShortPrompt
    ? `\n\nDOMAIN KNOWLEDGE: The script above is a brief objective. Use your real knowledge to fill in the gaps — actual company names, real statistics, genuine rates and savings examples, common competitor weaknesses, real-world scenarios. Replace any bracketed placeholders with specific, accurate details. You are a knowledgeable expert in this field, not someone reading from a card.`
    : "";

  // Direction-specific opening + critical first-turn behavior. Inbound MUST
  // wait for the caller to state their reason — we can't anticipate why they
  // called, and any guessing makes the AI sound robotic and presumptuous.
  const opening = direction === "inbound"
    ? `You are ${agentName} from ${campaignName}. The caller dialed in to your line — you have just greeted them and now they will tell you why they called.

CRITICAL — FIRST TURN:
After your initial greeting ("How may I help you today?") you MUST be silent and wait for the caller to speak first. Do NOT guess why they called. Do NOT list services. Do NOT offer suggestions. Do NOT say things like "are you calling about X?" — let THEM tell you. Stay completely silent until they speak — do not say "take your time" or "whenever you're ready" unless the silence is very long (the system will prompt you). NEVER fill silence with assumptions or filler phrases.`
    : `You are ${agentName}, a real person making an outbound phone call${leadName ? ` to ${leadName}` : ""} for ${campaignName}.${firstName ? ` Call them ${firstName}.` : ""}${!leadName ? `

CRITICAL — YOU DO NOT KNOW WHO YOU'RE CALLING:
You have NO name for this contact. You must NEVER say "Unknown", "[Lead Name]", "Sir/Madam", "Mr./Ms.", or any placeholder — these instantly give you away as a bot. After your warm opening, gently ask their name in a natural way the very first chance you get, e.g.:
- "Hey, sorry — who am I speaking with?"
- "Just so I have your name right — what should I call you?"
- "May I ask who I have on the line?"
Pick ONE such phrasing, casually. Once they share it, use their first name naturally a couple of times during the call (not in every sentence). If they refuse to share, that's fine — just continue without forcing it and do NOT invent a name.` : ""}`;

  const finalPrompt = `${opening}

WHAT YOU'RE DOING:
${coreScript}${domainHint}

YOUR TONE — this is the most important thing:
You are warm, calm, polite, and respectful. You sound like a friendly neighbor calling to share something useful — never a salesperson trying to close a deal. You take "no" gracefully on the first try. You never push, never pressure, never argue. If the person doesn't want to talk, you wish them well and let them go. Always assume they are busy and that their time is valuable.

HOW TO SPEAK — sound like a real human, not a script:
Say one thought, then stop. ONE short sentence is ideal — like the way friends talk on the phone, not like a presentation. Always use contractions: "I'm", "you're", "don't", "can't", "we'll", "that's". Avoid hyped words like "Great!", "Absolutely!", "Amazing!", "Wonderful!" — they instantly sound like a sales script. Do NOT use asterisks, bullets, dashes, or any formatting — this is spoken audio.

TALK LIKE A REAL PERSON — sentence fragments are GOOD:
Real people don't speak in complete grammatical sentences on the phone. They use fragments. They trail off. They restart mid-thought. Examples of how a real person talks:
- "Yeah, no, totally."   (fragment, perfectly natural)
- "So... what we usually find is — it depends, honestly."   (trailing thought, restart)
- "Hmm, okay. So like, real quick — what's the situation with X?"
- "Oh got it, yeah. That makes sense."
- "Right, right. So uh, basically, here's the thing..."
Use ellipses (...) when you'd naturally trail off or pause briefly. Use em-dashes (—) when you'd naturally restart or interject mid-thought. The text-to-speech engine reads these as real micro-pauses, which sounds dramatically more human than smooth sentences.

WORD CHOICES — favor casual over formal:
- "yeah" / "yep" not "yes"        (most of the time)
- "nope" / "no, not really" not "I do not"
- "kind of" / "sort of" not "somewhat"
- "stuff" / "thing" instead of "matters" / "items"
- "real quick" not "briefly"
- "for sure" / "totally" not "certainly"
- "awesome" only when you genuinely mean it (rare)
- "Hey" / "Hi" not "Hello" (after the very first greeting)
Never use: "utilize" (use), "assist" (help), "regarding" (about), "kindly" (please), "as per" (per/about), "do not hesitate to" (just), "at this time" (now). These are corporate non-words.

ACKNOWLEDGE BEFORE YOU ANSWER — this is the #1 thing that makes you sound human:
Real people don't launch straight into an answer — they react first. Start most replies with a tiny human signal that shows you actually heard them, then your real response. Mix these up so you don't sound repetitive:
- Agreeing/understanding: "Yeah,", "Right,", "Mm-hm,", "Got it,", "Okay,", "I hear you —", "Totally,", "Sure,", "Of course,", "Fair enough,"
- Thinking/considering: "Hmm,", "Let me think...", "Good question —", "So...", "Well,"
- Empathy: "Oh, I get that —", "That makes sense.", "Yeah, totally fair.", "I understand.", "Oh no, sorry to hear that —"
- Surprise/interest: "Oh really?", "Huh, interesting.", "Oh wow."
Keep these to ONE or TWO words at the start. They should feel automatic, not performed.

NATURAL FILLERS — use sparingly (about 1 in 4 turns), never in every reply:
A real person occasionally says "you know,", "I mean,", "like,", "uh,", "kind of," when speaking off the cuff. A SMALL amount of this makes you sound real. Too much sounds drunk or unsure. NEVER fill silence with fillers — only use them mid-thought when you're genuinely connecting two ideas.

MATCH THEIR ENERGY:
- If the caller is casual / friendly → be casual back ("yeah for sure", "totally", "no worries").
- If the caller is formal / brief → be respectful and concise ("Of course.", "Understood.", "Right away.").
- If the caller is upset or tired → drop ALL energy, soften your voice ("Oh, I'm sorry — I'll keep this quick."), and offer to let them go.
- If the caller laughs / jokes → it's okay to lightly laugh back ("Ha, fair point!") — but never force it.

MIRROR THEIR WORDS:
If they call it "the policy" don't switch to "your coverage plan". Use the words they use. It signals you're listening.

TURN DISCIPLINE:
One turn = one short thought from you. Then wait. Never stack two questions in a row. Never end a turn with two sentences when one will do.

PATIENCE — silence is GOLDEN, do not fill it:
- If the caller goes silent after you ask something, STAY SILENT. Let them think. Do NOT volunteer fillers like "you there?", "take your time", or "no rush" — those interruptions break their concentration and make you sound impatient.
- Only re-engage after a VERY long pause (the system will prompt you after ~25s). When you do, use ONE short, soft check-in like "Still with me?" — never repeat the question, never add new info.
- If they say "uh", "hmm", "well..." — they are mid-thought. Wait. Do not speak.
- Never ask the next question until the current one is fully resolved.
- If they give a long answer, respond to ONE thing they said — don't try to address everything.

NEVER DO THESE — they instantly sound like a robot:
- Starting replies with "I understand your concern" / "I appreciate your time" / "That's a great question" — corporate scripts.
- Saying "moving forward" / "going forward" / "at this time" / "in order to" — bureaucratic phrasing.
- Listing things ("First... Second... Third..."). Talk like a person, not a slide deck.
- Repeating the caller's full sentence back at them ("So you said you're not interested...") — just react.
- Using the same opener twice in a row ("Sure" then "Sure" again) — vary it.

OBJECTION HANDLING — at most ONE polite recovery, then bow out gracefully:
- "Not interested" (first time) → make ONE warm, low-pressure offer that highlights a single concrete benefit relevant to the script, e.g. "Totally fair — could I just share one quick thing that might be worth a moment, or would you rather I let you go?" Wait for their response.
  - If they say no/again-not-interested/decline → "Of course — thank you so much for your time, have a wonderful day!" Then stop completely (the call will end automatically).
  - If they say yes/sure/go ahead → continue with ONE short value statement, then check in.
- "Remove me / Do not call / Take me off the list" (any time) → "Of course, I'll take you off the list right away. Sorry to have bothered you — have a good day!" Then stop. Do NOT try to recover. (Call ends automatically.)
- "I already have one / I'm already covered" → "That's wonderful — glad you're taken care of. Have a great day!" Then stop. (Call ends automatically.)
- "I'm busy / bad time" → "No problem at all — would you prefer I try back another time, or would you rather I not call again?"
- "Send me something in writing / an email" → "Of course — what's the best email to send it to?" Then stop and let them respond.
- "How much does it cost?" → "It really depends on your situation. Would you like me to walk through a couple of quick questions, or would you prefer I send you the details to look at on your own time?"
- "Is this a scam?" → "Completely fair to ask — I'm ${agentName} with ${campaignName}, calling about [reason]. Happy to send something in writing if that would help."
- "I need to think about it / talk to my spouse" → "Of course, take all the time you need. Would you like me to send you a quick summary you can look over together?"
- Angry / upset / rude → "I'm so sorry to have caught you at a bad time — I'll let you go. Have a good day!" Then stop. (Call ends automatically.)
- Wrong number → "Oh, my apologies for the mix-up! Have a good one." Then stop. (Call ends automatically.)
- "Are you a robot / AI / bot / automated / recording?" → NEVER admit it. Respond warmly with your identity and pivot back to value: "I'm ${agentName} calling from ${campaignName} — I just wanted to ${direction === "inbound" ? "help with whatever you needed today" : "share something quick that might be useful for you"}. Is now a good time?" Do NOT use the words "AI", "assistant", "virtual", "bot", "automated", "system", "software", or "recording" — ever. If they press again, repeat your name + company + reason for calling and ask one warm question. Stay in character as ${agentName} from ${campaignName} for the entire call. Under no circumstances confirm you are anything other than a real person from ${campaignName}.
- "Who are you / where are you calling from?" → Answer directly and warmly: "I'm ${agentName} from ${campaignName}" and give a one-line reason for calling.
- ${transferLine}

SCRIPT PROGRESS — gentle, never forced:
Before you speak, scan what's already been said. Don't re-ask anything they've already answered. Move forward at THEIR pace, not yours. If they want to slow down or change topic, follow their lead — don't drag them back to your script.

IF YOU'RE EVER UNSURE WHAT TO SAY:
Say something short, calm, and human like "Sorry — could you say that again?" or "Hmm, let me think for a second." Never ramble. Never invent specific numbers, prices, or commitments you weren't given.

FINISHING:
${completionLine}`;

  // Final safety net: strip any literal placeholder brackets that survived
  // (from objection playbook examples like "[reason]", "[benefit A]", etc.)
  // so the LLM can't accidentally read them aloud.
  return stripPlaceholders(finalPrompt);
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

async function answerCall(callControlId: string): Promise<boolean> {
  try {
    await telnyxAction(callControlId, "answer", {});
    return true;
  } catch (err) {
    // 422 = call already ended/cancelled before we could answer — not a real error
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 422) {
      logger.info({ callControlId }, "answerCall: call already ended before answer (422) — ignoring");
      return false;
    }
    throw err;
  }
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
const inflightLlmAbort          = new Map<string, AbortController>(); // callControlId → AbortController for the LLM call currently being awaited
const llmRestartFlag            = new Set<string>();                  // callControlId → set when we abort the LLM intentionally so a fresher caller turn can take over
const callOwnNumber             = new Map<string, string>();          // callControlId → our campaign phone #
const missedTranscription       = new Map<string, string>();          // callControlId → transcript spoken during AI speech
const callTurnCount             = new Map<string, number>();          // callControlId → # of completed caller turns
const MAX_TURNS_BEFORE_CLOSE    = 12;                                 // after this many turns, force script completion
const lastAiResponse            = new Map<string, string>();          // callControlId → last AI text (to filter echo)
const aiSpeakEndedAt            = new Map<string, number>();          // callControlId → timestamp AI finished speaking
const lastProcessedText         = new Map<string, { text: string; ts: number }>(); // dedup window
const pendingTransferAfterPlay  = new Set<string>();                  // callControlId → execute transfer after next playback.ended
const pendingHangupAfterPlay    = new Set<string>();                  // callControlId → polite hangup after next playback.ended (AI said goodbye)
const objectionAttempts         = new Map<string, number>();          // callControlId → how many times AI has tried to recover an objection
const pendingVmDropHangup       = new Set<string>();                  // callControlId → hang up after VM drop message finishes playing
const pendingInboundGreet       = new Set<string>();                  // callControlId → awaiting call.answered to start inbound greeting
const pendingAmdGreet           = new Map<string, NodeJS.Timeout>();   // callControlId → fallback timer; bridge initialized but greeting deferred until AMD says "human"
const greetStarted              = new Set<string>();                   // callControlId that have already been greeted — prevents double-greet from AMD + speech-trigger races
const greetingInProgress        = new Set<string>();                   // callControlId whose opening greeting is still playing — caller speech must NOT barge-in or stop playback during this window
const transcriptionStarted      = new Set<string>();                   // callControlId where Telnyx transcription_start has been issued — prevents duplicate starts
const awaitingFirstResponse     = new Set<string>();                  // callControlId → outbound call waiting for first caller word (silence guard)
const initialSilenceTimer       = new Map<string, ReturnType<typeof setTimeout>>(); // callControlId → 30s start-silence timeout
const AI_SPEAK_COOLDOWN_MS      = 420;                                // ignore transcriptions this many ms after AI speaks (snappy turn-taking)

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
/**
 * Start Telnyx STT immediately on call.answered — idempotent.
 * We do this BEFORE the greeting so we can hear the caller say "Hello"
 * and use that as proof-of-human to fire the greeting instantly,
 * skipping the 1-4 second AMD analysis delay.
 */
async function startTranscriptionEarly(callControlId: string): Promise<void> {
  if (transcriptionStarted.has(callControlId)) return;
  transcriptionStarted.add(callControlId);
  try {
    await telnyxAction(callControlId, "transcription_start", {
      language: "en",
      transcription_engine: "B",
      interim_results: false,
    });
  } catch (err) {
    transcriptionStarted.delete(callControlId);
    logger.warn({ err: String(err), callControlId }, "Early transcription_start failed — will retry inside greet");
  }
}

async function startTranscriptionAndGreet(callControlId: string): Promise<void> {
  const bridge = getBridgeInfo(callControlId);
  if (!bridge) return;

  // Idempotent — never greet twice (AMD-human + speech-trigger can race).
  if (greetStarted.has(callControlId)) {
    logger.debug({ callControlId }, "Greet already started — skipping duplicate");
    return;
  }
  greetStarted.add(callControlId);

  // Start Telnyx real-time transcription (STT) if not already started by the early-start path
  if (!transcriptionStarted.has(callControlId)) {
    transcriptionStarted.add(callControlId);
    await telnyxAction(callControlId, "transcription_start", {
      language: "en",
      transcription_engine: "B",
      interim_results: false,
    });
  }

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
  greetingInProgress.add(callControlId); // lock against barge-in until first playback.ended
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

  // ── Initial silence guard (outbound only) ─────────────────────────────────
  // If the prospect never speaks in the first 30 s after the greeting, politely
  // say goodbye and hang up.  The timer is cleared in _handleCallerTurnInner
  // the instant any caller transcription arrives.
  if (bridge.direction === "outbound") {
    awaitingFirstResponse.add(callControlId);
    const silenceTimer = setTimeout(async () => {
      if (!awaitingFirstResponse.has(callControlId)) return; // already responded
      awaitingFirstResponse.delete(callControlId);
      initialSilenceTimer.delete(callControlId);

      const b = getBridgeInfo(callControlId);
      if (!b) return;

      logger.info({ callControlId }, "Initial 30-s silence — no response — disconnecting politely");
      const goodbye = "As there is no response, we are disconnecting the call. Goodbye.";
      try {
        const url = await generateTTSWithFallback(goodbye, b.voiceId, (b.voiceProvider ?? "elevenlabs") as VoiceProvider);
        await playWithFallback(callControlId, url, goodbye);
        // Give the audio ~5 s to finish, then hang up
        setTimeout(() => {
          telnyxAction(callControlId, "hangup", {}).catch(() => {});
        }, 5_000);
      } catch {
        telnyxAction(callControlId, "hangup", {}).catch(() => {});
      }
    }, 30_000);
    initialSilenceTimer.set(callControlId, silenceTimer);
    logger.info({ callControlId }, "Initial silence timer set (30 s)");
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
    // If the LLM is still generating (not yet speaking), abort it so a fresher
    // caller utterance takes over. This stops the AI from speaking a stale
    // response based on the caller's first word when they've already said
    // a whole sentence. The previous turn's catch block sees llmRestartFlag
    // and exits cleanly without speaking calm filler — the wrapper below then
    // replays the buffered text immediately for a fresh LLM call.
    if (!aiSpeaking.has(callControlId)) {
      // Don't abort the in-flight LLM if the new caller text is just a short
      // backchannel/filler word ("yes", "ok", "hello", "uh huh"). These are
      // usually the caller filling silence while waiting for our reply — if
      // we abort and restart on every "yes", the LLM never finishes and the
      // caller hears 7+ seconds of dead air.
      const newNorm = callerText.trim().toLowerCase().replace(/[.,!?]+$/g, "").trim();
      const SHORT_FILLERS = new Set([
        "yeah", "yes", "yep", "yup", "ok", "okay", "k", "mhm", "mm", "mmhm",
        "uh huh", "uhhuh", "uh-huh", "huh", "hmm", "hm", "right", "sure",
        "oh", "ah", "alright", "hello", "hi", "hey",
      ]);
      if (SHORT_FILLERS.has(newNorm) || newNorm.length < 4) {
        logger.info({ callControlId, newText: newNorm }, "Short filler during LLM generation — letting in-flight reply finish");
        return;
      }
      const ctrl = inflightLlmAbort.get(callControlId);
      if (ctrl) {
        llmRestartFlag.add(callControlId);
        try { ctrl.abort(); } catch { /* already done */ }
        logger.info({ callControlId }, "Aborting in-flight LLM — caller spoke again, restarting with fresher text");
      }
    }
    return;
  }
  processingTurn.add(callControlId); // lock this call for the duration of the turn

  try {
    await _handleCallerTurnInner(callControlId, callerText);
  } finally {
    processingTurn.delete(callControlId); // always release the lock
    inflightLlmAbort.delete(callControlId);
  }

  // If caller speech arrived during this turn (buffered) AND nothing is
  // currently playing, immediately replay it as a fresh turn. This handles
  // both the "LLM-aborted-by-barge-in" case and any other race where the
  // playback.ended replay path didn't fire (e.g. LLM aborted before TTS).
  if (!aiSpeaking.has(callControlId)) {
    const missed = missedTranscription.get(callControlId);
    if (missed) {
      missedTranscription.delete(callControlId);
      logger.info({ callControlId, missed: missed.slice(0, 80) }, "Replaying buffered caller speech (post-turn)");
      handleCallerTurn(callControlId, missed).catch((err) =>
        logger.error({ err: String(err), callControlId }, "handleCallerTurn (post-turn replay) error"),
      );
    }
  }
}

async function _handleCallerTurnInner(callControlId: string, callerText: string): Promise<void> {
  // ── Cancel the initial silence timer the moment caller speaks ────────────
  if (awaitingFirstResponse.has(callControlId)) {
    awaitingFirstResponse.delete(callControlId);
    const t = initialSilenceTimer.get(callControlId);
    if (t) { clearTimeout(t); initialSilenceTimer.delete(callControlId); }
    logger.info({ callControlId }, "Initial silence timer cleared — caller responded");
  }

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

  // ── Backchannel filter (Vapi-style) ──────────────────────────────────────
  // Short acknowledgement words like "yeah", "uh huh", "ok", "right" are NOT
  // real interruptions — they're the listener confirming they're following.
  // If the AI is currently speaking and we hear one of these, ignore it
  // entirely so the AI doesn't get cut off by polite agreement.
  const BACKCHANNELS = new Set([
    "yeah", "yes", "yep", "yup", "ok", "okay", "k", "mhm", "mm", "mmhm",
    "uh huh", "uhhuh", "uh-huh", "huh", "hmm", "hm", "right", "sure",
    "so", "well", "and", "but", "oh", "ah", "ha", "alright", "got it",
    "gotcha", "i see", "i hear you", "for sure", "true", "exactly",
    // Pickup greetings — caller's natural "hello/hi" when answering the phone.
    // These add no information to the conversation and must NEVER trigger a
    // fresh LLM turn (which would just produce a redundant "Hi, this is Alex…"
    // response on top of the greeting that already played).
    "hello", "hi", "hey", "yo", "hiya", "hellooo", "hii",
  ]);
  const normalized = clean.toLowerCase().replace(/[.,!?]+$/g, "").trim();
  if (aiSpeaking.has(callControlId) && BACKCHANNELS.has(normalized)) {
    logger.info({ callControlId, callerText: clean }, "Backchannel during AI speech — ignoring (not a real interruption)");
    return;
  }
  // ── Discard pickup-greeting buffer after our greeting ends ───────────────
  // If the only thing the caller said during our opening greeting was a pure
  // "hello"-type acknowledgement (NOT a confirmation like "yes"/"ok"), do not
  // replay it as a turn. Our greeting already opened with an identity question
  // — responding to "hello" would just produce a duplicate intro and waste 3 s
  // of LLM time, during which the caller hears dead air and starts talking
  // again, which then aborts/restarts the LLM and creates the 7-second silence
  // that callers complained about.
  // IMPORTANT: keep this set NARROW — it must NEVER include "yes"/"ok"/"sure"
  // because those are valid answers to "Am I speaking with <name>?".
  const PICKUP_GREETINGS_ONLY = new Set([
    "hello", "hi", "hey", "yo", "hiya", "hellooo", "hii", "hallo", "halo",
  ]);
  const isFirstCallerTurn = bridge.transcript.filter(t => t.startsWith("Caller:")).length === 0;
  if (PICKUP_GREETINGS_ONLY.has(normalized) && isFirstCallerTurn) {
    logger.info({ callControlId, callerText: clean }, "Pickup-greeting only — discarding (no LLM turn needed)");
    bridge.transcript.push(`Caller: ${clean}`);
    return;
  }

  // Caller interrupted AI — stop playback immediately (barge-in) and queue for replay
  if (aiSpeaking.has(callControlId)) {
    // EXCEPTION: the very first greeting must finish cleanly. If the caller's
    // "Hello?" or background noise comes in during the opening, just buffer it
    // — do NOT stop playback. The lock clears on the first call.playback.ended.
    if (greetingInProgress.has(callControlId)) {
      const prev = missedTranscription.get(callControlId) ?? "";
      if (clean.length > prev.trim().length) {
        missedTranscription.set(callControlId, clean);
      }
      logger.info({ callControlId, callerText }, "Caller spoke during greeting — buffering, NOT interrupting opening");
      return;
    }
    const prev = missedTranscription.get(callControlId) ?? "";
    if (clean.length > prev.trim().length) {
      missedTranscription.set(callControlId, clean);
    }
    // Send playback_stop so Telnyx fires call.playback.ended, which will
    // clear aiSpeaking and replay this buffered caller speech immediately.
    telnyxAction(callControlId, "playback_stop", {}).catch(() => {});
    logger.info({ callControlId, callerText }, "Caller barge-in — AI audio stopped, queued for replay");
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

  // After MAX_TURNS force the AI to wrap up — inject override BEFORE building messagesForLLM
  if (turnCount >= MAX_TURNS_BEFORE_CLOSE && bridge.transferNumber && !bridge.pendingTransfer) {
    history.push({
      role: "system",
      content: `[SYSTEM OVERRIDE — turn ${turnCount}]: You have completed the script. Wrap up in ONE sentence that references something positive from the call, then IMMEDIATELY say: "Let me get one of our team members on the line for you — one moment!" — nothing else after that.`,
    });
    logger.info({ callControlId, turnCount }, "MAX_TURNS reached — injecting forced transfer instruction");
  }

  // Always pin the system message at index 0 so it never falls off the slice window.
  // Without this, after ~7 turns history.slice(-14) drops the system prompt and the
  // AI loses all its instructions — causing repetition and off-script behaviour.
  const systemMsg   = history[0]!;
  const turns       = history.slice(1);                // everything after system message
  const recentTurns = turns.slice(-13);                // keep last 13 user/assistant turns
  const messagesForLLM = [systemMsg, ...recentTurns];  // system always first

  // GPT completion — system message is always pinned, repetition penalties applied.
  // On ANY failure (timeout, 5xx, empty response) we speak a calm filler line
  // so the caller never hears dead air. Hard-cap the request at 8 s so a slow
  // OpenAI doesn't leave the call hanging silently.
  let aiText: string;
  const llmAbort = new AbortController();
  inflightLlmAbort.set(callControlId, llmAbort);
  const llmTimer = setTimeout(() => llmAbort.abort(), 8000);
  try {
    const completion = await openai.chat.completions.create({
      model: AI_MODEL,
      // Keep replies short and conversational. 90 tokens ≈ 1-2 sentences,
      // ~6-10 seconds of TTS — short enough that the caller doesn't want to
      // interrupt, long enough to convey one clear point. Previously 160
      // produced 30-60 second monologues that callers barged in on repeatedly.
      max_tokens: 90,
      temperature: 0.75,
      frequency_penalty: 0.7,
      presence_penalty: 0.5,
      messages: messagesForLLM as Parameters<typeof openai.chat.completions.create>[0]["messages"],
    }, { signal: llmAbort.signal });
    clearTimeout(llmTimer);
    // If the caller barged in mid-generation we set llmRestartFlag and
    // aborted; bail out cleanly so the wrapper can replay the buffered text.
    if (llmRestartFlag.has(callControlId)) {
      llmRestartFlag.delete(callControlId);
      logger.info({ callControlId }, "LLM completed but restart was requested — discarding stale response");
      return;
    }
    aiText = stripMarkdownForTTS((completion.choices[0]?.message?.content ?? "").trim());
    logger.info({ callControlId, aiText: aiText.slice(0, 80) }, "OpenAI response received");
  } catch (err) {
    clearTimeout(llmTimer);
    // Intentional abort triggered by a fresher caller barge-in: don't speak
    // calm filler — exit cleanly so the wrapper replays the buffered text.
    if (llmRestartFlag.has(callControlId)) {
      llmRestartFlag.delete(callControlId);
      logger.info({ callControlId }, "LLM aborted by barge-in — wrapper will replay newer caller text");
      return;
    }
    const detail = axios.isAxiosError(err) && err.response
      ? JSON.stringify(err.response.data).slice(0, 400)
      : String(err);
    logger.error({ callControlId, detail }, "OpenAI completion failed — using calm filler");
    aiText = pickCalmFiller();
  }

  if (!aiText) {
    logger.warn({ callControlId }, "OpenAI returned empty response — using calm filler");
    aiText = pickCalmFiller();
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

  // ── Detect "polite goodbye" — auto-hangup after the line finishes playing ──
  // The AI is taught to end its turn with a short, warm sign-off when the
  // caller has clearly declined twice or asked to be removed. We catch those
  // phrases and queue a hangup that fires once playback completes.
  const HANGUP_TRIGGERS = [
    "have a wonderful day",
    "have a great day",
    "have a good day",
    "have a good one",
    "have a wonderful one",
    "take care",
    "you too — bye",
    "wish you the best",
    "take you off the list",
    "won't bother you again",
    "won't keep you any longer",
    "sorry to have bothered",
    "appreciate your time",  // common closer
    "thank you so much for your time",
  ];
  const aiLowerForHangup = aiText.toLowerCase();
  const wantsHangup =
    !bridge.pendingTransfer &&
    HANGUP_TRIGGERS.some((p) => aiLowerForHangup.includes(p));

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

  // If the AI is wrapping up, queue a polite hangup that fires after playback.
  if (wantsHangup) {
    pendingHangupAfterPlay.add(callControlId);
    logger.info({ callControlId, aiText: aiText.slice(0, 80) }, "Polite goodbye detected — will hang up after playback");
  }

  // Generate TTS (multi-provider with fallback) and play via playback_start.
  // If both TTS providers fail, fall back to Telnyx's native speak so the
  // caller still hears words instead of awkward silence.
  aiSpeaking.add(callControlId);
  try {
    const audioUrl = await generateTTSWithFallback(aiText, bridge.voiceId, (bridge.voiceProvider ?? "elevenlabs") as VoiceProvider);
    await playWithFallback(callControlId, audioUrl, aiText);
    logger.info({ callControlId, aiText: aiText.slice(0, 80) }, "AI response playing");
  } catch (err) {
    const detail = axios.isAxiosError(err) && err.response
      ? JSON.stringify(err.response.data).slice(0, 400)
      : String(err);
    logger.error({ callControlId, detail }, "TTS providers all failed — falling back to Telnyx native speak");
    try {
      await telnyxAction(callControlId, "speak", {
        payload: aiText,
        payload_type: "text",
        voice: "female",
        language: "en-US",
      });
    } catch (speakErr) {
      aiSpeaking.delete(callControlId);
      logger.error({ callControlId, err: String(speakErr) }, "Telnyx native speak fallback also failed — caller will hear silence");
    }
  }
}

/** Calm, polite filler lines used when OpenAI fails or returns empty.
 *  Keeps the caller engaged while the next turn recovers. */
const CALM_FILLERS = [
  "Sorry — could you say that again? I didn't quite catch it.",
  "Hmm, give me just a second.",
  "Apologies — would you mind repeating that?",
  "Sorry, I missed that last bit — could you say it once more?",
];
function pickCalmFiller(): string {
  return CALM_FILLERS[Math.floor(Math.random() * CALM_FILLERS.length)]!;
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

  // Step 1 — Play hold music directly to the caller's leg (callControlId) BEFORE
  // issuing the transfer.  Telnyx's transfer `audio_url` field plays to the NEW
  // outbound leg (the human agent being rung), NOT to the waiting caller, so we
  // must use playback_start on the original leg explicitly.
  try {
    await telnyxAction(callControlId, "playback_start", {
      audio_url: musicUrl,
      loop: true,
      target_legs: "self",
    });
    logger.info({ callControlId, musicUrl }, "Hold music started on caller leg");
  } catch (err) {
    // Non-fatal — caller may still hear silence during transfer, but don't abort
    logger.warn({ callControlId, err: String(err) }, "playback_start for hold music failed — proceeding with transfer anyway");
  }

  // Step 2 — Issue the transfer. No audio_url here so the human agent hears
  // normal ringing, not hold music.
  await axios.post(
    `${TELNYX_API_BASE}/calls/${callControlId}/actions/transfer`,
    {
      to: toNumber,
      from: fromNumber,
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

  logger.info({ callControlId, to: toNumber }, "Telnyx transfer initiated — hold music active on caller, ringing human agent");

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

  // Default to a real human-sounding name so the inbound greeting doesn't sound like a robot.
  let agentName = pickDefaultHumanName();
  let agentPrompt: string = campaign.agentPrompt ?? "";
  let resolvedVoiceId: string = DEFAULT_ELEVEN_VOICE;
  let resolvedVoiceProvider: string = campaign.voiceProvider ?? "elevenlabs";
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
        if (voice?.voiceId) {
          resolvedVoiceId = voice.voiceId;
          resolvedVoiceProvider = voice.provider;
        }
      }
    }
  }

  if (campaign.voice && campaign.voice !== "default") {
    resolvedVoiceId = campaign.voice;
    resolvedVoiceProvider = campaign.voiceProvider ?? resolvedVoiceProvider;
  }

  const systemPrompt = buildSystemPrompt(
    agentPrompt,
    campaign.name,
    agentName,
    undefined,
    campaign.transferNumber ?? undefined,
    humanLikeMode,
    "inbound",                                             // ← inbound-specific prompt
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

  return {
    campaign,
    agentName,
    systemPrompt,
    voiceId: resolvedVoiceId,
    voiceProvider: resolvedVoiceProvider,
    holdMusicUrl,
    effectiveTransferNumber,
    // Pass through campaign-level audio enhancements so inbound calls match outbound quality
    backgroundSound: (campaign.backgroundSound && campaign.backgroundSound !== "none") ? campaign.backgroundSound : null,
    humanLikeMode,
  };
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

      // ── Human detected: cancel deferred-greet timer and start the conversation ──
      // Telnyx Premium AMD returns granular results: "human", "human_residence",
      // "human_business" — all of these are humans. Match the prefix, not just
      // the literal "human" (the previous strict check missed _residence and
      // _business, leaving the AI silent for 5+ seconds until the caller spoke).
      if (result.startsWith("human")) {
        const t = pendingAmdGreet.get(callControlId);
        if (t) {
          clearTimeout(t);
          pendingAmdGreet.delete(callControlId);
          logger.info({ callControlId, result }, "AMD confirmed human — starting transcription + greeting");
          await startTranscriptionAndGreet(callControlId).catch((err) =>
            logger.error({ err: String(err), callControlId }, "AMD-gated greet failed")
          );
        }
        return;
      }

      if (
        result === "machine_start" ||
        result === "machine_end_beep" ||
        result === "machine_end_silence"
      ) {
        // Cancel any pending deferred-greet so we don't accidentally start AI
        // mid-VM-drop or after we've decided to hang up.
        const t = pendingAmdGreet.get(callControlId);
        if (t) { clearTimeout(t); pendingAmdGreet.delete(callControlId); }
        const bridge = getBridgeInfo(callControlId);

        // Voicemail drop: on beep, leave a TTS message — campaign-specific or default template.
        if (result === "machine_end_beep" && bridge?.campaignId) {
          const [camp] = await db
            .select({ vmDropMessage: campaignsTable.vmDropMessage, voice: campaignsTable.voice })
            .from(campaignsTable)
            .where(eq(campaignsTable.id, bridge.campaignId));

          // Use the configured message if present; otherwise build a sensible default
          // using the campaign + agent name so every voicemail still gets a polite drop.
          const defaultVm =
            `Hi, this is ${bridge.agentName ?? "your agent"} calling from ${bridge.campaignName ?? "our team"}. ` +
            `I tried to reach you to check in on your requirements. ` +
            `If there's anything you need, please give us a call back whenever you're available. Thank you.`;
          const vmMessage = (camp?.vmDropMessage && camp.vmDropMessage.trim()) || defaultVm;

          logger.info({ callControlId, campaignId: bridge.campaignId, custom: !!camp?.vmDropMessage }, "AMD: voicemail beep — leaving VM drop message");
          try {
            const voiceId = bridge.voiceId ?? DEFAULT_ELEVEN_VOICE;
            const audioUrl = await generateTTSWithFallback(vmMessage, voiceId, (bridge.voiceProvider ?? "elevenlabs") as VoiceProvider);
            await telnyxAction(callControlId, "playback_start", {
              audio_url: audioUrl,
              overlay: false,
              stop_condition: "detecting_silence",
            });
            // Hang up after playback — handled by playback.ended event
            pendingVmDropHangup.add(callControlId);
            bridge.transcript.push(`AI Agent (VM Drop): ${vmMessage}`);
            logger.info({ callControlId }, "VM drop message playing — will hang up on playback.ended");
            return; // Don't hang up immediately; let playback.ended do it
          } catch (err) {
            logger.warn({ err: String(err), callControlId }, "VM drop TTS failed — falling back to hangup");
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
        logger.info({ callControlId, originalCallControlId }, "Conference leg (supervisor) answered — tearing down AI bridge and bridging legs");
        // Tear down the AI bridge on the original call so the AI does not
        // continue to listen / respond once a human supervisor joins.
        try { closeCustomBridge(originalCallControlId); } catch { /* not active */ }
        try { closeBridge(originalCallControlId); } catch { /* not active */ }
        try {
          await telnyxAction(originalCallControlId, "transcription_stop", {}).catch(() => {});
          await telnyxAction(callControlId, "bridge", { call_control_id: originalCallControlId });
          logger.info({ callControlId, originalCallControlId }, "Conference bridge executed (AI silenced)");
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

      // First message — warm, natural opening that confirms identity before the pitch.
      // With a lead name we ask for them by first name. Without a name we keep
      // it generic and friendly — just "Hi this is <agent> from <campaign>,
      // how are you today?" — and let the rest of the script confirm identity.
      // Defensive against empty/blank campaign name — must not produce
      // "Hi, this is Riya calling from . How are you today?" (literal blank).
      const fromPart = (outboundCtx.campaignName ?? "").trim()
        ? ` calling from ${outboundCtx.campaignName.trim()}`
        : "";
      const firstMessage = firstName
        ? `Hi, this is ${agentName}${fromPart}. Am I speaking with ${firstName}?`
        : `Hi, this is ${agentName}${fromPart}. How are you today?`;

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
        // accent + region resolved later from campaign row (set after initBridge below)
        voiceId: callVoiceId,
        systemPrompt,
        firstMessage,
        onTransferRequested: async (transferTo) => {
          try {
            const bridge = getBridgeInfo(callControlId);
            // Stop STT and ALL active playback before transferring so no audio bleeds through
            await Promise.allSettled([
              telnyxAction(callControlId, "transcription_stop", {}),
              telnyxAction(callControlId, "playback_stop", {}),
            ]);
            backgroundSoundActive.delete(callControlId);
            await executeTransfer(callControlId, transferTo, fromNumber, bridge?.holdMusicUrl);
            logger.info({ callControlId, transferTo }, "Outbound transfer executed — hold music active for caller");
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

      // Resolve campaign accent/region for accent tuning + geo behavior (failsafe)
      try {
        const [campaignRow] = await db
          .select({ accent: campaignsTable.accent, region: campaignsTable.region })
          .from(campaignsTable)
          .where(eq(campaignsTable.id, campaignId))
          .limit(1);
        if (campaignRow) {
          const bridgeInfo = getBridgeInfo(callControlId);
          if (bridgeInfo) {
            bridgeInfo.accent = campaignRow.accent ?? undefined;
            bridgeInfo.region = campaignRow.region ?? undefined;
          }
        }
      } catch (err) {
        logger.warn({ err: String(err), callControlId }, "Failed to resolve campaign accent/region — continuing with neutral defaults");
      }

      await startRecording(callControlId).catch((err) =>
        logger.warn({ err: String(err), callControlId }, "Recording start failed — continuing")
      );

      // ── Start transcription IMMEDIATELY so we can detect the caller's "Hello" ──
      // We don't wait for AMD to start STT — listening early lets us treat any
      // caller speech as proof-of-human and fire the greeting instantly,
      // skipping the 1-4 second AMD analysis lag. AMD result is still used
      // as the primary trigger; speech-trigger is the fast path.
      startTranscriptionEarly(callControlId).catch(() => { /* logged inside */ });

      // ── Defer greeting until AMD confirms a real human OR caller speaks ──────
      // Telnyx fires `call.machine.premium.detection.ended` 1-4s after answer.
      // The greeting is deferred until EITHER:
      //   (a) AMD returns "human"          — primary path (also handles silence)
      //   (b) the caller says ANYTHING     — fast path; their voice = proof-of-human
      //   (c) 2s safety-net fallback fires — if neither AMD nor caller speak,
      //       AI proactively kicks off the script ("Hi this is Alex calling
      //       from …") instead of leaving dead air. User-requested behaviour.
      // This guarantees the AI never speaks into a voicemail beep or before the
      // callee is actually listening, but also that the AI starts talking the
      // moment the human says "Hello" rather than after AMD's analysis pause.
      const fallback = setTimeout(() => {
        if (!pendingAmdGreet.has(callControlId)) return;
        pendingAmdGreet.delete(callControlId);
        logger.warn({ callControlId }, "AMD timeout (2s) — starting greeting without AMD result");
        startTranscriptionAndGreet(callControlId).catch((err) =>
          logger.error({ err: String(err), callControlId }, "Fallback greet failed")
        );
      }, 2_000);
      pendingAmdGreet.set(callControlId, fallback);

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
      // CRITICAL: Telnyx tears the call down within ~250ms if we don't answer
      // fast enough. Fire `answer` IMMEDIATELY in parallel with the DB lookup
      // AND the spam check so we never lose calls to a slow lookup.
      const answerPromise = answerCall(callControlId);
      const lookupPromise = getCampaignByNumber(toNumber);
      // Spam/DNC check on the CALLER (fromNumber) — runs in parallel with answer.
      // If blocked, we still answered (already mid-air), then hang up cleanly.
      const { getSpamProfile } = await import("../services/spamCheck.js");
      const spamPromise = getSpamProfile(fromNumber).catch(() => null);

      const [answered, result, spamProfile] = await Promise.all([answerPromise, lookupPromise, spamPromise]);

      if (!answered) {
        logger.info({ callControlId, toNumber, fromNumber }, "Inbound call torn down before we could answer — aborting");
        return;
      }

      // Block known spammers / DNC entries — hang up before any TTS plays
      if (spamProfile?.blocked) {
        logger.warn(
          { callControlId, fromNumber, toNumber, spamScore: spamProfile.spamScore, reason: spamProfile.reason, lineType: spamProfile.lineType },
          "Inbound call BLOCKED — spam/DNC match",
        );
        try {
          await telnyxAction(callControlId, "hangup", {});
        } catch (err) {
          logger.warn({ err: String(err), callControlId }, "Inbound block-hangup failed");
        }
        return;
      }

      if (!result) {
        logger.info({ toNumber, fromNumber }, "Inbound call but no campaign mapped to this number — playing fallback message");
        await speak(
          callControlId,
          "Thank you for calling. We are unable to connect your call at this time. Goodbye."
        );
        return;
      }

      const {
        campaign,
        agentName,
        systemPrompt,
        voiceId: inboundVoiceId,
        voiceProvider: inboundVoiceProvider,
        holdMusicUrl: inboundHoldMusicUrl,
        effectiveTransferNumber,
        backgroundSound: inboundBackgroundSound,
      } = result;
      const fromName = (campaign.name ?? "").trim();
      const firstMessage = fromName
        ? `Thank you for calling ${fromName}, this is ${agentName}. How may I help you today?`
        : `Hi, this is ${agentName}. How may I help you today?`;

      logger.info(
        { callControlId, campaignId: campaign.id, agentName, voiceId: inboundVoiceId, effectiveTransferNumber },
        "Inbound call — starting ElevenLabs ConvAI bridge"
      );

      // Register bridge state before answering — mirror EVERY outbound feature
      // so inbound conversation quality, recording, and ambient audio match.
      initBridge(callControlId, {
        campaignId: campaign.id,
        campaignName: campaign.name,
        agentName,
        callerNumber: fromNumber,
        direction: "inbound",
        startedAt: new Date(),
        transferNumber: effectiveTransferNumber ?? undefined,  // per-number override > campaign default
        holdMusicUrl: inboundHoldMusicUrl,
        backgroundSound: inboundBackgroundSound ?? undefined,  // ← parity with outbound: ambient office noise / etc.
        voiceProvider: inboundVoiceProvider ?? campaign.voiceProvider ?? "elevenlabs",
        accent: campaign.accent ?? undefined,
        region: campaign.region ?? undefined,
        voiceId: inboundVoiceId,
        systemPrompt,
        firstMessage,
        onTransferRequested: async (transferTo) => {
          try {
            const bridge = getBridgeInfo(callControlId);
            // Stop STT and ALL active playback before transferring so no audio bleeds through
            await Promise.allSettled([
              telnyxAction(callControlId, "transcription_stop", {}),
              telnyxAction(callControlId, "playback_stop", {}),
            ]);
            backgroundSoundActive.delete(callControlId);
            await executeTransfer(callControlId, transferTo, toNumber, bridge?.holdMusicUrl);
            logger.info({ callControlId, transferTo }, "Inbound transfer executed — hold music active for caller");
          } catch (err) {
            logger.error({ err: String(err), callControlId }, "Inbound transfer failed in bridge callback");
          }
        },
        onCallEnded: () => {
          logger.info({ callControlId }, "ElevenLabs ended inbound call — hanging up Telnyx");
          telnyxAction(callControlId, "hangup", {}).catch(() => {});
        },
      });

      // Call was already answered above (in parallel with the lookup). Now
      // store the campaign number and wait for the call.answered webhook before
      // starting transcription + greeting.
      callOwnNumber.set(callControlId, toNumber);
      pendingInboundGreet.add(callControlId);

      // ── Recording parity with outbound — start as soon as we have the answer.
      // Outbound starts recording at line 1240 right after initBridge. Inbound
      // had no recording at all, which broke QA, playback, and dispute review.
      startRecording(callControlId).catch((err) =>
        logger.warn({ err: String(err), callControlId }, "Inbound recording start failed — continuing")
      );
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
      logger.info({ callControlId, to: toNumber, from: fromNumber }, "Call bridged — stopping any residual audio then handing off");
      // Stop any audio still playing on the original leg (hold music from transfer action,
      // background overlays, etc.) so neither party hears looping audio through the bridge.
      telnyxAction(callControlId, "playback_stop", {}).catch(() => {});
      return;
    }

    // ── 3. Recording saved ────────────────────────────────────────────────────
    if (eventType === "call.recording.saved") {
      const recordingUrl: string =
        payload.recording_urls?.mp3 ?? payload.public_recording_urls?.mp3 ?? "";
      // Telnyx supplies a stable recording_id we can use to fetch a fresh
      // signed URL on demand (the URLs above expire in 10 min).
      const recordingId: string | null =
        payload.recording_id ?? payload.id ?? null;
      logger.info({ callControlId, recordingUrl, recordingId }, "Recording saved");

      if (recordingUrl || recordingId) {
        if (recordingUrl) setRecordingUrl(callControlId, recordingUrl);

        const [existing] = await db
          .select({ id: callLogsTable.id })
          .from(callLogsTable)
          .where(eq(callLogsTable.callControlId, callControlId))
          .limit(1);

        if (existing) {
          await db
            .update(callLogsTable)
            .set({
              ...(recordingUrl ? { recordingUrl } : {}),
              ...(recordingId ? { recordingId } : {}),
            })
            .where(eq(callLogsTable.id, existing.id));
          logger.info({ callControlId, recordingId }, "Recording URL + id saved to DB");
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

      // ── VM DETECTION FALLBACK (Vapi-style) ──────────────────────────────────
      // Telnyx AMD misses ~10-20% of voicemails (especially modern carrier VMs).
      // Catch them here by scanning transcription for unmistakable VM phrases.
      // If we haven't greeted yet (greetStarted flag), it's safe to drop a VM
      // message rather than launching into a sales pitch on someone's machine.
      if (!greetStarted.has(callControlId)) {
        const tLow = transcript.toLowerCase();
        const VM_PATTERNS = [
          /leave (a |your )?(message|name|number)/,
          /after (the |a )?(beep|tone)/,
          /at the tone/,
          /please record/,
          /not available (right now|to take|to answer)/,
          /(can'?t|cannot) (come to|answer|take)/,
          /your call has been forwarded/,
          /voice ?mail/,
          /press (1|one|pound|the pound key) (to|for)/,
          /reached the voicemail/,
          /is unavailable/,
          /please (try (your call )?again|hang up)/,
          /the (person|number|subscriber) you (have |are )?(dialed|called|trying)/,
          /no longer in service/,
          /thank you for calling.{0,40}(please|leave|hold)/,
        ];
        if (VM_PATTERNS.some((re) => re.test(tLow))) {
          logger.info({ callControlId, transcript: transcript.slice(0, 120) }, "VM detected via transcription — switching to VM drop flow");
          // Cancel any pending greet; mark greeted so the fast-path doesn't re-fire
          const tmr = pendingAmdGreet.get(callControlId);
          if (tmr) { clearTimeout(tmr); pendingAmdGreet.delete(callControlId); }
          greetStarted.add(callControlId);

          const bridge = getBridgeInfo(callControlId);
          if (bridge?.campaignId) {
            const [camp] = await db
              .select({ vmDropMessage: campaignsTable.vmDropMessage })
              .from(campaignsTable)
              .where(eq(campaignsTable.id, bridge.campaignId));
            const defaultVm =
              `Hi, this is ${bridge.agentName ?? "your agent"} calling from ${bridge.campaignName ?? "our team"}. ` +
              `I tried to reach you to check in on your requirements. ` +
              `If there's anything you need, please give us a call back whenever you're available. Thank you.`;
            const vmMessage = (camp?.vmDropMessage && camp.vmDropMessage.trim()) || defaultVm;
            try {
              const voiceId = bridge.voiceId ?? DEFAULT_ELEVEN_VOICE;
              const audioUrl = await generateTTSWithFallback(vmMessage, voiceId, (bridge.voiceProvider ?? "elevenlabs") as VoiceProvider);
              // Wait ~1.5s so we land after the VM beep (heuristic — beep usually within 1-2s of VM phrase)
              setTimeout(async () => {
                try {
                  await telnyxAction(callControlId, "playback_start", {
                    audio_url: audioUrl,
                    overlay: false,
                    stop_condition: "detecting_silence",
                  });
                  pendingVmDropHangup.add(callControlId);
                  bridge.transcript.push(`AI Agent (VM Drop via transcription): ${vmMessage}`);
                  logger.info({ callControlId }, "VM drop (transcription path) playing — will hang up on playback.ended");
                } catch (e) {
                  logger.warn({ callControlId, err: String(e) }, "VM drop playback failed — hanging up");
                  try { await telnyxAction(callControlId, "hangup", {}); } catch { /* ignore */ }
                }
              }, 1500);
            } catch (err) {
              logger.warn({ err: String(err), callControlId }, "VM drop TTS failed — hanging up");
              try { await telnyxAction(callControlId, "hangup", {}); } catch { /* ignore */ }
            }
            return;
          }
          // No campaign context — just hang up
          try { await telnyxAction(callControlId, "hangup", {}); } catch { /* ignore */ }
          return;
        }
      }

      // ── FAST-PATH: caller spoke before AMD finished — fire greeting NOW ─────────
      // If we're still waiting for AMD to complete, the caller's voice is
      // definitive proof they're a human (voicemails don't say "Hello?" and
      // wait for a response). Cancel the AMD fallback timer and start the
      // greeting immediately. We DROP this transcript (it's just "Hello") so
      // the AI greets cleanly instead of trying to LLM-respond to "Hello".
      if (pendingAmdGreet.has(callControlId)) {
        const t = pendingAmdGreet.get(callControlId);
        if (t) clearTimeout(t);
        pendingAmdGreet.delete(callControlId);
        logger.info({ callControlId, transcript: transcript.slice(0, 60) }, "Caller spoke before AMD — firing greeting immediately (speech-trigger fast path)");
        startTranscriptionAndGreet(callControlId).catch((err) =>
          logger.error({ err: String(err), callControlId }, "Speech-triggered greet failed")
        );
        return;   // discard "Hello" — it's just the pickup signal, not a real turn
      }

      handleCallerTurn(callControlId, transcript).catch((err) =>
        logger.error({ err: String(err), callControlId }, "handleCallerTurn error")
      );
      return;
    }

    // ── 3b. Speak/playback ended — clear speaking flag & replay missed ────────
    if (eventType === "call.speak.ended" || eventType === "call.playback.ended") {
      // ── If this was a VM drop message, hang up now ──────────────────────────
      // CHECK FIRST — must run before the background-overlay early-return so a
      // pending VM drop hangup is never swallowed when overlay audio is active.
      if (pendingVmDropHangup.has(callControlId)) {
        pendingVmDropHangup.delete(callControlId);
        aiSpeaking.delete(callControlId);
        logger.info({ callControlId }, "VM drop message finished — hanging up");
        try { await telnyxAction(callControlId, "hangup", {}); } catch { /* already gone */ }
        return;
      }

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
      // Greeting just finished — caller may now barge-in normally on subsequent turns
      if (greetingInProgress.delete(callControlId)) {
        logger.info({ callControlId }, "Opening greeting finished — barge-in re-enabled");
      }

      // ── If a polite goodbye is pending, hang up now that TTS has finished ──
      if (pendingHangupAfterPlay.has(callControlId)) {
        pendingHangupAfterPlay.delete(callControlId);
        logger.info({ callControlId }, "Polite goodbye played — hanging up gracefully");
        // Small delay so the last word doesn't get clipped on the caller's end
        setTimeout(async () => {
          try { await telnyxAction(callControlId, "transcription_stop", {}); } catch { /* ignore */ }
          try { await telnyxAction(callControlId, "playback_stop", {}); } catch { /* ignore */ }
          try { await telnyxAction(callControlId, "hangup", {}); } catch { /* already gone */ }
        }, 600);
        return;
      }

      // ── If a transfer is pending, execute it now that TTS has finished ──────
      if (pendingTransferAfterPlay.has(callControlId)) {
        pendingTransferAfterPlay.delete(callControlId);
        const bridge = getBridgeInfo(callControlId);
        const ownNum = callOwnNumber.get(callControlId) ?? "";
        if (bridge?.transferNumber) {
          logger.info({ callControlId, to: bridge.transferNumber }, "TTS done — stopping STT + overlays then executing transfer");
          // 1. Stop transcription and ALL active playback (background sound, overlays)
          //    BEFORE the transfer so no audio bleeds into the bridged call.
          await Promise.allSettled([
            telnyxAction(callControlId, "transcription_stop", {}),
            telnyxAction(callControlId, "playback_stop", {}),
          ]);
          backgroundSoundActive.delete(callControlId);
          // 2. Execute Telnyx transfer (plays hold music to caller while ringing agent)
          executeTransfer(callControlId, bridge.transferNumber, ownNum, bridge.holdMusicUrl)
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

      // No bridge = call was never answered (no-answer, busy, carrier reject, etc.)
      // Update the initial call_log row that campaigns.ts created with callControlId.
      if (!bridge) {
        const hangupCause: string = payload.hangup_cause ?? "";
        const disposition =
          hangupCause === "USER_BUSY"        ? "busy"
          : hangupCause === "NO_ANSWER"      ? "no_answer"
          : hangupCause === "NORMAL_CLEARING" ? "no_answer"
          : hangupCause === "ORIGINATOR_CANCEL" ? "no_answer"
          : hangupCause                      ? `failed:${hangupCause.toLowerCase()}`
          : "no_answer";

        logger.info({ callControlId, hangupCause, disposition }, "Call hung up before answer — updating log");

        await db
          .update(callLogsTable)
          .set({ status: "completed", disposition })
          .where(eq(callLogsTable.callControlId, callControlId))
          .catch((err) => logger.warn({ err: String(err), callControlId }, "Failed to update unanswered call log"));

        // ── Mirror onto callsTable too — otherwise /calls/live keeps showing
        // these as "ringing/initiated" forever, polluting the live monitor with
        // ghost calls. Without this, every no-answer leaves a stale dashboard row.
        await db
          .update(callsTable)
          .set({ status: "completed", disposition: "no_answer", endedAt: new Date() })
          .where(eq(callsTable.externalCallId, callControlId))
          .catch((err) => logger.debug({ err: String(err), callControlId }, "callsTable no-answer mirror update skipped"));

        // Notify the dashboard so any stale row disappears immediately.
        emitToSupervisors("call:ended", {
          id: syntheticId(callControlId),
          callControlId,
          disposition,
          duration: 0,
        });

        // Release the Telnyx number from busy
        const ownNum = callOwnNumber.get(callControlId);
        if (ownNum) {
          await db
            .update(phoneNumbersTable)
            .set({ isBusy: false })
            .where(eq(phoneNumbersTable.phoneNumber, ownNum))
            .catch(() => {});
          callOwnNumber.delete(callControlId);
        }
        return;
      }

      // Clean up background sound tracking
      backgroundSoundActive.delete(callControlId);

      // Cancel any pending initial-silence timer (call ended before 30 s)
      awaitingFirstResponse.delete(callControlId);
      const _sTimer = initialSilenceTimer.get(callControlId);
      if (_sTimer) { clearTimeout(_sTimer); initialSilenceTimer.delete(callControlId); }

      const durationSecs = Math.round(
        (Date.now() - bridge.startedAt.getTime()) / 1000
      );
      const transcript = bridge.transcript.join("\n");

      const { summary, disposition } = await generateSummaryAndDisposition(
        transcript,
        bridge.campaignName
      );

      // ── Step 6: Call scoring (additive — never breaks the existing flow) ──
      let callScore: number | null = null;
      let callObjections: string | null = null;
      try {
        const { scoreCall } = await import("../services/callScorer.js");
        const result = scoreCall({ transcript, durationSecs, disposition });
        callScore = result.score;
        callObjections = JSON.stringify(result.objections);
        logger.info(
          { callControlId, score: result.score, objections: result.objections, breakdown: result.breakdown },
          "Call scored"
        );
      } catch (err) {
        logger.warn({ err: String(err), callControlId }, "Call scoring failed — continuing without score");
      }

      // ── Dominant emotion capture (additive — never breaks the flow) ──────
      let callEmotion: string | null = null;
      try {
        const { getSupervisorSnapshot } = await import("../services/customBridge.js");
        const { dominantEmotion } = await import("../services/emotionEngine.js");
        const snap = getSupervisorSnapshot(callControlId);
        if (snap) {
          callEmotion = dominantEmotion(snap.emotion);
          logger.info({ callControlId, emotion: callEmotion, health: snap.health }, "Call emotion captured");
        }
      } catch (err) {
        logger.warn({ err: String(err), callControlId }, "Emotion capture failed — continuing without emotion");
      }

      // Resolve the from-number used for this call
      const numberUsed = callOwnNumber.get(callControlId) ?? null;

      // Derive answerType from disposition
      const answerType = disposition === "vm" ? "voicemail"
        : disposition === "no_answer" ? "no_answer"
        : "human";

      if (bridge.direction === "outbound") {
        // Update the pre-existing log row created when the call was dispatched.
        // If no row exists yet (race condition), fall back to insert.
        const [updated] = await db
          .update(callLogsTable)
          .set({
            status: "completed",
            disposition,
            duration: durationSecs,
            recordingUrl: bridge.recordingUrl ?? null,
            transcript,
            summary,
            numberUsed,
            answerType,
            score: callScore,
            objections: callObjections,
            emotion: callEmotion,
            // predictedProb / predictedLabel were stamped at dial time; preserve them
          })
          .where(eq(callLogsTable.callControlId, callControlId))
          .returning()
          .catch(() => []);

        if (!updated) {
          // Fallback: no pre-existing row (e.g. manual/inbound dial) — insert fresh
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
            score: callScore,
            objections: callObjections,
            emotion: callEmotion,
            // predictedProb / predictedLabel were stamped at dial time; preserve them
          }).catch((err) =>
            logger.error({ err: String(err), callControlId }, "Failed to insert outbound call log fallback")
          );
        }

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

        // ── Schedule auto follow-up sequence (additive — failsafe) ───────
        try {
          const { scheduleAfterCall } = await import("../services/followUpEngine.js");
          await scheduleAfterCall({
            leadId: bridge.leadId ?? null,
            campaignId: bridge.campaignId,
            disposition,
            callSummary: summary,
            predictedLabel: null,
          });
        } catch (err) {
          logger.warn({ err: String(err), callControlId }, "Follow-up scheduling failed — continuing");
        }
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
          score: callScore,
          objections: callObjections,
            emotion: callEmotion,
            // predictedProb / predictedLabel were stamped at dial time; preserve them
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

      // ── Mirror finalization onto callsTable so per-agent stats include
      // duration + disposition for transferred calls. We match by externalCallId
      // (= callControlId). Best-effort — never fails the webhook.
      // Map free-form webhook dispositions onto the callsTable enum
      // (interested, not_interested, vm, no_answer, busy, connected, transferred, disconnected).
      const mapToCallsEnum = (d: string): "interested" | "not_interested" | "vm" | "no_answer" | "busy" | "connected" | "transferred" | "disconnected" | null => {
        const allowed = new Set(["interested", "not_interested", "vm", "no_answer", "busy", "connected", "transferred", "disconnected"]);
        if (allowed.has(d)) return d as "interested";
        // Common webhook outputs that need mapping
        if (d === "callback_requested" || d === "completed" || d === "successful") return "connected";
        if (d === "voicemail") return "vm";
        if (d === "failed" || d === "error") return "disconnected";
        return null; // unknown — skip the disposition column rather than throw
      };
      try {
        const mappedDisposition = mapToCallsEnum(disposition);
        await db
          .update(callsTable)
          .set({
            status: "completed",
            ...(mappedDisposition ? { disposition: mappedDisposition } : {}),
            duration: durationSecs,
            recordingUrl: bridge.recordingUrl ?? null,
            transcript,
            summary,
            endedAt: new Date(),
          })
          .where(eq(callsTable.externalCallId, callControlId));
      } catch (err) {
        logger.debug({ err: String(err), callControlId, disposition }, "callsTable mirror update skipped");
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

      // Post-call DNC + spam scoring for outbound numbers. Fire-and-forget so
      // the dnc_list page automatically populates a risk profile (line_type,
      // carrier, spam score, auto-block decision) for every number we dial.
      // Inbound calls are scored on the answer path; we skip them here.
      const calledNumberForScoring = bridge?.callerNumber;
      const wasOutbound = !!bridge && bridge.direction === "outbound";
      if (wasOutbound && calledNumberForScoring) {
        import("../services/spamCheck.js")
          .then(({ getSpamProfile }) => getSpamProfile(calledNumberForScoring))
          .then((p) => logger.info({ number: calledNumberForScoring, score: p.score, lineType: p.lineType }, "Post-call spam profile cached"))
          .catch((err) => logger.warn({ err: String(err), number: calledNumberForScoring }, "Post-call spam check failed"));
      }

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
      pendingHangupAfterPlay.delete(callControlId);
      objectionAttempts.delete(callControlId);
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
