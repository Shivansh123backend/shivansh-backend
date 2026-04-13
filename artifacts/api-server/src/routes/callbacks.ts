import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { leadsTable, campaignsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { z } from "zod";

const router: IRouter = Router();

// ── GET /callbacks ────────────────────────────────────────────────────────────
// Returns all leads with status = "callback", optionally filtered by campaignId.
// The Callbacks page (agent-facing) polls this endpoint every 30s.
router.get("/callbacks", authenticate, async (req, res): Promise<void> => {
  const campaignIdRaw = req.query.campaignId ?? req.query.campaign_id;
  const agentId = req.query.agentId ? parseInt(String(req.query.agentId), 10) : null;

  const conditions = [eq(leadsTable.status, "callback")];

  if (campaignIdRaw) {
    const campaignId = parseInt(String(campaignIdRaw), 10);
    if (!isNaN(campaignId)) conditions.push(eq(leadsTable.campaignId, campaignId));
  }

  const leads = await db
    .select({
      id: leadsTable.id,
      name: leadsTable.name,
      phone: leadsTable.phone,
      email: leadsTable.email,
      campaignId: leadsTable.campaignId,
      source: leadsTable.source,
      status: leadsTable.status,
      createdAt: leadsTable.createdAt,
    })
    .from(leadsTable)
    .where(and(...conditions))
    .orderBy(leadsTable.createdAt);

  // Enrich with campaign name
  const campaignIds = [...new Set(leads.map((l) => l.campaignId))];
  const campaigns =
    campaignIds.length > 0
      ? await db
          .select({ id: campaignsTable.id, name: campaignsTable.name })
          .from(campaignsTable)
      : [];

  const campaignMap = new Map(campaigns.map((c) => [c.id, c.name]));

  res.json(
    leads.map((l) => ({
      id: l.id,
      name: l.name,
      phone: l.phone,
      phone_number: l.phone,
      email: l.email,
      campaignId: l.campaignId,
      campaign_id: l.campaignId,
      campaignName: campaignMap.get(l.campaignId) ?? null,
      source: l.source,
      status: l.status,
      createdAt: l.createdAt,
      created_at: l.createdAt,
    }))
  );
});

// ── PATCH /callbacks/:id ──────────────────────────────────────────────────────
// Update callback status (mark as called, reschedule, etc.)
const updateCallbackSchema = z.object({
  status: z.enum(["pending", "called", "callback", "do_not_call", "completed"]).optional(),
  notes: z.string().optional(),
});

router.patch("/callbacks/:id", authenticate, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid lead ID" }); return; }

  const parsed = updateCallbackSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, id)).limit(1);
  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }

  const [updated] = await db
    .update(leadsTable)
    .set({ ...(parsed.data.status ? { status: parsed.data.status } : {}) })
    .where(eq(leadsTable.id, id))
    .returning();

  res.json({
    id: updated.id,
    name: updated.name,
    phone: updated.phone,
    phone_number: updated.phone,
    email: updated.email,
    campaignId: updated.campaignId,
    campaign_id: updated.campaignId,
    status: updated.status,
    createdAt: updated.createdAt,
    created_at: updated.createdAt,
  });
});

export default router;
