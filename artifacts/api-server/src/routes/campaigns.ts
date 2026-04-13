import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  campaignsTable,
  campaignAgentsTable,
  leadsTable,
  callLogsTable,
  usersTable,
  aiAgentsTable,
  voicesTable,
  phoneNumbersTable,
} from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { authenticate, requireRole } from "../middlewares/auth.js";
import { createAuditLog } from "../lib/audit.js";
import { emitToSupervisors } from "../websocket/index.js";
import { enqueueCall, delay } from "../services/workerService.js";
import { z } from "zod";

const router: IRouter = Router();


const createCampaignSchema = z.object({
  name: z.string().min(1),
  agentId: z.number().optional(),
  type: z.enum(["outbound", "inbound", "both"]).default("outbound"),
  routingType: z.enum(["ai", "human", "ai_then_human"]).default("ai"),
  maxConcurrentCalls: z.number().min(1).max(100).default(5),
  transferRules: z.string().optional(),
  agentPrompt: z.string().optional(),
  knowledgeBase: z.string().optional(),
  recordingNotes: z.string().optional(),
  voice: z.string().optional(),
  fromNumber: z.string().optional(),
  transferNumber: z.string().optional(),
  backgroundSound: z.enum(["none", "office", "typing", "cafe"]).default("none"),
  holdMusic: z.enum(["none", "jazz", "corporate", "smooth", "classical"]).default("none"),
  humanLike: z.string().default("true"),
});

const assignAgentSchema = z.object({
  agentId: z.number(),
});

router.post("/campaigns/create", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const parsed = createCampaignSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [campaign] = await db.insert(campaignsTable).values(parsed.data).returning();

  await createAuditLog({
    userId: req.user?.userId,
    action: "create",
    resource: "campaign",
    resourceId: campaign.id,
  });

  res.status(201).json(campaign);
});

router.get("/campaigns", authenticate, async (req, res): Promise<void> => {
  const campaigns = await db.select().from(campaignsTable);
  res.json(campaigns);
});

// ── /campaigns/options — returns all valid enum values for campaign fields ────
// Frontend uses this to populate Background Sound and Hold Music dropdowns.
router.get("/campaigns/options", authenticate, (_req, res): void => {
  res.json({
    backgroundSound: [
      { value: "none",   label: "None" },
      { value: "office", label: "Office Ambience" },
      { value: "typing", label: "Keyboard Typing" },
      { value: "cafe",   label: "Café Background" },
    ],
    holdMusic: [
      { value: "none",      label: "None" },
      { value: "jazz",      label: "Jazz" },
      { value: "corporate", label: "Corporate" },
      { value: "smooth",    label: "Smooth R&B" },
      { value: "classical", label: "Classical" },
    ],
    voice: [
      { value: "default", label: "Default Voice" },
    ],
    routingType: [
      { value: "ai",           label: "AI Only" },
      { value: "human",        label: "Human Only" },
      { value: "ai_then_human", label: "AI → Human Transfer" },
    ],
    type: [
      { value: "outbound", label: "Outbound" },
      { value: "inbound",  label: "Inbound" },
    ],
  });
});

const updateCampaignSchema = z.object({
  name: z.string().min(1).optional(),
  type: z.enum(["outbound", "inbound", "both"]).optional(),
  agentPrompt: z.string().optional(),
  knowledgeBase: z.string().optional(),
  recordingNotes: z.string().optional(),
  voice: z.string().optional(),
  fromNumber: z.string().optional(),
  transferNumber: z.string().optional(),
  maxConcurrentCalls: z.number().min(1).max(100).optional(),
  backgroundSound: z.enum(["none", "office", "typing", "cafe"]).optional(),
  holdMusic: z.enum(["none", "jazz", "corporate", "smooth", "classical"]).optional(),
  humanLike: z.string().optional(),
  // Allow status changes via PATCH (stop/pause/resume from frontend)
  status: z.enum(["draft", "active", "paused", "completed"]).optional(),
});

router.patch("/campaigns/:id", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid campaign ID" });
    return;
  }

  const parsed = updateCampaignSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [campaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, id));
  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }

  const [updated] = await db
    .update(campaignsTable)
    .set(parsed.data)
    .where(eq(campaignsTable.id, id))
    .returning();

  // Emit WebSocket events when status changes so dashboard updates in real-time
  if (parsed.data.status && parsed.data.status !== campaign.status) {
    if (parsed.data.status === "paused" || parsed.data.status === "completed") {
      emitToSupervisors("campaign:stopped", { campaignId: id, name: campaign.name });
    } else if (parsed.data.status === "active") {
      emitToSupervisors("campaign:started", { campaignId: id, name: campaign.name });
    }
  }

  await createAuditLog({
    userId: req.user?.userId,
    action: "update",
    resource: "campaign",
    resourceId: id,
  });

  res.json(updated);
});

router.post("/campaigns/start/:id", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid campaign ID" });
    return;
  }

  const [campaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, id));
  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }

  if (campaign.status === "active") {
    res.status(400).json({ error: "Campaign is already active" });
    return;
  }

  // For outbound/both campaigns, require at least one pending lead before launching
  if (campaign.type !== "inbound") {
    const [leadCount] = await db
      .select({ count: db.$count(leadsTable) })
      .from(leadsTable)
      .where(and(eq(leadsTable.campaignId, id), eq(leadsTable.status, "pending")));
    const pendingCount = Number(leadCount?.count ?? 0);
    if (pendingCount === 0) {
      // Check if there are any leads at all to give a better error
      const [totalRow] = await db
        .select({ count: db.$count(leadsTable) })
        .from(leadsTable)
        .where(eq(leadsTable.campaignId, id));
      const totalCount = Number(totalRow?.count ?? 0);
      if (totalCount === 0) {
        res.status(400).json({ error: "No leads added yet. Add leads before launching.", code: "no_leads" });
      } else {
        res.status(400).json({ error: "All leads have already been called. Reset leads before launching again.", code: "all_called" });
      }
      return;
    }
  }

  // Activate campaign first so frontend sees the state change immediately
  const [updated] = await db
    .update(campaignsTable)
    .set({ status: "active" })
    .where(eq(campaignsTable.id, id))
    .returning();

  emitToSupervisors("campaign:started", { campaignId: id, name: campaign.name });

  await createAuditLog({
    userId: req.user?.userId,
    action: "start",
    resource: "campaign",
    resourceId: id,
  });

  // Respond immediately — call triggering happens in background
  res.json(updated);

  // Background: trigger calls for outbound campaigns
  if (campaign.type !== "inbound") {
    triggerCampaignCalls(id, campaign).catch((err) => {
      req.log.error({ err, campaignId: id }, "Background call triggering failed");
    });
  }
});

async function triggerCampaignCalls(campaignId: number, campaign: typeof campaignsTable.$inferSelect) {
  const { script, voiceName, fromNumber, transferNumber, backgroundSound, holdMusicUrl } = await resolveCampaignAssets(campaignId, campaign);

  const pendingLeads = await db
    .select()
    .from(leadsTable)
    .where(and(eq(leadsTable.campaignId, campaignId), eq(leadsTable.status, "pending")));

  const concurrency = Math.min(campaign.maxConcurrentCalls ?? 5, 20);

  logger.info({ campaignId, count: pendingLeads.length, concurrency }, `Campaign starting — triggering calls concurrently (${concurrency} at a time)`);

  // Process leads in concurrent batches
  async function processLead(lead: typeof pendingLeads[0]): Promise<void> {
    const [logEntry] = await db
      .insert(callLogsTable)
      .values({ phoneNumber: lead.phone, campaignId, status: "initiated", direction: "outbound" })
      .returning();

    const result = await enqueueCall({
      phone: lead.phone,
      from_number: fromNumber,
      agent_prompt: script,
      voice: voiceName,
      transfer_number: transferNumber,
      campaign_id: String(campaignId),
      campaign_name: campaign.name,
      background_sound: backgroundSound !== "none" ? backgroundSound : undefined,
      hold_music_url: holdMusicUrl ?? undefined,
    });

    await db
      .update(callLogsTable)
      .set({ status: result.success ? "completed" : "failed" })
      .where(eq(callLogsTable.id, logEntry.id));

    await db
      .update(leadsTable)
      .set({ status: "called" })
      .where(eq(leadsTable.id, lead.id));
  }

  // Concurrency pool — run `concurrency` leads simultaneously
  let index = 0;
  async function worker(): Promise<void> {
    while (true) {
      const lead = pendingLeads[index++];
      if (!lead) break;

      // Re-check if campaign is still active before each call
      const [current] = await db
        .select({ status: campaignsTable.status })
        .from(campaignsTable)
        .where(eq(campaignsTable.id, campaignId))
        .limit(1);
      if (current?.status !== "active") break;

      await processLead(lead).catch((err) => {
        logger.error({ err, leadId: lead.id, phone: lead.phone, campaignId }, "Call dispatch failed for lead");
      });

      // Small jitter between calls in the same worker to avoid burst
      const jitter = 200 + Math.floor(Math.random() * 300);
      await delay(jitter);
    }
  }

  // Launch `concurrency` workers in parallel
  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.allSettled(workers);

  logger.info({ campaignId, count: pendingLeads.length }, `Campaign finished dispatching all calls`);

  await db
    .update(campaignsTable)
    .set({ status: "paused" })
    .where(eq(campaignsTable.id, campaignId));
  emitToSupervisors("campaign:stopped", { campaignId, name: campaign.name, reason: "all_leads_called" });
}

// Hold music URL map — royalty-free SoundHelix MP3s (no auth, direct download)
const HOLD_MUSIC_URLS: Record<string, string | null> = {
  none:      null,
  jazz:      "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-6.mp3",
  corporate: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
  smooth:    "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-9.mp3",
  classical: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3",
};

// Human-like conversation instructions injected when humanLike = true
const HUMAN_LIKE_INSTRUCTIONS = `
=== CONVERSATION STYLE INSTRUCTIONS ===
Sound completely natural and human — never robotic or scripted. Follow these rules:

SPEECH PATTERNS:
- Use natural fillers occasionally: "uh", "um", "you know", "right", "sure"
- Add brief thinking pauses: "Let me just check that..." / "Give me one moment..."
- Vary your sentence length — mix short punchy lines with longer explanations
- Use contractions always: "I'm", "we're", "it's", "that's", "don't"
- React naturally to what the person says before moving on

EMPATHY & WARMTH:
- Mirror the caller's energy — if they're warm, be warm back; if formal, stay professional
- Acknowledge feelings: "I completely understand", "That makes total sense", "Of course"
- Celebrate small wins: "Perfect!", "Great, that's exactly right", "Wonderful"
- If they seem busy: "I'll keep this brief" / "This will only take a minute"

PACING:
- Don't rush — leave natural silence for the person to think or respond
- After asking a question, WAIT — don't fill every gap with words
- If they haven't understood, rephrase simply rather than repeating word-for-word

NEVER DO:
- Never say "As an AI..." or reveal you are an AI unless directly asked
- Never use overly formal phrases like "Certainly!" or "Absolutely!" repeatedly
- Never read from a script in a monotone — vary your tone with the conversation
=== END STYLE INSTRUCTIONS ===
`;

async function resolveCampaignAssets(campaignId: number, campaign: typeof campaignsTable.$inferSelect) {
  const DEFAULT_PROMPT = `You are a friendly, professional voice agent making an outbound call. Here's how you handle the call:

OPENING — be warm and natural:
"Hey, is this [Lead Name]? Hey! This is [Name] calling from our team — hope I'm not catching you at a bad time?"

Wait for their response. If they sound rushed: "I'll keep it super quick, I promise."

CONFIRM THEIR DETAILS — one at a time, conversationally:
"Just want to make sure I've got the right person — could you confirm your full name for me?"
[pause, listen]
"And the best number to reach you — is this still it?"
[pause, listen]
"Perfect. And an email address I can send anything over to?"
[pause, listen]

PURPOSE — natural transition:
"So the reason I'm reaching out today..." [explain the purpose of the call clearly and briefly]

CLOSE — genuine and warm:
"Is there anything else I can help you with while I have you?" 
[listen]
"Brilliant, I really appreciate your time. Have a great rest of your day!"

HANDLING OBJECTIONS:
- "Not interested" → "Totally fair, I appreciate your honesty. Is it okay if I just leave a quick note in case things change?"
- "Call back later" → "Of course — what time works best for you?"
- "Remove me from list" → "Absolutely, I'll take care of that right now. Sorry for the interruption and have a great day!"

TONE: Be a real person having a real conversation. Stay warm, listen actively, and never rush.`;

  // Campaign's own fields take priority over linked AI agent values
  let basePrompt = campaign.agentPrompt ?? DEFAULT_PROMPT;

  // Build combined script: knowledge base → human-like style → main prompt → recording learnings
  const parts: string[] = [];
  if (campaign.knowledgeBase?.trim()) {
    parts.push(`=== KNOWLEDGE BASE & SOPs ===\n${campaign.knowledgeBase.trim()}\n=== END KNOWLEDGE BASE ===`);
  }
  // Inject human-like instructions when enabled (default: true)
  if (campaign.humanLike !== "false") {
    parts.push(HUMAN_LIKE_INSTRUCTIONS.trim());
  }
  parts.push(basePrompt.trim());
  if (campaign.recordingNotes?.trim()) {
    parts.push(`=== LEARNING FROM RECORDINGS ===\n${campaign.recordingNotes.trim()}\n=== END LEARNING ===`);
  }
  let script = parts.join("\n\n");
  let voiceName = campaign.voice ?? "default";
  let fromNumber = campaign.fromNumber ?? process.env.DEFAULT_FROM_NUMBER ?? "+10000000000";
  const transferNumber = campaign.transferNumber ?? campaign.transferRules ?? undefined;

  // Background sound to pass to worker
  const backgroundSound = campaign.backgroundSound ?? "none";

  // Hold music URL resolved from preset name
  const holdMusicPreset = campaign.holdMusic ?? "none";
  const holdMusicUrl = HOLD_MUSIC_URLS[holdMusicPreset] ?? null;

  // Supplement from linked AI agent only when campaign fields are absent
  if ((!campaign.agentPrompt || !campaign.voice) && campaign.agentId) {
    const [agent] = await db
      .select()
      .from(aiAgentsTable)
      .where(eq(aiAgentsTable.id, campaign.agentId))
      .limit(1);

    if (agent) {
      if (!campaign.agentPrompt) script = agent.prompt;

      if (!campaign.voice && agent.defaultVoiceId) {
        const [voice] = await db
          .select()
          .from(voicesTable)
          .where(eq(voicesTable.id, agent.defaultVoiceId))
          .limit(1);

        if (voice) voiceName = voice.voiceId;
      }
    }
  }

  // Supplement fromNumber from campaign's assigned phone number if not set directly
  if (!campaign.fromNumber) {
    const [phoneRow] = await db
      .select()
      .from(phoneNumbersTable)
      .where(and(eq(phoneNumbersTable.campaignId, campaignId), eq(phoneNumbersTable.status, "active")))
      .limit(1);

    if (phoneRow) fromNumber = phoneRow.phoneNumber;
  }

  return { script, voiceName, fromNumber, transferNumber, backgroundSound, holdMusicUrl };
}

// Shared logger (pino-style simple wrapper)
const logger = {
  info: (msg: string) => console.log(JSON.stringify({ level: "info", msg, time: Date.now() })),
  error: (msg: string) => console.error(JSON.stringify({ level: "error", msg, time: Date.now() })),
};

router.post("/campaigns/stop/:id", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid campaign ID" });
    return;
  }

  const [campaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, id));
  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }

  const [updated] = await db
    .update(campaignsTable)
    .set({ status: "paused" })
    .where(eq(campaignsTable.id, id))
    .returning();

  emitToSupervisors("campaign:stopped", { campaignId: id, name: campaign.name });

  await createAuditLog({
    userId: req.user?.userId,
    action: "stop",
    resource: "campaign",
    resourceId: id,
  });

  res.json(updated);
});

// ── POST /campaigns/:id/test-call — fire a single test call ──────────────────
router.post("/campaigns/:id/test-call", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid campaign ID" }); return; }

  const phone: string | undefined = req.body?.phone;
  if (!phone) { res.status(400).json({ error: "phone is required" }); return; }

  const [campaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, id)).limit(1);
  if (!campaign) { res.status(404).json({ error: "Campaign not found" }); return; }

  const { script, voiceName, fromNumber, transferNumber, backgroundSound, holdMusicUrl } = await resolveCampaignAssets(id, campaign);

  const [logEntry] = await db
    .insert(callLogsTable)
    .values({ phoneNumber: phone, campaignId: id, status: "initiated" })
    .returning();

  const result = await enqueueCall({
    phone,
    from_number: fromNumber,
    agent_prompt: script,
    voice: voiceName,
    transfer_number: transferNumber,
    campaign_id: String(id),
    campaign_name: `[TEST] ${campaign.name}`,
    background_sound: backgroundSound !== "none" ? backgroundSound : undefined,
    hold_music_url: holdMusicUrl ?? undefined,
  });

  await db
    .update(callLogsTable)
    .set({ status: result.success ? "completed" : "failed" })
    .where(eq(callLogsTable.id, logEntry.id));

  if (result.success) {
    res.json({ success: true, jobId: (result.data as { jobId?: string })?.jobId, phone, fromNumber, voice: voiceName, workerResponse: result.data });
  } else {
    res.status(502).json({ success: false, error: result.error, phone, fromNumber });
  }
});

// ── POST /campaigns/:id/reset-leads — reset all leads back to pending ─────────
router.post("/campaigns/:id/reset-leads", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid campaign ID" });
    return;
  }

  const [campaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, id));
  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }

  if (campaign.status === "active") {
    res.status(400).json({ error: "Stop the campaign before resetting leads" });
    return;
  }

  const result = await db
    .update(leadsTable)
    .set({ status: "pending" })
    .where(and(
      eq(leadsTable.campaignId, id),
      inArray(leadsTable.status, ["called", "callback", "completed"]),
    ))
    .returning({ id: leadsTable.id });

  res.json({ reset: result.length, campaignId: id });
});

router.post("/campaigns/:id/agents", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const campaignId = parseInt(rawId, 10);
  if (isNaN(campaignId)) {
    res.status(400).json({ error: "Invalid campaign ID" });
    return;
  }

  const parsed = assignAgentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [agent] = await db
    .select()
    .from(usersTable)
    .where(and(eq(usersTable.id, parsed.data.agentId), eq(usersTable.role, "agent")));

  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const [assignment] = await db
    .insert(campaignAgentsTable)
    .values({ campaignId, agentId: parsed.data.agentId })
    .returning();

  res.status(201).json(assignment);
});

router.get("/campaigns/:id/agents", authenticate, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const campaignId = parseInt(rawId, 10);
  if (isNaN(campaignId)) {
    res.status(400).json({ error: "Invalid campaign ID" });
    return;
  }

  const agents = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      status: usersTable.status,
    })
    .from(campaignAgentsTable)
    .innerJoin(usersTable, eq(campaignAgentsTable.agentId, usersTable.id))
    .where(eq(campaignAgentsTable.campaignId, campaignId));

  res.json(agents);
});

// ── REST-conventional aliases (/:id/start|stop|pause|resume and POST /campaigns) ──
// These mirror the /start/:id and /stop/:id routes so either URL shape works.

router.post("/campaigns", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const parsed = createCampaignSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [campaign] = await db.insert(campaignsTable).values(parsed.data).returning();
  res.status(201).json(campaign);
});

async function getCampaignOrFail(id: number, res: import("express").Response): Promise<typeof campaignsTable.$inferSelect | null> {
  const [campaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, id));
  if (!campaign) { res.status(404).json({ error: "Campaign not found" }); return null; }
  return campaign;
}

/** Returns false and sends a 400 if the outbound campaign has no pending leads. */
async function guardPendingLeads(id: number, campaign: typeof campaignsTable.$inferSelect, res: import("express").Response): Promise<boolean> {
  if (campaign.type === "inbound") return true;
  const [pendingRow] = await db.select({ count: db.$count(leadsTable) }).from(leadsTable).where(and(eq(leadsTable.campaignId, id), eq(leadsTable.status, "pending")));
  if (Number(pendingRow?.count ?? 0) > 0) return true;
  const [totalRow] = await db.select({ count: db.$count(leadsTable) }).from(leadsTable).where(eq(leadsTable.campaignId, id));
  if (Number(totalRow?.count ?? 0) === 0) {
    res.status(400).json({ error: "No leads added yet. Add leads before launching.", code: "no_leads" });
  } else {
    res.status(400).json({ error: "All leads have already been called. Reset leads before launching again.", code: "all_called" });
  }
  return false;
}

router.post("/campaigns/:id/start", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid campaign ID" }); return; }
  const campaign = await getCampaignOrFail(id, res);
  if (!campaign) return;
  if (campaign.status === "active") { res.status(400).json({ error: "Campaign is already active" }); return; }
  if (!await guardPendingLeads(id, campaign, res)) return;
  const [updated] = await db.update(campaignsTable).set({ status: "active" }).where(eq(campaignsTable.id, id)).returning();
  emitToSupervisors("campaign:started", { campaignId: id, name: campaign.name });
  res.json(updated);
  if (campaign.type !== "inbound") {
    triggerCampaignCalls(id, campaign).catch((err) => console.error("Background call triggering failed", err));
  }
});

router.post("/campaigns/:id/stop", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid campaign ID" }); return; }
  const campaign = await getCampaignOrFail(id, res);
  if (!campaign) return;
  const [updated] = await db.update(campaignsTable).set({ status: "paused" }).where(eq(campaignsTable.id, id)).returning();
  emitToSupervisors("campaign:stopped", { campaignId: id, name: campaign.name });
  res.json(updated);
});

// ── GET /campaigns/:id — fetch a single campaign ──────────────────────────────
router.get("/campaigns/:id", authenticate, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid campaign ID" }); return; }
  const campaign = await getCampaignOrFail(id, res);
  if (!campaign) return;
  res.json(campaign);
});

// ── DELETE /campaigns/:id — delete a campaign and all its leads ───────────────
router.delete("/campaigns/:id", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid campaign ID" }); return; }

  const campaign = await getCampaignOrFail(id, res);
  if (!campaign) return;

  if (campaign.status === "active") {
    res.status(400).json({ error: "Stop the campaign before deleting it" });
    return;
  }

  // Delete child records first to respect foreign key constraints
  await db.delete(leadsTable).where(eq(leadsTable.campaignId, id));
  await db.delete(callLogsTable).where(eq(callLogsTable.campaignId, id));
  await db.delete(campaignAgentsTable).where(eq(campaignAgentsTable.campaignId, id));
  await db.delete(campaignsTable).where(eq(campaignsTable.id, id));

  await createAuditLog({
    userId: req.user?.userId,
    action: "delete",
    resource: "campaign",
    resourceId: id,
  });

  emitToSupervisors("campaign:stopped", { campaignId: id, name: campaign.name });
  res.json({ success: true, deleted: { id, name: campaign.name } });
});

router.post("/campaigns/:id/pause", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid campaign ID" }); return; }
  const campaign = await getCampaignOrFail(id, res);
  if (!campaign) return;
  const [updated] = await db.update(campaignsTable).set({ status: "paused" }).where(eq(campaignsTable.id, id)).returning();
  emitToSupervisors("campaign:stopped", { campaignId: id, name: campaign.name });
  res.json(updated);
});

router.post("/campaigns/:id/resume", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid campaign ID" }); return; }
  const campaign = await getCampaignOrFail(id, res);
  if (!campaign) return;
  if (campaign.status === "active") { res.status(400).json({ error: "Campaign is already active" }); return; }
  if (!await guardPendingLeads(id, campaign, res)) return;
  const [updated] = await db.update(campaignsTable).set({ status: "active" }).where(eq(campaignsTable.id, id)).returning();
  emitToSupervisors("campaign:started", { campaignId: id, name: campaign.name });
  res.json(updated);
  if (campaign.type !== "inbound") {
    triggerCampaignCalls(id, campaign).catch((err) => console.error("Background call triggering failed", err));
  }
});

export default router;
