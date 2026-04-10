import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { callLogsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { z } from "zod";

const router: IRouter = Router();

const logCallSchema = z.object({
  phone_number: z.string().min(7),
  campaign_id: z.number().int().positive(),
  status: z.string().default("initiated"),
  disposition: z.string().optional(),
});

// POST /calls/log — worker calls this to record a call result (no auth — public webhook)
router.post("/calls/log", async (req, res): Promise<void> => {
  const parsed = logCallSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "phone_number and campaign_id are required" });
    return;
  }

  const [log] = await db
    .insert(callLogsTable)
    .values({
      phoneNumber: parsed.data.phone_number,
      campaignId: parsed.data.campaign_id,
      status: parsed.data.status,
      disposition: parsed.data.disposition,
    })
    .returning();

  res.status(201).json(log);
});

// GET /call-logs/:campaign_id — return all logs for a campaign
// (Using /call-logs prefix to avoid conflict with existing GET /calls/:id route)
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
