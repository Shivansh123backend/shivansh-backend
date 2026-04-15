import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { voicesTable, agentVoicesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { authenticate, requireRole } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";
import axios from "axios";
import { z } from "zod";
import {
  VOICE_CATALOG,
  generateTTSFromProvider,
  type VoiceProvider,
} from "../services/voiceRegistry.js";

const router: IRouter = Router();

const SUPPORTED_PROVIDERS: VoiceProvider[] = ["elevenlabs", "deepgram", "cartesia"];

const createVoiceSchema = z.object({
  name: z.string().min(1),
  provider: z.enum(["elevenlabs", "playht", "azure", "deepgram", "cartesia"]),
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

// REST-conventional alias: POST /voices → same as POST /voices/create
router.post("/voices", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const parsed = createVoiceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [voice] = await db.insert(voicesTable).values(parsed.data).returning();
  res.status(201).json(voice);
});

// ── GET /voices?provider=elevenlabs|deepgram|cartesia ─────────────────────────
// Returns all DB-stored voices as a flat array.
// If `provider` is supplied, filters to that provider only.
// The generated API client (useListVoices) expects Voice[] — never a grouped object.
router.get("/voices", authenticate, async (req, res): Promise<void> => {
  const providerParam = req.query.provider as string | undefined;

  if (providerParam) {
    const voices = await db
      .select()
      .from(voicesTable)
      .where(eq(voicesTable.provider, providerParam as "elevenlabs" | "playht" | "azure"));
    res.json(voices);
    return;
  }

  // No provider filter — return every voice in the DB as a flat array
  const voices = await db.select().from(voicesTable);
  res.json(voices);
});

// ── POST /voices/preview — generate TTS preview for any provider ───────────────
// Body: { provider: "elevenlabs"|"deepgram"|"cartesia", voice_id: string, text?: string }
// Returns: { url: string } — publicly reachable MP3 served from /api/audio/:token
router.post("/voices/preview", authenticate, async (req, res): Promise<void> => {
  const body = req.body as { provider?: string; voice_id?: string; text?: string };

  if (!body.provider || !SUPPORTED_PROVIDERS.includes(body.provider as VoiceProvider)) {
    res.status(400).json({ error: `provider must be one of: ${SUPPORTED_PROVIDERS.join(", ")}` });
    return;
  }
  if (!body.voice_id) {
    res.status(400).json({ error: "voice_id is required" });
    return;
  }

  const provider  = body.provider as VoiceProvider;
  const voiceId   = body.voice_id;
  const text      = body.text ?? "Hello! I'm your AI assistant. I'm here to help you with your calls today.";

  try {
    const url = await generateTTSFromProvider(provider, voiceId, text);
    res.json({ url, provider, voice_id: voiceId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = axios.isAxiosError(err) ? (err.response?.status ?? 502) : 502;
    logger.error({ err: msg, provider, voiceId }, "Voice preview TTS failed");
    res.status(status).json({ error: "TTS preview failed", detail: msg, provider, voice_id: voiceId });
  }
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

// ── GET /voices/:id/preview — proxy the stored previewUrl with correct Content-Type ──
router.get("/voices/:id/preview", authenticate, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid voice ID" }); return; }

  const [voice] = await db.select().from(voicesTable).where(eq(voicesTable.id, id)).limit(1);
  if (!voice) { res.status(404).json({ error: "Voice not found" }); return; }
  if (!voice.previewUrl) { res.status(404).json({ error: "No preview available for this voice" }); return; }

  try {
    const upstream = await axios.get(voice.previewUrl, {
      responseType: "stream",
      timeout: 15_000,
      headers: { "User-Agent": "NexusCall/1.0" },
    });

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    (upstream.data as NodeJS.ReadableStream).pipe(res);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg, voiceId: voice.voiceId }, "Preview proxy failed");
    res.status(502).json({ error: "Preview fetch failed", detail: msg });
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
