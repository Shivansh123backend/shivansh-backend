import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { voicesTable, agentVoicesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { authenticate, requireRole } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";
import axios from "axios";
import { z } from "zod";

const router: IRouter = Router();

const createVoiceSchema = z.object({
  name: z.string().min(1),
  provider: z.enum(["elevenlabs", "playht", "azure"]),
  voiceId: z.string().min(1),
  gender: z.enum(["male", "female"]),
  accent: z.enum(["us", "uk", "indian", "australian", "canadian", "other"]).default("us"),
  language: z.string().default("en"),
  previewUrl: z.string().optional(),
  description: z.string().optional(),
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

// ── GET /voices/elevenlabs — fetch directly from ElevenLabs API ───────────────
router.get("/voices/elevenlabs", authenticate, async (req, res): Promise<void> => {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: "ELEVENLABS_API_KEY not configured" });
    return;
  }

  try {
    const response = await axios.get("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": apiKey },
      timeout: 15000,
    });

    const voices = response.data?.voices ?? [];
    res.json(voices);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "Failed to fetch ElevenLabs voices");
    res.status(502).json({ error: "Failed to fetch ElevenLabs voices", detail: message });
  }
});

// ── POST /voices/elevenlabs/sync — sync ElevenLabs voices into DB ─────────────
router.post("/voices/elevenlabs/sync", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: "ELEVENLABS_API_KEY not configured" });
    return;
  }

  try {
    const response = await axios.get("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": apiKey },
      timeout: 15000,
    });

    const elVoices: Array<{
      voice_id: string;
      name: string;
      preview_url?: string;
      labels?: Record<string, string>;
    }> = response.data?.voices ?? [];

    let synced = 0;
    let skipped = 0;

    for (const v of elVoices) {
      const gender = v.labels?.gender === "male" ? "male" : "female";
      const accentRaw = (v.labels?.accent ?? "us").toLowerCase();
      const accentMap: Record<string, string> = {
        american: "us", british: "uk", indian: "indian",
        australian: "australian", canadian: "canadian",
      };
      const accent = (accentMap[accentRaw] ?? (["us","uk","indian","australian","canadian"].includes(accentRaw) ? accentRaw : "other")) as "us"|"uk"|"indian"|"australian"|"canadian"|"other";
      const description = [v.labels?.description, v.labels?.use_case, v.labels?.age]
        .filter(Boolean).join(", ");

      const existing = await db.select({ id: voicesTable.id })
        .from(voicesTable)
        .where(eq(voicesTable.voiceId, v.voice_id))
        .limit(1);

      if (existing.length > 0) {
        await db.update(voicesTable)
          .set({ name: v.name, previewUrl: v.preview_url ?? null, description: description || null })
          .where(eq(voicesTable.voiceId, v.voice_id));
        skipped++;
      } else {
        await db.insert(voicesTable).values({
          name: v.name,
          provider: "elevenlabs",
          voiceId: v.voice_id,
          gender,
          accent,
          language: "en",
          previewUrl: v.preview_url ?? null,
          description: description || null,
        });
        synced++;
      }
    }

    logger.info({ synced, skipped }, "ElevenLabs voices synced");
    res.json({ synced, updated: skipped, total: elVoices.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "ElevenLabs sync failed");
    res.status(502).json({ error: "ElevenLabs sync failed", detail: message });
  }
});

// ── POST /voices/:id/sample — stream a short TTS preview via ElevenLabs ──────
router.post("/voices/:id/sample", authenticate, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid voice ID" }); return; }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) { res.status(503).json({ error: "ELEVENLABS_API_KEY not configured" }); return; }

  const [voice] = await db.select().from(voicesTable).where(eq(voicesTable.id, id)).limit(1);
  if (!voice) { res.status(404).json({ error: "Voice not found" }); return; }

  const sampleText = req.body?.text ?? "Hello! I'm your AI voice assistant. I'm here to help you with your calls today.";

  try {
    const ttsRes = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice.voiceId}`,
      {
        text: sampleText,
        model_id: "eleven_turbo_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      },
      {
        headers: { "xi-api-key": apiKey, Accept: "audio/mpeg", "Content-Type": "application/json" },
        responseType: "stream",
        timeout: 30_000,
      }
    );

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Transfer-Encoding", "chunked");
    (ttsRes.data as NodeJS.ReadableStream).pipe(res);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg, voiceId: voice.voiceId }, "TTS sample failed");
    res.status(502).json({ error: "TTS generation failed", detail: msg });
  }
});

export default router;
