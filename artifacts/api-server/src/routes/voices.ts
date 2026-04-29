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

router.delete("/voices/all", authenticate, requireRole("admin"), async (_req, res): Promise<void> => {
  await db.delete(agentVoicesTable);
  const deleted = await db.delete(voicesTable).returning({ id: voicesTable.id });
  res.json({ deleted: deleted.length });
});

router.delete("/voices/:id", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  await db.delete(agentVoicesTable).where(eq(agentVoicesTable.voiceId, id));
  const [row] = await db.delete(voicesTable).where(eq(voicesTable.id, id)).returning();
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ ok: true });
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

// ── POST /voices/:id/sample — generate and stream a TTS preview (any provider) ──
// Calls each provider's API directly and pipes the audio back to the browser.
// No in-memory cache is used — avoids multi-process cache miss when PM2 runs
// more than one worker (each worker has its own Map and would return 404 on
// /api/audio/:token requests generated by a different worker process).
router.post("/voices/:id/sample", authenticate, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid voice ID" }); return; }

  const [voice] = await db.select().from(voicesTable).where(eq(voicesTable.id, id)).limit(1);
  if (!voice) { res.status(404).json({ error: "Voice not found" }); return; }

  const provider = (SUPPORTED_PROVIDERS.includes(voice.provider as VoiceProvider)
    ? voice.provider
    : "elevenlabs") as VoiceProvider;
  const sampleText: string = req.body?.text ?? "Hello! I'm your AI voice assistant. I'm here to help you with your calls today.";

  try {
    let audioBuffer: Buffer;
    let contentType = "audio/mpeg";

    if (provider === "elevenlabs") {
      const apiKey = process.env.ELEVENLABS_API_KEY;
      if (!apiKey) { res.status(503).json({ error: "ElevenLabs API key not configured" }); return; }
      const ttsRes = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${voice.voiceId}`,
        { text: sampleText, model_id: "eleven_turbo_v2", voice_settings: { stability: 0.5, similarity_boost: 0.75 } },
        {
          headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
          responseType: "arraybuffer",
          timeout: 20_000,
          validateStatus: () => true,
        }
      );
      if (ttsRes.status !== 200) {
        const detail = Buffer.from(ttsRes.data as ArrayBuffer).toString("utf8").slice(0, 300);
        logger.error({ status: ttsRes.status, voiceId: voice.voiceId, detail }, "ElevenLabs TTS sample error");
        res.status(502).json({ error: "ElevenLabs TTS failed", detail });
        return;
      }
      audioBuffer = Buffer.from(ttsRes.data as ArrayBuffer);

    } else if (provider === "cartesia") {
      const apiKey = process.env.CARTESIA_API_KEY;
      if (!apiKey) { res.status(503).json({ error: "Cartesia API key not configured" }); return; }
      const ttsRes = await axios.post(
        "https://api.cartesia.ai/tts/bytes",
        {
          model_id:      "sonic-2",
          voice:         { mode: "id", id: voice.voiceId },
          transcript:    sampleText,
          output_format: { container: "mp3", encoding: "mp3", sample_rate: 44100 },
        },
        {
          headers: {
            "X-API-Key":        apiKey,
            "Cartesia-Version": "2024-06-10",
            "Content-Type":     "application/json",
          },
          responseType: "arraybuffer",
          timeout: 15_000,
          validateStatus: () => true,
        }
      );
      if (ttsRes.status !== 200) {
        const detail = Buffer.from(ttsRes.data as ArrayBuffer).toString("utf8").slice(0, 300);
        logger.error({ status: ttsRes.status, voiceId: voice.voiceId, detail }, "Cartesia TTS sample error");
        res.status(502).json({ error: "Cartesia TTS failed", detail });
        return;
      }
      audioBuffer = Buffer.from(ttsRes.data as ArrayBuffer);

    } else if (provider === "deepgram") {
      const apiKey = process.env.DEEPGRAM_API_KEY;
      if (!apiKey) { res.status(503).json({ error: "Deepgram API key not configured" }); return; }
      const ttsRes = await axios.post(
        `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(voice.voiceId)}`,
        { text: sampleText },
        {
          headers: { Authorization: `Token ${apiKey}`, "Content-Type": "application/json" },
          responseType: "arraybuffer",
          timeout: 12_000,
          validateStatus: () => true,
        }
      );
      if (ttsRes.status !== 200) {
        const detail = Buffer.from(ttsRes.data as ArrayBuffer).toString("utf8").slice(0, 300);
        logger.error({ status: ttsRes.status, voiceId: voice.voiceId, detail }, "Deepgram TTS sample error");
        res.status(502).json({ error: "Deepgram TTS failed", detail });
        return;
      }
      audioBuffer = Buffer.from(ttsRes.data as ArrayBuffer);

    } else {
      res.status(400).json({ error: `Unsupported provider: ${provider}` });
      return;
    }

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", audioBuffer.length);
    res.setHeader("Cache-Control", "no-store");
    res.send(audioBuffer);
    logger.info({ voiceId: voice.voiceId, provider, bytes: audioBuffer.length }, "TTS sample served");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg, voiceId: voice.voiceId, provider }, "TTS sample failed");
    res.status(502).json({ error: "TTS generation failed", detail: msg });
  }
});

export default router;
