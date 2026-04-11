import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { phoneNumbersTable, campaignsTable, aiAgentsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import axios from "axios";

const router: IRouter = Router();

const TELNYX_API_BASE = "https://api.telnyx.com/v2";

// ── In-memory state for active inbound calls ──────────────────────────────────
interface InboundCallState {
  campaignId: number;
  campaignName: string;
  agentName: string;
  transferNumber?: string;
  callerNumber: string;
  greetingDone: boolean;
}

const activeInboundCalls = new Map<string, InboundCallState>();

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

async function speakGreeting(
  callControlId: string,
  text: string
): Promise<void> {
  await telnyxAction(callControlId, "speak", {
    payload: text,
    payload_type: "text",
    voice: "female",
    language: "en-US",
    service_level: "premium",
  });
}

async function gatherSpeech(callControlId: string): Promise<void> {
  await telnyxAction(callControlId, "gather", {
    maximum_digits: 0,
    gather_after_silence: 2000,
    gather_timeout: 30000,
    voice: "female",
    language: "en-US",
  });
}

async function transferCall(
  callControlId: string,
  to: string
): Promise<void> {
  await telnyxAction(callControlId, "transfer", { to });
}

async function hangupCall(callControlId: string): Promise<void> {
  await telnyxAction(callControlId, "hangup", {});
}

async function speakAndHangup(
  callControlId: string,
  text: string
): Promise<void> {
  await telnyxAction(callControlId, "speak", {
    payload: text,
    payload_type: "text",
    voice: "female",
    language: "en-US",
    service_level: "premium",
  });
}

// ── Lookup campaign by phone number ───────────────────────────────────────────
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

  let agentName = "your AI assistant";
  if (campaign.agentId) {
    const [agent] = await db
      .select()
      .from(aiAgentsTable)
      .where(eq(aiAgentsTable.id, campaign.agentId))
      .limit(1);
    if (agent) agentName = agent.name;
  }

  return {
    campaign,
    agentName,
  };
}

// ── POST /webhooks/telnyx ─────────────────────────────────────────────────────
// Telnyx sends all Call Control events here. No auth middleware — Telnyx signs
// events, but we skip signature validation for simplicity (add later if needed).
router.post("/webhooks/telnyx", async (req, res): Promise<void> => {
  // Always respond 200 immediately so Telnyx doesn't retry
  res.status(200).json({ received: true });

  const event = req.body?.data;
  if (!event) return;

  const eventType: string = event.event_type ?? "";
  const payload = event.payload ?? {};
  const callControlId: string = payload.call_control_id ?? "";
  const direction: string = payload.direction ?? "";
  const toNumber: string = payload.to ?? "";
  const fromNumber: string = payload.from ?? "";

  logger.info({ eventType, direction, to: toNumber, from: fromNumber }, "Telnyx webhook received");

  try {
    // ── Inbound call initiated ────────────────────────────────────────────────
    if (eventType === "call.initiated" && direction === "incoming") {
      const result = await getCampaignByNumber(toNumber);

      if (!result) {
        // No campaign configured for this number — answer and inform caller
        await answerCall(callControlId);
        await speakAndHangup(
          callControlId,
          "Thank you for calling. We were unable to connect your call at this time. Please try again later."
        );
        return;
      }

      const { campaign, agentName } = result;

      // Store call state for subsequent events
      activeInboundCalls.set(callControlId, {
        campaignId: campaign.id,
        campaignName: campaign.name,
        agentName,
        transferNumber: campaign.transferNumber ?? undefined,
        callerNumber: fromNumber,
        greetingDone: false,
      });

      const greeting = `Thank you for calling ${campaign.name}. This is ${agentName}. How may I help you today?`;

      logger.info({ callControlId, campaignId: campaign.id, agentName, greeting }, "Answering inbound call");

      await answerCall(callControlId);
      await speakGreeting(callControlId, greeting);

      return;
    }

    // ── Greeting finished — start listening ───────────────────────────────────
    if (eventType === "call.speak.ended") {
      const state = activeInboundCalls.get(callControlId);
      if (!state) return;

      if (!state.greetingDone) {
        state.greetingDone = true;
        activeInboundCalls.set(callControlId, state);

        if (state.transferNumber) {
          // Transfer to the configured agent/queue number
          logger.info({ callControlId, transferTo: state.transferNumber }, "Transferring inbound call after greeting");
          await transferCall(callControlId, state.transferNumber);
        } else {
          // Gather caller input to continue the conversation
          await gatherSpeech(callControlId);
        }
      }
      return;
    }

    // ── Caller spoke or pressed a key ─────────────────────────────────────────
    if (eventType === "call.gather.ended") {
      const state = activeInboundCalls.get(callControlId);
      if (!state) return;

      const digits: string = payload.digits ?? "";
      const speech: string = payload.speech ?? "";
      const input = speech || (digits ? `Pressed ${digits}` : "");

      logger.info({ callControlId, input }, "Caller input gathered");

      if (state.transferNumber) {
        await transferCall(callControlId, state.transferNumber);
      } else {
        // No AI/transfer configured — thank the caller and close
        await speakAndHangup(
          callControlId,
          "Thank you for your message. One of our team members will follow up with you shortly. Goodbye!"
        );
      }
      return;
    }

    // ── Call ended — clean up ──────────────────────────────────────────────────
    if (eventType === "call.hangup") {
      const state = activeInboundCalls.get(callControlId);
      if (state) {
        logger.info({ callControlId, campaignId: state.campaignId }, "Inbound call ended, cleaning up");
        activeInboundCalls.delete(callControlId);
      }
      return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ eventType, callControlId, err: msg }, "Error handling Telnyx webhook");
  }
});

// ── GET /webhooks/telnyx/config — returns webhook URL info for admin UI ───────
router.get("/webhooks/telnyx/config", async (_req, res): Promise<void> => {
  const baseUrl = process.env.API_BASE_URL ?? process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : "https://shivanshbackend.replit.app";

  res.json({
    webhookUrl: `${baseUrl}/api/webhooks/telnyx`,
    instructions: [
      "1. Log in to Telnyx Mission Control Portal",
      "2. Go to Numbers → Your Phone Numbers",
      "3. Click on a number → Voice Settings",
      "4. Set 'Connection' type to 'Call Control'",
      "5. Set the 'Webhook URL' to the URL above",
      "6. Set 'Webhook API Version' to v2",
      "7. Save — inbound calls will now be handled automatically",
    ],
  });
});

export default router;
