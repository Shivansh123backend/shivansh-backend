/**
 * Custom LLM endpoint for ElevenLabs Conversational AI.
 *
 * ElevenLabs calls this as an OpenAI-compatible chat completions endpoint.
 * We proxy to GPT-4o via Replit AI Integrations and stream back the response.
 *
 * ElevenLabs sets custom_llm_url = "https://shivanshbackend.replit.app/api/llm"
 * and will POST to /api/llm/chat/completions with a standard OpenAI body.
 */

import { Router } from "express";
import OpenAI from "openai";
import { logger } from "../lib/logger.js";

const router = Router();

const openai = new OpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? "placeholder",
});

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

/**
 * POST /api/llm/chat/completions
 *
 * Receives: OpenAI chat completion request from ElevenLabs
 * Returns:  Streaming OpenAI-compatible SSE response via GPT-4o
 */
router.post("/llm/chat/completions", async (req, res) => {
  try {
    const { messages, stream = true } = req.body as {
      messages: ChatMessage[];
      stream?: boolean;
    };

    if (!messages || !Array.isArray(messages)) {
      res.status(400).json({ error: "messages array required" });
      return;
    }

    logger.info(
      { messageCount: messages.length, firstRole: messages[0]?.role },
      "LLM proxy: forwarding to GPT-4o"
    );

    if (!stream) {
      // Non-streaming fallback (ElevenLabs almost always uses streaming)
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages,
        max_completion_tokens: 90,
        temperature: 0.85,
      });
      res.json(completion);
      return;
    }

    // Streaming response
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Transfer-Encoding", "chunked");
    res.flushHeaders();

    const streamResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",          // ~3x faster TTFT than gpt-4o (150ms vs 500ms+) — critical for phone-call latency
      messages,
      max_completion_tokens: 90,     // 1-2 sentences ≈ 6-10s of TTS — short, conversational, low chance of barge-in
      temperature: 0.85,
      stream: true,
    });

    for await (const chunk of streamResponse) {
      const data = JSON.stringify(chunk);
      res.write(`data: ${data}\n\n`);
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    logger.error({ err: String(err) }, "LLM proxy error");
    if (!res.headersSent) {
      res.status(500).json({ error: "LLM proxy failed", detail: String(err) });
    } else {
      res.end();
    }
  }
});

export default router;
