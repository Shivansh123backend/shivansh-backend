import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  campaignsTable,
  campaignAgentsTable,
  leadsTable,
  leadListsTable,
  callLogsTable,
  usersTable,
  aiAgentsTable,
  voicesTable,
  phoneNumbersTable,
  dncListTable,
} from "@workspace/db";
import { eq, and, inArray, sql, asc, desc, or } from "drizzle-orm";
import { authenticate, requireRole } from "../middlewares/auth.js";
import { createAuditLog } from "../lib/audit.js";
import { emitToSupervisors } from "../websocket/index.js";
import { enqueueCall, delay } from "../services/workerService.js";
import { logger } from "../lib/logger.js";
import { z } from "zod";

const router: IRouter = Router();

// ── Campaign run lock — prevents the same campaign from being double-started ──
// Maps campaignId → true while triggerCampaignCalls is running in this process
const activeCampaignRuns = new Map<number, boolean>();


const createCampaignSchema = z.object({
  name: z.string().min(1),
  agentId: z.preprocess((v) => (v === "" || v == null ? null : typeof v === "string" ? Number(v) : v), z.number().nullish()),
  type: z.enum(["outbound", "inbound", "both"]).default("outbound"),
  routingType: z.enum(["ai", "human", "ai_then_human"]).default("ai"),
  routingStrategy: z.enum(["round_robin", "priority", "sequential"]).default("round_robin"),
  maxConcurrentCalls: z.number().min(1).max(100).default(5),
  transferRules: z.string().nullish(),
  agentPrompt: z.string().nullish(),
  knowledgeBase: z.string().nullish(),
  recordingNotes: z.string().nullish(),
  voice: z.string().nullish(),
  fromNumber: z.string().nullish(),
  transferNumber: z.string().nullish(),
  backgroundSound: z.enum(["none", "office"]).default("none"),
  holdMusic: z.enum(["none", "jazz", "corporate", "smooth", "classical"]).default("none"),
  humanLike: z.string().default("true"),
  // Dialing engine
  dialingMode: z.enum(["manual", "progressive", "predictive", "preview"]).default("progressive"),
  dialingRatio: z.number().min(1).max(20).default(1),
  dialingSpeed: z.number().min(1).max(120).default(10),
  dropRateLimit: z.number().min(1).max(50).default(3),
  retryAttempts: z.number().min(0).max(10).default(2),
  retryIntervalMinutes: z.number().min(1).max(1440).default(60),
  workingHoursStart: z.string().nullish(),
  workingHoursEnd: z.string().nullish(),
  workingHoursTimezone: z.string().nullish().transform(v => v ?? "UTC"),
  amdEnabled: z.boolean().default(false),
  tcpaEnabled: z.boolean().default(false),
  voiceProvider: z.enum(["elevenlabs", "deepgram", "cartesia"]).default("elevenlabs").nullish(),
  useVapi: z.boolean().default(false),
  vmDropMessage: z.string().nullish(),
  // Geo + voice profile (additive)
  region: z.enum(["US", "UK", "CA", "AU", "IN", "OTHER"]).nullish(),
  accent: z.enum(["US", "UK", "neutral"]).nullish(),
  voiceProfile: z.string().nullish(),
});

const assignAgentSchema = z.object({
  agentId: z.number(),
  // Used by routing strategies "priority" and "sequential" — lower = first.
  // Optional; defaults to 1.
  priority: z.number().int().min(1).max(999).optional(),
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

// ── DRAFT campaign system ─────────────────────────────────────────────────────
// Lenient create — only `name` is required. Everything else can be filled in
// later via PATCH /campaigns/:id. The campaign is forced to status="draft" so
// the dialer never picks it up until the user explicitly launches it.
//
// Frontend usage:
//   POST /campaigns/draft  { name?: "Untitled draft", ...partial fields }
//     → returns { id, ...row }  — store the id in component state and use
//       PATCH /campaigns/:id for every subsequent autosave
//   GET  /campaigns/drafts → list everything where status='draft' (so the user
//       can resume an in-progress draft from the campaigns list)
const draftCampaignSchema = z.object({
  name: z.string().min(1).default("Untitled draft"),
  agentId: z.preprocess((v) => (v === "" || v == null ? null : typeof v === "string" ? Number(v) : v), z.number().nullish()),
  type: z.enum(["outbound", "inbound", "both"]).optional(),
  routingType: z.enum(["ai", "human", "ai_then_human"]).optional(),
  routingStrategy: z.enum(["round_robin", "priority", "sequential"]).optional(),
  agentPrompt: z.string().nullish(),
  knowledgeBase: z.string().nullish(),
  recordingNotes: z.string().nullish(),
  voice: z.string().nullish(),
  voiceProvider: z.enum(["elevenlabs", "deepgram", "cartesia"]).nullish(),
  fromNumber: z.string().nullish(),
  transferNumber: z.string().nullish(),
  transferRules: z.string().nullish(),
  maxConcurrentCalls: z.number().min(1).max(100).optional(),
  backgroundSound: z.enum(["none", "office"]).optional(),
  holdMusic: z.enum(["none", "jazz", "corporate", "smooth", "classical"]).optional(),
  humanLike: z.string().optional(),
  dialingMode: z.enum(["manual", "progressive", "predictive", "preview"]).optional(),
  dialingRatio: z.number().min(1).max(20).nullish(),
  dialingSpeed: z.number().min(1).max(120).nullish(),
  dropRateLimit: z.number().min(1).max(50).nullish(),
  retryAttempts: z.number().min(0).max(10).nullish(),
  retryIntervalMinutes: z.number().min(1).max(1440).nullish(),
  workingHoursStart: z.string().nullish(),
  workingHoursEnd: z.string().nullish(),
  workingHoursTimezone: z.string().nullish(),
  amdEnabled: z.boolean().optional(),
  tcpaEnabled: z.boolean().optional(),
  useVapi: z.boolean().optional(),
  vmDropMessage: z.string().nullish(),
  region: z.enum(["US", "UK", "CA", "AU", "IN", "OTHER"]).nullish(),
  accent: z.enum(["US", "UK", "neutral"]).nullish(),
  voiceProfile: z.string().nullish(),
});

router.post("/campaigns/draft", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const parsed = draftCampaignSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [campaign] = await db
    .insert(campaignsTable)
    .values({ ...parsed.data, status: "draft" })
    .returning();

  await createAuditLog({
    userId: req.user?.userId,
    action: "create_draft",
    resource: "campaign",
    resourceId: campaign.id,
  });

  res.status(201).json(campaign);
});

router.get("/campaigns/drafts", authenticate, async (_req, res): Promise<void> => {
  const drafts = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.status, "draft"))
    .orderBy(desc(campaignsTable.updatedAt));
  res.json(drafts);
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
  agentId: z.preprocess((v) => (v === "" || v == null ? null : typeof v === "string" ? Number(v) : v), z.number().nullish()),
  routingType: z.enum(["ai", "human", "ai_then_human"]).optional(),
  routingStrategy: z.enum(["round_robin", "priority", "sequential"]).optional(),
  agentPrompt: z.string().nullish(),
  knowledgeBase: z.string().nullish(),
  recordingNotes: z.string().nullish(),
  voice: z.string().nullish(),
  fromNumber: z.string().nullish(),
  transferNumber: z.string().nullish(),
  transferRules: z.string().nullish(),
  maxConcurrentCalls: z.number().min(1).max(100).optional(),
  backgroundSound: z.enum(["none", "office"]).optional(),
  holdMusic: z.enum(["none", "jazz", "corporate", "smooth", "classical"]).optional(),
  humanLike: z.string().optional(),
  // Allow status changes via PATCH (stop/pause/resume from frontend)
  status: z.enum(["draft", "active", "paused", "completed"]).optional(),
  // Dialing engine
  dialingMode: z.enum(["manual", "progressive", "predictive", "preview"]).optional(),
  dialingRatio: z.number().min(1).max(20).nullish(),
  dialingSpeed: z.number().min(1).max(120).nullish(),
  dropRateLimit: z.number().min(1).max(50).nullish(),
  retryAttempts: z.number().min(0).max(10).nullish(),
  retryIntervalMinutes: z.number().min(1).max(1440).nullish(),
  workingHoursStart: z.string().nullish(),
  workingHoursEnd: z.string().nullish(),
  workingHoursTimezone: z.string().optional(),
  amdEnabled: z.boolean().optional(),
  tcpaEnabled: z.boolean().optional(),
  voiceProvider: z.enum(["elevenlabs", "deepgram", "cartesia"]).optional(),
  useVapi: z.boolean().optional(),
  region: z.enum(["US", "UK", "CA", "AU", "IN", "OTHER"]).nullish(),
  accent: z.enum(["US", "UK", "neutral"]).nullish(),
  voiceProfile: z.string().nullish(),
  vmDropMessage: z.string().nullish(),
});

router.patch("/campaigns/:id", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid campaign ID" });
    return;
  }

  // ── Tolerant pre-processing of the body ────────────────────────────────────
  // The frontend "Resume Draft" path re-sends the full stored row, including
  // null values for unset fields and JSON objects/arrays for fields stored as
  // serialized strings. Strip nulls (they mean "no change") and stringify any
  // object/array values for the few text-stored JSON columns.
  const JSON_TEXT_FIELDS = new Set(["voiceProfile", "transferRules"]);
  const cleanBody: Record<string, unknown> = {};
  for (const [k, v] of Object.entries((req.body ?? {}) as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;            // skip nulls
    if (JSON_TEXT_FIELDS.has(k) && typeof v !== "string") {
      cleanBody[k] = JSON.stringify(v);
    } else {
      cleanBody[k] = v;
    }
  }

  const parsed = updateCampaignSchema.safeParse(cleanBody);
  if (!parsed.success) {
    logger.warn({ campaignId: id, body: cleanBody, errors: parsed.error.message }, "PATCH /campaigns rejected by schema");
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // ── Server-authoritative voice/provider coupling ────────────────────────────
  // If the client sent a non-empty `voice`, look it up in the voices table and
  // override `voiceProvider` from the DB row. This prevents drift where the
  // dashboard sends a stale or wrong provider for the chosen voiceId.
  // Empty string means "clear" → drop both fields so DB keeps its current value.
  if (typeof parsed.data.voice === "string") {
    const v = parsed.data.voice.trim();
    if (!v || v === "default") {
      delete (parsed.data as Record<string, unknown>).voice;
      delete (parsed.data as Record<string, unknown>).voiceProvider;
    } else {
      const [voiceRow] = await db
        .select({ provider: voicesTable.provider })
        .from(voicesTable)
        .where(eq(voicesTable.voiceId, v))
        .limit(1);
      if (voiceRow) {
        parsed.data.voiceProvider = voiceRow.provider as "elevenlabs" | "deepgram" | "cartesia";
      }
      // If voice not in catalog (e.g. user pasted a raw ElevenLabs id), keep
      // whatever provider the client sent (or fall back to elevenlabs).
      if (!parsed.data.voiceProvider) parsed.data.voiceProvider = "elevenlabs";
    }
  }

  // Temporary diagnostics — voice change debugging.
  logger.info(
    {
      campaignId: id,
      bodyKeys: Object.keys(req.body ?? {}),
      bodyVoice: (req.body as Record<string, unknown>)?.voice,
      bodyVoiceProvider: (req.body as Record<string, unknown>)?.voiceProvider,
      bodyUseVapi: (req.body as Record<string, unknown>)?.useVapi,
      bodyUseVapiType: typeof (req.body as Record<string, unknown>)?.useVapi,
      parsedVoice: parsed.data.voice,
      parsedVoiceProvider: parsed.data.voiceProvider,
      parsedUseVapi: parsed.data.useVapi,
    },
    "PATCH /campaigns — incoming voice fields",
  );

  const [campaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, id));
  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }

  // No-op: every supplied field was null/undefined → nothing to update.
  // Return the current row so the dashboard's "Save" feedback succeeds.
  if (Object.keys(parsed.data).length === 0) {
    res.json(campaign);
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

  // For outbound/both campaigns, ensure there are callable leads.
  // Source = leads directly attached to the campaign UNION leads from any
  // active list assigned to this campaign.
  if (campaign.type !== "inbound") {
    const startAssignedListIds = (await db
      .select({ id: leadListsTable.id })
      .from(leadListsTable)
      .where(and(eq(leadListsTable.campaignId, id), eq(leadListsTable.active, true)))
    ).map(r => r.id);
    const startSourceFilter = startAssignedListIds.length > 0
      ? or(eq(leadsTable.campaignId, id), inArray(leadsTable.listId, startAssignedListIds))
      : eq(leadsTable.campaignId, id);

    const [pendingRow] = await db
      .select({ count: db.$count(leadsTable) })
      .from(leadsTable)
      .where(and(startSourceFilter, eq(leadsTable.status, "pending")));
    const pendingCount = Number(pendingRow?.count ?? 0);

    if (pendingCount === 0) {
      // Check if there are any leads at all (across direct + assigned lists)
      const [totalRow] = await db
        .select({ count: db.$count(leadsTable) })
        .from(leadsTable)
        .where(startSourceFilter);
      const totalCount = Number(totalRow?.count ?? 0);

      if (totalCount === 0) {
        res.status(400).json({ error: "No leads added yet. Add leads before launching.", code: "no_leads" });
        return;
      }

      // Auto-reset previously dialled leads so they can be dialled again.
      // Only the lead_status enum values that mean "already tried, safe to
      // redial" — `callback` is left alone (scheduler handles it) and
      // `do_not_call` must never be re-dialled.
      const resetResult = await db
        .update(leadsTable)
        .set({ status: "pending", retryCount: 0 })
        .where(and(
          startSourceFilter,
          inArray(leadsTable.status, ["called", "completed"]),
        ))
        .returning({ id: leadsTable.id });

      if (resetResult.length === 0) {
        // Leads exist but none are eligible for redial (all DNC, scheduled
        // callbacks, etc). Tell the user clearly instead of starting an
        // empty engine.
        const breakdown = await db
          .select({ status: leadsTable.status, count: db.$count(leadsTable) })
          .from(leadsTable)
          .where(startSourceFilter)
          .groupBy(leadsTable.status);
        const summary = breakdown.map(b => `${b.count} ${b.status}`).join(", ");
        res.status(400).json({
          error: `No leads ready to dial (${summary}). Upload new leads, or clear scheduled callbacks / DNC entries.`,
          code: "no_pending_leads",
          totalLeads: totalCount,
          pendingLeads: 0,
          breakdown,
        });
        return;
      }
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

// ── TCPA per-lead timezone scrubbing ─────────────────────────────────────────
// Maps US NPA (area code) → IANA timezone. Covers all 50 states.
// If a lead's local time falls outside 8am–9pm, skip it (TCPA safe-harbour).
const AREA_CODE_TZ: Record<string, string> = {
  // Eastern
  "201":"America/New_York","202":"America/New_York","203":"America/New_York",
  "207":"America/New_York","212":"America/New_York","215":"America/New_York",
  "216":"America/New_York","217":"America/Chicago","218":"America/Chicago",
  "219":"America/Chicago","224":"America/Chicago","225":"America/Chicago",
  "228":"America/Chicago","229":"America/New_York","231":"America/Detroit",
  "234":"America/New_York","239":"America/New_York","240":"America/New_York",
  "248":"America/Detroit","251":"America/Chicago","252":"America/New_York",
  "253":"America/Los_Angeles","254":"America/Chicago","256":"America/Chicago",
  "260":"America/Indiana/Indianapolis","267":"America/New_York","269":"America/Detroit",
  "270":"America/Chicago","272":"America/New_York","274":"America/Chicago",
  "276":"America/New_York","281":"America/Chicago","301":"America/New_York",
  "302":"America/New_York","303":"America/Denver","304":"America/New_York",
  "305":"America/New_York","307":"America/Denver","308":"America/Chicago",
  "309":"America/Chicago","310":"America/Los_Angeles","312":"America/Chicago",
  "313":"America/Detroit","314":"America/Chicago","315":"America/New_York",
  "316":"America/Chicago","317":"America/Indiana/Indianapolis","318":"America/Chicago",
  "319":"America/Chicago","320":"America/Chicago","321":"America/New_York",
  "323":"America/Los_Angeles","325":"America/Chicago","330":"America/New_York",
  "331":"America/Chicago","334":"America/Chicago","336":"America/New_York",
  "337":"America/Chicago","339":"America/New_York","340":"America/St_Thomas",
  "346":"America/Chicago","347":"America/New_York","351":"America/New_York",
  "352":"America/New_York","360":"America/Los_Angeles","361":"America/Chicago",
  "364":"America/Chicago","380":"America/New_York","385":"America/Denver",
  "386":"America/New_York","401":"America/New_York","402":"America/Chicago",
  "404":"America/New_York","405":"America/Chicago","406":"America/Denver",
  "407":"America/New_York","408":"America/Los_Angeles","409":"America/Chicago",
  "410":"America/New_York","412":"America/New_York","413":"America/New_York",
  "414":"America/Chicago","415":"America/Los_Angeles","417":"America/Chicago",
  "419":"America/New_York","423":"America/New_York","424":"America/Los_Angeles",
  "425":"America/Los_Angeles","430":"America/Chicago","432":"America/Chicago",
  "434":"America/New_York","435":"America/Denver","440":"America/New_York",
  "442":"America/Los_Angeles","443":"America/New_York","445":"America/New_York",
  "458":"America/Los_Angeles","463":"America/Indiana/Indianapolis","469":"America/Chicago",
  "470":"America/New_York","475":"America/New_York","478":"America/New_York",
  "479":"America/Chicago","480":"America/Phoenix","484":"America/New_York",
  "501":"America/Chicago","502":"America/New_York","503":"America/Los_Angeles",
  "504":"America/Chicago","505":"America/Denver","507":"America/Chicago",
  "508":"America/New_York","509":"America/Los_Angeles","510":"America/Los_Angeles",
  "512":"America/Chicago","513":"America/New_York","515":"America/Chicago",
  "516":"America/New_York","517":"America/Detroit","518":"America/New_York",
  "520":"America/Phoenix","530":"America/Los_Angeles","531":"America/Chicago",
  "534":"America/Chicago","539":"America/Chicago","540":"America/New_York",
  "541":"America/Los_Angeles","551":"America/New_York","559":"America/Los_Angeles",
  "561":"America/New_York","562":"America/Los_Angeles","563":"America/Chicago",
  "567":"America/New_York","570":"America/New_York","571":"America/New_York",
  "573":"America/Chicago","574":"America/Indiana/Indianapolis","575":"America/Denver",
  "580":"America/Chicago","585":"America/New_York","586":"America/Detroit",
  "601":"America/Chicago","602":"America/Phoenix","603":"America/New_York",
  "605":"America/Chicago","606":"America/New_York","607":"America/New_York",
  "608":"America/Chicago","609":"America/New_York","610":"America/New_York",
  "612":"America/Chicago","614":"America/New_York","615":"America/Chicago",
  "616":"America/Detroit","617":"America/New_York","618":"America/Chicago",
  "619":"America/Los_Angeles","620":"America/Chicago","623":"America/Phoenix",
  "626":"America/Los_Angeles","628":"America/Los_Angeles","629":"America/Chicago",
  "630":"America/Chicago","631":"America/New_York","636":"America/Chicago",
  "641":"America/Chicago","646":"America/New_York","650":"America/Los_Angeles",
  "651":"America/Chicago","657":"America/Los_Angeles","660":"America/Chicago",
  "661":"America/Los_Angeles","662":"America/Chicago","667":"America/New_York",
  "669":"America/Los_Angeles","678":"America/New_York","681":"America/New_York",
  "682":"America/Chicago","701":"America/Chicago","702":"America/Los_Angeles",
  "703":"America/New_York","704":"America/New_York","706":"America/New_York",
  "707":"America/Los_Angeles","708":"America/Chicago","712":"America/Chicago",
  "713":"America/Chicago","714":"America/Los_Angeles","715":"America/Chicago",
  "716":"America/New_York","717":"America/New_York","718":"America/New_York",
  "719":"America/Denver","720":"America/Denver","724":"America/New_York",
  "725":"America/Los_Angeles","726":"America/Chicago","727":"America/New_York",
  "731":"America/Chicago","732":"America/New_York","734":"America/Detroit",
  "737":"America/Chicago","740":"America/New_York","747":"America/Los_Angeles",
  "754":"America/New_York","757":"America/New_York","760":"America/Los_Angeles",
  "762":"America/New_York","763":"America/Chicago","765":"America/Indiana/Indianapolis",
  "769":"America/Chicago","770":"America/New_York","771":"America/New_York",
  "772":"America/New_York","773":"America/Chicago","774":"America/New_York",
  "775":"America/Los_Angeles","779":"America/Chicago","781":"America/New_York",
  "785":"America/Chicago","786":"America/New_York","801":"America/Denver",
  "802":"America/New_York","803":"America/New_York","804":"America/New_York",
  "805":"America/Los_Angeles","806":"America/Chicago","808":"Pacific/Honolulu",
  "810":"America/Detroit","812":"America/Indiana/Indianapolis","813":"America/New_York",
  "814":"America/New_York","815":"America/Chicago","816":"America/Chicago",
  "817":"America/Chicago","818":"America/Los_Angeles","820":"America/Los_Angeles",
  "828":"America/New_York","830":"America/Chicago","831":"America/Los_Angeles",
  "832":"America/Chicago","835":"America/New_York","843":"America/New_York",
  "845":"America/New_York","847":"America/Chicago","848":"America/New_York",
  "850":"America/Chicago","856":"America/New_York","857":"America/New_York",
  "858":"America/Los_Angeles","859":"America/New_York","860":"America/New_York",
  "862":"America/New_York","863":"America/New_York","864":"America/New_York",
  "865":"America/New_York","870":"America/Chicago","872":"America/Chicago",
  "878":"America/New_York","901":"America/Chicago","903":"America/Chicago",
  "904":"America/New_York","906":"America/Detroit","907":"America/Anchorage",
  "908":"America/New_York","909":"America/Los_Angeles","910":"America/New_York",
  "912":"America/New_York","913":"America/Chicago","914":"America/New_York",
  "915":"America/Denver","916":"America/Los_Angeles","917":"America/New_York",
  "918":"America/Chicago","919":"America/New_York","920":"America/Chicago",
  "925":"America/Los_Angeles","928":"America/Phoenix","929":"America/New_York",
  "930":"America/Indiana/Indianapolis","931":"America/Chicago","934":"America/New_York",
  "936":"America/Chicago","937":"America/New_York","938":"America/Chicago",
  "939":"America/Puerto_Rico","940":"America/Chicago","941":"America/New_York",
  "947":"America/Detroit","949":"America/Los_Angeles","951":"America/Los_Angeles",
  "952":"America/Chicago","954":"America/New_York","956":"America/Chicago",
  "959":"America/New_York","970":"America/Denver","971":"America/Los_Angeles",
  "972":"America/Chicago","973":"America/New_York","975":"America/Chicago",
  "978":"America/New_York","979":"America/Chicago","980":"America/New_York",
  "984":"America/New_York","985":"America/Chicago","986":"America/Denver",
  "989":"America/Detroit",
};

/** Returns the IANA timezone for a US phone number based on area code, or null if unknown. */
function getLeadTimezone(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  // Strip leading 1 for US numbers
  const local = digits.startsWith("1") && digits.length === 11 ? digits.slice(1) : digits;
  const areaCode = local.slice(0, 3);
  return AREA_CODE_TZ[areaCode] ?? null;
}

/** TCPA: returns true if it's currently a legal calling time for this lead (8am–9pm local).
 *  Fail-CLOSED for unknown US area codes and any timezone-formatting errors:
 *  the only way to be safe under TCPA is to skip the call when we cannot prove
 *  the local time. The lead is re-queued and tried again at the next tick. */
function isTcpaCallable(phone: string): boolean {
  // Non-US numbers (no leading +1, length != 11 with leading 1, or length != 10):
  // fall back to the campaign's working-hours window — TCPA only applies to US.
  const digits = phone.replace(/\D/g, "");
  const isUs = (digits.length === 10) || (digits.length === 11 && digits.startsWith("1"));
  if (!isUs) return true;

  const tz = getLeadTimezone(phone);
  if (!tz) return false; // Unknown US area code → safer to skip than risk a 3 AM call

  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
    });
    const parts = formatter.formatToParts(new Date());
    const h = parseInt(parts.find(p => p.type === "hour")?.value ?? "0", 10);
    const m = parseInt(parts.find(p => p.type === "minute")?.value ?? "0", 10);
    const nowMins = h * 60 + m;
    return nowMins >= 480 && nowMins <= 1260; // 8:00 AM – 9:00 PM
  } catch {
    return false;
  }
}

// ── Working hours helper ──────────────────────────────────────────────────────
function isWithinWorkingHours(campaign: typeof campaignsTable.$inferSelect): boolean {
  if (!campaign.workingHoursStart || !campaign.workingHoursEnd) return true;
  try {
    const tz = campaign.workingHoursTimezone ?? "UTC";
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const h = parseInt(parts.find(p => p.type === "hour")?.value ?? "0", 10);
    const m = parseInt(parts.find(p => p.type === "minute")?.value ?? "0", 10);
    const nowMins = h * 60 + m;
    const [sh, sm] = campaign.workingHoursStart.split(":").map(Number);
    const [eh, em] = campaign.workingHoursEnd.split(":").map(Number);
    const startMins = (sh ?? 0) * 60 + (sm ?? 0);
    const endMins = (eh ?? 23) * 60 + (em ?? 59);
    return nowMins >= startMins && nowMins <= endMins;
  } catch {
    return true;
  }
}

// ── DNC lookup (cached in-memory for the duration of a campaign run) ──────────
// IMPORTANT: dnc_list also contains NON-BLOCKING score-cache rows (autoBlocked=false,
// reason=null) written by the spam-check service just to memoize Telnyx lookups.
// Those must NOT be treated as DNC blocks. A row is a real block only if
// autoBlocked=true (spam auto-block) OR reason is set (manual POST /dnc entry).
async function buildDncSet(): Promise<Set<string>> {
  const rows = await db
    .select({ phone: dncListTable.phoneNumber, autoBlocked: dncListTable.autoBlocked, reason: dncListTable.reason })
    .from(dncListTable);
  const blockingRows = rows.filter(r => r.autoBlocked || r.reason !== null);
  return new Set(blockingRows.map(r => r.phone.replace(/[^\d+]/g, "")));
}

async function triggerCampaignCalls(campaignId: number, campaign: typeof campaignsTable.$inferSelect) {
  // Concurrency guard — prevent double-starting the same campaign in this process
  if (activeCampaignRuns.get(campaignId)) {
    logger.warn({ campaignId }, "Campaign already running in this process — ignoring duplicate start");
    return;
  }
  activeCampaignRuns.set(campaignId, true);

  try {
    await _runCampaignCalls(campaignId, campaign);
  } catch (err) {
    const e = err as Error;
    logger.error(
      {
        campaignId,
        errMessage: e?.message,
        errStack: e?.stack,
        errStage: (e as { __stage?: string })?.__stage ?? "unknown",
      },
      "_runCampaignCalls crashed",
    );
    throw err;
  } finally {
    activeCampaignRuns.delete(campaignId);
    logger.info({ campaignId }, "Campaign run lock released");
  }
}

// Wrap an await with a stage label so a crash inside is reported with its origin.
async function stage<T>(stageName: string, campaignId: number, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const e = err as Error & { __stage?: string };
    if (!e.__stage) e.__stage = stageName;
    logger.error(
      { campaignId, stage: stageName, errMessage: e?.message, errStack: e?.stack },
      `Campaign stage failed: ${stageName}`,
    );
    throw err;
  }
}

/** Pick an available number from the global pool for a campaign.
 *  Priority: not busy, not blocked, spamScore < 70, lowest usageCount first.
 *  Falls back to the campaign's configured fromNumber if no pool number is free.
 *
 *  Selected-number contract: if the user has explicitly assigned ≥1 number to
 *  this campaign (via /campaigns/:id/numbers), we ONLY rotate through those
 *  numbers. We never silently fall back to unassigned floating numbers — that
 *  would let calls go out from numbers the user didn't pick. Only when the
 *  campaign has zero assigned numbers do we use the unassigned pool. */
async function allocateNumber(
  campaignId: number,
  fallbackNumber: string,
  opts: { requireVapiId?: boolean } = {}
): Promise<{ phoneNumber: string; vapiPhoneNumberId: string | null }> {
  // Are there any numbers explicitly assigned to this campaign?
  const [assignedRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(phoneNumbersTable)
    .where(eq(phoneNumbersTable.campaignId, campaignId));
  const hasAssigned = (assignedRow?.count ?? 0) > 0;

  const scopeFilter = hasAssigned
    ? eq(phoneNumbersTable.campaignId, campaignId)
    : sql`${phoneNumbersTable.campaignId} IS NULL`;

  const filters = [
    eq(phoneNumbersTable.status, "active"),
    eq(phoneNumbersTable.isBusy, false),
    eq(phoneNumbersTable.isBlocked, false),
    sql`${phoneNumbersTable.spamScore} < 70`,
    sql`${phoneNumbersTable.direction} IN ('outbound', 'both')`,
    scopeFilter,
  ];
  // For Vapi-routed campaigns, only consider numbers that have already been
  // registered with Vapi (otherwise the call has no Vapi phoneNumberId to
  // originate from and would fail the lead).
  if (opts.requireVapiId) {
    filters.push(sql`${phoneNumbersTable.vapiPhoneNumberId} IS NOT NULL`);
  }

  const [poolRow] = await db
    .select({
      phoneNumber: phoneNumbersTable.phoneNumber,
      vapiPhoneNumberId: phoneNumbersTable.vapiPhoneNumberId,
    })
    .from(phoneNumbersTable)
    .where(and(...filters))
    .orderBy(asc(phoneNumbersTable.usageCount), asc(phoneNumbersTable.spamScore))
    .limit(1);

  // Vapi path with no synced numbers in the pool — surface a clear error
  // rather than dialing from an arbitrary fallback that Vapi can't use.
  if (opts.requireVapiId && !poolRow) {
    return { phoneNumber: "", vapiPhoneNumberId: null };
  }

  const chosen = poolRow?.phoneNumber ?? fallbackNumber;

  // Mark as busy immediately (optimistic lock)
  if (poolRow) {
    await db
      .update(phoneNumbersTable)
      .set({ isBusy: true, lastUsedAt: new Date() })
      .where(eq(phoneNumbersTable.phoneNumber, chosen))
      .catch(() => {});
  }

  return { phoneNumber: chosen, vapiPhoneNumberId: poolRow?.vapiPhoneNumberId ?? null };
}

async function _runCampaignCalls(campaignId: number, campaign: typeof campaignsTable.$inferSelect) {
  const { script, voiceName, voiceProvider, fromNumber, transferNumber, backgroundSound, holdMusicUrl } =
    await stage("resolveCampaignAssets", campaignId, () => resolveCampaignAssets(campaignId, campaign));

  const retryAttempts = campaign.retryAttempts ?? 2;
  const retryIntervalMs = (campaign.retryIntervalMinutes ?? 60) * 60 * 1000;
  const maxConcurrency = Math.min(campaign.maxConcurrentCalls ?? 5, 20);
  const dialingSpeed = Math.max(1, campaign.dialingSpeed ?? 10); // calls per minute
  let msPerCall = Math.floor(60_000 / dialingSpeed);

  // Build DNC set once for the entire run
  const dncSet = await stage("buildDncSet", campaignId, () => buildDncSet());

  // Fetch dialable leads: pending + called (called = previously attempted, retry allowed).
  // Includes leads directly attached to the campaign AND leads belonging to any
  // active list assigned to this campaign.
  const assignedListIds = (await db
    .select({ id: leadListsTable.id })
    .from(leadListsTable)
    .where(and(eq(leadListsTable.campaignId, campaignId), eq(leadListsTable.active, true)))
  ).map(r => r.id);

  const sourceFilter = assignedListIds.length > 0
    ? or(eq(leadsTable.campaignId, campaignId), inArray(leadsTable.listId, assignedListIds))
    : eq(leadsTable.campaignId, campaignId);

  let pendingLeads = await db
    .select()
    .from(leadsTable)
    .where(and(
      sourceFilter,
      inArray(leadsTable.status, ["pending", "called"]),
    ));

  // ── Lead Prioritization ─────────────────────────────────────────────────
  // Compute a per-lead rank score from prior call history + campaign signal,
  // then dial highest-value leads first. Falls back to the legacy sort if the
  // ranker errors out, so dialing is never blocked.
  try {
    const { prioritizeLeads } = await import("../services/leadPrioritizer.js");
    pendingLeads = await prioritizeLeads(pendingLeads as never) as typeof pendingLeads;
  } catch (err) {
    logger.warn({ err: String(err), campaignId }, "Prioritization failed — using priority sort");
    pendingLeads.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  logger.info(
    { campaignId, count: pendingLeads.length, concurrency: maxConcurrency, dialingSpeed, mode: campaign.dialingMode },
    `Campaign starting — dialing engine active`,
  );

  // Track drop rate + voicemail rate for adaptive speed
  let totalCalls = 0;
  let abandonedCalls = 0;
  let voicemailCalls = 0;
  const dropRateLimit = campaign.dropRateLimit ?? 3;

  async function processLead(lead: typeof pendingLeads[0]): Promise<void> {
    // Strip all formatting, then normalize to E.164
    const stripped = lead.phone.replace(/[^\d+]/g, "");
    const normPhone =
      stripped.startsWith("+") ? stripped               // already E.164
      : stripped.length === 10  ? `+1${stripped}`       // US 10-digit → +1XXXXXXXXXX
      : stripped.length === 11 && stripped.startsWith("1") ? `+${stripped}` // US 11-digit starting with 1
      : `+${stripped}`;                                 // best-effort for other formats

    // Basic sanity check — skip obviously invalid numbers
    if (normPhone.length < 8) {
      logger.warn({ leadId: lead.id, phone: lead.phone, normPhone }, "Lead skipped — phone number too short");
      return;
    }

    // Permanent allow-list — bypass ALL DNC / spam checks for these numbers.
    // (Owner test lines, known-good VIP contacts, etc.)
    const { isAlwaysAllowed } = await import("../services/spamCheck.js");
    const whitelisted = isAlwaysAllowed(normPhone);

    // DNC check (manual list + per-lead flag) — skipped for whitelisted numbers
    if (!whitelisted && (dncSet.has(normPhone) || lead.dncFlag)) {
      logger.info({ leadId: lead.id, phone: lead.phone }, "Lead skipped — on DNC list");
      await db.update(leadsTable).set({ status: "do_not_call" }).where(eq(leadsTable.id, lead.id));
      return;
    }

    // Spam-score check — calls Telnyx Number Lookup, caches result for 30 days.
    // Auto-blocks high-risk numbers (premium-rate scams, suspicious VoIP) and
    // adds them to dnc_list so future runs skip them instantly via dncSet.
    if (!whitelisted) {
      try {
        const { isBlocked: isSpamBlocked } = await import("../services/spamCheck.js");
        if (await isSpamBlocked(normPhone)) {
          logger.info({ leadId: lead.id, phone: lead.phone }, "Lead skipped — spam-score block");
          await db.update(leadsTable).set({ status: "do_not_call" }).where(eq(leadsTable.id, lead.id));
          dncSet.add(normPhone);  // keep in-memory set in sync for the rest of the run
          return;
        }
      } catch (err) {
        logger.debug({ err: String(err), leadId: lead.id }, "Spam check errored — proceeding (fail-open)");
      }
    }

    // Retry exhaustion check
    if ((lead.retryCount ?? 0) > retryAttempts) {
      logger.info({ leadId: lead.id }, "Lead skipped — retry limit reached");
      await db.update(leadsTable).set({ status: "completed" }).where(eq(leadsTable.id, lead.id));
      return;
    }

    // Working hours check
    if (!isWithinWorkingHours(campaign)) {
      logger.info({ campaignId }, "Outside working hours — pausing dialing");
      return;
    }

    // TCPA per-lead timezone check (8am–9pm in lead's local time) — only if campaign has it enabled
    if (campaign.tcpaEnabled && !isTcpaCallable(normPhone)) {
      logger.info({ leadId: lead.id, phone: lead.phone }, "Lead skipped — outside TCPA calling hours for lead's timezone");
      return; // Don't update status — retry later when it's within hours
    }

    // Allocate a Telnyx number from the campaign's selected pool (round-
    // robin, least-recently-used, skips busy/blocked). For Vapi-routed
    // campaigns we additionally require `vapiPhoneNumberId IS NOT NULL`
    // so we never pick a number that hasn't been registered with Vapi.
    const useVapiForThisCall =
      Boolean((campaign as { useVapi?: boolean }).useVapi) ||
      process.env.VAPI_FORCE_DEFAULT === "true";
    const allocation = await allocateNumber(campaignId, fromNumber, {
      requireVapiId: useVapiForThisCall,
    });
    const callFromNumber = allocation.phoneNumber;
    const vapiPhoneNumberIdForCall = allocation.vapiPhoneNumberId ?? undefined;

    // No synced numbers in the Vapi pool — fail this lead with a clear,
    // actionable error and stop here (number was never marked busy).
    if (useVapiForThisCall && !vapiPhoneNumberIdForCall) {
      logger.warn(
        { leadId: lead.id, campaignId },
        "Vapi campaign has no numbers registered with Vapi — open Phone Numbers and click 'Sync to Vapi'"
      );
      await db
        .update(leadsTable)
        .set({
          status: "failed",
          lastError:
            "No phone numbers in this campaign are registered with Vapi. Go to Phone Numbers → click 'Sync to Vapi'.",
        })
        .where(eq(leadsTable.id, lead.id));
      return;
    }

    // ── Conversion prediction (additive — never blocks dial) ─────────────
    let predProb: number | null = null;
    let predLabel: string | null = null;
    try {
      const { predictConversion } = await import("../services/conversionPredictor.js");
      const prediction = await predictConversion({
        campaignId,
        rankScore: lead.rankScore ?? 50,
      });
      predProb = Math.round(prediction.probability * 100);
      predLabel = prediction.label;
      // Persist on the lead row for dashboard surfacing
      await db.update(leadsTable)
        .set({ predictedProb: predProb, predictedLabel: predLabel })
        .where(eq(leadsTable.id, lead.id))
        .catch(() => {});
    } catch (err) {
      logger.warn({ err: String(err), leadId: lead.id }, "Conversion prediction failed — continuing");
    }

    const [logEntry] = await db
      .insert(callLogsTable)
      .values({
        phoneNumber: normPhone,
        campaignId,
        status: "initiated",
        direction: "outbound",
        numberUsed: callFromNumber,
        predictedProb: predProb,
        predictedLabel: predLabel,
      })
      .returning();

    totalCalls++;

    // Re-read the campaign's CURRENT voice + provider from DB on every dial.
    // The campaign-level resolved values (voiceName / voiceProvider) are computed
    // ONCE when the run starts, so without this re-read, edits made while the
    // campaign is running wouldn't take effect until the next run. This makes
    // voice changes apply to the very next call.
    const [liveCampaign] = await db
      .select({
        voice: campaignsTable.voice,
        voiceProvider: campaignsTable.voiceProvider,
        useVapi: campaignsTable.useVapi,
        knowledgeBase: campaignsTable.knowledgeBase,
      })
      .from(campaignsTable)
      .where(eq(campaignsTable.id, campaignId))
      .limit(1);
    let liveVoice = liveCampaign?.voice && liveCampaign.voice !== "default"
      ? liveCampaign.voice
      : voiceName;
    let liveVoiceProvider = liveCampaign?.voiceProvider ?? voiceProvider;
    // If `voice` is a numeric DB id (campaigns.voice stores the voices.id),
    // resolve it to the provider's actual voice_id string before sending to
    // Vapi/TTS. Without this, Vapi gets "60" instead of "5BTfD9GV..." and
    // ElevenLabs returns voice-not-found, dropping the call instantly.
    if (liveVoice && /^\d+$/.test(liveVoice)) {
      const [v] = await db
        .select({ voiceId: voicesTable.voiceId, provider: voicesTable.provider })
        .from(voicesTable)
        .where(eq(voicesTable.id, Number(liveVoice)))
        .limit(1);
      if (v?.voiceId) {
        liveVoice = v.voiceId;
        liveVoiceProvider = v.provider;
      }
    }

    const result = await enqueueCall({
      phone: normPhone,
      from_number: callFromNumber,
      agent_prompt: script,
      voice: liveVoice,
      voice_provider: liveVoiceProvider,
      transfer_number: transferNumber,
      campaign_id: String(campaignId),
      campaign_name: campaign.name,
      background_sound: backgroundSound !== "none" ? backgroundSound : undefined,
      hold_music_url: holdMusicUrl ?? undefined,
      amd_enabled: campaign.amdEnabled ? "true" : undefined,
      use_vapi: liveCampaign?.useVapi ?? false,
      vapi_phone_number_id: vapiPhoneNumberIdForCall,
      knowledge_base: liveCampaign?.knowledgeBase ?? undefined,
      lead_id: String(lead.id),
      lead_name: lead.name ?? undefined,
    });

    // If call fails, release the number immediately (webhook won't fire).
    // Both paths now allocate a real Telnyx number, so always release.
    if (!result.success) {
      await db
        .update(phoneNumbersTable)
        .set({ isBusy: false })
        .where(eq(phoneNumbersTable.phoneNumber, callFromNumber))
        .catch(() => {});
    }

    const newRetryCount = (lead.retryCount ?? 0) + (result.success ? 0 : 1);

    // Save callControlId (for webhook to find this log later) + error reason on failure
    await db
      .update(callLogsTable)
      .set({
        status: result.success ? "initiated" : "failed",
        callControlId: result.callControlId ?? null,
        disposition: result.success ? null : (result.error?.slice(0, 255) ?? "unknown_error"),
      })
      .where(eq(callLogsTable.id, logEntry.id));

    if (result.success) {
      await db
        .update(leadsTable)
        .set({ status: "called", lastCalledAt: new Date(), retryCount: newRetryCount })
        .where(eq(leadsTable.id, lead.id));
    } else {
      abandonedCalls++;
      // Schedule retry: reset to pending if retry limit not reached
      if (newRetryCount <= retryAttempts) {
        setTimeout(async () => {
          const [still] = await db
            .select({ status: campaignsTable.status })
            .from(campaignsTable)
            .where(eq(campaignsTable.id, campaignId));
          if (still?.status === "active") {
            await db
              .update(leadsTable)
              .set({ status: "pending", retryCount: newRetryCount, lastCalledAt: new Date() })
              .where(eq(leadsTable.id, lead.id));
          }
        }, retryIntervalMs);
      } else {
        await db
          .update(leadsTable)
          .set({ status: "called", retryCount: newRetryCount, lastCalledAt: new Date() })
          .where(eq(leadsTable.id, lead.id));
      }
    }

    // Track voicemail hits for adaptive speed
    if (!result.success) {
      abandonedCalls++;
    }

    // Adaptive throttling — slow down on high drop rate OR high voicemail rate
    if (totalCalls > 10) {
      const dropRate = (abandonedCalls / totalCalls) * 100;
      const vmRate = (voicemailCalls / totalCalls) * 100;

      if (dropRate > dropRateLimit) {
        logger.warn({ dropRate, dropRateLimit, campaignId }, "Drop rate exceeded — throttling");
        msPerCall = Math.min(msPerCall * 1.5, 10_000); // slow down, cap at 10s
        await delay(2000);
      } else if (vmRate > 40) {
        logger.warn({ vmRate, campaignId }, "Voicemail rate high — reducing speed");
        msPerCall = Math.min(msPerCall * 1.25, 10_000);
        await delay(1000);
      } else if (dropRate < dropRateLimit * 0.5 && vmRate < 20 && msPerCall > Math.floor(60_000 / dialingSpeed)) {
        // Conditions are good — restore original speed
        msPerCall = Math.max(msPerCall * 0.9, Math.floor(60_000 / dialingSpeed));
      }
    }
  }

  let index = 0;
  async function worker(): Promise<void> {
    while (true) {
      const lead = pendingLeads[index++];
      if (!lead) break;

      // Re-check campaign status
      const [current] = await db
        .select({ status: campaignsTable.status })
        .from(campaignsTable)
        .where(eq(campaignsTable.id, campaignId))
        .limit(1);
      if (current?.status !== "active") break;

      await processLead(lead).catch((err) => {
        logger.error({ err, leadId: lead.id, phone: lead.phone, campaignId }, "Call dispatch failed for lead");
      });

      // Pace calls according to dialingSpeed (calls/min)
      await delay(msPerCall + Math.floor(Math.random() * 300));
    }
  }

  // For predictive mode: calculate target concurrency = agents × dialingRatio
  const dialingRatio = campaign.dialingRatio ?? 1;
  const effectiveConcurrency = campaign.dialingMode === "predictive"
    ? Math.min(maxConcurrency * dialingRatio, 20)
    : maxConcurrency;

  const workers = Array.from({ length: effectiveConcurrency }, () => worker());
  await Promise.allSettled(workers);

  logger.info({ campaignId, totalCalls, abandonedCalls }, `Campaign finished dispatching all leads in current batch`);

  // Check if there are still pending leads in the DB that weren't in our initial snapshot
  // (e.g. retry leads that got reset after the batch was taken)
  // Re-derive the same source filter so retry pickup includes list-sourced leads.
  const remainAssignedListIds = (await db
    .select({ id: leadListsTable.id })
    .from(leadListsTable)
    .where(and(eq(leadListsTable.campaignId, campaignId), eq(leadListsTable.active, true)))
  ).map(r => r.id);
  const remainSourceFilter = remainAssignedListIds.length > 0
    ? or(eq(leadsTable.campaignId, campaignId), inArray(leadsTable.listId, remainAssignedListIds))
    : eq(leadsTable.campaignId, campaignId);

  const [remaining] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(leadsTable)
    .where(and(remainSourceFilter, inArray(leadsTable.status, ["pending"])));

  const remainingCount = remaining?.count ?? 0;

  if (remainingCount > 0) {
    // Re-check that campaign is still supposed to be active
    const [latestCampaign] = await db
      .select({ status: campaignsTable.status })
      .from(campaignsTable)
      .where(eq(campaignsTable.id, campaignId));

    if (latestCampaign?.status === "active") {
      logger.info({ campaignId, remainingCount }, "Pending retry leads found — re-running campaign batch");
      // Brief pause to avoid tight loop, then restart the worker for retry leads
      await delay(30_000);
      return _runCampaignCalls(campaignId, campaign);
    }
  }

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
- Keep sentences short — one clear thought, then stop and let the person react
- Use contractions always: "I'm", "we're", "it's", "that's", "don't"
- React to what the person JUST said before moving to your next point

PACING — the most important rule:
- After every question or statement, STOP COMPLETELY and wait for the full response
- If the person is mid-sentence or sounds like they are still thinking, say nothing — let them finish
- If their answer is very short ("yeah", "uh", "hmm"), say "Yeah, go on?" or "Take your time" — never assume they are done
- NEVER ask your next question before the current topic is fully resolved
- One topic at a time. One question at a time. No exceptions.

EMPATHY & WARMTH:
- Mirror the caller's energy — warm if they're warm, brief if they're busy
- Acknowledge what they said: "Right, that makes sense", "Fair enough", "Got it"
- If they seem rushed: "I'll keep it super quick, I promise"
- Never barrel forward mid-sentence or cut across their response

NEVER DO:
- Never say "As an AI..." or reveal you are an AI unless directly asked
- Never skip ahead to your next question while still on the current one
- Never use "Certainly!", "Absolutely!", "Of course!" — these sound like a bot
- Never read from a script in a monotone — vary your tone with the conversation

=== OBJECTION HANDLING PLAYBOOK ===
This is the most important section. When the person pushes back, ALWAYS follow
the four-step pattern: 1) ACKNOWLEDGE their feeling, 2) NORMALIZE it (most
people feel this way), 3) REDIRECT to a small, low-commitment next step, 4) ASK
ONE open question. Never argue, never repeat your pitch louder, never sound
hurt. Stay calm, warm, and curious — like a friend, not a salesperson.

Hard rule: never handle the same objection more than TWICE. If they push back
a third time, gracefully exit: "I can hear this isn't the right time —
would you prefer I call back later or take you off the list?" Then respect
their choice instantly.

If they go silent for 3+ seconds after you ask a question, gently re-engage:
"You there? No rush at all" — never repeat the same question verbatim.

Common objections and how to respond (paraphrase — never read these word for word):

- "Not interested" / "Not for me" / "I'll pass" / "No thanks"
  → "Totally fair — most folks say that before they hear what it actually is.
     Mind if I ask, is it because you've already got something sorted, or just
     not on your radar right now?"

- "I'm busy" / "Bad time" / "Driving" / "In a meeting"
  → "Got it, I won't keep you. Quick question — is there a time later today or
     tomorrow that's easier? I can call back to the minute."

- "How much?" / "Too expensive" / "Can't afford"
  → "Fair question — and honestly, it depends on what you actually need.
     Could I ask one or two quick things so I can give you a real answer
     instead of a generic one?"

- "Already have one" / "Already with someone" / "Got a provider"
  → "Makes sense — most people do. This is more about whether there's a better
     fit out there. Mind if I ask who you're with and roughly when you set it
     up? Things have changed a lot recently."

- "Send me info" / "Email me" / "Send me a brochure"
  → "Happy to. Just so I send the right thing and not waste your inbox — what
     matters most to you here?" (then name two specific benefits relevant to
     this campaign in your own words — never use bracketed placeholders aloud)

- "How did you get my number?" / "Where'd you get my info?"
  → "Totally fair to ask. Your details came through our records and you're
     welcome to be removed any time. While I have you though, mind if I
     quickly ask one thing?" (do NOT name a specific source unless you
     genuinely know it — vague is better than wrong)

- "Is this a robot?" / "Are you AI?" / "Are you real?"
  → If asked DIRECTLY: be honest. Say "I'm an AI assistant" then briefly
     and naturally state which company / campaign you're calling for and
     the reason for the call (use the campaign name from your instructions —
     never say the literal word "company" or "[company]"). Offer to connect
     them to a human if that's easier.
  → Never deny it under direct questioning. Lying destroys trust instantly.

- "I'll think about it" / "Let me get back to you"
  → "Of course, take your time. Just so I know — is there one specific thing
     you'd want to mull over? I might be able to clear it up in 30 seconds."

- "Stop calling" / "Take me off the list" / "Don't call again" / hostile language
  → STOP IMMEDIATELY. "Understood — I'll mark you do-not-contact right now.
     Sorry for the disturbance, have a good day." Then end the call. Never
     try to recover, never push, never apologize twice.

HOSTILITY RULES:
- If the caller raises their voice or swears: drop your energy, slow down,
  speak softer. Never match their tone. Offer a clean exit within one turn.
- If they hang up mid-sentence: do not attempt to dial back unless that
  campaign explicitly allows callbacks.

CLOSING WHEN INTERESTED:
- Confirm one concrete next step (callback time, email send, transfer to a
  specialist) — never leave it vague.
- Repeat the next step back so they remember it: "So I'll have someone call
  you Tuesday at 3 — sound good?"
=== END OBJECTION HANDLING PLAYBOOK ===
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
  let voiceProvider = (campaign.voiceProvider ?? "elevenlabs") as string;
  let fromNumber: string | null = campaign.fromNumber ?? process.env.DEFAULT_FROM_NUMBER ?? null;
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

        if (voice) {
          voiceName = voice.voiceId;
          voiceProvider = voice.provider;
        }
      }
    }
  }

  // Safety guard: if no specific voice is set, we'll use the ElevenLabs default — reset provider
  if (!voiceName || voiceName === "default") {
    voiceProvider = "elevenlabs";
  }

  // If `campaign.voice` stored a numeric voices.id (e.g. "60") instead of the
  // provider's actual voice_id string, resolve it here so downstream callers
  // (Vapi/TTS) receive the real provider id like "5BTfD9GV7eMTyvzofs0V".
  if (voiceName && /^\d+$/.test(voiceName)) {
    const [v] = await db
      .select({ voiceId: voicesTable.voiceId, provider: voicesTable.provider })
      .from(voicesTable)
      .where(eq(voicesTable.id, Number(voiceName)))
      .limit(1);
    if (v?.voiceId) {
      voiceName = v.voiceId;
      voiceProvider = v.provider;
    }
  }

  // Resolve fromNumber: campaign field → campaign-assigned pool → any active DB number → placeholder
  if (!fromNumber) {
    // Try number assigned specifically to this campaign
    const [campaignRow] = await db
      .select()
      .from(phoneNumbersTable)
      .where(and(eq(phoneNumbersTable.campaignId, campaignId), eq(phoneNumbersTable.status, "active")))
      .limit(1);

    if (campaignRow) {
      fromNumber = campaignRow.phoneNumber;
    } else {
      // Final fallback: pick the best available active number from the whole pool
      // (ordered by priority asc, id desc so synced/newer numbers come first)
      const [anyRow] = await db
        .select()
        .from(phoneNumbersTable)
        .where(eq(phoneNumbersTable.status, "active"))
        .orderBy(asc(phoneNumbersTable.priority), desc(phoneNumbersTable.id))
        .limit(1);
      if (anyRow) fromNumber = anyRow.phoneNumber;
    }
  }

  // Last-resort sentinel — will be caught by workerService guard with a clear error
  const resolvedFromNumber = fromNumber ?? "+10000000000";

  return { script, voiceName, voiceProvider, fromNumber: resolvedFromNumber, transferNumber, backgroundSound, holdMusicUrl };
}

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

  const { script, voiceName, voiceProvider, fromNumber, transferNumber, backgroundSound, holdMusicUrl } = await resolveCampaignAssets(id, campaign);

  const [logEntry] = await db
    .insert(callLogsTable)
    .values({ phoneNumber: phone, campaignId: id, status: "initiated" })
    .returning();

  const result = await enqueueCall({
    phone,
    from_number: fromNumber,
    agent_prompt: script,
    voice: voiceName,
    voice_provider: voiceProvider,
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
    .values({
      campaignId,
      agentId: parsed.data.agentId,
      priority: parsed.data.priority ?? 1,
    })
    .returning();

  res.status(201).json(assignment);
});

// PATCH /campaigns/:id/agents/:agentId — change an assigned agent's priority
// (used by "priority" + "sequential" routing strategies).
router.patch("/campaigns/:id/agents/:agentId", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const campaignId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const agentId    = parseInt(Array.isArray(req.params.agentId) ? req.params.agentId[0] : req.params.agentId, 10);
  if (isNaN(campaignId) || isNaN(agentId)) { res.status(400).json({ error: "Invalid IDs" }); return; }

  const body = z.object({ priority: z.number().int().min(1).max(999) }).safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }

  const [updated] = await db
    .update(campaignAgentsTable)
    .set({ priority: body.data.priority })
    .where(and(eq(campaignAgentsTable.campaignId, campaignId), eq(campaignAgentsTable.agentId, agentId)))
    .returning();

  if (!updated) { res.status(404).json({ error: "Assignment not found" }); return; }
  res.json(updated);
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
      priority: campaignAgentsTable.priority,
    })
    .from(campaignAgentsTable)
    .innerJoin(usersTable, eq(campaignAgentsTable.agentId, usersTable.id))
    .where(eq(campaignAgentsTable.campaignId, campaignId))
    .orderBy(asc(campaignAgentsTable.priority), asc(usersTable.id));

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

/** Ensures there are pending leads to dial. Auto-resets called/completed leads if none are pending. */
async function guardPendingLeads(id: number, campaign: typeof campaignsTable.$inferSelect, res: import("express").Response): Promise<boolean> {
  if (campaign.type === "inbound") return true;

  const [pendingRow] = await db.select({ count: db.$count(leadsTable) }).from(leadsTable)
    .where(and(eq(leadsTable.campaignId, id), eq(leadsTable.status, "pending")));
  if (Number(pendingRow?.count ?? 0) > 0) return true;

  const [totalRow] = await db.select({ count: db.$count(leadsTable) }).from(leadsTable)
    .where(eq(leadsTable.campaignId, id));
  if (Number(totalRow?.count ?? 0) === 0) {
    res.status(400).json({ error: "No leads added yet. Add leads before launching.", code: "no_leads" });
    return false;
  }

  // Auto-reset previously called leads so they can be dialled again
  await db
    .update(leadsTable)
    .set({ status: "pending", retryCount: 0 })
    .where(and(
      eq(leadsTable.campaignId, id),
      inArray(leadsTable.status, ["called", "completed"]),
    ));
  return true;
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

// ── POST /campaigns/:id/numbers — assign phone numbers to a campaign ──────────
// Replaces all current number assignments for this campaign.
// Numbers from other campaigns cannot be reassigned here (they remain bound).
// Maximum 5 numbers per campaign.
router.post("/campaigns/:id/numbers", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid campaign ID" }); return; }

  const campaign = await getCampaignOrFail(id, res);
  if (!campaign) return;

  const { numberIds } = req.body as { numberIds?: unknown };
  if (!Array.isArray(numberIds) || numberIds.some(n => typeof n !== "number")) {
    res.status(400).json({ error: "numberIds must be an array of number IDs" });
    return;
  }
  if (numberIds.length > 5) {
    res.status(400).json({ error: "Maximum 5 numbers may be assigned per campaign" });
    return;
  }

  // Clear numbers that were previously assigned to THIS campaign (free them up)
  await db
    .update(phoneNumbersTable)
    .set({ campaignId: null })
    .where(eq(phoneNumbersTable.campaignId, id));

  if (numberIds.length > 0) {
    // Assign the newly selected numbers (only if they are currently unassigned or already ours)
    await db
      .update(phoneNumbersTable)
      .set({ campaignId: id })
      .where(
        and(
          inArray(phoneNumbersTable.id, numberIds as number[]),
          sql`(${phoneNumbersTable.campaignId} IS NULL OR ${phoneNumbersTable.campaignId} = ${id})`
        )
      );

    // Sync fromNumber on the campaign to the phone string of the first selected number
    const [firstNum] = await db
      .select({ phoneNumber: phoneNumbersTable.phoneNumber })
      .from(phoneNumbersTable)
      .where(eq(phoneNumbersTable.id, (numberIds as number[])[0]));
    if (firstNum) {
      await db
        .update(campaignsTable)
        .set({ fromNumber: firstNum.phoneNumber })
        .where(eq(campaignsTable.id, id));
    }
  }

  res.json({ ok: true, campaignId: id, assigned: numberIds.length });
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

  // Release any phone numbers assigned to this campaign before deleting
  await db
    .update(phoneNumbersTable)
    .set({ campaignId: null })
    .where(eq(phoneNumbersTable.campaignId, id));

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
