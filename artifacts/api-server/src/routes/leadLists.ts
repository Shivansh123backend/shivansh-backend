import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { leadListsTable, leadsTable, campaignsTable } from "@workspace/db";
import { eq, inArray, and, sql } from "drizzle-orm";
import { authenticate, requireRole } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";
import { z } from "zod";

const router: IRouter = Router();

// ── GET /lists ────────────────────────────────────────────────────────────────
// List every list with lead counts + assigned campaign name.
router.get("/lists", authenticate, async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: leadListsTable.id,
      name: leadListsTable.name,
      description: leadListsTable.description,
      campaignId: leadListsTable.campaignId,
      active: leadListsTable.active,
      createdAt: leadListsTable.createdAt,
      campaignName: campaignsTable.name,
      leadsCount: sql<number>`(SELECT COUNT(*)::int FROM ${leadsTable} WHERE ${leadsTable.listId} = ${leadListsTable.id})`,
      lastCalledAt: sql<Date | null>`(SELECT MAX(${leadsTable.lastCalledAt}) FROM ${leadsTable} WHERE ${leadsTable.listId} = ${leadListsTable.id})`,
    })
    .from(leadListsTable)
    .leftJoin(campaignsTable, eq(leadListsTable.campaignId, campaignsTable.id))
    .orderBy(leadListsTable.id);
  res.json(rows);
});

// ── GET /lists/:id ────────────────────────────────────────────────────────────
router.get("/lists/:id", authenticate, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid list ID" }); return; }
  const [list] = await db.select().from(leadListsTable).where(eq(leadListsTable.id, id)).limit(1);
  if (!list) { res.status(404).json({ error: "List not found" }); return; }
  const leads = await db.select().from(leadsTable).where(eq(leadsTable.listId, id)).orderBy(leadsTable.createdAt);
  res.json({ ...list, leads });
});

// ── POST /lists ───────────────────────────────────────────────────────────────
const createSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  campaignId: z.number().int().positive().optional().nullable(),
  active: z.boolean().optional(),
});
router.post("/lists", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }); return; }
  const [created] = await db.insert(leadListsTable).values({
    name: parsed.data.name,
    description: parsed.data.description,
    campaignId: parsed.data.campaignId ?? null,
    active: parsed.data.active ?? true,
  }).returning();
  logger.info({ listId: created.id, name: created.name }, "Lead list created");
  res.status(201).json(created);
});

// ── PATCH /lists/:id ──────────────────────────────────────────────────────────
const patchSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  campaignId: z.number().int().positive().optional().nullable(),
  active: z.boolean().optional(),
});
router.patch("/lists/:id", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid list ID" }); return; }
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }); return; }
  const [updated] = await db.update(leadListsTable).set(parsed.data).where(eq(leadListsTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "List not found" }); return; }
  res.json(updated);
});

// ── DELETE /lists/:id ─────────────────────────────────────────────────────────
router.delete("/lists/:id", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid list ID" }); return; }
  // FK on leads.listId is ON DELETE SET NULL — leads survive, are simply un-listed.
  const deleted = await db.delete(leadListsTable).where(eq(leadListsTable.id, id)).returning({ id: leadListsTable.id });
  if (deleted.length === 0) { res.status(404).json({ error: "List not found" }); return; }
  logger.info({ listId: id }, "Lead list deleted");
  res.json({ success: true, id });
});

// ── POST /lists/:id/leads — add lead IDs to this list ────────────────────────
const assignLeadsSchema = z.object({ leadIds: z.array(z.number().int().positive()).min(1) });
router.post("/lists/:id/leads", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid list ID" }); return; }
  const parsed = assignLeadsSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }); return; }
  const [list] = await db.select().from(leadListsTable).where(eq(leadListsTable.id, id)).limit(1);
  if (!list) { res.status(404).json({ error: "List not found" }); return; }
  const updated = await db.update(leadsTable)
    .set({ listId: id })
    .where(inArray(leadsTable.id, parsed.data.leadIds))
    .returning({ id: leadsTable.id });
  logger.info({ listId: id, count: updated.length }, "Leads assigned to list");
  res.json({ success: true, listId: id, assigned: updated.length });
});

// ── POST /lists/:id/assign-campaign — link list to a campaign ────────────────
const assignCampaignSchema = z.object({ campaignId: z.number().int().positive().nullable() });
router.post("/lists/:id/assign-campaign", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid list ID" }); return; }
  const parsed = assignCampaignSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }); return; }
  if (parsed.data.campaignId !== null) {
    const [c] = await db.select({ id: campaignsTable.id }).from(campaignsTable).where(eq(campaignsTable.id, parsed.data.campaignId)).limit(1);
    if (!c) { res.status(404).json({ error: "Campaign not found" }); return; }
  }
  const [updated] = await db.update(leadListsTable)
    .set({ campaignId: parsed.data.campaignId })
    .where(eq(leadListsTable.id, id))
    .returning();
  if (!updated) { res.status(404).json({ error: "List not found" }); return; }
  logger.info({ listId: id, campaignId: parsed.data.campaignId }, "List assigned to campaign");
  res.json(updated);
});

export default router;
