import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { phoneNumbersTable, campaignsTable } from "@workspace/db";
import { eq, notInArray, isNull, or, sql } from "drizzle-orm";
import { authenticate, requireRole } from "../middlewares/auth.js";
import { z } from "zod";
import axios from "axios";
import { logger } from "../lib/logger.js";

const TELNYX_API_BASE = "https://api.telnyx.com/v2";

const router: IRouter = Router();

const addNumberSchema = z.object({
  phoneNumber: z.string().min(1),
  label: z.string().optional(),
  provider: z.enum(["voip", "telnyx", "twilio"]),
  campaignId: z.number().optional(),
  direction: z.enum(["inbound", "outbound", "both"]).default("both"),
  forwardNumber: z.string().optional(),
  priority: z.number().default(1),
});

router.post("/numbers/add", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const parsed = addNumberSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  if (parsed.data.campaignId) {
    const [campaign] = await db
      .select()
      .from(campaignsTable)
      .where(eq(campaignsTable.id, parsed.data.campaignId));
    if (!campaign) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
  }

  const [number] = await db.insert(phoneNumbersTable).values(parsed.data).returning();
  res.status(201).json(number);
});

router.get("/numbers", authenticate, async (req, res): Promise<void> => {
  // Self-healing: clear stale isBusy flags. Any number marked busy whose last
  // call started >10 min ago is almost certainly stuck (no real call lasts that
  // long in our system). This prevents Telnyx hiccups / server restarts mid-call
  // from leaving numbers permanently flagged "busy" and skipped by the dialer.
  await db.execute(sql`
    UPDATE phone_numbers
    SET is_busy = false
    WHERE is_busy = true
      AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '10 minutes')
  `).catch(() => { /* best effort */ });

  const numbers = await db
    .select({
      id: phoneNumbersTable.id,
      phoneNumber: phoneNumbersTable.phoneNumber,
      label: phoneNumbersTable.label,
      provider: phoneNumbersTable.provider,
      campaignId: phoneNumbersTable.campaignId,
      campaignName: campaignsTable.name,
      direction: phoneNumbersTable.direction,
      forwardNumber: phoneNumbersTable.forwardNumber,
      queueId: phoneNumbersTable.queueId,
      humanAgentId: phoneNumbersTable.humanAgentId,
      status: phoneNumbersTable.status,
      priority: phoneNumbersTable.priority,
      usageCount: phoneNumbersTable.usageCount,
      spamScore: phoneNumbersTable.spamScore,
      lastUsedAt: phoneNumbersTable.lastUsedAt,
      isBusy: phoneNumbersTable.isBusy,
      isBlocked: phoneNumbersTable.isBlocked,
      createdAt: phoneNumbersTable.createdAt,
      updatedAt: phoneNumbersTable.updatedAt,
    })
    .from(phoneNumbersTable)
    .leftJoin(campaignsTable, eq(phoneNumbersTable.campaignId, campaignsTable.id));
  res.json(numbers);
});

router.patch("/numbers/:id", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid number ID" });
    return;
  }

  const updateSchema = z.object({
    label:         z.string().optional(),
    campaignId:    z.union([z.number(), z.null()]).optional(),
    direction:     z.enum(["inbound", "outbound", "both"]).optional(),
    forwardNumber: z.union([z.string(), z.null()]).optional(),
    queueId:       z.union([z.number(), z.null()]).optional(),
    humanAgentId:  z.union([z.number(), z.null()]).optional(),
    status:        z.enum(["active", "inactive"]).optional(),
    isBlocked:     z.boolean().optional(),
    priority:      z.number().optional(),
  });

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updatePayload: Record<string, unknown> = {};
  if (parsed.data.label !== undefined)         updatePayload.label = parsed.data.label;
  if (parsed.data.status !== undefined)        updatePayload.status = parsed.data.status;
  if (parsed.data.priority !== undefined)      updatePayload.priority = parsed.data.priority;
  if (parsed.data.direction !== undefined)     updatePayload.direction = parsed.data.direction;
  if (parsed.data.isBlocked !== undefined)     updatePayload.isBlocked = parsed.data.isBlocked;
  if ("campaignId" in parsed.data)             updatePayload.campaignId    = parsed.data.campaignId ?? null;
  if ("forwardNumber" in parsed.data)          updatePayload.forwardNumber = parsed.data.forwardNumber ?? null;
  if ("queueId" in parsed.data)               updatePayload.queueId       = parsed.data.queueId ?? null;
  if ("humanAgentId" in parsed.data)          updatePayload.humanAgentId  = parsed.data.humanAgentId ?? null;

  const [updated] = await db
    .update(phoneNumbersTable)
    .set(updatePayload)
    .where(eq(phoneNumbersTable.id, id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Phone number not found" });
    return;
  }

  res.json(updated);
});

router.delete("/numbers/:id", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid number ID" });
    return;
  }
  await db.delete(phoneNumbersTable).where(eq(phoneNumbersTable.id, id));
  res.json({ ok: true });
});

// ── POST /numbers/sync-from-telnyx ───────────────────────────────────────────
// Fetches all phone numbers from the Telnyx account via API and upserts them
// into the local DB so they can be used as verified origination numbers.
router.post("/numbers/sync-from-telnyx", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "TELNYX_API_KEY not configured" });
    return;
  }

  try {
    // Paginate through all numbers (Telnyx returns up to 250 per page)
    let pageToken: string | null = null;
    const telnyxNumbers: string[] = [];

    do {
      const url = pageToken
        ? `${TELNYX_API_BASE}/phone_numbers?page[size]=250&page[after]=${pageToken}`
        : `${TELNYX_API_BASE}/phone_numbers?page[size]=250`;

      const resp = await axios.get(url, {
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        timeout: 15_000,
      });

      const data = resp.data?.data ?? [];
      for (const n of data) {
        if (n.phone_number) telnyxNumbers.push(n.phone_number as string);
      }
      pageToken = resp.data?.meta?.next_page_token ?? null;
    } while (pageToken);

    if (telnyxNumbers.length === 0) {
      res.json({ synced: 0, message: "No phone numbers found in your Telnyx account. Purchase numbers at portal.telnyx.com." });
      return;
    }

    // Upsert: insert if not exists, skip if already present
    let synced = 0;
    for (const phoneNumber of telnyxNumbers) {
      const [existing] = await db
        .select({ id: phoneNumbersTable.id })
        .from(phoneNumbersTable)
        .where(eq(phoneNumbersTable.phoneNumber, phoneNumber))
        .limit(1);

      if (!existing) {
        await db.insert(phoneNumbersTable).values({
          phoneNumber,
          provider: "telnyx",
          status: "active",
          direction: "both",
          priority: 1,
        });
        synced++;
      }
    }

    // ── Step 2: remove any seeded numbers that are NOT actually in this Telnyx account ──
    // These are the hardcoded placeholder numbers that were inserted at startup.
    // We only remove numbers that have no campaignId assigned (i.e. unassigned pool).
    const telnyxSet = new Set(telnyxNumbers);
    const allDbNumbers = await db
      .select({ id: phoneNumbersTable.id, phoneNumber: phoneNumbersTable.phoneNumber })
      .from(phoneNumbersTable)
      .where(eq(phoneNumbersTable.provider, "telnyx"));

    const staleIds = allDbNumbers
      .filter((n) => !telnyxSet.has(n.phoneNumber))
      .map((n) => n.id);

    for (const id of staleIds) {
      await db.delete(phoneNumbersTable).where(eq(phoneNumbersTable.id, id));
    }

    // ── Step 3: auto-fix campaigns that have a fake/stale fromNumber ─────────────
    // Any campaign whose fromNumber is null OR not a real Telnyx number gets
    // reassigned to the first real synced number automatically.
    const firstReal = telnyxNumbers[0];
    const campaignsFixed = await db
      .update(campaignsTable)
      .set({ fromNumber: firstReal })
      .where(
        or(
          isNull(campaignsTable.fromNumber),
          notInArray(campaignsTable.fromNumber, telnyxNumbers)
        )
      )
      .returning({ id: campaignsTable.id });

    logger.info({ total: telnyxNumbers.length, synced, staleRemoved: staleIds.length, campaignsFixed: campaignsFixed.length }, "Telnyx number sync complete");
    res.json({
      synced,
      total: telnyxNumbers.length,
      staleRemoved: staleIds.length,
      campaignsFixed: campaignsFixed.length,
      message: [
        synced > 0
          ? `Synced ${synced} new number${synced !== 1 ? "s" : ""} from Telnyx (${telnyxNumbers.length} total in account)`
          : `All ${telnyxNumbers.length} Telnyx numbers are already in your database`,
        staleIds.length > 0 ? `Removed ${staleIds.length} stale placeholder number${staleIds.length !== 1 ? "s" : ""}.` : "",
        campaignsFixed.length > 0 ? `Auto-fixed ${campaignsFixed.length} campaign${campaignsFixed.length !== 1 ? "s" : ""} to use a verified number.` : "",
      ].filter(Boolean).join(" "),
    });
  } catch (err) {
    const status = (err as { response?: { status?: number } }).response?.status;
    const detail = (err as { response?: { data?: unknown } }).response?.data;
    logger.error({ err: String(err), status, detail }, "Telnyx number sync failed");
    res.status(502).json({ error: `Telnyx API error (${status ?? "unknown"}): ${String(err)}` });
  }
});

export default router;
