import { createServer } from "http";
import app from "./app.js";
import { logger } from "./lib/logger.js";
import { initWebSocket } from "./websocket/index.js";
import { getCallQueue } from "./queue/callQueue.js";
import { closeRedis } from "./lib/redis.js";
import { closeQueue } from "./queue/callQueue.js";
import { ensureAdminUser, ensurePhoneNumbers } from "./lib/startup.js";

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

// Initialize WebSocket server
initWebSocket(httpServer);

// Initialize call queue only if Redis is configured
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

// Ensure admin user exists (safe to call on every boot — checks first)
ensureAdminUser().catch((err) => {
  logger.warn({ err }, "ensureAdminUser failed — continuing anyway");
});

// Ensure real Telnyx phone numbers are seeded
ensurePhoneNumbers().catch((err) => {
  logger.warn({ err }, "ensurePhoneNumbers failed — continuing anyway");
});

httpServer.listen(port, () => {
  logger.info({ port }, "AI Calling SaaS backend listening");
});

// Graceful shutdown
const shutdown = async (signal: string) => {
  logger.info({ signal }, "Shutting down gracefully");
  await closeQueue();
  await closeRedis();
  httpServer.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
