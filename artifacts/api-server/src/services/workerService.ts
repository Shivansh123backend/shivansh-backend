import axios from "axios";
import { logger } from "../lib/logger.js";

const WORKER_URL = process.env.WORKER_URL ?? "https://ai-voice-worker1.replit.app";

export interface TriggerCallPayload {
  to: string;
  from: string;
  script: string;
  voice: string;
  transfer_number?: string;
  campaign_id: number;
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
