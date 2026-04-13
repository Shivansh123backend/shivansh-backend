import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { phoneNumbersTable, campaignsTable, aiAgentsTable, callLogsTable, leadsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import axios from "axios";
import OpenAI from "openai";

const router: IRouter = Router();

// ── OpenAI client ─────────────────────────────────────────────────────────────
// Replit AI Integration proxy (localhost:1106) works in both dev and production.
// Fall back to direct OpenAI if the integration isn't set up.
const openai = new OpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ?? undefined,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? "placeholder",
});

// Configurable model — default to gpt-4o-mini which is fast and widely available
const AI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

const TELNYX_API_BASE = "https://api.telnyx.com/v2";
const MAX_TURNS = 12;

// ── Per-call conversation state ───────────────────────────────────────────────
interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

type CallStage =
  | "waiting_for_pickup"   // outbound: waiting for caller to say anything
  | "confirming_name"      // outbound: asked "Is this [Name]?" — waiting for yes/no
  | "conversation"         // normal AI conversation loop
  ;

interface CallState {
  campaignId: number;
  campaignName: string;
  agentName: string;
  agentPrompt: string;
  callerNumber: string;
  calledNumber: string;
  messages: Message[];
  turnCount: number;
  startedAt: Date;
  recordingUrl?: string;
  direction: "inbound" | "outbound";
  stage: CallStage;
  leadName?: string;
  leadId?: number;
  pendingHangup?: boolean;  // hang up gracefully after current speech ends
}

const activeCalls = new Map<string, CallState>();
// Keep backward-compat alias used in some helpers
type InboundCallState = CallState;

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
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      timeout: 10_000,
    }
  );
}

async function answerCall(callControlId: string): Promise<void> {
  await telnyxAction(callControlId, "answer", {});
}

async function startRecording(callControlId: string): Promise<void> {
  await telnyxAction(callControlId, "record_start", {
    format: "mp3",
    channels: "dual",
    play_beep: false,
  });
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
    gather_after_silence: 2500,   // 2.5s — gives callers time to finish a sentence
    gather_timeout: 30000,
    voice: "female",
    language: "en-US",
  });
}

// ── Natural system prompt builder (VAPI-like) ─────────────────────────────────
function buildNaturalSystemPrompt(
  rawPrompt: string,
  campaignName: string,
  agentName = "AI Assistant",
  leadName?: string
): string {
  const intro = leadName
    ? `You are ${agentName}, calling ${leadName} on behalf of "${campaignName}".`
    : `You are ${agentName}, an AI phone agent calling on behalf of "${campaignName}".`;

  const instructions = rawPrompt?.trim()
    ? `YOUR ROLE AND GOAL:\n${rawPrompt}\n`
    : `Be helpful, professional, and guide the conversation naturally.\n`;

  return `${intro}

${instructions}
CONVERSATION RULES — follow these at all times:
- Sound completely natural and human. NEVER sound scripted or robotic.
- Keep every response SHORT: 1-3 sentences maximum. This is a real phone call.
- ALWAYS respond directly to what the caller just said before anything else.
- If they ask an unexpected question, answer it genuinely, then gently return to your purpose.
- If asked "are you an AI or robot?" — be honest: "Yes, I'm an AI assistant, but I'm genuinely here to help."
- If they're not interested or want to opt out: "Absolutely, I'll remove you right away. Really sorry for the interruption — have a great day!" then wrap up.
- If they want a callback: confirm their preferred time warmly and say someone will follow up.
- Use natural filler language: "Got it", "Sure", "Absolutely", "Of course", "Makes sense", "Happy to help".
- Never repeat yourself. Never read from a numbered list. Adapt to wherever the conversation goes.
- If you learn their name, use it naturally once in a while (not every sentence).
- Be warm, empathetic, and genuinely helpful. If you don't know something, say so honestly.
- When wrapping up the call, give a friendly natural close like "Great talking with you, have an amazing day!"`;
}

// ── OpenAI helpers ────────────────────────────────────────────────────────────
async function generateAiResponse(messages: Message[]): Promise<string> {
  const response = await openai.chat.completions.create({
    model: AI_MODEL,
    max_tokens: 500,
    temperature: 0.7,   // slightly creative for natural responses
    messages,
  });
  const content = response.choices[0]?.message?.content?.trim();
  if (!content) return "Sorry, could you say that again?";
  return content;
}

async function generateSummaryAndDisposition(
  messages: Message[],
  campaignName: string
): Promise<{ summary: string; disposition: string; transcript: string }> {
  // Build readable transcript from conversation
  const transcript = messages
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role === "assistant" ? "AI Agent" : "Caller"}: ${m.content}`)
    .join("\n");

  if (!transcript.trim()) {
    return { summary: "No conversation recorded.", disposition: "no_answer", transcript: "" };
  }

  try {
    const response = await openai.chat.completions.create({
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
Choose disposition based on: interested=caller wants product/service, not_interested=caller declined, vm=voicemail, callback_requested=wants callback later, connected=brief conversation, completed=full successful interaction.
Return ONLY valid JSON, no markdown.`,
        },
        {
          role: "user",
          content: `CALL TRANSCRIPT:\n${transcript}`,
        },
      ],
    });

    const raw = response.choices[0]?.message?.content?.trim() ?? "{}";
    const parsed = JSON.parse(raw);
    return {
      summary: parsed.summary ?? "Call completed.",
      disposition: parsed.disposition ?? "connected",
      transcript,
    };
  } catch {
    return {
      summary: "Call completed successfully.",
      disposition: "connected",
      transcript,
    };
  }
}

// ── Goodbye detection ─────────────────────────────────────────────────────────
function isGoodbye(text: string): boolean {
  const lower = text.toLowerCase();
  return ["goodbye", "bye", "hang up", "that's all", "no thanks", "i'm done", "end call", "thanks bye", "have a good day"].some(
    (phrase) => lower.includes(phrase)
  );
}

// ── Campaign lookup by called number ─────────────────────────────────────────
async function getCampaignByNumber(toNumber: string) {
  const [phoneRow] = await db
    .select()
    .from(phoneNumbersTable)
    .where(and(eq(phoneNumbersTable.phoneNumber, toNumber), eq(phoneNumbersTable.status, "active")))
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

  const systemPrompt = buildNaturalSystemPrompt(agentPrompt, campaign.name, agentName);

  return { campaign, agentName, systemPrompt };
}

// ── Finalize inbound call — save to DB with all data ─────────────────────────
async function finalizeInboundCall(
  callControlId: string,
  state: InboundCallState,
  recordingUrl?: string
): Promise<void> {
  try {
    const durationSecs = Math.round((Date.now() - state.startedAt.getTime()) / 1000);
    const { summary, disposition, transcript } = await generateSummaryAndDisposition(
      state.messages,
      state.campaignName
    );

    await db.insert(callLogsTable).values({
      phoneNumber: state.callerNumber,
      campaignId: state.campaignId,
      status: "completed",
      disposition,
      direction: "inbound",
      duration: durationSecs,
      recordingUrl: recordingUrl ?? state.recordingUrl ?? null,
      transcript,
      summary,
      callControlId,
    });

    logger.info(
      { callControlId, campaignId: state.campaignId, disposition, durationSecs, turns: state.turnCount },
      "Inbound call finalized and saved to DB"
    );
  } catch (err) {
    logger.error({ err, callControlId }, "Failed to finalize inbound call");
  }
}

// ── Outbound client_state decoder ────────────────────────────────────────────
interface OutboundClientState {
  type: "outbound";
  campaignId: string;
  campaignName: string;
  script: string;
  voice: string;
  phone: string;
  transferNumber: string | null;
}

function decodeClientState(raw: string): OutboundClientState | null {
  try {
    const json = Buffer.from(raw, "base64").toString("utf-8");
    const parsed = JSON.parse(json);
    if (parsed?.type === "outbound") return parsed as OutboundClientState;
    return null;
  } catch {
    return null;
  }
}

// ── Finalize outbound call — save to DB + update lead ──────────────────────────
async function finalizeOutboundCall(
  callControlId: string,
  state: InboundCallState,
  disposition?: string
): Promise<void> {
  try {
    const durationSecs = Math.round((Date.now() - state.startedAt.getTime()) / 1000);
    const { summary, disposition: detectedDisposition, transcript } = await generateSummaryAndDisposition(
      state.messages,
      state.campaignName
    );

    const finalDisposition = disposition ?? detectedDisposition;

    await db.insert(callLogsTable).values({
      phoneNumber: state.callerNumber,
      campaignId: state.campaignId,
      status: "completed",
      disposition: finalDisposition,
      direction: "outbound",
      duration: durationSecs,
      recordingUrl: state.recordingUrl ?? null,
      transcript,
      summary,
      callControlId,
    });

    // Mark the lead as called so it doesn't get called again
    const leadStatus = finalDisposition === "callback_requested" ? "callback" : "called";
    await db
      .update(leadsTable)
      .set({
        status: leadStatus as "called" | "callback",
        metadata: JSON.stringify({ lastCallSummary: summary, lastDisposition: finalDisposition }),
      })
      .where(and(
        eq(leadsTable.phone, state.callerNumber),
        eq(leadsTable.campaignId, state.campaignId)
      ));

    logger.info(
      { callControlId, campaignId: state.campaignId, disposition: finalDisposition, durationSecs, leadStatus },
      "Outbound call finalized and lead updated"
    );
  } catch (err) {
    logger.error({ err, callControlId }, "Failed to finalize outbound call");
  }
}

// ── POST /webhooks/telnyx ─────────────────────────────────────────────────────
router.post("/webhooks/telnyx", async (req, res): Promise<void> => {
  // Always respond 200 immediately
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
    // ── 0. Outbound: AMD result — hang up on voicemail ───────────────────────
    // Telnyx sends "call.machine.premium.detection.ended" for premium AMD
    if (eventType === "call.machine.detection.ended" || eventType === "call.machine.premium.detection.ended") {
      const result: string = payload.result ?? "";
      logger.info({ callControlId, result }, "AMD result");

      if (result === "machine_start" || result === "machine_end_beep" || result === "machine_end_silence") {
        // Voicemail detected — hang up and log as vm
        try { await telnyxAction(callControlId, "hangup", {}); } catch { /* already hung up */ }

        const state = activeCalls.get(callControlId);
        if (state) {
          const durationSecs = Math.round((Date.now() - state.startedAt.getTime()) / 1000);
          await db.insert(callLogsTable).values({
            phoneNumber: state.callerNumber,
            campaignId: state.campaignId,
            status: "completed",
            disposition: "vm",
            direction: "outbound",
            duration: durationSecs,
            callControlId,
          }).catch(() => {});
          activeCalls.delete(callControlId);
        }
      }
      // If human detected — call.answered will fire; nothing to do here
      return;
    }

    // ── 1a. Outbound call answered by human ──────────────────────────────────
    // Telnyx sends call.answered with direction="" (not "outgoing"), so we
    // detect outbound calls by the presence of our client_state payload.
    if (eventType === "call.answered") {
      const ctx = clientStateRaw ? decodeClientState(clientStateRaw) : null;

      // If no client_state → this is an inbound answered call; skip (handled by call.initiated)
      if (!ctx) {
        logger.info({ callControlId, direction }, "call.answered without client_state — inbound or unknown, skipping");
        return;
      }

      const campaignId = parseInt(ctx.campaignId, 10);

      // Look up lead name for a personalized, natural greeting
      const [lead] = await db
        .select({ name: leadsTable.name, id: leadsTable.id })
        .from(leadsTable)
        .where(and(eq(leadsTable.phone, ctx.phone), eq(leadsTable.campaignId, campaignId)))
        .limit(1);

      const leadName = lead?.name;
      const firstName = leadName?.split(" ")[0];

      // Natural greeting — personalised if we have their name
      const greeting = firstName
        ? `Hi ${firstName}, this is an AI assistant calling from ${ctx.campaignName}. Did I catch you at a good time?`
        : `Hi there, this is an AI assistant calling from ${ctx.campaignName}. Is now an okay time to chat?`;

      const naturalScript = buildNaturalSystemPrompt(ctx.script, ctx.campaignName, "AI Assistant", leadName);

      activeCalls.set(callControlId, {
        campaignId,
        campaignName: ctx.campaignName,
        agentName: "AI Assistant",
        agentPrompt: naturalScript,
        callerNumber: ctx.phone,
        calledNumber: fromNumber,
        messages: [
          { role: "system", content: naturalScript },
          { role: "assistant", content: greeting },
        ],
        turnCount: 0,
        startedAt: new Date(),
      });

      logger.info({ callControlId, campaignId, phone: ctx.phone, leadName }, "Outbound call answered — starting AI conversation");

      await startRecording(callControlId).catch((err) =>
        logger.warn({ err, callControlId }, "Outbound recording start failed — continuing")
      );
      await speak(callControlId, greeting);
      return;
    }

    // ── 1b. Inbound call arrives ──────────────────────────────────────────────
    if (eventType === "call.initiated" && direction === "incoming") {
      const result = await getCampaignByNumber(toNumber);

      if (!result) {
        await answerCall(callControlId);
        await speak(callControlId, "Thank you for calling. We are unable to connect your call at this time. Goodbye.");
        return;
      }

      const { campaign, agentName, systemPrompt } = result;
      const greeting = `Thank you for calling ${campaign.name}. This is ${agentName}. How may I help you today?`;

      activeCalls.set(callControlId, {
        campaignId: campaign.id,
        campaignName: campaign.name,
        agentName,
        agentPrompt: systemPrompt,
        callerNumber: fromNumber,
        calledNumber: toNumber,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "assistant", content: greeting },
        ],
        turnCount: 0,
        startedAt: new Date(),
        direction: "inbound",
        stage: "conversation",
      });

      logger.info({ callControlId, campaignId: campaign.id, agentName }, "Answering inbound call");

      await answerCall(callControlId);
      await startRecording(callControlId).catch((err) =>
        logger.warn({ err, callControlId }, "Recording start failed — continuing without recording")
      );
      await speak(callControlId, greeting);
      return;
    }

    // ── 2. Greeting/response done → listen ──────────────────────────────────
    if (eventType === "call.speak.ended") {
      const state = activeCalls.get(callControlId);
      if (!state) return;

      if (state.turnCount >= MAX_TURNS) {
        await speak(callControlId, "Thank you for calling. Someone from our team will follow up with you soon. Have a great day! Goodbye!");
        await finalizeInboundCall(callControlId, state);
        activeCalls.delete(callControlId);
        return;
      }

      await gatherSpeech(callControlId);
      return;
    }

    // ── 3. Caller spoke → generate AI response ───────────────────────────────
    if (eventType === "call.gather.ended") {
      const state = activeCalls.get(callControlId);
      if (!state) return;

      const speechText: string = payload.speech ?? "";
      const digits: string = payload.digits ?? "";
      const reason: string = payload.reason ?? "";

      if (!speechText && !digits) {
        if (reason === "timeout") {
          if (state.turnCount >= 1) {
            await speak(callControlId, "I didn't hear anything. Thank you for calling. Goodbye!");
            await finalizeInboundCall(callControlId, state);
            activeCalls.delete(callControlId);
          } else {
            state.turnCount++;
            await speak(callControlId, "I'm sorry, I didn't catch that. Could you please say something?");
          }
          return;
        }
        return;
      }

      const callerInput = speechText || `Pressed ${digits}`;
      logger.info({ callControlId, callerInput, turn: state.turnCount }, "Caller input");

      if (isGoodbye(callerInput)) {
        await speak(callControlId, "Thank you for calling. Have a wonderful day. Goodbye!");
        state.messages.push({ role: "user", content: callerInput });
        await finalizeInboundCall(callControlId, state);
        activeCalls.delete(callControlId);
        return;
      }

      state.messages.push({ role: "user", content: callerInput });
      state.turnCount++;

      let aiResponse: string;
      try {
        aiResponse = await generateAiResponse(state.messages);
      } catch (err) {
        logger.error({ err, callControlId }, "OpenAI response failed");
        aiResponse = "I'm sorry, I'm having trouble processing that. Could you please repeat?";
      }

      state.messages.push({ role: "assistant", content: aiResponse });
      logger.info({ callControlId, aiResponse, turn: state.turnCount }, "AI response generated");
      await speak(callControlId, aiResponse);
      return;
    }

    // ── 4. Recording saved — update DB record ────────────────────────────────
    if (eventType === "call.recording.saved") {
      const recordingUrl: string = payload.recording_urls?.mp3 ?? payload.public_recording_urls?.mp3 ?? "";
      logger.info({ callControlId, recordingUrl }, "Recording saved");

      if (recordingUrl) {
        // Update existing call log if it exists
        const [existing] = await db
          .select({ id: callLogsTable.id })
          .from(callLogsTable)
          .where(eq(callLogsTable.callControlId, callControlId))
          .limit(1);

        if (existing) {
          await db
            .update(callLogsTable)
            .set({ recordingUrl })
            .where(eq(callLogsTable.id, existing.id));
          logger.info({ callControlId, callLogId: existing.id }, "Recording URL saved to DB");
        } else {
          // Store on active call state so it gets saved when call ends
          const state = activeCalls.get(callControlId);
          if (state) state.recordingUrl = recordingUrl;
        }
      }
      return;
    }

    // ── 5. Call hung up — finalize (inbound or outbound) ─────────────────────
    if (eventType === "call.hangup") {
      const state = activeCalls.get(callControlId);
      if (state) {
        // Outbound calls always have client_state encoded on them
        if (clientStateRaw) {
          logger.info({ callControlId, campaignId: state.campaignId, turns: state.turnCount }, "Outbound call ended");
          await finalizeOutboundCall(callControlId, state);
        } else {
          logger.info({ callControlId, campaignId: state.campaignId, turns: state.turnCount }, "Inbound call ended");
          await finalizeInboundCall(callControlId, state);
        }
        activeCalls.delete(callControlId);
      }
      return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ eventType, callControlId, err: msg }, "Error handling Telnyx webhook");
  }
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
