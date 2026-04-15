import { type Server as HttpServer } from "http";
import { Server as SocketIOServer, type Socket } from "socket.io";
import axios from "axios";
import { verifyToken } from "../lib/jwt.js";
import { logger } from "../lib/logger.js";
import {
  addCallListener,
  removeCallListener,
  removeSocketFromAll,
  getCallListeners,
} from "./callListeners.js";

const TELNYX_API_BASE = "https://api.telnyx.com/v2";
const BACKEND_WS_BASE = (() => {
  const http = process.env.WEBHOOK_BASE_URL ?? "https://shivanshbackend.replit.app";
  return http.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
})();

let io: SocketIOServer | null = null;

async function startTelnyxFork(callControlId: string): Promise<void> {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return;

  const target = `${BACKEND_WS_BASE}/ws/listen/${encodeURIComponent(callControlId)}`;
  try {
    await axios.post(
      `${TELNYX_API_BASE}/calls/${callControlId}/actions/fork_start`,
      { target },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 8_000,
      }
    );
    logger.info({ callControlId, target }, "Telnyx listen fork started");
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } }).response?.status;
    // 400 / 422 usually means the call is already ended — not a real error
    if (status !== 400 && status !== 422) {
      logger.warn({ callControlId, err: String(err) }, "Could not start Telnyx listen fork");
    }
  }
}

async function stopTelnyxFork(callControlId: string): Promise<void> {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return;

  try {
    await axios.post(
      `${TELNYX_API_BASE}/calls/${callControlId}/actions/fork_stop`,
      {},
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 5_000,
      }
    );
    logger.info({ callControlId }, "Telnyx listen fork stopped");
  } catch {
    // Call may already be ended — ignore
  }
}

export function initWebSocket(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    path: "/api/ws",
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth.token as string | undefined;
    if (!token) {
      next(new Error("Authentication required"));
      return;
    }
    try {
      const user = verifyToken(token);
      (socket as Socket & { user?: ReturnType<typeof verifyToken> }).user = user;
      next();
    } catch {
      next(new Error("Invalid token"));
    }
  });

  io.on("connection", (socket) => {
    const user = (socket as Socket & { user?: ReturnType<typeof verifyToken> }).user;
    logger.info({ userId: user?.userId, role: user?.role }, "WebSocket client connected");

    socket.on("disconnect", () => {
      logger.info({ userId: user?.userId }, "WebSocket client disconnected");
      // Clean up any live-listen subscriptions this socket had
      removeSocketFromAll(socket.id);
    });

    // Supervisors and admins join supervisor room for live monitoring
    if (user?.role === "supervisor" || user?.role === "admin") {
      socket.join("supervisors");
    }

    // Agents join their own room for incoming call events
    if (user?.role === "agent") {
      socket.join(`agent:${user.userId}`);
    }

    // ── Live listen: subscribe / unsubscribe to a call's audio stream ──────
    // Only supervisors/admins can listen in
    if (user?.role === "admin" || user?.role === "supervisor") {
      socket.on("listen:join", (callControlId: string) => {
        if (typeof callControlId !== "string" || !callControlId) return;
        addCallListener(callControlId, socket.id);
        logger.info({ userId: user?.userId, callControlId }, "Supervisor joined live listen");
        // Start a Telnyx media fork so raw audio flows to our /ws/listen/ endpoint
        startTelnyxFork(callControlId).catch(() => {});
      });

      socket.on("listen:leave", (callControlId: string) => {
        if (typeof callControlId !== "string" || !callControlId) return;
        removeCallListener(callControlId, socket.id);
        logger.info({ userId: user?.userId, callControlId }, "Supervisor left live listen");
        // Stop the fork when nobody is listening anymore (saves bandwidth)
        const remaining = getCallListeners(callControlId);
        if (remaining.length === 0) {
          stopTelnyxFork(callControlId).catch(() => {});
        }
      });
    }
  });

  logger.info("WebSocket server initialized");
  return io;
}

export function getIO(): SocketIOServer {
  if (!io) throw new Error("WebSocket server not initialized");
  return io;
}

export function emitToSupervisors(event: string, data: unknown): void {
  if (!io) return;
  io.to("supervisors").emit(event, data);
}

export function emitToAgent(agentId: number, event: string, data: unknown): void {
  if (!io) return;
  io.to(`agent:${agentId}`).emit(event, data);
}

export function broadcast(event: string, data: unknown): void {
  if (!io) return;
  io.emit(event, data);
}
