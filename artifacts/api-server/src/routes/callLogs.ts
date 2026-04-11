import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { callLogsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { getRedisClient, removeActiveCall } from "../lib/redis.js";
import { logger } from "../lib/logger.js";
import { z } from "zod";

const router: IRouter = Router();

const TERMINAL_STATUSES = new Set(["completed", "failed", "no_answer", "busy", "cancelled"]);

// Worker/webhook payload — accepts full call data including recording/transcript/summary
const logCallSchema = z.object({
  phone_number: z.string().min(7),
  campaign_id: z.number().int().positive(),
  status: z.string().default("initiated"),
  disposition: z.string().optional(),
  call_id: z.string().optional(),
  direction: z.string().optional(),
  duration: z.number().optional(),
  recording_url: z.string().optional(),
  transcript: z.string().optional(),
  summary: z.string().optional(),
});

// ── POST /calls/log — worker calls this (no auth — public webhook) ─────────────
router.post("/calls/log", async (req, res): Promise<void> => {
  const parsed = logCallSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "phone_number and campaign_id are required" });
    return;
  }

  const { phone_number, campaign_id, status, disposition, call_id, direction, duration, recording_url, transcript, summary } = parsed.data;

  const [log] = await db
    .insert(callLogsTable)
    .values({
      phoneNumber: phone_number,
      campaignId: campaign_id,
      status,
      disposition: disposition ?? null,
      direction: direction ?? "outbound",
      duration: duration ?? null,
      recordingUrl: recording_url ?? null,
      transcript: transcript ?? null,
      summary: summary ?? null,
      callControlId: call_id ?? null,
    })
    .returning();

  if (TERMINAL_STATUSES.has(status)) {
    if (call_id) {
      await removeActiveCall(call_id);
    } else {
      await removeActiveCallByPhone(phone_number, campaign_id);
    }
  }

  res.status(201).json(log);
});

// ── PATCH /call-logs/:id/disposition — manually tag/update disposition ────────
const dispositionSchema = z.object({
  disposition: z.enum(["interested", "not_interested", "vm", "no_answer", "busy", "connected", "callback_requested", "transferred", "completed"]),
  summary: z.string().optional(),
});

router.patch("/call-logs/:id/disposition", authenticate, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const parsed = dispositionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid disposition value" });
    return;
  }

  const update: Record<string, unknown> = { disposition: parsed.data.disposition };
  if (parsed.data.summary) update.summary = parsed.data.summary;

  const [updated] = await db
    .update(callLogsTable)
    .set(update)
    .where(eq(callLogsTable.id, id))
    .returning();

  if (!updated) { res.status(404).json({ error: "Call log not found" }); return; }
  res.json(updated);
});

// ── PATCH /calls/:id/disposition — same for the calls table ──────────────────
import { callsTable } from "@workspace/db";

router.patch("/calls/:id/disposition", authenticate, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const parsed = dispositionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid disposition value" });
    return;
  }

  const update: Record<string, unknown> = { disposition: parsed.data.disposition };
  if (parsed.data.summary) update.summary = parsed.data.summary;

  const [updated] = await db
    .update(callsTable)
    .set(update)
    .where(eq(callsTable.id, id))
    .returning();

  if (!updated) { res.status(404).json({ error: "Call not found" }); return; }
  res.json(updated);
});

// ── GET /call-logs — all logs with optional filters ───────────────────────────
router.get("/call-logs", authenticate, async (req, res): Promise<void> => {
  const campaignId = req.query.campaignId ? parseInt(req.query.campaignId as string, 10) : null;

  let logs;
  if (campaignId && !isNaN(campaignId)) {
    logs = await db
      .select()
      .from(callLogsTable)
      .where(eq(callLogsTable.campaignId, campaignId))
      .orderBy(desc(callLogsTable.timestamp));
  } else {
    logs = await db
      .select()
      .from(callLogsTable)
      .orderBy(desc(callLogsTable.timestamp))
      .limit(500);
  }

  res.json(logs);
});

// ── GET /call-logs/:campaign_id — legacy route ────────────────────────────────
router.get("/call-logs/:campaign_id", authenticate, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.campaign_id) ? req.params.campaign_id[0] : req.params.campaign_id;
  const campaignId = parseInt(rawId, 10);
  if (isNaN(campaignId)) { res.status(400).json({ error: "Invalid campaign_id" }); return; }

  const logs = await db
    .select()
    .from(callLogsTable)
    .where(eq(callLogsTable.campaignId, campaignId))
    .orderBy(desc(callLogsTable.timestamp));

  res.json(logs);
});

export default router;

// ── Redis helper ──────────────────────────────────────────────────────────────
async function removeActiveCallByPhone(phone: string, campaignId: number): Promise<void> {
  if (!process.env.REDIS_HOST && !process.env.REDIS_URL) return;
  try {
    const client = getRedisClient();
    const digits = phone.replace(/\D/g, "");
    const pattern = `active_calls:${campaignId}-${digits}-*`;
    let cursor = "0";
    const toDelete: string[] = [];
    do {
      const [nextCursor, keys] = await client.scan(cursor, "MATCH", pattern, "COUNT", 50);
      cursor = nextCursor;
      toDelete.push(...keys);
    } while (cursor !== "0");
    if (toDelete.length > 0) await client.del(...toDelete);
  } catch (err) {
    logger.warn({ err, phone }, "Redis removeActiveCallByPhone failed");
  }
}
