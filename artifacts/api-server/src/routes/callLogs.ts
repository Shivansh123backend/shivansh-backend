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
// Accepts the canonical enum values *and* common synonyms used by the agent
// wrap-up screen so the UI never gets a 400 for harmless variants.
const ALLOWED_DISPOSITIONS = new Set([
  "interested", "not_interested", "vm", "voicemail", "no_answer", "busy",
  "connected", "callback_requested", "callback", "transferred", "completed",
  "sale", "no_sale", "do_not_call", "dnc", "wrong_number", "answering_machine",
  "left_message", "appointment_set", "follow_up", "other",
]);
// ── GET /dispositions — server-controlled list for the wrap-up dropdown ──────
// Mirrors ALLOWED_DISPOSITIONS so the softphone can never submit a value the
// backend will reject. Each row has a stable `code` (what the backend stores)
// and a friendly `label` for the UI.
const DISPOSITION_OPTIONS: { code: string; label: string }[] = [
  { code: "interested",        label: "Interested" },
  { code: "not_interested",    label: "Not Interested" },
  { code: "callback_requested",label: "Callback Requested" },
  { code: "appointment_set",   label: "Appointment Set" },
  { code: "sale",              label: "Sale" },
  { code: "no_sale",           label: "No Sale" },
  { code: "voicemail",         label: "Voicemail / No Answer" },
  { code: "wrong_number",      label: "Wrong Number" },
  { code: "do_not_call",       label: "Do Not Call (DNC)" },
  { code: "follow_up",         label: "Follow Up" },
  { code: "transferred",       label: "Transferred" },
  { code: "completed",         label: "Completed" },
  { code: "other",             label: "Other" },
];
router.get("/dispositions", authenticate, (_req, res): void => {
  res.json(DISPOSITION_OPTIONS);
});

const dispositionSchema = z.object({
  disposition: z.string().min(1).refine(v => ALLOWED_DISPOSITIONS.has(v), {
    message: `disposition must be one of: ${[...ALLOWED_DISPOSITIONS].join(", ")}`,
  }),
  summary: z.string().optional(),
  notes: z.string().optional(),
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

// ── POST /calls/disposition — flexible wrap-up endpoint ──────────────────────
// Used by the agent softphone "Save" / "Save & Ready" buttons. Accepts EITHER
// a numeric callLogId / callId OR a Telnyx callControlId string, so the UI can
// just hand us whatever it's holding without translating IDs first.
import { callsTable } from "@workspace/db";
import { humanAgentsTable } from "@workspace/db";
import { setAgentStatus } from "../lib/redis.js";

const wrapUpSchema = z.object({
  callControlId: z.string().optional(),
  callLogId:     z.union([z.string(), z.number()]).optional(),
  callId:        z.union([z.string(), z.number()]).optional(),
  disposition:   z.string().min(1).refine(v => ALLOWED_DISPOSITIONS.has(v), {
    message: `disposition must be one of: ${[...ALLOWED_DISPOSITIONS].join(", ")}`,
  }),
  summary:       z.string().optional(),
  notes:         z.string().optional(),
  setReady:      z.boolean().optional(),     // "Save & Ready" → flip agent back to available
  agentId:       z.union([z.string(), z.number()]).optional(),
});

router.post("/calls/disposition", authenticate, async (req, res): Promise<void> => {
  const parsed = wrapUpSchema.safeParse(req.body);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? "Invalid request";
    res.status(400).json({ error: msg, issues: parsed.error.issues });
    return;
  }

  const { callControlId, callLogId, callId, disposition, summary, notes, setReady, agentId } = parsed.data;

  if (!callControlId && callLogId == null && callId == null) {
    res.status(400).json({ error: "Provide callControlId, callLogId, or callId" });
    return;
  }

  const updateLog: Record<string, unknown> = { disposition };
  if (summary) updateLog.summary = summary;
  if (notes)   updateLog.summary = (updateLog.summary ? updateLog.summary + "\n" : "") + notes;

  let updated:
    | { table: "call_logs"; row: typeof callLogsTable.$inferSelect }
    | { table: "calls";     row: typeof callsTable.$inferSelect }
    | null = null;

  // Try call_logs by callControlId first (most common path from the softphone)
  if (callControlId) {
    const [row] = await db
      .update(callLogsTable)
      .set(updateLog)
      .where(eq(callLogsTable.callControlId, callControlId))
      .returning();
    if (row) updated = { table: "call_logs", row };
  }

  // Fall back to numeric IDs
  if (!updated && callLogId != null) {
    const id = typeof callLogId === "number" ? callLogId : parseInt(callLogId, 10);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "callLogId must be numeric" }); return; }
    const [row] = await db
      .update(callLogsTable)
      .set(updateLog)
      .where(eq(callLogsTable.id, id))
      .returning();
    if (row) updated = { table: "call_logs", row };
  }

  if (!updated && callId != null) {
    const id = typeof callId === "number" ? callId : parseInt(callId, 10);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "callId must be numeric" }); return; }
    const [row] = await db
      .update(callsTable)
      .set({ disposition: disposition as never, ...(summary || notes ? { summary: [summary, notes].filter(Boolean).join("\n") } : {}) })
      .where(eq(callsTable.id, id))
      .returning();
    if (row) updated = { table: "calls", row };
  }

  if (!updated) {
    res.status(404).json({ error: "No call found for the given callControlId / callLogId / callId" });
    return;
  }

  // "Save & Ready" — flip the human agent back to available so the dialer can route again
  let agentResult: { id: number; status: string } | null = null;
  if (setReady) {
    const aid = agentId != null
      ? (typeof agentId === "number" ? agentId : parseInt(agentId, 10))
      : (req as unknown as { user?: { humanAgentId?: number; id?: number } }).user?.humanAgentId
        ?? (req as unknown as { user?: { humanAgentId?: number; id?: number } }).user?.id;

    if (aid && Number.isFinite(aid)) {
      try {
        const [agent] = await db
          .update(humanAgentsTable)
          .set({ status: "available", updatedAt: new Date() })
          .where(eq(humanAgentsTable.id, aid as number))
          .returning();
        if (agent) {
          await setAgentStatus({ agent_id: agent.id, status: "available", updated_at: new Date().toISOString() });
          agentResult = { id: agent.id, status: "available" };
        }
      } catch (err) {
        logger.warn({ err, aid }, "setReady failed — disposition still saved");
      }
    }
  }

  res.json({ ok: true, table: updated.table, row: updated.row, agent: agentResult });
});

// ── PATCH /calls/:id/disposition — same for the calls table ──────────────────

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
