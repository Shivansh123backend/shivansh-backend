import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { dncListTable, leadsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { authenticate, requireRole } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";
import { z } from "zod";
import { getSpamProfile, scanNumbers, BLOCK_THRESHOLD } from "../services/spamCheck.js";

const router: IRouter = Router();

// ── GET /dnc ─────────────────────────────────────────────────────────────────
// Returns ALL rows in dnc_list. Each row may be a manual block, an auto-block
// (autoBlocked=true), or a non-blocking score cache (spamScore < threshold).
// The UI renders manual + auto-blocked rows; cached-only rows are hidden.
router.get("/dnc", authenticate, async (_req, res): Promise<void> => {
  const list = await db
    .select()
    .from(dncListTable)
    .orderBy(desc(dncListTable.createdAt));

  // Hide pure score-cache rows (not blocking) from the list view — they're
  // only there to speed up future lookups, not to surface to the user.
  // A row is a real block iff it was auto-blocked OR has a manual reason.
  const visible = list.filter(r => r.autoBlocked || r.reason !== null);
  res.json(visible);
});

// ── POST /dnc ─────────────────────────────────────────────────────────────────
router.post("/dnc", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const schema = z.object({
    phone_number: z.string().min(7),
    reason: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    return;
  }
  const { phone_number, reason } = parsed.data;
  const normalised = phone_number.replace(/[^\d+]/g, "");
  // A row only counts as "blocking" when reason IS NOT NULL or autoBlocked=true.
  // Callers often submit a blank reason — default to "Manual block" so the entry
  // actually blocks. Upsert (not onConflictDoNothing) so an existing non-blocking
  // score-cache row gets promoted to a real block instead of silently ignored.
  const effectiveReason = (reason && reason.trim().length > 0) ? reason.trim() : "Manual block";
  try {
    const [entry] = await db
      .insert(dncListTable)
      .values({ phoneNumber: normalised, reason: effectiveReason })
      .onConflictDoUpdate({
        target: dncListTable.phoneNumber,
        set: { reason: effectiveReason },
      })
      .returning();
    res.status(201).json(entry);
  } catch (err) {
    logger.warn({ err }, "DNC insert failed");
    res.status(400).json({ error: "Could not add to DNC list" });
  }
});

// ── POST /dnc/import ─────────────────────────────────────────────────────────
// Bulk add — body: { numbers: string[] }
router.post("/dnc/import", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const schema = z.object({ numbers: z.array(z.string()).min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Provide an array of phone numbers in 'numbers'" });
    return;
  }
  // Each row needs a non-null reason to actually block (see POST /dnc for the rule).
  const normalised = parsed.data.numbers
    .map(n => n.replace(/[^\d+]/g, ""))
    .filter(n => n.length >= 7)
    .map(phoneNumber => ({ phoneNumber, reason: "Bulk import" }));

  if (normalised.length === 0) {
    res.status(400).json({ error: "No valid numbers found" });
    return;
  }

  // Upsert so existing non-blocking score-cache rows get promoted to blocks.
  const inserted = await db
    .insert(dncListTable)
    .values(normalised)
    .onConflictDoUpdate({
      target: dncListTable.phoneNumber,
      set: { reason: "Bulk import" },
    })
    .returning();

  logger.info({ count: inserted.length }, "DNC bulk import");
  res.status(201).json({ added: inserted.length, skipped: normalised.length - inserted.length });
});

// ── DELETE /dnc/:id ───────────────────────────────────────────────────────────
router.delete("/dnc/:id", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid ID" });
    return;
  }
  await db.delete(dncListTable).where(eq(dncListTable.id, id));
  res.json({ success: true });
});

// ── GET /dnc/check/:number ────────────────────────────────────────────────────
// Live DNC + spam check. Hits cache if fresh (<30 days), otherwise queries
// Telnyx Number Lookup. Used by the dashboard "Preview" button before adding
// a number, and by all 3 enforcement points internally.
router.get("/dnc/check/:number", authenticate, async (req, res): Promise<void> => {
  try {
    const profile = await getSpamProfile(req.params.number);
    res.json({
      on_dnc: profile.onDnc,
      blocked: profile.blocked,
      spam_score: profile.spamScore,
      line_type: profile.lineType,
      carrier_name: profile.carrierName,
      reason: profile.reason,
      cached: profile.cached,
    });
  } catch (err) {
    logger.warn({ err: String(err), number: req.params.number }, "DNC check failed");
    res.status(500).json({ error: "Spam check failed" });
  }
});

// ── POST /dnc/scan/:number ───────────────────────────────────────────────────
// Force a fresh Telnyx lookup (bypasses cache). Use this from the UI when the
// user explicitly clicks "Re-check spam score".
router.post("/dnc/scan/:number", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  try {
    const profile = await getSpamProfile(req.params.number, { forceRefresh: true });
    res.json(profile);
  } catch (err) {
    logger.warn({ err: String(err) }, "DNC force-scan failed");
    res.status(500).json({ error: "Scan failed" });
  }
});

// ── POST /dnc/scan-campaign/:campaignId ──────────────────────────────────────
// Bulk-scan every lead in a campaign. Auto-blocks any lead whose spam score
// crosses the threshold. Returns counts so the UI can show "X blocked, Y safe".
router.post("/dnc/scan-campaign/:campaignId", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const campaignId = parseInt(req.params.campaignId, 10);
  if (isNaN(campaignId)) {
    res.status(400).json({ error: "Invalid campaignId" });
    return;
  }
  const leads = await db
    .select({ phone: leadsTable.phone })
    .from(leadsTable)
    .where(eq(leadsTable.campaignId, campaignId));
  if (leads.length === 0) {
    res.json({ scanned: 0, blocked: 0, results: [] });
    return;
  }
  const numbers = Array.from(new Set(leads.map(l => l.phone).filter(Boolean)));
  logger.info({ campaignId, count: numbers.length }, "DNC bulk scan starting");
  const out = await scanNumbers(numbers);
  logger.info({ campaignId, scanned: out.scanned, blocked: out.blocked }, "DNC bulk scan done");
  res.json(out);
});

export default router;
