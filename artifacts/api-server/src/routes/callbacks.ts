import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { leadsTable, campaignsTable, phoneNumbersTable } from "@workspace/db";
import { eq, and, lte, isNotNull, sql, asc } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { enqueueCall } from "../services/workerService.js";
import { logger } from "../lib/logger.js";
import { z } from "zod";

const router: IRouter = Router();

// ── GET /callbacks ────────────────────────────────────────────────────────────
// Returns all leads with status = "callback", optionally filtered by campaignId.
router.get("/callbacks", authenticate, async (req, res): Promise<void> => {
  const campaignIdRaw = req.query.campaignId ?? req.query.campaign_id;

  const conditions = [eq(leadsTable.status, "callback")];

  if (campaignIdRaw) {
    const campaignId = parseInt(String(campaignIdRaw), 10);
    if (!isNaN(campaignId)) conditions.push(eq(leadsTable.campaignId, campaignId));
  }

  const leads = await db
    .select({
      id:         leadsTable.id,
      name:       leadsTable.name,
      phone:      leadsTable.phone,
      email:      leadsTable.email,
      campaignId: leadsTable.campaignId,
      source:     leadsTable.source,
      status:     leadsTable.status,
      notes:      leadsTable.notes,
      callbackAt: leadsTable.callbackAt,
      createdAt:  leadsTable.createdAt,
    })
    .from(leadsTable)
    .where(and(...conditions))
    .orderBy(leadsTable.callbackAt, leadsTable.createdAt);

  const campaignIds = [...new Set(leads.map((l) => l.campaignId))];
  const campaigns =
    campaignIds.length > 0
      ? await db.select({ id: campaignsTable.id, name: campaignsTable.name }).from(campaignsTable)
      : [];

  const campaignMap = new Map(campaigns.map((c) => [c.id, c.name]));

  res.json(
    leads.map((l) => ({
      id:           l.id,
      name:         l.name,
      phone:        l.phone,
      phone_number: l.phone,
      email:        l.email,
      campaignId:   l.campaignId,
      campaign_id:  l.campaignId,
      campaignName: campaignMap.get(l.campaignId) ?? null,
      source:       l.source,
      status:       l.status,
      notes:        l.notes,
      callbackAt:   l.callbackAt,
      callback_at:  l.callbackAt,
      createdAt:    l.createdAt,
      created_at:   l.createdAt,
    }))
  );
});

// ── POST /callbacks/schedule ──────────────────────────────────────────────────
// Schedule a callback for a lead at a specific datetime.
// Body: { leadId: number, callbackAt: ISO8601 string, notes?: string }
const scheduleSchema = z.object({
  leadId:     z.number().int().positive(),
  callbackAt: z.string().min(1),
  notes:      z.string().optional(),
});

router.post("/callbacks/schedule", authenticate, async (req, res): Promise<void> => {
  const parsed = scheduleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    return;
  }

  const callbackDate = new Date(parsed.data.callbackAt);
  if (isNaN(callbackDate.getTime())) {
    res.status(400).json({ error: "Invalid callbackAt — must be a valid ISO 8601 datetime" });
    return;
  }

  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, parsed.data.leadId)).limit(1);
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  const [updated] = await db
    .update(leadsTable)
    .set({
      status:     "callback",
      callbackAt: callbackDate,
      ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
    })
    .where(eq(leadsTable.id, parsed.data.leadId))
    .returning();

  logger.info({ leadId: parsed.data.leadId, callbackAt: callbackDate.toISOString() }, "Callback scheduled");

  res.status(201).json({
    id:          updated.id,
    name:        updated.name,
    phone:       updated.phone,
    phone_number: updated.phone,
    email:       updated.email,
    campaignId:  updated.campaignId,
    campaign_id: updated.campaignId,
    status:      updated.status,
    notes:       updated.notes,
    callbackAt:  updated.callbackAt,
    callback_at: updated.callbackAt,
    createdAt:   updated.createdAt,
    created_at:  updated.createdAt,
  });
});

// ── PATCH /callbacks/:id ──────────────────────────────────────────────────────
const updateCallbackSchema = z.object({
  status:     z.enum(["pending", "called", "callback", "do_not_call", "completed"]).optional(),
  notes:      z.string().optional(),
  callbackAt: z.string().optional(),
});

router.patch("/callbacks/:id", authenticate, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid lead ID" }); return; }

  const parsed = updateCallbackSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const [existing] = await db.select().from(leadsTable).where(eq(leadsTable.id, id)).limit(1);
  if (!existing) { res.status(404).json({ error: "Lead not found" }); return; }

  const patch: Record<string, unknown> = {};
  if (parsed.data.status !== undefined)     patch.status     = parsed.data.status;
  if (parsed.data.notes  !== undefined)     patch.notes      = parsed.data.notes;
  if (parsed.data.callbackAt !== undefined) {
    const d = new Date(parsed.data.callbackAt);
    if (!isNaN(d.getTime())) patch.callbackAt = d;
  }

  const [updated] = await db
    .update(leadsTable)
    .set(patch)
    .where(eq(leadsTable.id, id))
    .returning();

  res.json({
    id:           updated.id,
    name:         updated.name,
    phone:        updated.phone,
    phone_number: updated.phone,
    email:        updated.email,
    campaignId:   updated.campaignId,
    campaign_id:  updated.campaignId,
    status:       updated.status,
    notes:        updated.notes,
    callbackAt:   updated.callbackAt,
    callback_at:  updated.callbackAt,
    createdAt:    updated.createdAt,
    created_at:   updated.createdAt,
  });
});

export default router;

// ── Callback scheduler ────────────────────────────────────────────────────────
// Exported so index.ts can start it. Polls every 60s and auto-dials due leads.
let _callbackTickRunning = false;

export async function startCallbackScheduler(): Promise<void> {
  logger.info("Callback scheduler started — polling every 60s for due callbacks");

  async function tick(): Promise<void> {
    if (_callbackTickRunning) return;
    _callbackTickRunning = true;
    try {
      const now = new Date();

      // ── Atomic claim ──────────────────────────────────────────────────────
      // Single UPDATE...WHERE...RETURNING flips status callback→called for any
      // due rows in one DB roundtrip. Even with multiple app instances polling
      // concurrently, each lead is claimed by exactly one tick (Postgres MVCC).
      // We move to "called" (terminal-ish) so a second tick can never re-claim,
      // then dial. If dial enqueue fails, status stays "called" and the user
      // can re-schedule via PATCH /callbacks/:id.
      const claimedLeads = await db
        .update(leadsTable)
        .set({ status: "called", callbackAt: null, retryCount: 0 })
        .where(
          and(
            eq(leadsTable.status, "callback"),
            isNotNull(leadsTable.callbackAt),
            lte(leadsTable.callbackAt, now)
          )
        )
        .returning();

      for (const lead of claimedLeads) {
        logger.info({ leadId: lead.id, phone: lead.phone }, "Callback claimed — processing");

        const [campaign] = await db
          .select()
          .from(campaignsTable)
          .where(eq(campaignsTable.id, lead.campaignId))
          .limit(1);

        // Campaign paused/draft → revert lead back to callback for next tick.
        // Do NOT mutate callbackAt — preserve the user's originally scheduled time.
        if (!campaign || campaign.status !== "active") {
          logger.warn({ leadId: lead.id, campaignId: lead.campaignId, status: campaign?.status }, "Callback skipped — campaign not active; restoring with 5-minute backoff");
          // Backoff to prevent a hot-loop while the campaign stays paused.
          await db.update(leadsTable)
            .set({ status: "callback", callbackAt: new Date(now.getTime() + 5 * 60_000) })
            .where(eq(leadsTable.id, lead.id))
            .catch(() => {});
          continue;
        }

        // Resolve a from-number: prefer campaign.fromNumber, fall back to any
        // active outbound number from the pool. NEVER drop the callback silently.
        let fromNumber = campaign.fromNumber;
        if (!fromNumber) {
          // Mirror allocateNumber's selected-number contract: prefer numbers
          // explicitly assigned to the campaign, otherwise fall back to the
          // unassigned pool. Never mix the two.
          const [assignedRow] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(phoneNumbersTable)
            .where(eq(phoneNumbersTable.campaignId, campaign.id));
          const scopeFilter = (assignedRow?.count ?? 0) > 0
            ? eq(phoneNumbersTable.campaignId, campaign.id)
            : sql`${phoneNumbersTable.campaignId} IS NULL`;
          const [poolRow] = await db
            .select({ phoneNumber: phoneNumbersTable.phoneNumber })
            .from(phoneNumbersTable)
            .where(
              and(
                eq(phoneNumbersTable.status, "active"),
                eq(phoneNumbersTable.isBlocked, false),
                sql`${phoneNumbersTable.direction} IN ('outbound', 'both')`,
                scopeFilter,
              )
            )
            .orderBy(asc(phoneNumbersTable.usageCount))
            .limit(1);
          fromNumber = poolRow?.phoneNumber ?? null;
        }

        if (!fromNumber) {
          logger.error({ leadId: lead.id, campaignId: campaign.id }, "Callback: no from-number available — restoring callback for retry");
          await db.update(leadsTable)
            .set({ status: "callback", callbackAt: new Date(now.getTime() + 5 * 60_000) })
            .where(eq(leadsTable.id, lead.id))
            .catch(() => {});
          continue;
        }

        // enqueueCall returns { success: false, error } instead of throwing
        // for Telnyx/worker errors, so we MUST check both return value AND throw.
        let dialOk = false;
        let dialErr: string | undefined;
        try {
          const result = await enqueueCall({
            phone:           lead.phone,
            from_number:     fromNumber,
            agent_prompt:    campaign.agentPrompt ?? "",
            voice:           campaign.voice ?? "default",
            transfer_number: campaign.transferNumber ?? undefined,
            campaign_id:     String(lead.campaignId),
            campaign_name:   campaign.name,
            amd_enabled:     campaign.amdEnabled ? "true" : undefined,
          });
          dialOk = result?.success === true;
          if (!dialOk) dialErr = result?.error ?? "enqueueCall returned success=false";
        } catch (err) {
          dialErr = String(err);
        }

        if (!dialOk) {
          logger.error({ leadId: lead.id, err: dialErr }, "Callback enqueue failed — restoring callback for retry in 5 min");
          await db.update(leadsTable)
            .set({ status: "callback", callbackAt: new Date(now.getTime() + 5 * 60_000) })
            .where(eq(leadsTable.id, lead.id))
            .catch(() => {});
        }
      }
    } catch (err) {
      logger.error({ err: String(err) }, "Callback scheduler tick error");
    } finally {
      _callbackTickRunning = false;
    }
  }

  await tick();
  setInterval(() => { tick().catch(() => {}); }, 60_000);
}
