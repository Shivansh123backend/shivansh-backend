import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { phoneNumbersTable, campaignsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { authenticate, requireRole } from "../middlewares/auth.js";
import { z } from "zod";

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
  const numbers = await db.select().from(phoneNumbersTable);
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
    label: z.string().optional(),
    campaignId: z.union([z.number(), z.null()]).optional(),
    direction: z.enum(["inbound", "outbound", "both"]).optional(),
    forwardNumber: z.union([z.string(), z.null()]).optional(),
    status: z.enum(["active", "inactive"]).optional(),
    isBlocked: z.boolean().optional(),
    priority: z.number().optional(),
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
  if ("campaignId" in parsed.data)             updatePayload.campaignId = parsed.data.campaignId ?? null;
  if ("forwardNumber" in parsed.data)          updatePayload.forwardNumber = parsed.data.forwardNumber ?? null;

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

export default router;
