import { Router, type IRouter } from "express";
import multer from "multer";
import { parse as csvParse } from "csv-parse/sync";
import * as XLSX from "xlsx";
import axios from "axios";
import { db } from "@workspace/db";
import { leadsTable, campaignsTable, dncListTable, leadListsTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { authenticate, requireRole } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";
import { z } from "zod";

const BATCH_SIZE = 50;
const BATCH_DELAY_MS = 500;

const router: IRouter = Router();

// ── Multer — memory storage, 20 MB cap ──────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// ── Helpers ──────────────────────────────────────────────────────────────────

import { normalisePhone } from "../lib/phone.js";

/** Build a normalised set of all DNC phone numbers for fast O(1) lookup.
 *  Skips non-blocking score-cache rows (autoBlocked=false, reason=null) that
 *  the spam-check service writes purely to memoize Telnyx lookups. */
async function fetchDncSet(): Promise<Set<string>> {
  const rows = await db
    .select({ phone: dncListTable.phoneNumber, autoBlocked: dncListTable.autoBlocked, reason: dncListTable.reason })
    .from(dncListTable);
  return new Set(
    rows
      .filter(r => r.autoBlocked || r.reason !== null)
      .map(r => r.phone.replace(/[^\d+]/g, "")),
  );
}

/** Insert rows in batches of BATCH_SIZE with BATCH_DELAY_MS between each batch. */
async function batchInsert(
  rows: Array<{ name: string; phone: string; email: string | null; campaignId: number; listId?: number | null; source: "manual" | "csv" | "sheet" }>,
): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const result = await db.insert(leadsTable).values(batch).returning({ id: leadsTable.id });
    inserted += result.length;
    if (i + BATCH_SIZE < rows.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }
  return inserted;
}

function normaliseEmail(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed : null;
}

/** Extract name/phone/email from a raw row object (handles various header spellings). */
function extractRow(row: Record<string, unknown>): {
  name: string;
  phone: string | null;
  email: string | null;
} {
  const str = (keys: string[]): string | null => {
    for (const k of keys) {
      const v = row[k] ?? row[k.toLowerCase()] ?? row[k.toUpperCase()];
      if (v != null && String(v).trim()) return String(v).trim();
    }
    return null;
  };

  return {
    name: str(["name", "Name", "NAME", "full_name", "Full Name"]) ?? "Unknown",
    phone: normalisePhone(str(["phone_number", "phone", "Phone", "PHONE", "Phone Number", "mobile", "Mobile"])),
    email: normaliseEmail(str(["email", "Email", "EMAIL", "e-mail", "E-mail"])),
  };
}

/** Parse CSV buffer → array of raw row objects. */
function parseCsv(buffer: Buffer): Record<string, unknown>[] {
  return csvParse(buffer, { columns: true, skip_empty_lines: true, trim: true });
}

/** Parse XLSX/XLS/ODS buffer → array of raw row objects. */
function parseExcel(buffer: Buffer): Record<string, unknown>[] {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });
}

interface NormalisedLead {
  name: string;
  phone: string;
  email: string | null;
}

/** Deduplicate by phone within the batch, then filter against existing DB rows. */
async function deduplicateBatch(
  rows: NormalisedLead[],
  campaignId: number
): Promise<{ valid: NormalisedLead[]; skipped: number }> {
  // Within-batch deduplication (keep first occurrence per phone)
  const seen = new Set<string>();
  const unique: NormalisedLead[] = [];
  for (const r of rows) {
    if (!seen.has(r.phone)) {
      seen.add(r.phone);
      unique.push(r);
    }
  }

  // DB deduplication — find phones already in this campaign
  if (unique.length === 0) return { valid: [], skipped: rows.length };

  const phones = unique.map((r) => r.phone);
  const existing = await db
    .select({ phone: leadsTable.phone })
    .from(leadsTable)
    .where(and(eq(leadsTable.campaignId, campaignId), inArray(leadsTable.phone, phones)));

  const existingPhones = new Set(existing.map((e) => e.phone));
  const valid = unique.filter((r) => !existingPhones.has(r.phone));

  return { valid, skipped: rows.length - valid.length };
}

/** Verify campaign exists and return it. */
async function getCampaign(campaignId: number) {
  const [campaign] = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.id, campaignId));
  return campaign ?? null;
}

// ── POST /leads/add ─────────────────────────────────────────────────────────
// Manual single-lead entry
// Accept both snake_case and camelCase field names from any client
const addLeadSchema = z.object({
  name: z.string().min(1),
  phone_number: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  phoneNumber: z.string().min(1).optional(),
  email: z.string().email().optional().nullable(),
  campaign_id: z.coerce.number().int().positive().optional(),
  campaignId: z.coerce.number().int().positive().optional(),
  list_id: z.coerce.number().int().positive().optional().nullable(),
  listId: z.coerce.number().int().positive().optional().nullable(),
}).transform((d) => ({
  name: d.name,
  phone_number: d.phone_number ?? d.phone ?? d.phoneNumber ?? "",
  email: d.email,
  campaign_id: d.campaign_id ?? d.campaignId ?? 0,
  list_id: d.list_id ?? d.listId ?? null,
}));

async function handleAddLead(
  req: import("express").Request,
  res: import("express").Response,
): Promise<void> {
  const parsed = addLeadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    return;
  }

  const { name, phone_number, email, campaign_id, list_id } = parsed.data;

  if (!campaign_id) {
    res.status(400).json({ error: "campaign_id is required" });
    return;
  }

  const phone = normalisePhone(phone_number);
  if (!phone) {
    res.status(400).json({ error: "Invalid phone number" });
    return;
  }

  const campaign = await getCampaign(campaign_id);
  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }

  if (list_id) {
    const [list] = await db.select({ id: leadListsTable.id }).from(leadListsTable).where(eq(leadListsTable.id, list_id)).limit(1);
    if (!list) { res.status(404).json({ error: "List not found" }); return; }
  }

  const [dup] = await db
    .select({ id: leadsTable.id })
    .from(leadsTable)
    .where(and(eq(leadsTable.campaignId, campaign_id), eq(leadsTable.phone, phone)));

  if (dup) {
    res.status(409).json({ error: "Lead with this phone number already exists in this campaign" });
    return;
  }

  const [lead] = await db
    .insert(leadsTable)
    .values({ name, phone, email: email ?? null, campaignId: campaign_id, listId: list_id ?? null, source: "manual" })
    .returning();

  res.status(201).json({
    id: lead.id,
    name: lead.name,
    phone: lead.phone,
    phone_number: lead.phone,
    email: lead.email,
    campaignId: lead.campaignId,
    campaign_id: lead.campaignId,
    source: lead.source,
    status: lead.status,
    createdAt: lead.createdAt,
    created_at: lead.createdAt,
  });
}

// POST /leads — standard REST endpoint (JSON single lead)
router.post("/leads", authenticate, handleAddLead);

// POST /leads/add — original endpoint kept for compatibility
router.post("/leads/add", authenticate, handleAddLead);

// ── POST /leads/upload ──────────────────────────────────────────────────────
// CSV or Excel bulk upload — multipart/form-data field: "file" + "campaign_id"
router.post(
  "/leads/upload",
  authenticate,
  requireRole("admin"),
  upload.single("file"),
  async (req, res): Promise<void> => {
    const campaignId = parseInt(req.body.campaign_id ?? req.body.campaignId, 10);
    if (isNaN(campaignId)) {
      res.status(400).json({ error: "campaign_id is required" });
      return;
    }
    const listIdRaw = req.body.list_id ?? req.body.listId;
    const listId: number | null = listIdRaw ? parseInt(listIdRaw, 10) : null;

    if (!req.file) {
      // No file — if the body has JSON lead fields, handle as a single lead add
      const contentType = req.headers["content-type"] ?? "";
      if (contentType.includes("application/json") || req.body?.name) {
        await handleAddLead(req, res);
        return;
      }
      res.status(400).json({ error: "No file uploaded. Send a CSV or XLSX file in the 'file' field." });
      return;
    }

    const campaign = await getCampaign(campaignId);
    if (!campaign) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }

    if (listId) {
      const [list] = await db.select({ id: leadListsTable.id }).from(leadListsTable).where(eq(leadListsTable.id, listId)).limit(1);
      if (!list) { res.status(404).json({ error: "List not found" }); return; }
    }

    // Detect format by MIME type or original name
    const mime = req.file.mimetype.toLowerCase();
    const ext = (req.file.originalname ?? "").split(".").pop()?.toLowerCase();
    const isExcel =
      mime.includes("spreadsheet") ||
      mime.includes("excel") ||
      mime.includes("officedocument") ||
      ext === "xlsx" ||
      ext === "xls" ||
      ext === "ods";

    let rawRows: Record<string, unknown>[];
    try {
      rawRows = isExcel ? parseExcel(req.file.buffer) : parseCsv(req.file.buffer);
    } catch (err) {
      logger.warn({ err }, "File parse error");
      res.status(400).json({ error: "Could not parse file. Ensure it is a valid CSV or XLSX." });
      return;
    }

    // Extract + validate
    const validRows: NormalisedLead[] = [];
    let invalidCount = 0;
    for (const row of rawRows) {
      const { name, phone, email } = extractRow(row);
      if (!phone) { invalidCount++; continue; }
      validRows.push({ name, phone, email });
    }

    // DNC filtering — skip any number on the do-not-call list
    const dncSet = await fetchDncSet();
    const nonDncRows: NormalisedLead[] = [];
    let dncCount = 0;
    for (const r of validRows) {
      const norm = r.phone.replace(/[^\d+]/g, "");
      if (dncSet.has(norm)) {
        dncCount++;
        logger.info({ phone: r.phone, campaignId }, "Lead skipped during upload — DNC flagged");
      } else {
        nonDncRows.push(r);
      }
    }

    // Deduplicate against DB
    const { valid, skipped: dupCount } = await deduplicateBatch(nonDncRows, campaignId);

    if (valid.length === 0) {
      res.json({
        total_uploaded: 0,
        total_skipped: invalidCount + dncCount + dupCount,
        invalid_numbers: invalidCount,
        duplicates: dupCount,
        dnc_skipped: dncCount,
      });
      return;
    }

    // Batch insert — 50 rows per batch, 500 ms between batches
    const totalInserted = await batchInsert(
      valid.map(r => ({ name: r.name, phone: r.phone, email: r.email, campaignId, listId: listId ?? null, source: "csv" as const }))
    );

    logger.info(
      { campaignId, uploaded: totalInserted, invalid: invalidCount, duplicates: dupCount, dnc: dncCount },
      "Bulk CSV/XLSX upload complete"
    );
    res.status(201).json({
      total_uploaded: totalInserted,
      total_skipped: invalidCount + dncCount + dupCount,
      invalid_numbers: invalidCount,
      duplicates: dupCount,
      dnc_skipped: dncCount,
    });
  }
);

// ── POST /leads/import-sheet ────────────────────────────────────────────────
// Google Sheets public import — fetches CSV export from a Sheets URL
const importSheetSchema = z.object({
  sheet_url: z.string().url(),
  campaign_id: z.coerce.number().int().positive(),
});

router.post("/leads/import-sheet", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const parsed = importSheetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "sheet_url and campaign_id are required" });
    return;
  }

  const { sheet_url, campaign_id } = parsed.data;

  // Extract sheet ID from any Google Sheets URL format
  const idMatch = sheet_url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!idMatch) {
    res.status(400).json({ error: "Invalid Google Sheets URL. Expected: https://docs.google.com/spreadsheets/d/{sheet_id}/..." });
    return;
  }

  const campaign = await getCampaign(campaign_id);
  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }

  const sheetId = idMatch[1];
  const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;

  let rawRows: Record<string, unknown>[];
  try {
    const response = await axios.get<Buffer>(csvUrl, { responseType: "arraybuffer", timeout: 15000 });
    rawRows = parseCsv(Buffer.from(response.data));
  } catch (err) {
    logger.warn({ err, sheetId }, "Google Sheets fetch failed");
    res.status(400).json({
      error: "Could not fetch the Google Sheet. Make sure the sheet is public (Anyone with link → Viewer).",
    });
    return;
  }

  // Extract + validate
  const validRows: NormalisedLead[] = [];
  let invalidCount = 0;
  for (const row of rawRows) {
    const { name, phone, email } = extractRow(row);
    if (!phone) { invalidCount++; continue; }
    validRows.push({ name, phone, email });
  }

  // DNC filtering
  const dncSet = await fetchDncSet();
  const nonDncRows: NormalisedLead[] = [];
  let dncCount = 0;
  for (const r of validRows) {
    const norm = r.phone.replace(/[^\d+]/g, "");
    if (dncSet.has(norm)) {
      dncCount++;
      logger.info({ phone: r.phone, campaign_id }, "Lead skipped during sheet import — DNC flagged");
    } else {
      nonDncRows.push(r);
    }
  }

  const { valid, skipped: dupCount } = await deduplicateBatch(nonDncRows, campaign_id);

  if (valid.length === 0) {
    res.json({
      total_uploaded: 0,
      total_skipped: invalidCount + dncCount + dupCount,
      invalid_numbers: invalidCount,
      duplicates: dupCount,
      dnc_skipped: dncCount,
    });
    return;
  }

  // Batch insert
  const totalInserted = await batchInsert(
    valid.map(r => ({ name: r.name, phone: r.phone, email: r.email, campaignId: campaign_id, source: "sheet" as const }))
  );

  logger.info(
    { campaign_id, uploaded: totalInserted, invalid: invalidCount, duplicates: dupCount, dnc: dncCount, sheetId },
    "Google Sheets import complete"
  );
  res.status(201).json({
    total_uploaded: totalInserted,
    total_skipped: invalidCount + dncCount + dupCount,
    invalid_numbers: invalidCount,
    duplicates: dupCount,
    dnc_skipped: dncCount,
  });
});

// ── PATCH /leads/:id ─────────────────────────────────────────────────────────
// Update a lead: reassign to a different campaign, change status, update name/phone/email
const updateLeadSchema = z.object({
  campaignId:  z.coerce.number().int().positive().optional(),
  campaign_id: z.coerce.number().int().positive().optional(),
  status: z.enum(["pending", "called", "callback", "do_not_call", "completed"]).optional(),
  name:  z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  phone_number: z.string().min(1).optional(),
  email: z.string().email().nullable().optional(),
});

router.patch("/leads/:id", authenticate, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid lead ID" }); return; }

  const parsed = updateLeadSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }); return; }

  const [existing] = await db.select().from(leadsTable).where(eq(leadsTable.id, id)).limit(1);
  if (!existing) { res.status(404).json({ error: "Lead not found" }); return; }

  const data = parsed.data;
  const newCampaignId = data.campaignId ?? data.campaign_id;
  const newPhone = data.phone ?? data.phone_number;

  // Validate new campaign exists
  if (newCampaignId) {
    const campaign = await getCampaign(newCampaignId);
    if (!campaign) { res.status(404).json({ error: "Campaign not found" }); return; }
  }

  // Build update payload
  const update: Partial<typeof leadsTable.$inferInsert> = {};
  if (newCampaignId)    update.campaignId = newCampaignId;
  if (data.status)      update.status = data.status;
  if (data.name)        update.name = data.name;
  if (newPhone) {
    const phone = normalisePhone(newPhone);
    if (!phone) { res.status(400).json({ error: "Invalid phone number" }); return; }
    update.phone = phone;
  }
  if (data.email !== undefined) update.email = data.email;

  if (Object.keys(update).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  const [updated] = await db.update(leadsTable).set(update).where(eq(leadsTable.id, id)).returning();

  res.json({
    id: updated.id,
    name: updated.name,
    phone: updated.phone,
    phone_number: updated.phone,
    email: updated.email,
    campaignId: updated.campaignId,
    campaign_id: updated.campaignId,
    source: updated.source,
    status: updated.status,
    createdAt: updated.createdAt,
    created_at: updated.createdAt,
  });
});

// ── POST /leads/bulk-delete — delete leads by IDs ─────────────────────────────
const bulkDeleteSchema = z.object({ ids: z.array(z.number().int().positive()).min(1).max(5000) });
router.post("/leads/bulk-delete", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const parsed = bulkDeleteSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }); return; }
  const deleted = await db.delete(leadsTable).where(inArray(leadsTable.id, parsed.data.ids)).returning({ id: leadsTable.id });
  logger.info({ count: deleted.length }, "Bulk-deleted leads");
  res.json({ success: true, deleted: deleted.length });
});

// ── POST /leads/bulk-assign-list — assign leads to a list (or null = un-list) ─
const bulkAssignSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(5000),
  listId: z.number().int().positive().nullable(),
});
router.post("/leads/bulk-assign-list", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const parsed = bulkAssignSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }); return; }
  if (parsed.data.listId !== null) {
    const [list] = await db.select({ id: leadListsTable.id }).from(leadListsTable).where(eq(leadListsTable.id, parsed.data.listId)).limit(1);
    if (!list) { res.status(404).json({ error: "List not found" }); return; }
  }
  const updated = await db.update(leadsTable)
    .set({ listId: parsed.data.listId })
    .where(inArray(leadsTable.id, parsed.data.ids))
    .returning({ id: leadsTable.id });
  logger.info({ count: updated.length, listId: parsed.data.listId }, "Bulk-assigned leads to list");
  res.json({ success: true, updated: updated.length, listId: parsed.data.listId });
});

// ── DELETE /leads/:id ─────────────────────────────────────────────────────────
router.delete("/leads/:id", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid lead ID" }); return; }

  const [existing] = await db.select().from(leadsTable).where(eq(leadsTable.id, id)).limit(1);
  if (!existing) { res.status(404).json({ error: "Lead not found" }); return; }

  await db.delete(leadsTable).where(eq(leadsTable.id, id));
  res.json({ success: true, deleted: { id, name: existing.name, phone: existing.phone } });
});

// ── DELETE /leads — bulk delete all leads for a campaign ─────────────────────
router.delete("/leads", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const campaignIdRaw = req.query.campaignId ?? req.query.campaign_id;
  if (!campaignIdRaw) { res.status(400).json({ error: "campaignId query param is required" }); return; }
  const campaignId = parseInt(String(campaignIdRaw), 10);
  if (isNaN(campaignId)) { res.status(400).json({ error: "Invalid campaignId" }); return; }

  const campaign = await getCampaign(campaignId);
  if (!campaign) { res.status(404).json({ error: "Campaign not found" }); return; }

  const deleted = await db.delete(leadsTable).where(eq(leadsTable.campaignId, campaignId)).returning({ id: leadsTable.id });
  res.json({ success: true, deleted: deleted.length, campaignId });
});

// ── GET /leads/:campaign_id ─────────────────────────────────────────────────
// List leads for a campaign. Includes leads directly on the campaign AND leads
// belonging to any list that is assigned to this campaign.
// Optional ?source=manual|csv|sheet filter.
router.get("/leads/:campaign_id", authenticate, async (req, res): Promise<void> => {
  const campaignId = parseInt(req.params.campaign_id, 10);
  if (isNaN(campaignId)) {
    res.status(400).json({ error: "Invalid campaign_id" });
    return;
  }

  // Collect IDs of lists assigned to this campaign
  const assignedLists = await db
    .select({ id: leadListsTable.id })
    .from(leadListsTable)
    .where(eq(leadListsTable.campaignId, campaignId));
  const assignedListIds = assignedLists.map(r => r.id);

  // Build the WHERE clause: direct campaign leads OR leads from assigned lists
  const campaignFilter = assignedListIds.length > 0
    ? or(eq(leadsTable.campaignId, campaignId), inArray(leadsTable.listId, assignedListIds))
    : eq(leadsTable.campaignId, campaignId);

  const sourceFilter = req.query.source as string | undefined;
  const allowedSources = ["manual", "csv", "sheet"] as const;

  let leads;
  if (sourceFilter && allowedSources.includes(sourceFilter as typeof allowedSources[number])) {
    leads = await db
      .select()
      .from(leadsTable)
      .where(and(campaignFilter, eq(leadsTable.source, sourceFilter as typeof allowedSources[number])))
      .orderBy(leadsTable.createdAt);
  } else {
    leads = await db
      .select()
      .from(leadsTable)
      .where(campaignFilter)
      .orderBy(leadsTable.createdAt);
  }

  res.json(
    leads.map((l) => ({
      id: l.id,
      name: l.name,
      phone_number: l.phone,
      phone: l.phone,
      email: l.email,
      campaign_id: l.campaignId,
      campaignId: l.campaignId,
      listId: l.listId,
      list_id: l.listId,
      source: l.source,
      status: l.status,
      spamScore: l.rankScore,
      spam_score: l.rankScore,
      callbackAt: l.callbackAt,
      callback_at: l.callbackAt,
      created_at: l.createdAt,
      createdAt: l.createdAt,
    }))
  );
});

// ── GET /leads ────────────────────────────────────────────────────────────────
router.get("/leads", authenticate, async (req, res): Promise<void> => {
  const campaignIdRaw = req.query.campaignId ?? req.query.campaign_id;
  const statusRaw = req.query.status ? String(req.query.status) : undefined;

  const conditions = [];

  if (campaignIdRaw) {
    const campaignId = parseInt(String(campaignIdRaw), 10);
    if (!isNaN(campaignId)) {
      // Include leads directly on campaign AND leads from lists assigned to it
      const assignedLists = await db
        .select({ id: leadListsTable.id })
        .from(leadListsTable)
        .where(eq(leadListsTable.campaignId, campaignId));
      const assignedListIds = assignedLists.map(r => r.id);
      if (assignedListIds.length > 0) {
        conditions.push(or(eq(leadsTable.campaignId, campaignId), inArray(leadsTable.listId, assignedListIds)));
      } else {
        conditions.push(eq(leadsTable.campaignId, campaignId));
      }
    }
  }

  if (statusRaw) {
    conditions.push(eq(leadsTable.status, statusRaw as "pending" | "called" | "callback" | "do_not_call" | "completed"));
  }

  const query = db.select().from(leadsTable);
  const leads = await (conditions.length > 0
    ? query.where(conditions.length === 1 ? conditions[0] : and(...conditions))
    : query
  ).orderBy(leadsTable.createdAt);

  res.json(leads.map((l) => ({
    id: l.id,
    name: l.name,
    phone: l.phone,
    phone_number: l.phone,
    email: l.email,
    campaignId: l.campaignId,
    campaign_id: l.campaignId,
    listId: l.listId,
    list_id: l.listId,
    source: l.source,
    status: l.status,
    createdAt: l.createdAt,
    created_at: l.createdAt,
  })));
});

export default router;
