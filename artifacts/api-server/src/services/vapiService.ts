import axios, { AxiosError } from "axios";
import { logger } from "../lib/logger.js";
import { setActiveCall } from "../lib/redis.js";

// ─────────────────────────────────────────────────────────────────────────────
// Vapi outbound call service
//
// Routes outbound calls through Vapi (https://api.vapi.ai) instead of our
// custom Telnyx + LLM + TTS pipeline. Vapi handles STT, LLM, TTS, barge-in,
// endpointing, and backchannel internally — giving us air.ai-grade latency
// without us having to maintain the realtime audio bridge.
//
// We use *transient assistants*: every call sends the full assistant config
// inline (system prompt, voice, model, transcriber, firstMessage). No state
// is stored on Vapi's side — each campaign run is self-contained.
// ─────────────────────────────────────────────────────────────────────────────

const VAPI_API_BASE = "https://api.vapi.ai";
const VAPI_API_KEY = process.env.VAPI_API_KEY;
const VAPI_PHONE_NUMBER_ID = process.env.VAPI_PHONE_NUMBER_ID; // ID of a phone number registered in Vapi (BYO Telnyx or Vapi-provided)
const BACKEND_WEBHOOK_URL =
  process.env.WEBHOOK_BASE_URL ?? "https://api.shivanshagent.cloudisoft.com";

export interface VapiCallPayload {
  phone: string;            // E.164 destination
  agent_prompt: string;     // System prompt for the LLM (your script + KB)
  voice: string;            // Voice ID (provider-specific)
  voice_provider?: string;  // "elevenlabs" | "cartesia" | "deepgram" | "playht" | "openai"
  campaign_id: string;
  campaign_name?: string;
  transfer_number?: string;
  first_message?: string;   // Optional opening line (bot speaks first)
  lead_id?: string;
  lead_name?: string;
  knowledge_base?: string;  // Optional KB injected into system prompt
}

export interface VapiCallResult {
  success: boolean;
  data?: unknown;
  error?: string;
  callControlId?: string;   // Vapi call ID
}

// Map our internal voice provider names to Vapi's provider names
function mapVoiceProvider(provider?: string): string {
  const p = (provider ?? "elevenlabs").toLowerCase();
  if (p === "elevenlabs") return "11labs";
  if (p === "cartesia") return "cartesia";
  if (p === "deepgram") return "deepgram";
  if (p === "playht") return "playht";
  if (p === "openai") return "openai";
  return "11labs"; // safe default
}

// Build the inline assistant config sent with each call
function buildAssistant(payload: VapiCallPayload) {
  const voiceProvider = mapVoiceProvider(payload.voice_provider);
  const systemPrompt = payload.knowledge_base
    ? `${payload.agent_prompt}\n\n--- KNOWLEDGE BASE (use this as your source of truth) ---\n${payload.knowledge_base}`
    : payload.agent_prompt;

  const firstMessage =
    payload.first_message ??
    `Hi${payload.lead_name ? `, am I speaking with ${payload.lead_name}` : " there"}?`;

  return {
    model: {
      provider: "openai",
      model: "gpt-4o-mini",
      temperature: 0.7,
      messages: [{ role: "system", content: systemPrompt }],
    },
    voice: {
      provider: voiceProvider,
      voiceId: payload.voice,
    },
    transcriber: {
      provider: "deepgram",
      model: "nova-2-phonecall",
      language: "en",
      smartFormat: true,
    },
    firstMessage,
    firstMessageMode: "assistant-speaks-first",
    endCallMessage: "Thank you for your time. Have a great day!",
    endCallPhrases: ["goodbye", "good bye", "have a good day", "have a great day"],
    silenceTimeoutSeconds: 20,
    maxDurationSeconds: 600,
    // Vapi handles barge-in / interruption natively
    backgroundSound: "off",
    backchannelingEnabled: true,
    serverUrl: `${BACKEND_WEBHOOK_URL}/api/vapi/webhook`,
    // Sent back to us as `x-vapi-secret` header on every webhook event so
    // we can authenticate the request. Falls back to empty if not set
    // (dev only — production must set VAPI_WEBHOOK_SECRET).
    serverUrlSecret: process.env.VAPI_WEBHOOK_SECRET ?? "",
  };
}

export async function vapiDirectCall(payload: VapiCallPayload): Promise<VapiCallResult> {
  if (!VAPI_API_KEY) {
    return { success: false, error: "VAPI_API_KEY environment variable not set" };
  }
  if (!VAPI_PHONE_NUMBER_ID) {
    return {
      success: false,
      error:
        "VAPI_PHONE_NUMBER_ID not set. Register a phone number at https://dashboard.vapi.ai/phone-numbers (BYO your Telnyx number) and set the env var to its ID.",
    };
  }

  const phone = (payload.phone ?? "").trim();
  if (!/^\+\d{7,15}$/.test(phone)) {
    return { success: false, error: `Invalid destination number "${phone}". Must be E.164.` };
  }

  const body = {
    phoneNumberId: VAPI_PHONE_NUMBER_ID,
    customer: {
      number: phone,
      name: payload.lead_name,
    },
    assistant: buildAssistant(payload),
    metadata: {
      campaignId: payload.campaign_id,
      campaignName: payload.campaign_name ?? "",
      leadId: payload.lead_id ?? "",
      transferNumber: payload.transfer_number ?? "",
    },
  };

  try {
    logger.info(
      { phone, campaignId: payload.campaign_id, voice: payload.voice, voiceProvider: payload.voice_provider },
      "Initiating Vapi outbound call"
    );

    const response = await axios.post(`${VAPI_API_BASE}/call`, body, {
      headers: {
        Authorization: `Bearer ${VAPI_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 15_000,
    });

    const callId: string = response.data?.id ?? "";

    logger.info(
      { phone, callId, status: response.status },
      "Vapi outbound call initiated"
    );

    if (callId) {
      await setActiveCall({
        call_id: `vapi:${callId}`,
        phone_number: phone,
        campaign_id: parseInt(payload.campaign_id, 10),
        campaign_name: payload.campaign_name,
        status: "ringing",
        started_at: new Date().toISOString(),
      }).catch(() => {}); // non-fatal
    }

    return { success: true, data: response.data, callControlId: callId };
  } catch (err) {
    const ax = err as AxiosError<{ message?: string | string[]; error?: string }>;
    const status = ax.response?.status;
    const detail = ax.response?.data;
    const msg = Array.isArray(detail?.message) ? detail.message.join("; ") : (detail?.message ?? detail?.error ?? ax.message);
    logger.error({ phone, err: msg, status, detail }, "Vapi direct call failed");
    return { success: false, error: `Vapi ${status ?? "error"}: ${msg}` };
  }
}

// One-shot helper: register an existing Telnyx number with Vapi (BYO).
// Run this once per number; persist the returned `id` as VAPI_PHONE_NUMBER_ID.
export async function registerByoTelnyxNumber(opts: {
  number: string;        // E.164
  name?: string;
  telnyxApiKey?: string; // defaults to env TELNYX_API_KEY
}): Promise<{ success: boolean; id?: string; error?: string }> {
  if (!VAPI_API_KEY) return { success: false, error: "VAPI_API_KEY not set" };
  const telnyxKey = opts.telnyxApiKey ?? process.env.TELNYX_API_KEY;
  if (!telnyxKey) return { success: false, error: "TELNYX_API_KEY not set" };

  try {
    const resp = await axios.post(
      `${VAPI_API_BASE}/phone-number`,
      {
        provider: "byo-phone-number",
        name: opts.name ?? `Telnyx ${opts.number}`,
        number: opts.number,
        numberE164CheckEnabled: true,
        credentialId: undefined, // for BYO via Telnyx, see Vapi docs; alternative: use 'twilio'/'telnyx' provider
      },
      {
        headers: {
          Authorization: `Bearer ${VAPI_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 10_000,
      }
    );
    return { success: true, id: resp.data?.id };
  } catch (err) {
    const ax = err as AxiosError<{ message?: string }>;
    return { success: false, error: ax.response?.data?.message ?? ax.message };
  }
}
