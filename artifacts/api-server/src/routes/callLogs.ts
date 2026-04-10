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

const logCallSchema = z.object({
  phone_number: z.string().min(7),
  campaign_id: z.number().int().positive(),
  status: z.string().default("initiated"),
  disposition: z.string().optional(),
  call_id: z.string().optional(), // worker can pass back the call_id for Redis cleanup
});

// POST /calls/log — worker calls this to record a call result (no auth — public webhook)
router.post("/calls/log", async (req, res): Promise<void> => {
  const parsed = logCallSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "phone_number and campaign_id are required" });
    return;
  }

  const { phone_number, campaign_id, status, disposition, call_id } = parsed.data;

  const [log] = await db
    .insert(callLogsTable)
    .values({ phoneNumber: phone_number, campaignId: campaign_id, status, disposition })
    .returning();

  // Remove from Redis when the call has ended
  if (TERMINAL_STATUSES.has(status)) {
    if (call_id) {
      // Exact removal if the worker provided our call_id
      await removeActiveCall(call_id);
    } else {
      // Scan for any active_calls entries matching this phone+campaign and remove them
      await removeActiveCallByPhone(phone_number, campaign_id);
    }
  }

  res.status(201).json(log);
});

// GET /call-logs — return all call logs (optionally filtered by ?campaignId=)
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

// GET /call-logs/:campaign_id — return all logs for a campaign (legacy route)
router.get("/call-logs/:campaign_id", authenticate, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.campaign_id) ? req.params.campaign_id[0] : req.params.campaign_id;
  const campaignId = parseInt(rawId, 10);

  if (isNaN(campaignId)) {
    res.status(400).json({ error: "Invalid campaign_id" });
    return;
  }

  const logs = await db
    .select()
    .from(callLogsTable)
    .where(eq(callLogsTable.campaignId, campaignId))
    .orderBy(desc(callLogsTable.timestamp));

  res.json(logs);
});

export default router;

// Scan Redis for active_calls matching a phone+campaign and delete them.
// Used when the worker doesn't know the internal call_id.
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

    if (toDelete.length > 0) {
      await client.del(...toDelete);
    }
  } catch (err) {
    logger.warn({ err, phone }, "Redis removeActiveCallByPhone failed");
  }
}
