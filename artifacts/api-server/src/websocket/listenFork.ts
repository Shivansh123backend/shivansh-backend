/**
 * Listen-only Telnyx media fork handler.
 *
 * When a supervisor clicks "Listen" on the dashboard, the server calls
 * Telnyx fork_start pointing to wss://<host>/ws/listen/:callControlId.
 * Telnyx opens a WebSocket here and streams µ-law 8 kHz audio frames.
 * We forward each frame as a `call:audio` Socket.IO event to the room
 * `listen:<callControlId>`. The Redis adapter (initWebSocket) syncs that
 * room across every API node, so a fork that lands on VPS-B still reaches
 * a supervisor connected to VPS-A.
 *
 * No AI processing of any kind — purely an audio relay.
 */

import WebSocket from "ws";
import { type IncomingMessage } from "http";
import { logger } from "../lib/logger.js";
import { getIO } from "./index.js";

const activeForks = new Map<string, WebSocket>();

function listenRoom(callControlId: string): string {
  return `listen:${callControlId}`;
}

function roomHasListeners(callControlId: string): boolean {
  try {
    const io = getIO();
    return (io.sockets.adapter.rooms.get(listenRoom(callControlId))?.size ?? 0) > 0;
  } catch {
    return false;
  }
}

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
      if (msg["event"] !== "media") return;
      const media = msg["media"] as Record<string, string> | undefined;
      const ulawB64 = media?.["payload"];
      if (!ulawB64) return;
      if (!roomHasListeners(callControlId)) return;
      try {
        const io = getIO();
        io.to(listenRoom(callControlId)).emit("call:audio", {
          callControlId,
          payload: ulawB64,
          side: "caller" as const,
        });
      } catch {
        // IO not yet initialised — safe to ignore
      }
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
