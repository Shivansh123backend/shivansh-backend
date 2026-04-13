import { Router, type IRouter } from "express";
import multer from "multer";
import { parse as csvParse } from "csv-parse/sync";
import * as XLSX from "xlsx";
import axios from "axios";
import { db } from "@workspace/db";
import { leadsTable, campaignsTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { authenticate, requireRole } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";
import { z } from "zod";

const router: IRouter = Router();

// ── Multer — memory storage, 20 MB cap ──────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Normalise a phone string: strip everything except digits and leading +.
 *  Returns null for obviously invalid numbers (< 7 digits). */
function normalisePhone(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const stripped = String(raw).replace(/[^\d+]/g, "").replace(/(?!^\+)\+/g, "");
  const digits = stripped.replace(/\D/g, "");
  if (digits.length < 7) return null;
  // Preserve leading + if present
  return stripped.startsWith("+") ? stripped : digits;
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
}).transform((d) => ({
  name: d.name,
  phone_number: d.phone_number ?? d.phone ?? d.phoneNumber ?? "",
  email: d.email,
  campaign_id: d.campaign_id ?? d.campaignId ?? 0,
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

  const { name, phone_number, email, campaign_id } = parsed.data;

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
    .values({ name, phone, email: email ?? null, campaignId: campaign_id, source: "manual" })
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

    // Deduplicate
    const { valid, skipped } = await deduplicateBatch(validRows, campaignId);
    const totalSkipped = invalidCount + skipped;

    if (valid.length === 0) {
      res.json({ total_uploaded: 0, total_skipped: totalSkipped });
      return;
    }

    const inserted = await db
      .insert(leadsTable)
      .values(valid.map((r) => ({ name: r.name, phone: r.phone, email: r.email, campaignId, source: "csv" as const })))
      .returning();

    logger.info({ campaignId, uploaded: inserted.length, skipped: totalSkipped }, "Bulk CSV/XLSX upload");
    res.status(201).json({ total_uploaded: inserted.length, total_skipped: totalSkipped });
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

  const { valid, skipped } = await deduplicateBatch(validRows, campaign_id);
  const totalSkipped = invalidCount + skipped;

  if (valid.length === 0) {
    res.json({ total_uploaded: 0, total_skipped: totalSkipped });
    return;
  }

  const inserted = await db
    .insert(leadsTable)
    .values(valid.map((r) => ({ name: r.name, phone: r.phone, email: r.email, campaignId: campaign_id, source: "sheet" as const })))
    .returning();

  logger.info({ campaign_id, uploaded: inserted.length, skipped: totalSkipped, sheetId }, "Google Sheets import");
  res.status(201).json({ total_uploaded: inserted.length, total_skipped: totalSkipped });
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
// List leads for a campaign. Optional ?source=manual|csv|sheet filter.
router.get("/leads/:campaign_id", authenticate, async (req, res): Promise<void> => {
  const campaignId = parseInt(req.params.campaign_id, 10);
  if (isNaN(campaignId)) {
    res.status(400).json({ error: "Invalid campaign_id" });
    return;
  }

  const sourceFilter = req.query.source as string | undefined;
  const allowedSources = ["manual", "csv", "sheet"] as const;

  let leads;
  if (sourceFilter && allowedSources.includes(sourceFilter as typeof allowedSources[number])) {
    leads = await db
      .select()
      .from(leadsTable)
      .where(and(
        eq(leadsTable.campaignId, campaignId),
        eq(leadsTable.source, sourceFilter as typeof allowedSources[number])
      ))
      .orderBy(leadsTable.createdAt);
  } else {
    leads = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.campaignId, campaignId))
      .orderBy(leadsTable.createdAt);
  }

  res.json(
    leads.map((l) => ({
      id: l.id,
      name: l.name,
      phone_number: l.phone,
      email: l.email,
      campaign_id: l.campaignId,
      source: l.source,
      status: l.status,
      created_at: l.createdAt,
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
    if (!isNaN(campaignId)) conditions.push(eq(leadsTable.campaignId, campaignId));
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
    source: l.source,
    status: l.status,
    createdAt: l.createdAt,
    created_at: l.createdAt,
  })));
});

export default router;
