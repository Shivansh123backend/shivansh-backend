import axios from "axios";
import { logger } from "../lib/logger.js";
import { setActiveCall } from "../lib/redis.js";

const WORKER_URL = process.env.WORKER_URL ?? "https://ai-voice-worker1.replit.app";

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
  transfer_number?: string;
  campaign_id: string;
  campaign_name?: string;
}

export interface TriggerCallResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

function isHtmlResponse(data: unknown): boolean {
  return typeof data === "string" && data.trimStart().startsWith("<");
}

/** POST /api/calls/start-call — immediate real-time call */
export async function triggerCall(payload: TriggerCallPayload): Promise<TriggerCallResult> {
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
      logger.warn(
        { to: payload.to, workerUrl: WORKER_URL },
        `Worker returned HTML for ${payload.to} — endpoint not configured`,
      );
      return { success: false, error: "Worker endpoint /api/calls/start-call returned HTML. Check WORKER_URL." };
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
    });

    return { success: true, data: response.data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ to: payload.to, err: message }, `Worker error for ${payload.to}`);
    return { success: false, error: message };
  }
}

/** POST /api/calls/enqueue — queue via worker's BullMQ (preferred for campaigns) */
export async function enqueueCall(payload: EnqueueCallPayload): Promise<TriggerCallResult> {
  try {
    logger.info({ phone: payload.phone, campaignId: payload.campaign_id }, `Enqueueing call to ${payload.phone}`);

    const response = await axios.post(`${WORKER_URL}/api/calls/enqueue`, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    });

    if (isHtmlResponse(response.data)) {
      logger.warn(
        { phone: payload.phone, workerUrl: WORKER_URL },
        `Worker returned HTML for ${payload.phone} — endpoint not configured`,
      );
      return { success: false, error: "Worker endpoint /api/calls/enqueue returned HTML. Check WORKER_URL." };
    }

    logger.info({ phone: payload.phone, status: response.status }, `Worker enqueued call to ${payload.phone}`);
    return { success: true, data: response.data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ phone: payload.phone, err: message }, `Worker enqueue error for ${payload.phone}`);
    return { success: false, error: message };
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
