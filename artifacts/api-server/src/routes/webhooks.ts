import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { phoneNumbersTable, campaignsTable, aiAgentsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import axios from "axios";
import OpenAI from "openai";

const router: IRouter = Router();

// ── OpenAI client (Replit AI integration) ─────────────────────────────────────
const openai = new OpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? "placeholder",
});

const TELNYX_API_BASE = "https://api.telnyx.com/v2";
const MAX_TURNS = 12;

// ── Conversation state per active inbound call ────────────────────────────────
interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

interface InboundCallState {
  campaignId: number;
  campaignName: string;
  agentName: string;
  agentPrompt: string;
  callerNumber: string;
  messages: Message[];
  turnCount: number;
  greetingDone: boolean;
}

const activeCalls = new Map<string, InboundCallState>();

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

async function speak(callControlId: string, text: string): Promise<void> {
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
    minimum_digits: 0,
    gather_after_silence: 1500,
    gather_timeout: 30000,
    voice: "female",
    language: "en-US",
  });
}

async function hangupCall(callControlId: string): Promise<void> {
  await telnyxAction(callControlId, "hangup", {});
}

// ── Generate AI response using OpenAI ─────────────────────────────────────────
async function generateAiResponse(messages: Message[]): Promise<string> {
  const response = await openai.chat.completions.create({
    model: "gpt-5-mini",
    max_completion_tokens: 8192,
    messages,
  });

  const content = response.choices[0]?.message?.content?.trim();
  if (!content) return "I'm sorry, I didn't catch that. Could you please repeat?";
  return content;
}

// ── Detect if the caller wants to end the call ────────────────────────────────
function isGoodbye(text: string): boolean {
  const lower = text.toLowerCase();
  return ["goodbye", "bye", "hang up", "that's all", "no thanks", "i'm done", "end call", "thanks bye"].some(
    phrase => lower.includes(phrase)
  );
}

// ── Lookup campaign by inbound phone number ───────────────────────────────────
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

  let agentName = "AI Assistant";
  let agentPrompt: string = campaign.agentPrompt ?? "";

  if (campaign.agentId) {
    const [agent] = await db
      .select()
      .from(aiAgentsTable)
      .where(eq(aiAgentsTable.id, campaign.agentId))
      .limit(1);
    if (agent) {
      agentName = agent.name;
      if (!agentPrompt) agentPrompt = agent.prompt;
    }
  }

  // Build system prompt for inbound calls
  const systemPrompt = agentPrompt
    ? `${agentPrompt}\n\nYou are handling an inbound callback call for the campaign "${campaign.name}". You are ${agentName}. Keep responses concise and conversational — 1-2 sentences max since this is a phone call.`
    : `You are ${agentName}, an AI voice assistant handling an inbound callback call for "${campaign.name}". Be professional, helpful, and concise. Keep responses to 1-2 sentences since this is a phone call. Gather the caller's needs and assist them appropriately.`;

  return { campaign, agentName, systemPrompt };
}

// ── POST /webhooks/telnyx — Telnyx Call Control event handler ─────────────────
// No auth — Telnyx sends events here directly.
router.post("/webhooks/telnyx", async (req, res): Promise<void> => {
  // Always respond 200 immediately — Telnyx will retry if we don't
  res.status(200).json({ received: true });

  const event = req.body?.data;
  if (!event) return;

  const eventType: string = event.event_type ?? "";
  const payload = event.payload ?? {};
  const callControlId: string = payload.call_control_id ?? "";
  const direction: string = payload.direction ?? "";
  const toNumber: string = payload.to ?? "";
  const fromNumber: string = payload.from ?? "";

  logger.info({ eventType, direction, to: toNumber, from: fromNumber, callControlId }, "Telnyx event");

  try {
    // ── 1. Inbound call arrives ─────────────────────────────────────────────
    if (eventType === "call.initiated" && direction === "incoming") {
      const result = await getCampaignByNumber(toNumber);

      if (!result) {
        // No campaign for this number — answer briefly and close
        await answerCall(callControlId);
        await speak(
          callControlId,
          "Thank you for calling. We are unable to connect your call at this time. Please try again later. Goodbye."
        );
        return;
      }

      const { campaign, agentName, systemPrompt } = result;
      const greeting = `Thank you for calling ${campaign.name}. This is ${agentName}. How may I help you today?`;

      // Store call state with conversation history
      activeCalls.set(callControlId, {
        campaignId: campaign.id,
        campaignName: campaign.name,
        agentName,
        agentPrompt: systemPrompt,
        callerNumber: fromNumber,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "assistant", content: greeting },
        ],
        turnCount: 0,
        greetingDone: false,
      });

      logger.info({ callControlId, campaignId: campaign.id, agentName }, "Answering inbound call");

      await answerCall(callControlId);
      await speak(callControlId, greeting);
      return;
    }

    // ── 2. Greeting (or AI response) finished speaking — start listening ────
    if (eventType === "call.speak.ended") {
      const state = activeCalls.get(callControlId);
      if (!state) return;

      state.greetingDone = true;

      // If we've hit the turn limit, close gracefully
      if (state.turnCount >= MAX_TURNS) {
        await speak(
          callControlId,
          "Thank you for calling. I've noted your inquiry and someone from our team will follow up with you. Have a great day. Goodbye!"
        );
        activeCalls.delete(callControlId);
        return;
      }

      // Listen for the caller's response
      await gatherSpeech(callControlId);
      return;
    }

    // ── 3. Caller spoke — get transcript, generate AI response ──────────────
    if (eventType === "call.gather.ended") {
      const state = activeCalls.get(callControlId);
      if (!state) return;

      const speechText: string = payload.speech ?? "";
      const digits: string = payload.digits ?? "";
      const reason: string = payload.reason ?? "";

      // If no speech gathered (timeout/silence), prompt again
      if (!speechText && !digits) {
        if (reason === "timeout") {
          // Caller went silent — prompt once, then hang up
          if (state.turnCount >= 1) {
            await speak(callControlId, "I didn't hear anything. Thank you for calling. Goodbye!");
            activeCalls.delete(callControlId);
          } else {
            state.turnCount++;
            await speak(callControlId, "I'm sorry, I didn't hear you. Could you please say something?");
          }
          return;
        }
        return;
      }

      const callerInput = speechText || `Pressed ${digits}`;
      logger.info({ callControlId, callerInput, turn: state.turnCount }, "Caller input received");

      // Check for goodbye intent
      if (isGoodbye(callerInput)) {
        await speak(callControlId, "Thank you for calling. Have a wonderful day. Goodbye!");
        activeCalls.delete(callControlId);
        return;
      }

      // Add caller's message to conversation history
      state.messages.push({ role: "user", content: callerInput });
      state.turnCount++;

      // Generate AI response
      let aiResponse: string;
      try {
        aiResponse = await generateAiResponse(state.messages);
      } catch (err) {
        logger.error({ err, callControlId }, "OpenAI response failed");
        aiResponse = "I'm sorry, I'm having trouble processing that. Could you please repeat your request?";
      }

      // Add AI response to history
      state.messages.push({ role: "assistant", content: aiResponse });

      logger.info({ callControlId, aiResponse, turn: state.turnCount }, "AI response generated");

      // Speak the AI response (will trigger call.speak.ended → gather again)
      await speak(callControlId, aiResponse);
      return;
    }

    // ── 4. Call ended — clean up ─────────────────────────────────────────────
    if (eventType === "call.hangup") {
      const state = activeCalls.get(callControlId);
      if (state) {
        logger.info(
          { callControlId, campaignId: state.campaignId, turns: state.turnCount },
          "Inbound call ended"
        );
        activeCalls.delete(callControlId);
      }
      return;
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ eventType, callControlId, err: msg }, "Error handling Telnyx webhook");
  }
});

// ── GET /webhooks/telnyx/config ────────────────────────────────────────────────
router.get("/webhooks/telnyx/config", async (_req, res): Promise<void> => {
  res.json({
    webhookUrl: "https://shivanshbackend.replit.app/api/webhooks/telnyx",
    instructions: [
      "1. Log in to Telnyx Mission Control Portal (portal.telnyx.com)",
      "2. Go to Numbers → My Numbers → select your phone number",
      "3. Under Voice Settings, set Connection to 'Call Control'",
      "4. Paste the webhook URL above into the 'Webhook URL' field",
      "5. Set Webhook API Version to v2 and save",
      "6. Assign the number to an Inbound campaign below",
    ],
  });
});

export default router;
