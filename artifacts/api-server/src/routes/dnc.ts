import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { dncListTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { authenticate, requireRole } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";
import { z } from "zod";

const router: IRouter = Router();

// ── GET /dnc ─────────────────────────────────────────────────────────────────
router.get("/dnc", authenticate, async (_req, res): Promise<void> => {
  const list = await db.select().from(dncListTable).orderBy(dncListTable.createdAt);
  res.json(list);
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
  try {
    const [entry] = await db
      .insert(dncListTable)
      .values({ phoneNumber: normalised, reason })
      .onConflictDoNothing()
      .returning();
    res.status(201).json(entry ?? { message: "Already exists" });
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
  const normalised = parsed.data.numbers
    .map(n => n.replace(/[^\d+]/g, ""))
    .filter(n => n.length >= 7)
    .map(phoneNumber => ({ phoneNumber }));

  if (normalised.length === 0) {
    res.status(400).json({ error: "No valid numbers found" });
    return;
  }

  const inserted = await db
    .insert(dncListTable)
    .values(normalised)
    .onConflictDoNothing()
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
router.get("/dnc/check/:number", authenticate, async (req, res): Promise<void> => {
  const normalised = req.params.number.replace(/[^\d+]/g, "");
  const [entry] = await db
    .select()
    .from(dncListTable)
    .where(eq(dncListTable.phoneNumber, normalised));
  res.json({ on_dnc: !!entry, entry: entry ?? null });
});

export default router;
