import { type Server as HttpServer } from "http";
import { Server as SocketIOServer, type Socket } from "socket.io";
import { verifyToken } from "../lib/jwt.js";
import { logger } from "../lib/logger.js";
import {
  addCallListener,
  removeCallListener,
  removeSocketFromAll,
} from "./callListeners.js";

let io: SocketIOServer | null = null;

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
    // Audio is relayed directly from the active AI bridge (customBridge / elevenBridge)
    // which already receives the Telnyx media fork. We do NOT start a second Telnyx
    // fork here — Telnyx only allows one fork per call leg and the AI bridge already
    // owns it. The bridges read getCallListeners() on every audio frame and forward
    // to subscribed socket IDs.
    if (user?.role === "admin" || user?.role === "supervisor") {
      socket.on("listen:join", (callControlId: string) => {
        if (typeof callControlId !== "string" || !callControlId) return;
        addCallListener(callControlId, socket.id);
        logger.info({ userId: user?.userId, callControlId }, "Supervisor joined live listen");
        // Acknowledge so the dashboard knows listening has started
        socket.emit("listen:joined", { callControlId });
      });

      socket.on("listen:leave", (callControlId: string) => {
        if (typeof callControlId !== "string" || !callControlId) return;
        removeCallListener(callControlId, socket.id);
        logger.info({ userId: user?.userId, callControlId }, "Supervisor left live listen");
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
