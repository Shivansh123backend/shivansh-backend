import axios from "axios";
import { logger } from "../lib/logger.js";
import { setActiveCall } from "../lib/redis.js";

const WORKER_URL = process.env.WORKER_URL;
const TELNYX_API_BASE = "https://api.telnyx.com/v2";
const BACKEND_WEBHOOK_URL =
  process.env.WEBHOOK_BASE_URL ?? "https://shivanshbackend.replit.app";

export interface TriggerCallPayload {
  to: string;
  from: string;
  script: string;
  voice: string;
  transfer_number?: string;
  campaign_id: number;
  campaign_name?: string;
}

export interface EnqueueCallPayload {
  phone: string;
  from_number: string;
  agent_prompt: string;
  voice: string;
  voice_provider?: string;
  transfer_number?: string;
  campaign_id: string;
  campaign_name?: string;
  background_sound?: string;
  hold_music_url?: string;
  amd_enabled?: string;
}

export interface TriggerCallResult {
  success: boolean;
  data?: unknown;
  error?: string;
  callControlId?: string;
}

function isHtmlResponse(data: unknown): boolean {
  return typeof data === "string" && data.trimStart().startsWith("<");
}

// ── Telnyx direct outbound call ───────────────────────────────────────────────
async function telnyxDirectCall(payload: EnqueueCallPayload): Promise<TriggerCallResult> {
  const apiKey = process.env.TELNYX_API_KEY;
  const connectionId = process.env.TELNYX_CONNECTION_ID;

  if (!apiKey) {
    return { success: false, error: "TELNYX_API_KEY environment variable not set" };
  }
  if (!connectionId) {
    return { success: false, error: "TELNYX_CONNECTION_ID environment variable not set. Get it from portal.telnyx.com → Call Control Applications." };
  }

  // Guard against placeholder / clearly invalid from numbers before wasting a Telnyx API call.
  // A valid E.164 number starts with '+' followed by 7–15 digits.
  const fromTrimmed = (payload.from_number ?? "").trim();
  if (!fromTrimmed || fromTrimmed === "+10000000000" || !/^\+\d{7,15}$/.test(fromTrimmed)) {
    return {
      success: false,
      error: `Invalid origination number "${fromTrimmed}". Go to Phone Numbers → Sync from Telnyx to import your verified Telnyx numbers, then assign one to this campaign.`,
    };
  }

  // Encode campaign context in client_state so webhook knows which campaign this call is for
  const clientStateData = {
    type: "outbound",
    campaignId: payload.campaign_id,
    campaignName: payload.campaign_name ?? "",
    script: payload.agent_prompt,
    voice: payload.voice,
    voiceProvider: payload.voice_provider ?? "elevenlabs",
    phone: payload.phone,
    fromNumber: payload.from_number,
    transferNumber: payload.transfer_number ?? null,
    backgroundSound: payload.background_sound ?? null,
  };
  const clientState = Buffer.from(JSON.stringify(clientStateData)).toString("base64");

  try {
    logger.info(
      { phone: payload.phone, from: payload.from_number, campaignId: payload.campaign_id },
      "Initiating Telnyx outbound call directly"
    );

    const body: Record<string, unknown> = {
      connection_id: connectionId,
      to: payload.phone,
      from: payload.from_number,
      from_display_name: payload.campaign_name ?? "Shivansh AI",
      webhook_url: `${BACKEND_WEBHOOK_URL}/api/webhooks/telnyx`,
      webhook_api_version: "2",
      client_state: clientState,
    };
    // AMD is always-on (premium) for outbound calls. The AI greeting is gated
    // on the webhook's `call.machine.premium.detection.ended` result so the
    // bot never speaks until a real human is on the line.
    if (payload.amd_enabled !== "false") {
      body.answering_machine_detection = "premium";
      // Tune for faster human/machine decision (Vapi-style ~1.5-2s):
      // - cap total analysis time so AMD never delays us past 2.5s
      // - shorter "after greeting silence" makes "Hello?" trigger human faster
      body.answering_machine_detection_config = {
        total_analysis_time_millis: 2500,
        after_greeting_silence_millis: 600,
        between_words_silence_millis: 50,
        greeting_duration_millis: 2500,
        initial_silence_millis: 2500,
        maximum_number_of_words: 5,
        maximum_word_length_millis: 2500,
        silence_threshold: 256,
        greeting_total_analysis_time_millis: 2500,
        greeting_silence_duration_millis: 1200,
      };
    } else {
      body.answering_machine_detection = "disabled";
    }

    const response = await axios.post(`${TELNYX_API_BASE}/calls`, body, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 15_000,
    });

    const callControlId: string = response.data?.data?.call_control_id ?? "";

    logger.info(
      { phone: payload.phone, callControlId, status: response.status },
      "Telnyx outbound call initiated"
    );

    if (callControlId) {
      await setActiveCall({
        call_id: callControlId,
        phone_number: payload.phone,
        campaign_id: parseInt(payload.campaign_id, 10),
        campaign_name: payload.campaign_name,
        status: "ringing",
        started_at: new Date().toISOString(),
      }).catch(() => {}); // non-fatal if Redis unavailable
    }

    return { success: true, data: response.data, callControlId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const resp = (err as Record<string, unknown> & { response?: { status?: number; data?: { errors?: Array<{ detail?: string; title?: string; code?: string }> } } })?.response;
    const status = resp?.status;
    const detail = resp?.data;
    const firstErr = detail?.errors?.[0];
    const telnyxReason = firstErr?.detail ?? firstErr?.title ?? msg;
    const telnyxCode = firstErr?.code ?? "";

    logger.error({ phone: payload.phone, err: msg, status, detail, telnyxCode }, "Telnyx direct call failed");

    // D51 = unverified origination number — give a clear actionable error
    if (status === 403 || telnyxCode === "D51" || telnyxReason.includes("non-Telnyx") || telnyxReason.includes("Unverified origination")) {
      return {
        success: false,
        error: `Telnyx 403 D51: The origination number "${payload.from_number}" is not verified in your Telnyx account. Fix: Go to Phone Numbers page → click "Sync from Telnyx" to import your real verified numbers, then assign one to this campaign.`,
      };
    }

    return { success: false, error: `Telnyx ${status ?? "error"}: ${telnyxReason}` };
  }
}

// ── External worker fallback ──────────────────────────────────────────────────

/** POST /api/calls/start-call — immediate real-time call via external worker */
export async function triggerCall(payload: TriggerCallPayload): Promise<TriggerCallResult> {
  // If no worker configured, use Telnyx direct
  if (!WORKER_URL) {
    return telnyxDirectCall({
      phone: payload.to,
      from_number: payload.from,
      agent_prompt: payload.script,
      voice: payload.voice,
      transfer_number: payload.transfer_number,
      campaign_id: String(payload.campaign_id),
      campaign_name: payload.campaign_name,
    });
  }

  try {
    logger.info({ to: payload.to, from: payload.from, campaignId: payload.campaign_id }, `Triggering call to ${payload.to}`);

    const body = {
      to: payload.to,
      from: payload.from,
      script: payload.script,
      voice: payload.voice,
      transfer_number: payload.transfer_number,
      campaign_id: String(payload.campaign_id),
    };

    const response = await axios.post(`${WORKER_URL}/api/calls/start-call`, body, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    });

    if (isHtmlResponse(response.data)) {
      logger.warn({ to: payload.to, workerUrl: WORKER_URL }, `Worker returned HTML — falling back to Telnyx direct`);
      return telnyxDirectCall({
        phone: payload.to,
        from_number: payload.from,
        agent_prompt: payload.script,
        voice: payload.voice,
        transfer_number: payload.transfer_number,
        campaign_id: String(payload.campaign_id),
        campaign_name: payload.campaign_name,
      });
    }

    logger.info({ to: payload.to, status: response.status }, `Worker accepted call to ${payload.to}`);

    const callId = `${payload.campaign_id}-${payload.to.replace(/\D/g, "")}-${Date.now()}`;
    await setActiveCall({
      call_id: callId,
      phone_number: payload.to,
      campaign_id: payload.campaign_id,
      campaign_name: payload.campaign_name,
      status: "ringing",
      started_at: new Date().toISOString(),
    }).catch(() => {});

    return { success: true, data: response.data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ to: payload.to, err: message }, `Worker error — falling back to Telnyx direct`);
    return telnyxDirectCall({
      phone: payload.to,
      from_number: payload.from,
      agent_prompt: payload.script,
      voice: payload.voice,
      transfer_number: payload.transfer_number,
      campaign_id: String(payload.campaign_id),
      campaign_name: payload.campaign_name,
    });
  }
}

/** POST /api/calls/enqueue — queue via worker's BullMQ or Telnyx direct */
export async function enqueueCall(payload: EnqueueCallPayload): Promise<TriggerCallResult> {
  // Rate-limit outbound dial rate to stay under Telnyx account caps and
  // protect downstream STT/LLM/TTS streams. No-op when DIAL_RATE_PER_SEC=0.
  const { acquireDispatchToken } = await import("../lib/dispatchLimiter.js");
  await acquireDispatchToken();

  // If no worker configured (or WORKER_URL not set), use Telnyx direct
  if (!WORKER_URL) {
    return telnyxDirectCall(payload);
  }

  try {
    logger.info({ phone: payload.phone, campaignId: payload.campaign_id }, `Enqueueing call to ${payload.phone}`);

    const response = await axios.post(`${WORKER_URL}/api/calls/enqueue`, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    });

    if (isHtmlResponse(response.data)) {
      logger.warn({ phone: payload.phone, workerUrl: WORKER_URL }, `Worker returned HTML — falling back to Telnyx direct`);
      return telnyxDirectCall(payload);
    }

    logger.info({ phone: payload.phone, status: response.status }, `Worker enqueued call to ${payload.phone}`);
    return { success: true, data: response.data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ phone: payload.phone, err: message }, `Worker enqueue failed — falling back to Telnyx direct`);
    return telnyxDirectCall(payload);
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
