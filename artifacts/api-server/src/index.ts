import { createServer } from "http";
import { WebSocketServer } from "ws";
import app from "./app.js";
import { logger } from "./lib/logger.js";
import { initWebSocket } from "./websocket/index.js";
import { getCallQueue } from "./queue/callQueue.js";
import { closeRedis } from "./lib/redis.js";
import { closeQueue } from "./queue/callQueue.js";
import { ensureAdminUser, ensurePhoneNumbers, ensureElevenLabsVoices } from "./lib/startup.js";
import { handleTelnyxMediaSocket, warmupElevenAgent } from "./services/elevenBridge.js";
import { startCallbackScheduler } from "./routes/callbacks.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const httpServer = createServer(app);

// ── Raw WebSocket server for Telnyx media forks ───────────────────────────────
// IMPORTANT: register this BEFORE Socket.IO so our handler fires first.
// engine.io (inside Socket.IO) destroys any upgrade that doesn't match /api/ws.
// Using prependListener ensures /ws/eleven/* is consumed before that happens.
const rawWss = new WebSocketServer({ noServer: true });

httpServer.prependListener("upgrade", (req, socket, head) => {
  const url = req.url ?? "";
  if (url.startsWith("/ws/eleven/")) {
    logger.info({ url }, "Telnyx media fork upgrade — handling");
    rawWss.handleUpgrade(req, socket as import("net").Socket, head, (ws) => {
      handleTelnyxMediaSocket(ws, req);
    });
    // Stop here — don't let Socket.IO see this upgrade
    return;
  }
  // All other paths fall through to Socket.IO's upgrade handler
  logger.info({ url }, "HTTP upgrade request received");
});

// ── Socket.IO WebSocket (dashboard real-time events) ───────────────────────────
// Must be registered AFTER prependListener so it doesn't pre-empt Telnyx upgrades
initWebSocket(httpServer);

// ── Call queue (Redis, optional) ───────────────────────────────────────────────
if (process.env.REDIS_HOST || process.env.REDIS_URL) {
  try {
    getCallQueue();
    logger.info("Call queue initialized");
  } catch (err) {
    logger.warn({ err }, "Queue initialization failed — Redis may not be available");
  }
} else {
  logger.info("Redis not configured — call queue disabled (set REDIS_HOST to enable)");
}

// ── Startup tasks ──────────────────────────────────────────────────────────────
ensureAdminUser().catch((err) => {
  logger.warn({ err }, "ensureAdminUser failed — continuing anyway");
});

ensurePhoneNumbers().catch((err) => {
  logger.warn({ err }, "ensurePhoneNumbers failed — continuing anyway");
});

ensureElevenLabsVoices().catch((err) => {
  logger.warn({ err }, "ensureElevenLabsVoices failed — continuing anyway");
});

warmupElevenAgent().catch((err) => {
  logger.warn({ err: String(err) }, "ElevenLabs agent warmup failed — will retry on first call");
});

startCallbackScheduler().catch((err) => {
  logger.warn({ err: String(err) }, "Callback scheduler failed to start");
});

httpServer.listen(port, () => {
  logger.info({ port }, "AI Calling SaaS backend listening");
});

// ── Graceful shutdown ──────────────────────────────────────────────────────────
const shutdown = async (signal: string) => {
  logger.info({ signal }, "Shutting down gracefully");
  rawWss.close();
  await closeQueue();
  await closeRedis();
  httpServer.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
