import { Router } from "express";
import { z } from "zod/v4";
import { authenticate, requireRole } from "../middlewares/auth.js";
import { generateScript } from "../services/scriptGenerator.js";
import { logger } from "../lib/logger.js";

const router = Router();

const generateSchema = z.object({
  description: z.string().min(5).max(500),
});

router.post("/scripts/generate", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const parsed = generateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }
  try {
    const script = await generateScript(parsed.data.description);
    res.json({ success: true, script });
  } catch (err) {
    logger.error({ err: String(err) }, "Script generation route failed");
    res.status(500).json({ error: "Script generation failed" });
  }
});

export default router;
