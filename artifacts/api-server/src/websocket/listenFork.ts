/**
 * Listen-only Telnyx media fork handler.
 *
 * When a supervisor clicks "Listen" on the dashboard, the server calls
 * Telnyx fork_start pointing to wss://<host>/ws/listen/:callControlId.
 * Telnyx opens a WebSocket here and streams µ-law 8 kHz audio frames.
 * We forward each frame as a `call:audio` Socket.IO event to any supervisor
 * sockets that are subscribed to this call via the callListeners registry.
 *
 * No AI processing of any kind — purely an audio relay.
 */

import WebSocket from "ws";
import { type IncomingMessage } from "http";
import { logger } from "../lib/logger.js";
import { getCallListeners } from "./callListeners.js";
import { getIO } from "./index.js";

// Active fork sockets keyed by callControlId
const activeForks = new Map<string, WebSocket>();

export function handleListenForkSocket(ws: WebSocket, req: IncomingMessage): void {
  const url = req.url ?? "";
  const match = url.match(/\/ws\/listen\/(.+)/);
  if (!match?.[1]) {
    logger.warn({ url }, "Listen fork: no callControlId in URL — closing");
    ws.close();
    return;
  }
  const callControlId = decodeURIComponent(match[1]);

  activeForks.set(callControlId, ws);
  logger.info({ callControlId }, "Listen fork WebSocket connected");

  ws.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;

      if (msg["event"] === "media") {
        const media = msg["media"] as Record<string, string> | undefined;
        const ulawB64 = media?.["payload"];
        if (!ulawB64) return;

        const listeners = getCallListeners(callControlId);
        if (listeners.length === 0) return;

        try {
          const io = getIO();
          const payload = { callControlId, payload: ulawB64, side: "caller" as const };
          for (const sid of listeners) {
            io.to(sid).emit("call:audio", payload);
          }
        } catch {
          // IO not yet initialised — safe to ignore
        }
      }
      // "connected" / "start" / "stop" frames are intentionally ignored
    } catch {
      // Non-JSON binary frame — ignore
    }
  });

  ws.on("close", () => {
    activeForks.delete(callControlId);
    logger.info({ callControlId }, "Listen fork WebSocket closed");
  });

  ws.on("error", (err) => {
    logger.warn({ callControlId, err: String(err) }, "Listen fork WebSocket error");
    activeForks.delete(callControlId);
  });
}

export function isListenForkActive(callControlId: string): boolean {
  return activeForks.has(callControlId);
}

export function closeListenFork(callControlId: string): void {
  const ws = activeForks.get(callControlId);
  if (!ws) return;
  try { ws.close(); } catch { /* already closed */ }
  activeForks.delete(callControlId);
}
