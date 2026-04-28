/**
 * Vapi live-listen bridge.
 *
 * Vapi exposes a per-call `monitor.listenUrl` (wss://) that streams the
 * live conversation audio as signed 16-bit little-endian PCM (Linear16).
 *
 * The exact sample rate Vapi uses depends on its internal audio pipeline
 * (typically 8 kHz for PSTN/SIP phone calls). Rather than converting to
 * µ-law on the backend (which requires knowing the sample rate upfront and
 * introduces a lossy re-encoding step), we pass the raw PCM16 bytes through
 * as base64 and attach `format: "pcm16le"` + `sampleRate` metadata on the
 * socket event. The dashboard player decodes Int16 → Float32 directly and
 * creates the AudioBuffer at the declared sample rate.
 *
 * Vapi chunk size is logged on the first frame so the actual sample rate
 * can be inferred: 160 bytes = 10 ms at 8 kHz; 320 bytes = 10 ms at 16 kHz.
 *
 * One bridge per call. Reference-counted by the supervisor count in the room
 * (managed in websocket/index.ts).
 */

import WebSocket from "ws";
import { logger } from "../lib/logger.js";
import { getIO } from "./index.js";
import { getVapiMonitorUrls } from "../services/vapiMonitor.js";

// Phone-call PSTN audio: 8 kHz (ITU-T G.711 standard). Change to 16000 if
// Vapi is confirmed to send wideband audio on this call path.
const VAPI_SAMPLE_RATE = 8000;

const activeBridges = new Map<string, WebSocket>(); // callControlId → ws to Vapi

function listenRoom(callControlId: string): string {
  return `listen:${callControlId}`;
}

/**
 * Open a WebSocket to the Vapi listenUrl for the given call and start
 * relaying audio to the supervisor room. No-op if a bridge already exists.
 *
 * `callControlId` is the prefixed id we use elsewhere ("vapi:<vapiCallId>").
 */
export async function startVapiListen(callControlId: string): Promise<void> {
  if (activeBridges.has(callControlId)) return;
  const vapiCallId = callControlId.startsWith("vapi:")
    ? callControlId.slice("vapi:".length)
    : callControlId;

  const urls = await getVapiMonitorUrls(vapiCallId);
  if (!urls?.listenUrl) {
    logger.warn({ callControlId, vapiCallId }, "startVapiListen — no listenUrl on file (call too old or monitor disabled)");
    return;
  }

  let ws: WebSocket;
  try {
    ws = new WebSocket(urls.listenUrl, { perMessageDeflate: false });
  } catch (err) {
    logger.error({ err: String(err), callControlId }, "startVapiListen — WebSocket constructor failed");
    return;
  }

  activeBridges.set(callControlId, ws);
  const room = listenRoom(callControlId);

  let firstFrame = true;

  ws.on("open", () => {
    logger.info({ callControlId }, "Vapi listen bridge opened");
  });

  ws.on("message", (raw: WebSocket.RawData, isBinary: boolean) => {
    // Vapi may send a text JSON frame first (e.g. {"type":"start","encoding":"linear16",...})
    // before binary PCM data. Log it and skip.
    if (!isBinary) {
      const text = raw.toString();
      logger.info({ callControlId, frame: text.slice(0, 200) }, "Vapi listen bridge: text frame (control)");
      return;
    }
    try {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      // Log the first frame's byte length so we can infer the sample rate:
      //   160 bytes = 10 ms @ 8 kHz  |  320 bytes = 10 ms @ 16 kHz
      if (firstFrame) {
        logger.info({ callControlId, bytes: buf.length, sampleRate: VAPI_SAMPLE_RATE }, "Vapi listen bridge: first audio frame");
        firstFrame = false;
      }
      // Pass raw PCM16 LE bytes through — no lossy re-encoding.
      // The frontend decodes Int16 → Float32 and creates the AudioBuffer at VAPI_SAMPLE_RATE.
      const payload = buf.toString("base64");
      try {
        getIO().to(room).emit("call:audio", {
          callControlId,
          payload,
          side: "caller" as const,
          format: "pcm16le",
          sampleRate: VAPI_SAMPLE_RATE,
        });
      } catch {
        /* IO not initialised — ignore */
      }
    } catch (err) {
      logger.warn({ err: String(err), callControlId }, "Vapi listen bridge: frame relay failed");
    }
  });

  ws.on("close", () => {
    activeBridges.delete(callControlId);
    logger.info({ callControlId }, "Vapi listen bridge closed");
  });

  ws.on("error", (err) => {
    logger.warn({ callControlId, err: String(err) }, "Vapi listen bridge error");
    activeBridges.delete(callControlId);
    try { ws.close(); } catch { /* ignore */ }
  });
}

/** Close the bridge to Vapi for this call. Safe to call repeatedly. */
export function stopVapiListen(callControlId: string): void {
  const ws = activeBridges.get(callControlId);
  if (!ws) return;
  activeBridges.delete(callControlId);
  try { ws.close(); } catch { /* ignore */ }
  logger.info({ callControlId }, "Vapi listen bridge stop requested");
}
