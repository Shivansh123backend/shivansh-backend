/**
 * Voice Registry — centralised multi-provider TTS with fallback chain.
 *
 * Supported providers:  elevenlabs | deepgram | cartesia
 * Fallback order:       requested provider → ElevenLabs → OpenAI TTS
 *
 * Also owns the in-memory audio cache (shared with webhooks.ts via import).
 */

import axios from "axios";
import crypto from "node:crypto";
import { logger } from "../lib/logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type VoiceProvider = "elevenlabs" | "deepgram" | "cartesia";

export interface VoiceEntry {
  voice_id:    string;
  name:        string;
  gender:      "male" | "female";
  accent?:     string;
  language?:   string;
  description?: string;
}

export interface CachedAudio {
  data:        Buffer;
  contentType: string;
  expiresAt:   number;
}

// ── Audio Cache ───────────────────────────────────────────────────────────────

export const audioCache = new Map<string, CachedAudio>();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of audioCache) if (v.expiresAt < now) audioCache.delete(k);
}, 30_000);

export function makeAudioToken(): string {
  return crypto.randomBytes(8).toString("hex");
}

const BACKEND_WEBHOOK_URL =
  process.env.WEBHOOK_BASE_URL ?? "https://shivanshbackend.replit.app";

// ── Static Voice Catalog ──────────────────────────────────────────────────────

const ELEVENLABS_VOICES: VoiceEntry[] = [
  { voice_id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel",  gender: "female", accent: "us",  description: "Calm, natural" },
  { voice_id: "EXAVITQu4vr4xnSDxMaL", name: "Bella",   gender: "female", accent: "us",  description: "Expressive, warm" },
  { voice_id: "MF3mGyEYCl7XYWbV9V6O", name: "Elli",    gender: "female", accent: "us",  description: "Light, friendly" },
  { voice_id: "LcfcDJNUP1GQjkzn1xUU", name: "Emily",   gender: "female", accent: "us",  description: "Clear, professional" },
  { voice_id: "pNInz6obpgDQGcFmaJgB", name: "Adam",    gender: "male",   accent: "us",  description: "Deep, confident" },
  { voice_id: "TxGEqnHWrfWFTfGW9XjX", name: "Josh",    gender: "male",   accent: "us",  description: "Young, energetic" },
  { voice_id: "ErXwobaYiN019PkySvjV", name: "Antoni",  gender: "male",   accent: "us",  description: "Well-rounded" },
  { voice_id: "SOYHLrjzK2X1ezoPC6cr", name: "Harry",   gender: "male",   accent: "uk",  description: "Whispery, casual" },
];

const DEEPGRAM_VOICES: VoiceEntry[] = [
  { voice_id: "aura-asteria-en",  name: "Asteria",  gender: "female", accent: "us" },
  { voice_id: "aura-luna-en",     name: "Luna",     gender: "female", accent: "us" },
  { voice_id: "aura-stella-en",   name: "Stella",   gender: "female", accent: "us" },
  { voice_id: "aura-athena-en",   name: "Athena",   gender: "female", accent: "uk" },
  { voice_id: "aura-hera-en",     name: "Hera",     gender: "female", accent: "us" },
  { voice_id: "aura-orion-en",    name: "Orion",    gender: "male",   accent: "us" },
  { voice_id: "aura-arcas-en",    name: "Arcas",    gender: "male",   accent: "us" },
  { voice_id: "aura-perseus-en",  name: "Perseus",  gender: "male",   accent: "us" },
  { voice_id: "aura-helios-en",   name: "Helios",   gender: "male",   accent: "uk" },
  { voice_id: "aura-zeus-en",     name: "Zeus",     gender: "male",   accent: "us" },
];

const CARTESIA_VOICES: VoiceEntry[] = [
  // Female — US
  { voice_id: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4", name: "Skylar",   gender: "female", accent: "us", description: "Approachable, friendly guide" },
  { voice_id: "0ee8beaa-db49-4024-940d-c7ea09b590b3", name: "Morgan",   gender: "female", accent: "us", description: "Polished, professional" },
  { voice_id: "e07c00bc-4134-4eae-9ea4-1a55fb45746b", name: "Brooke",   gender: "female", accent: "us", description: "Confident, conversational" },
  { voice_id: "5f621418-ab01-4bf4-9a9d-73d66032234e", name: "Willow",   gender: "female", accent: "us", description: "Friendly, down-to-earth" },
  { voice_id: "e5a6cd18-d552-4192-9533-82a08cac8f23", name: "Patricia", gender: "female", accent: "us", description: "Energetic customer service" },
  // Female — UK
  { voice_id: "62ae83ad-4f6a-430b-af41-a9bede9286ca", name: "Gemma",    gender: "female", accent: "uk", description: "Confident, professional" },
  { voice_id: "2f251ac3-89a9-4a77-a452-704b474ccd01", name: "Lucy",     gender: "female", accent: "uk", description: "Reassuring, capable" },
  // Male — US
  { voice_id: "f24ae0b7-a3d2-4dd1-89df-959bdc4ab179", name: "Ross",     gender: "male",   accent: "us", description: "Steady, customer support" },
  { voice_id: "3e39e9a5-585c-4f5f-bac6-5e4905c51095", name: "Cole",     gender: "male",   accent: "us", description: "Articulate, approachable" },
  { voice_id: "d709a7e8-9495-4247-aef0-01b3207d11bf", name: "Donny",    gender: "male",   accent: "us", description: "Balanced, neutral" },
  { voice_id: "df872fcd-da17-4b01-a49f-a80d7aaee95e", name: "Cameron",  gender: "male",   accent: "us", description: "Laidback, conversational" },
  // Male — UK
  { voice_id: "df89f42f-f285-4613-adbf-14eedcec4c9e", name: "Harrison", gender: "male",   accent: "uk", description: "Crisp, professional" },
  { voice_id: "4bc3cb8c-adb9-4bb8-b5d5-cbbef950b991", name: "George",   gender: "male",   accent: "uk", description: "Steady, British" },
];

export const VOICE_CATALOG: Record<VoiceProvider, VoiceEntry[]> = {
  elevenlabs: ELEVENLABS_VOICES,
  deepgram:   DEEPGRAM_VOICES,
  cartesia:   CARTESIA_VOICES,
};

export function getCatalogVoices(provider?: VoiceProvider): Record<string, VoiceEntry[]> {
  if (provider) return { [provider]: VOICE_CATALOG[provider] };
  return { ...VOICE_CATALOG };
}

// ── Provider TTS implementations ──────────────────────────────────────────────

async function storeBuffer(buf: ArrayBuffer, contentType = "audio/mpeg"): Promise<string> {
  const token = makeAudioToken();
  audioCache.set(token, {
    data:        Buffer.from(buf),
    contentType,
    expiresAt:   Date.now() + 10 * 60_000,
  });
  return `${BACKEND_WEBHOOK_URL}/api/audio/${token}`;
}

/** ElevenLabs TTS */
async function ttsElevenLabs(voiceId: string, text: string): Promise<string> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not configured");

  const resp = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    { text, model_id: "eleven_turbo_v2", voice_settings: { stability: 0.5, similarity_boost: 0.75 } },
    {
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
      responseType: "arraybuffer",
      timeout: 18_000,
    }
  );

  return storeBuffer(resp.data as ArrayBuffer);
}

/** Deepgram Aura TTS */
async function ttsDeepgram(voiceId: string, text: string): Promise<string> {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error("DEEPGRAM_API_KEY not configured");

  const resp = await axios.post(
    `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(voiceId)}`,
    { text },
    {
      headers: { Authorization: `Token ${apiKey}`, "Content-Type": "application/json" },
      responseType: "arraybuffer",
      timeout: 10_000,
    }
  );

  return storeBuffer(resp.data as ArrayBuffer);
}

/** Cartesia TTS */
async function ttsCartesia(voiceId: string, text: string): Promise<string> {
  const apiKey = process.env.CARTESIA_API_KEY;
  if (!apiKey) throw new Error("CARTESIA_API_KEY not configured");

  const resp = await axios.post(
    "https://api.cartesia.ai/tts/bytes",
    {
      model_id: "sonic-2",
      voice:    { mode: "id", id: voiceId },
      transcript: text,
      output_format: { container: "mp3", encoding: "mp3", sample_rate: 44100 },
    },
    {
      headers: {
        "X-API-Key":        apiKey,
        "Cartesia-Version": "2024-06-10",
        "Content-Type":     "application/json",
      },
      responseType: "arraybuffer",
      timeout: 10_000,
    }
  );

  return storeBuffer(resp.data as ArrayBuffer);
}

/** OpenAI TTS — last-resort fallback */
async function ttsOpenAI(text: string): Promise<string> {
  const apiKey =
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OpenAI API key not configured");

  const resp = await axios.post(
    "https://api.openai.com/v1/audio/speech",
    { model: "tts-1", input: text, voice: "alloy", response_format: "mp3" },
    {
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      responseType: "arraybuffer",
      timeout: 12_000,
    }
  );

  return storeBuffer(resp.data as ArrayBuffer);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate TTS from a specific provider.
 * Throws on provider/network failure (caller decides how to handle).
 */
export async function generateTTSFromProvider(
  provider: VoiceProvider,
  voiceId:  string,
  text:     string
): Promise<string> {
  switch (provider) {
    case "elevenlabs": return ttsElevenLabs(voiceId, text);
    case "deepgram":   return ttsDeepgram(voiceId, text);
    case "cartesia":   return ttsCartesia(voiceId, text);
    default:           throw new Error(`Unknown provider: ${String(provider)}`);
  }
}

const DEFAULT_ELEVEN_VOICE = "21m00Tcm4TlvDq8ikWAM";

/**
 * Generate TTS with automatic fallback chain:
 *   1. Requested provider + voiceId
 *   2. ElevenLabs default voice (Rachel)
 *   3. OpenAI TTS (alloy)
 *
 * Throws only if all three stages fail — system should never be silent.
 */
export async function generateTTSWithFallback(
  text:     string,
  voiceId:  string    = DEFAULT_ELEVEN_VOICE,
  provider: VoiceProvider = "elevenlabs"
): Promise<string> {
  try {
    return await generateTTSFromProvider(provider, voiceId, text);
  } catch (err) {
    logger.warn({ err: String(err), provider, voiceId }, "Primary TTS failed — trying ElevenLabs");
  }

  if (provider !== "elevenlabs") {
    try {
      return await ttsElevenLabs(DEFAULT_ELEVEN_VOICE, text);
    } catch (err) {
      logger.warn({ err: String(err) }, "ElevenLabs fallback failed — trying OpenAI TTS");
    }
  }

  return ttsOpenAI(text);
}
