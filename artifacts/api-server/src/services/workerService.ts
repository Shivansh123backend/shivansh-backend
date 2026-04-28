import axios from "axios";
import { logger } from "../lib/logger.js";
import { setActiveCall } from "../lib/redis.js";

const WORKER_URL = process.env.WORKER_URL;
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
  // "blind" → AI hangs up the moment the call is bridged.
  // "warm"  → AI greets the human agent first, then bridges the lead.
  transfer_mode?: "blind" | "warm";
  campaign_id: string;
  campaign_name?: string;
  background_sound?: string;
  hold_music_url?: string;
  amd_enabled?: boolean;
  // Voicemail drop message: when Vapi detects an answering machine, it speaks
  // this message and ends the call. Empty/undefined ⇒ silent hang-up on VM.
  vm_drop_message?: string;
  // When true, route this call through Vapi instead of Telnyx+custom pipeline
  use_vapi?: boolean;
  // Vapi phone-number ID to originate from (resolved from the allocated
  // Telnyx number's vapiPhoneNumberId column). Required when use_vapi=true.
  vapi_phone_number_id?: string;
  // Optional context fields used by Vapi assistant (firstMessage, KB, etc.)
  knowledge_base?: string;
  lead_id?: string;
  lead_name?: string;
  first_message?: string;
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

// ── Vapi fallback — replaces the old Telnyx direct-call path ─────────────────
// All paths that previously fell back to Telnyx now route through Vapi.
async function vapiCallFallback(payload: EnqueueCallPayload): Promise<TriggerCallResult> {
  const { vapiDirectCall } = await import("./vapiService.js");

  // Resolve vapiPhoneNumberId from the from_number if not already set
  let vapiPhoneNumberId = payload.vapi_phone_number_id;
  if (!vapiPhoneNumberId && payload.from_number) {
    try {
      const { db } = await import("../lib/db.js");
      const { phoneNumbersTable } = await import("@workspace/db");
      const { eq } = await import("drizzle-orm");
      const rows = await db
        .select({ v: phoneNumbersTable.vapiPhoneNumberId })
        .from(phoneNumbersTable)
        .where(eq(phoneNumbersTable.phoneNumber, payload.from_number))
        .limit(1);
      vapiPhoneNumberId = rows[0]?.v ?? undefined;
    } catch {
      // Non-fatal — Vapi will fall back to the env-configured default number
    }
  }

  logger.info(
    { phone: payload.phone, campaignId: payload.campaign_id, vapiPhoneNumberId: vapiPhoneNumberId ?? "(env default)" },
    "Routing call through Vapi"
  );

  return vapiDirectCall({
    phone: payload.phone,
    agent_prompt: payload.agent_prompt,
    voice: payload.voice,
    voice_provider: payload.voice_provider,
    campaign_id: payload.campaign_id,
    campaign_name: payload.campaign_name,
    transfer_number: payload.transfer_number,
    transfer_mode: payload.transfer_mode,
    knowledge_base: payload.knowledge_base,
    lead_id: payload.lead_id,
    lead_name: payload.lead_name,
    first_message: payload.first_message,
    vapi_phone_number_id: vapiPhoneNumberId ?? undefined,
    background_sound: payload.background_sound,
    amd_enabled: payload.amd_enabled,
    vm_drop_message: payload.vm_drop_message,
  });
}

// ── External worker fallback ──────────────────────────────────────────────────

/** POST /api/calls/start-call — immediate real-time call (worker or Vapi) */
export async function triggerCall(payload: TriggerCallPayload): Promise<TriggerCallResult> {
  const vapiPayload: EnqueueCallPayload = {
    phone: payload.to,
    from_number: payload.from,
    agent_prompt: payload.script,
    voice: payload.voice,
    transfer_number: payload.transfer_number,
    campaign_id: String(payload.campaign_id),
    campaign_name: payload.campaign_name,
  };

  // If no external worker configured, go straight to Vapi
  if (!WORKER_URL) {
    return vapiCallFallback(vapiPayload);
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
      logger.warn({ to: payload.to, workerUrl: WORKER_URL }, `Worker returned HTML — routing through Vapi`);
      return vapiCallFallback(vapiPayload);
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
    logger.warn({ to: payload.to, err: message }, `Worker error — routing through Vapi`);
    return vapiCallFallback(vapiPayload);
  }
}

/** POST /api/calls/enqueue — queue via worker's BullMQ or Vapi direct */
export async function enqueueCall(payload: EnqueueCallPayload): Promise<TriggerCallResult> {
  // Rate-limit outbound dial rate. No-op when DIAL_RATE_PER_SEC=0.
  const { acquireDispatchToken } = await import("../lib/dispatchLimiter.js");
  await acquireDispatchToken();

  // All calls route through Vapi — either explicitly (use_vapi=true) or as default
  if (payload.use_vapi || !WORKER_URL) {
    return vapiCallFallback(payload);
  }

  try {
    logger.info({ phone: payload.phone, campaignId: payload.campaign_id }, `Enqueueing call to ${payload.phone}`);

    const response = await axios.post(`${WORKER_URL}/api/calls/enqueue`, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    });

    if (isHtmlResponse(response.data)) {
      logger.warn({ phone: payload.phone, workerUrl: WORKER_URL }, `Worker returned HTML — routing through Vapi`);
      return vapiCallFallback(payload);
    }

    logger.info({ phone: payload.phone, status: response.status }, `Worker enqueued call to ${payload.phone}`);
    return { success: true, data: response.data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ phone: payload.phone, err: message }, `Worker enqueue failed — routing through Vapi`);
    return vapiCallFallback(payload);
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
