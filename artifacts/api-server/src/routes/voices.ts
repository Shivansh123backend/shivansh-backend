import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { voicesTable, agentVoicesTable } from "@workspace/db";
import { authenticate, requireRole } from "../middlewares/auth.js";
import { z } from "zod";

const router: IRouter = Router();

const createVoiceSchema = z.object({
  name: z.string().min(1),
  provider: z.enum(["elevenlabs", "playht", "azure"]),
  voiceId: z.string().min(1),
  gender: z.enum(["male", "female"]),
  accent: z.enum(["us", "uk", "indian", "australian", "canadian", "other"]).default("us"),
  language: z.string().default("en"),
});

router.post("/voices/create", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const parsed = createVoiceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [voice] = await db.insert(voicesTable).values(parsed.data).returning();
  res.status(201).json(voice);
});

router.get("/voices", authenticate, async (req, res): Promise<void> => {
  const voices = await db.select().from(voicesTable);
  res.json(voices);
});

export default router;
