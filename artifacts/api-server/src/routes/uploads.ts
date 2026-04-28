import { Router } from "express";
import multer from "multer";
import axios, { AxiosError } from "axios";
import { authenticate } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB cap on audio uploads
});

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const DEEPGRAM_URL =
  "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true&diarize=false&detect_language=true";

router.post(
  "/uploads/transcribe",
  authenticate,
  upload.single("file"),
  async (req, res): Promise<void> => {
    if (!DEEPGRAM_API_KEY) {
      res.status(503).json({ error: "Transcription disabled — DEEPGRAM_API_KEY not configured." });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded. Send audio in the 'file' field." });
      return;
    }
    const mime = (req.file.mimetype ?? "").toLowerCase();
    if (!mime.startsWith("audio/") && !mime.startsWith("video/")) {
      res.status(400).json({ error: `Unsupported file type: ${mime || "unknown"}. Upload an audio or video file.` });
      return;
    }

    try {
      const response = await axios.post(DEEPGRAM_URL, req.file.buffer, {
        headers: {
          Authorization: `Token ${DEEPGRAM_API_KEY}`,
          "Content-Type": req.file.mimetype || "audio/wav",
        },
        timeout: 120_000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });

      const data = response.data as {
        results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
      };

      const transcript =
        data?.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";

      if (!transcript) {
        res.status(422).json({
          error: "No speech detected in the file. Try a clearer recording or a different format.",
        });
        return;
      }

      logger.info(
        { filename: req.file.originalname, bytes: req.file.size, chars: transcript.length },
        "Audio transcribed via Deepgram",
      );
      res.json({ transcript, filename: req.file.originalname });
    } catch (err) {
      const ax = err as AxiosError;
      const status = ax.response?.status ?? 500;
      const detail =
        typeof ax.response?.data === "string"
          ? ax.response.data
          : JSON.stringify(ax.response?.data ?? { message: ax.message });
      logger.error({ status, detail }, "Deepgram transcription failed");
      res.status(502).json({ error: `Transcription failed: ${detail.slice(0, 300)}` });
    }
  },
);

export default router;
