import axios, { AxiosError } from "axios";
import { logger } from "../lib/logger.js";
import { setActiveCall } from "../lib/redis.js";
import { setVapiMonitorUrls } from "./vapiMonitor.js";

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
  // "blind" → the AI hangs up the moment the call is bridged.
  // "warm"  → the AI greets the human agent, summarizes the lead, then bridges.
  transfer_mode?: "blind" | "warm";
  first_message?: string;   // Optional opening line (bot speaks first)
  lead_id?: string;
  lead_name?: string;
  knowledge_base?: string;  // Optional KB injected into system prompt
  // Vapi phone-number ID to originate from. Per-call override of the
  // VAPI_PHONE_NUMBER_ID env var. Set this to the allocated Telnyx
  // number's Vapi-registered ID so calls go out from the user-selected
  // number pool, not a single global number.
  vapi_phone_number_id?: string;
  background_sound?: string;
  // Voicemail handling: when Vapi detects an answering machine, it plays this
  // message and ends the call. When undefined/empty, Vapi just hangs up on VM.
  vm_drop_message?: string;
  // Enable Vapi's built-in answering-machine detection. When true, Vapi runs
  // its own AMD; when false, the assistant just talks to whoever (or whatever)
  // picks up. Default: true — VM detection is the safer behaviour for
  // outbound campaigns.
  amd_enabled?: boolean;
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

// Behavioural preamble prepended to every system prompt so the agent feels
// human: it must answer the user's actual question instead of plowing through
// the script, keep replies short, and never read out punctuation/markdown.
const NATURAL_CONVERSATION_PREAMBLE = `You are on a live phone call. Behave like a real human salesperson, not a script-reader.

CONVERSATION RULES (these override the script when they conflict):
- Keep replies short and conversational — 1-2 sentences max unless the caller asks for detail.
- If the caller interrupts or asks a question, STOP whatever you were saying and answer THEIR question first. Then, only if it still makes sense, continue the script.
- Never repeat the same line twice. If the caller didn't hear you, paraphrase.
- Never speak markdown, asterisks, bullets, or stage directions out loud. Speak only what a person would actually say.
- If the caller is silent for a few seconds, gently check in ("Are you still there?") instead of restarting the pitch.
- Match the caller's pace and tone. If they sound rushed, be brief. If they're chatting, be warm.

--- SCRIPT / GOAL ---
`;

// Build the inline assistant config sent with each call.
// Exported so the inbound webhook (assistant-request) can build the same
// shape from a campaign row when Vapi asks "what assistant do I run for
// this incoming call?" — keeping outbound and inbound conversation parity.
export function buildAssistant(payload: VapiCallPayload) {
  const voiceProvider = mapVoiceProvider(payload.voice_provider);
  const baseScript = payload.knowledge_base
    ? `${payload.agent_prompt}\n\n--- KNOWLEDGE BASE (use this as your source of truth) ---\n${payload.knowledge_base}`
    : payload.agent_prompt;

  // Append transfer instructions to the prompt when a transfer number is
  // configured so the AI knows exactly when and how to hand off the call.
  const transferInstructions = payload.transfer_number
    ? `\n\n--- TRANSFER INSTRUCTIONS ---\nIf the caller expresses clear interest, agrees to proceed, requests to speak with a human, or asks any question you cannot answer, immediately transfer the call by using the transferCall tool. Say "Let me connect you with our team now" and use the transfer tool right away — do not ask for confirmation. IMPORTANT: Never say or repeat the transfer phone number aloud under any circumstances.`
    : "";

  const systemPrompt = `${NATURAL_CONVERSATION_PREAMBLE}${baseScript}${transferInstructions}`;

  const firstMessage =
    payload.first_message ??
    `Hi${payload.lead_name ? `, am I speaking with ${payload.lead_name}` : " there"}?`;

  // ── Vapi transferCall tool ─────────────────────────────────────────────────
  // When a transfer_number is configured this tool is added to the assistant.
  // Vapi's AI will call it autonomously when the conversation warrants a
  // hand-off. Without this tool entry the AI has no action to execute even if
  // it says "I'll transfer you now" — the call simply stays connected.
  const isWarm = payload.transfer_mode === "warm";
  const tools = payload.transfer_number
    ? [
        {
          type: "transferCall",
          destinations: [
            {
              type: "number",
              number: payload.transfer_number,
              description:
                "Transfer the caller to a live human agent. Use this when the caller is interested, agrees to move forward, asks to speak with a person, or has a question you cannot answer.",
              transferPlan: isWarm
                ? {
                    // Warm transfer: AI stays on the line, summarizes the lead to
                    // the human agent, then drops off. Vapi reads the message to
                    // the human BEFORE bridging the customer in.
                    mode: "warm-transfer-say-message",
                    message: `Transferring an interested lead${
                      payload.lead_name ? ` named ${payload.lead_name}` : ""
                    }${
                      payload.campaign_name ? ` from the ${payload.campaign_name} campaign` : ""
                    }. They wanted to speak with a human. Connecting you now.`,
                  }
                : {
                    // Blind transfer: Vapi hangs up the AI immediately and
                    // bridges the customer straight to the human agent.
                    mode: "blind-transfer",
                  },
            },
          ],
        },
      ]
    : undefined;

  return {
    model: {
      // Groq's llama-3.1-8b-instant returns first token in ~150ms vs ~600ms
      // for gpt-4o-mini — the single biggest latency win for live calls.
      provider: "groq",
      model: "llama-3.1-8b-instant",
      temperature: 0.7,
      maxTokens: 250,
      messages: [{ role: "system", content: systemPrompt }],
      // transferCall must live inside model.tools for inline assistants.
      // Placing it at the assistant top-level causes Vapi to reject the
      // entire call with 400 "assistant.property tools should not exist".
      ...(tools ? { tools } : {}),
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
    // Hang-up only after 30s of total silence (call abandoned).
    silenceTimeoutSeconds: 30,
    maxDurationSeconds: 600,
    // Background ambience comes from the campaign's `background_sound` field.
    // Vapi only ships built-in "office"; everything else (none/typing/cafe) is
    // mapped accordingly. "none" or unset → silent line.
    backgroundSound: ((): "off" | "office" => {
      const v = (payload.background_sound ?? "").toLowerCase();
      return v === "office" ? "office" : "off";
    })(),
    // Backchannel ("mhm", "right") makes the agent feel present while listening.
    backchannelingEnabled: true,
    // ---- Latency / interruption tuning (air.ai-style natural conversation) ----
    // Respond as fast as possible; smart endpointing uses an LLM to detect
    // when the caller has actually finished a thought (vs a brief pause).
    startSpeakingPlan: {
      waitSeconds: 0.1,
      smartEndpointingEnabled: true,
      transcriptionEndpointingPlan: {
        onPunctuationSeconds: 0.1,
        onNoPunctuationSeconds: 0.4,
        onNumberSeconds: 0.3,
      },
    },
    // Barge-in: cut off on the first word; almost no voice-detection delay.
    stopSpeakingPlan: {
      numWords: 1,
      voiceSeconds: 0.1,
      backoffSeconds: 0.5,
    },
    // After ~5s of caller silence, gently check in instead of dead-airing.
    // (Vapi's minimum allowed idle timeout is 5s — closest we can get to the
    // requested 2s without the API rejecting the config.)
    messagePlan: {
      idleMessages: [
        "Are you still there?",
        "Hello, can you hear me?",
        "Just checking — are you on the line?",
      ],
      idleTimeoutSeconds: 5,
      idleMessageMaxSpokenCount: 3,
    },
    serverUrl: `${BACKEND_WEBHOOK_URL}/api/vapi/webhook`,
    // Sent back to us as `x-vapi-secret` header on every webhook event so
    // we can authenticate the request. Falls back to empty if not set
    // (dev only — production must set VAPI_WEBHOOK_SECRET).
    serverUrlSecret: process.env.VAPI_WEBHOOK_SECRET ?? "",
    // Explicitly opt in to every webhook type we consume. Without this list
    // Vapi only sends end-of-call-report by default — transcripts are dropped.
    serverMessages: [
      "status-update",
      "transcript",
      "end-of-call-report",
      "hang",
      "function-call",
    ],
    // Live supervisor support: ask Vapi to expose listen + control URLs in
    // the call response. We persist them in Redis so the dashboard's
    // `listen:join` can find them later (see services/vapiMonitor.ts and
    // websocket/vapiListen.ts).
    monitorPlan: {
      listenEnabled: true,
      controlEnabled: true,
    },
    // ── Voicemail / answering-machine handling ─────────────────────────────
    // Vapi's built-in detection. When it concludes the line is a machine,
    // it skips the conversational assistant and either plays
    // `voicemailMessage` (when set) and hangs up, or just hangs up.
    // Default: ON. Disable per-campaign by setting amdEnabled = false.
    ...(payload.amd_enabled !== false ? {
      voicemailDetection: {
        provider: "vapi",
        backoffPlan: { startAtSeconds: 5, frequencySeconds: 5, maxRetries: 6 },
        beepMaxAwaitSeconds: 10,
      },
      // Message Vapi will speak after the beep, then hang up. When the
      // campaign hasn't configured one we leave it undefined so Vapi just
      // hangs up silently (better than playing nothing weird).
      ...(payload.vm_drop_message?.trim()
        ? { voicemailMessage: payload.vm_drop_message.trim() }
        : {}),
      // Let the model issue an end-call tool when the conversation finishes
      // naturally — required for the post-VM hang-up to take effect.
      endCallFunctionEnabled: true,
    } : {}),
  };
}

export async function vapiDirectCall(payload: VapiCallPayload): Promise<VapiCallResult> {
  if (!VAPI_API_KEY) {
    return { success: false, error: "VAPI_API_KEY environment variable not set" };
  }
  // Last-mile voice resolution: if `voice` arrives as a numeric voices.id
  // (e.g. "60") instead of the provider's actual voice_id string, look it up
  // here. Several upstream paths (campaign loop, dashboard test call, etc.)
  // pass the raw DB id; resolving at the boundary guarantees Vapi always
  // gets a real provider voice ID like "5BTfD9GV7eMTyvzofs0V".
  logger.info({ voice: payload.voice, type: typeof payload.voice, isNumeric: payload.voice ? /^\d+$/.test(payload.voice) : false }, "[VOICE-CHECK] entering vapiDirectCall");
  if (payload.voice && /^\d+$/.test(payload.voice)) {
    logger.info({ voice: payload.voice }, "[VOICE-CHECK] entering resolver branch");
    try {
      const { db, voicesTable } = await import("@workspace/db");
      const { eq } = await import("drizzle-orm");
      const [v] = await db
        .select({ voiceId: voicesTable.voiceId, provider: voicesTable.provider })
        .from(voicesTable)
        .where(eq(voicesTable.id, Number(payload.voice)))
        .limit(1);
      if (v?.voiceId) {
        logger.info({ from: payload.voice, to: v.voiceId, provider: v.provider }, "Resolved numeric voice id");
        payload = { ...payload, voice: v.voiceId, voice_provider: v.provider };
      } else {
        logger.warn({ voice: payload.voice }, "Numeric voice id not found in voices table");
      }
    } catch (e) {
      logger.error({ err: e instanceof Error ? e.message : String(e) }, "Voice resolution lookup failed");
    }
  }
  // Per-call override (allocated from campaign's number pool) takes
  // priority; fall back to the global env var for one-off test calls.
  const phoneNumberId = payload.vapi_phone_number_id ?? VAPI_PHONE_NUMBER_ID;
  if (!phoneNumberId) {
    return {
      success: false,
      error:
        "No Vapi phone number available. Go to Phone Numbers → click 'Sync to Vapi' to register your Telnyx numbers with Vapi, then assign at least one to this campaign.",
    };
  }

  const phone = (payload.phone ?? "").trim();
  if (!/^\+\d{7,15}$/.test(phone)) {
    return { success: false, error: `Invalid destination number "${phone}". Must be E.164.` };
  }

  const body = {
    phoneNumberId,
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
    const monitor = (response.data as { monitor?: { listenUrl?: string; controlUrl?: string } })?.monitor;

    logger.info(
      { phone, callId, status: response.status, hasListenUrl: !!monitor?.listenUrl },
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

      // Persist the supervisor monitor URLs so listen:join (which may land on
      // a different VPS than the one that placed the call) can resolve them.
      if (monitor?.listenUrl || monitor?.controlUrl) {
        await setVapiMonitorUrls(callId, {
          listenUrl: monitor.listenUrl,
          controlUrl: monitor.controlUrl,
        }).catch(() => {}); // non-fatal
      }
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

// ─────────────────────────────────────────────────────────────────────────────
// Telnyx credential + phone-number registration in Vapi
//
// Vapi needs each Telnyx number registered as a Vapi phone-number record
// before it can originate calls from it. The setup is two-step:
//   1. Create a Vapi credential carrying your Telnyx API key (one-time per
//      Telnyx account). Vapi stores it server-side and uses it to talk to
//      Telnyx on your behalf.
//   2. POST /phone-number with provider="byo-phone-number-credential" + the
//      credentialId for each E.164 number. (Vapi's "telnyx" provider name
//      is for Vapi-purchased Telnyx numbers — we want BYO since the user
//      already owns the numbers in their own Telnyx account.)
//
// We cache the credentialId in module memory after first lookup/creation so
// the per-number calls during a sync don't re-list every time.
// ─────────────────────────────────────────────────────────────────────────────

let cachedTelnyxCredentialId: string | null = null;

async function getOrCreateTelnyxCredential(): Promise<{ id: string } | { error: string }> {
  if (cachedTelnyxCredentialId) return { id: cachedTelnyxCredentialId };
  if (!VAPI_API_KEY) return { error: "VAPI_API_KEY not set" };
  const telnyxKey = process.env.TELNYX_API_KEY;
  if (!telnyxKey) return { error: "TELNYX_API_KEY not set" };

  try {
    // Try to find an existing Telnyx credential first (idempotent sync)
    const list = await axios.get(`${VAPI_API_BASE}/credential`, {
      headers: { Authorization: `Bearer ${VAPI_API_KEY}` },
      timeout: 10_000,
    });
    const existing = (list.data as Array<{ id: string; provider: string }>).find(
      (c) => c.provider === "byo-sip-trunk" || c.provider === "telnyx"
    );
    if (existing?.id) {
      cachedTelnyxCredentialId = existing.id;
      return { id: existing.id };
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Could not list Vapi credentials — will try to create");
  }

  // Create a new Telnyx credential carrying the API key
  try {
    const create = await axios.post(
      `${VAPI_API_BASE}/credential`,
      { provider: "telnyx", apiKey: telnyxKey, name: "Shivansh Telnyx" },
      {
        headers: { Authorization: `Bearer ${VAPI_API_KEY}`, "Content-Type": "application/json" },
        timeout: 10_000,
      }
    );
    const id = create.data?.id as string | undefined;
    if (!id) return { error: "Vapi did not return a credential id" };
    cachedTelnyxCredentialId = id;
    return { id };
  } catch (err) {
    const ax = err as AxiosError<{ message?: string }>;
    return { error: `Vapi credential create failed: ${ax.response?.data?.message ?? ax.message}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Inbound assistant resolver
//
// When someone dials a Vapi-registered Telnyx number, Telnyx SIP-forwards
// the call to sip.vapi.ai. Vapi then POSTs `{message:{type:"assistant-request",
// call:{phoneNumber:{number,...},customer:{number,...},...}}}` to our
// configured serverUrl. We look up the called number → its assigned campaign
// (and the campaign's voice + prompt + KB) and return the assistant inline.
//
// Returns either { assistant } (Vapi runs it) or { error } (Vapi rejects the
// call gracefully). Voice resolution mirrors vapiDirectCall — accepts numeric
// voices.id or provider voiceId.
// ─────────────────────────────────────────────────────────────────────────────
export async function buildInboundAssistantForNumber(
  calledE164: string,
  callerE164: string,
): Promise<{ assistant?: ReturnType<typeof buildAssistant>; campaignId?: number; error?: string }> {
  if (!calledE164) return { error: "no called number on inbound request" };

  try {
    const { db, phoneNumbersTable, campaignsTable, voicesTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");

    const [num] = await db
      .select()
      .from(phoneNumbersTable)
      .where(eq(phoneNumbersTable.phoneNumber, calledE164))
      .limit(1);

    if (!num?.campaignId) {
      return { error: `Number ${calledE164} is not assigned to any campaign` };
    }

    const [campaign] = await db
      .select()
      .from(campaignsTable)
      .where(eq(campaignsTable.id, num.campaignId))
      .limit(1);

    if (!campaign) return { error: `Campaign ${num.campaignId} not found` };
    if (campaign.type !== "inbound" && campaign.type !== "both") {
      return { error: `Campaign "${campaign.name}" is outbound-only — refusing inbound call` };
    }

    // Resolve voice: campaigns store either a numeric voices.id or the
    // provider voiceId string. Look up the row to get the real voice + provider.
    let voiceId = campaign.voice ?? "21m00Tcm4TlvDq8ikWAM";
    let voiceProvider = campaign.voiceProvider ?? "elevenlabs";
    if (voiceId && /^\d+$/.test(voiceId)) {
      const [v] = await db
        .select({ voiceId: voicesTable.voiceId, provider: voicesTable.provider })
        .from(voicesTable)
        .where(eq(voicesTable.id, Number(voiceId)))
        .limit(1);
      if (v?.voiceId) {
        voiceId = v.voiceId;
        voiceProvider = v.provider ?? voiceProvider;
      }
    }

    const callerName = callerE164 || "there";
    const inboundFirstMessage = `Hi, this is ${campaign.name}. How can I help you today?`;

    const assistant = buildAssistant({
      phone: callerE164,
      agent_prompt: campaign.agentPrompt ?? "You are a helpful assistant. Greet the caller warmly and ask how you can help.",
      voice: voiceId,
      voice_provider: voiceProvider,
      campaign_id: String(campaign.id),
      campaign_name: campaign.name,
      transfer_number: campaign.transferNumber ?? undefined,
      transfer_mode: (campaign.transferMode === "warm" ? "warm" : "blind") as "blind" | "warm",
      first_message: inboundFirstMessage,
      lead_name: callerName,
      knowledge_base: campaign.knowledgeBase ?? undefined,
      background_sound: campaign.backgroundSound ?? undefined,
    });

    logger.info(
      { calledE164, callerE164, campaignId: campaign.id, voiceId, voiceProvider },
      "Built inbound assistant config",
    );
    return { assistant, campaignId: campaign.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg, calledE164 }, "buildInboundAssistantForNumber failed");
    return { error: msg };
  }
}

// Register a single Telnyx number with Vapi. Idempotent-ish: returns the
// existing id if Vapi 409s on duplicate.
export async function registerNumberWithVapi(opts: {
  number: string;   // E.164
  name?: string;
}): Promise<{ success: boolean; id?: string; error?: string }> {
  if (!VAPI_API_KEY) return { success: false, error: "VAPI_API_KEY not set" };

  const cred = await getOrCreateTelnyxCredential();
  if ("error" in cred) return { success: false, error: cred.error };

  try {
    const resp = await axios.post(
      `${VAPI_API_BASE}/phone-number`,
      {
        provider: "telnyx",
        number: opts.number,
        credentialId: cred.id,
        name: opts.name ?? `Telnyx ${opts.number}`,
        // Hook every Vapi call from this number to our webhook. Per-call
        // assistant configs override this, so it's just a safe default.
        serverUrl: `${BACKEND_WEBHOOK_URL}/api/vapi/webhook`,
        serverUrlSecret: process.env.VAPI_WEBHOOK_SECRET ?? "",
      },
      {
        headers: { Authorization: `Bearer ${VAPI_API_KEY}`, "Content-Type": "application/json" },
        timeout: 10_000,
      }
    );
    return { success: true, id: resp.data?.id };
  } catch (err) {
    const ax = err as AxiosError<{ message?: string | string[] }>;
    const msg = Array.isArray(ax.response?.data?.message)
      ? ax.response.data.message.join("; ")
      : (ax.response?.data?.message ?? ax.message);
    // 409 / "already exists" → try to look it up so we can persist the id
    if (ax.response?.status === 409 || /already exists|duplicate/i.test(msg)) {
      try {
        const list = await axios.get(`${VAPI_API_BASE}/phone-number`, {
          headers: { Authorization: `Bearer ${VAPI_API_KEY}` },
          timeout: 10_000,
        });
        const found = (list.data as Array<{ id: string; number: string }>).find((p) => p.number === opts.number);
        if (found?.id) return { success: true, id: found.id };
      } catch {
        // fall through to error return
      }
    }
    return { success: false, error: msg };
  }
}
