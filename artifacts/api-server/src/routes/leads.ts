import { Router, type IRouter } from "express";
import multer from "multer";
import { parse } from "csv-parse";
import { db } from "@workspace/db";
import { leadsTable, campaignsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { authenticate, requireRole } from "../middlewares/auth.js";
import { z } from "zod";

const router: IRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const createLeadSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  campaignId: z.number(),
  metadata: z.string().optional(),
});

router.post("/leads/upload", authenticate, requireRole("admin"), upload.single("file"), async (req, res): Promise<void> => {
  const campaignIdRaw = req.body.campaignId;
  const campaignId = parseInt(campaignIdRaw, 10);

  if (isNaN(campaignId)) {
    res.status(400).json({ error: "campaignId is required" });
    return;
  }

  const [campaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, campaignId));
  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }

  // Handle CSV file upload
  if (req.file) {
    const csvContent = req.file.buffer.toString("utf-8");
    const inserted: unknown[] = [];

    await new Promise<void>((resolve, reject) => {
      parse(csvContent, { columns: true, skip_empty_lines: true }, async (err, records) => {
        if (err) {
          reject(err);
          return;
        }

        const leads = records.map((record: Record<string, string>) => ({
          name: record.name ?? record.Name ?? "Unknown",
          phone: record.phone ?? record.Phone ?? record.phone_number ?? "",
          campaignId,
          metadata: JSON.stringify(record),
        })).filter((l: { phone: string }) => l.phone);

        if (leads.length > 0) {
          const result = await db.insert(leadsTable).values(leads).returning();
          inserted.push(...result);
        }

        resolve();
      });
    });

    res.status(201).json({ inserted: inserted.length, message: `${inserted.length} leads uploaded` });
    return;
  }

  // Handle single lead JSON
  const parsed = createLeadSchema.safeParse({ ...req.body, campaignId });
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [lead] = await db.insert(leadsTable).values(parsed.data).returning();
  res.status(201).json(lead);
});

router.get("/leads", authenticate, async (req, res): Promise<void> => {
  const campaignIdRaw = req.query.campaignId;
  
  if (campaignIdRaw) {
    const campaignId = parseInt(String(campaignIdRaw), 10);
    if (!isNaN(campaignId)) {
      const leads = await db.select().from(leadsTable).where(eq(leadsTable.campaignId, campaignId));
      res.json(leads);
      return;
    }
  }

  const leads = await db.select().from(leadsTable);
  res.json(leads);
});

export default router;
