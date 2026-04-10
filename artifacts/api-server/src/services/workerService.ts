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

export interface TriggerCallResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export async function triggerCall(payload: TriggerCallPayload): Promise<TriggerCallResult> {
  try {
    logger.info({ to: payload.to, from: payload.from, campaignId: payload.campaign_id }, `Call triggered to ${payload.to}`);

    const response = await axios.post(`${WORKER_URL}/start-call`, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    });

    logger.info({ to: payload.to, status: response.status }, `Worker accepted call to ${payload.to}`);

    // Track the live call in Redis so the dashboard can show it in real time.
    // Use phone+timestamp as call_id since we don't have an external call ID yet.
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

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
