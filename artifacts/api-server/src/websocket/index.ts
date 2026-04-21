import { type Server as HttpServer } from "http";
import { Server as SocketIOServer, type Socket } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import axios from "axios";
import { verifyToken } from "../lib/jwt.js";
import { logger } from "../lib/logger.js";
import { getRedisClient } from "../lib/redis.js";

// Live-listen subscribers are tracked using Socket.IO **rooms** named
// `listen:<callControlId>`. With the Redis adapter installed, broadcasts to
// these rooms are mirrored to every API node — so a Telnyx fork that lands on
// VPS-B can still deliver audio to a supervisor connected to VPS-A.
function listenRoom(callControlId: string): string {
  return `listen:${callControlId}`;
}

// ── Telnyx fork management for live listen ────────────────────────────────────
// When a supervisor joins a call, we tell Telnyx to start streaming that call's
// audio (both legs) to our /ws/listen/:callControlId WebSocket. listenFork.ts
// then relays each frame to subscribed supervisor sockets. When the LAST
// supervisor leaves, we stop the fork to save Telnyx bandwidth.
const activeListenForks = new Set<string>();   // callControlIds we've started a fork for
const TELNYX_API = "https://api.telnyx.com/v2";

function buildListenStreamUrl(callControlId: string): string {
  // Convert WEBHOOK_BASE_URL (https://...) to wss:// equivalent
  const base = process.env.WEBHOOK_BASE_URL ?? "https://api.shivanshagent.cloudisoft.com";
  const wssBase = base.replace(/^https?:\/\//, "wss://").replace(/\/$/, "");
  return `${wssBase}/ws/listen/${encodeURIComponent(callControlId)}`;
}

async function startListenFork(callControlId: string): Promise<void> {
  if (activeListenForks.has(callControlId)) return;
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    logger.warn({ callControlId }, "Cannot start listen fork — TELNYX_API_KEY not set");
    return;
  }
  const stream_url = buildListenStreamUrl(callControlId);
  try {
    await axios.post(
      `${TELNYX_API}/calls/${callControlId}/actions/fork_start`,
      { stream_url, stream_track: "both_tracks", stream_bidirectional_mode: "rtp" },
      { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 8_000 },
    );
    activeListenForks.add(callControlId);
    logger.info({ callControlId, stream_url }, "Listen fork started on Telnyx");
  } catch (err: unknown) {
    const ax = err as { response?: { status?: number; data?: unknown }; message?: string };
    logger.warn(
      { callControlId, status: ax?.response?.status, data: ax?.response?.data, msg: ax?.message },
      "Listen fork_start failed — supervisor will only see transcript",
    );
  }
}

async function countListenersClusterWide(callControlId: string): Promise<number> {
  if (!io) return 0;
  try {
    const sockets = await io.in(listenRoom(callControlId)).fetchSockets();
    return sockets.length;
  } catch {
    return 0;
  }
}

async function maybeStopListenFork(callControlId: string): Promise<void> {
  const remaining = await countListenersClusterWide(callControlId);
  if (remaining > 0) return;
  await stopListenFork(callControlId);
}

async function stopListenFork(callControlId: string): Promise<void> {
  if (!activeListenForks.has(callControlId)) return;
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return;
  try {
    await axios.post(
      `${TELNYX_API}/calls/${callControlId}/actions/fork_stop`,
      {},
      { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 8_000 },
    );
    logger.info({ callControlId }, "Listen fork stopped — no supervisors remain");
  } catch (err: unknown) {
    const ax = err as { response?: { status?: number }; message?: string };
    // 422 = call already ended — fine, fork is gone too
    if (ax?.response?.status !== 422) {
      logger.warn({ callControlId, status: ax?.response?.status, msg: ax?.message }, "Listen fork_stop failed");
    }
  } finally {
    activeListenForks.delete(callControlId);
  }
}

let io: SocketIOServer | null = null;

export function initWebSocket(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    path: "/api/ws",
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  // ── Redis adapter — REQUIRED for cross-VPS broadcast (live listen audio) ──
  // Without this, an event emitted on VPS-A is invisible to clients on VPS-B.
  // Adapter is wired only when Redis is configured; otherwise we run single-node
  // (still works, just no HA for supervisor monitoring).
  if (process.env.REDIS_URL || process.env.REDIS_HOST) {
    try {
      const pubClient = getRedisClient();
      const subClient = pubClient.duplicate();
      io.adapter(createAdapter(pubClient, subClient));
      logger.info("Socket.IO Redis adapter attached — events sync across nodes");
    } catch (err) {
      logger.warn({ err: String(err) }, "Socket.IO Redis adapter init failed — running single-node");
    }
  } else {
    logger.warn("Socket.IO running single-node (no REDIS_HOST) — live listen will not work across multiple VPS");
  }

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

    socket.on("disconnect", async () => {
      logger.info({ userId: user?.userId }, "WebSocket client disconnected");
      // For each call this socket was listening to, after it leaves the room,
      // check (cluster-wide) if anyone else is still listening — if not, stop the fork.
      const rooms = [...socket.rooms].filter((r) => r.startsWith("listen:"));
      for (const room of rooms) {
        const callControlId = room.slice("listen:".length);
        // socket.rooms still contains the rooms at disconnect time; leave is automatic.
        await maybeStopListenFork(callControlId);
      }
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
    // On the first supervisor for a given call, we tell Telnyx to fork that
    // call's media to /ws/listen/:callControlId. listenFork.ts then forwards
    // each audio frame to every subscribed supervisor socket. When the last
    // supervisor leaves (or disconnects), we stop the fork.
    if (user?.role === "admin" || user?.role === "supervisor") {
      socket.on("listen:join", async (callControlId: string) => {
        if (typeof callControlId !== "string" || !callControlId) return;
        const room = listenRoom(callControlId);
        // Cluster-wide listener count BEFORE we join, so every node agrees on
        // who started the fork.
        const before = await countListenersClusterWide(callControlId);
        await socket.join(room);
        logger.info({ userId: user?.userId, callControlId, prior: before }, "Supervisor joined live listen");
        if (before === 0) {
          startListenFork(callControlId).catch(() => { /* logged */ });
        }
        socket.emit("listen:joined", { callControlId });
      });

      socket.on("listen:leave", async (callControlId: string) => {
        if (typeof callControlId !== "string" || !callControlId) return;
        await socket.leave(listenRoom(callControlId));
        logger.info({ userId: user?.userId, callControlId }, "Supervisor left live listen");
        await maybeStopListenFork(callControlId);
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
