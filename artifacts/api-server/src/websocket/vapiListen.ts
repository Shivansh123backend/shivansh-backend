/**
 * Vapi live-listen bridge.
 *
 * Vapi exposes a per-call `monitor.listenUrl` (wss://) that streams the live
 * conversation audio as raw PCM 16-bit, 16 kHz, mono. Our supervisor UI on
 * the dashboard already speaks the Telnyx fork format: µ-law 8 kHz frames
 * delivered as `call:audio` Socket.IO events to the room `listen:<callId>`.
 *
 * This module bridges the two: when a supervisor asks to listen on a Vapi
 * call (callControlId starts with `vapi:`), we open the listenUrl WebSocket,
 * convert each incoming PCM16/16k buffer to µ-law/8k, base64-encode, and
 * emit it to the same room — so the existing dashboard player works without
 * any frontend change.
 *
 * One bridge per call. Reference-counted by the supervisor count in the room
 * (managed in websocket/index.ts).
 */

import WebSocket from "ws";
import { logger } from "../lib/logger.js";
import { getIO } from "./index.js";
import { getVapiMonitorUrls } from "../services/vapiMonitor.js";

const activeBridges = new Map<string, WebSocket>(); // callControlId → ws to Vapi

function listenRoom(callControlId: string): string {
  return `listen:${callControlId}`;
}

// ── PCM16 → µ-law conversion ──────────────────────────────────────────────────
// Standard ITU-T G.711 µ-law encoder. Input is signed 16-bit PCM samples;
// output is one µ-law byte per sample.
const MU_LAW_BIAS = 0x84;
const MU_LAW_CLIP = 32635;

function pcm16ToMulawByte(sample: number): number {
  let s = sample;
  const sign = (s >> 8) & 0x80;
  if (sign) s = -s;
  if (s > MU_LAW_CLIP) s = MU_LAW_CLIP;
  s += MU_LAW_BIAS;

  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Decimate 16 kHz → 8 kHz (every other sample) and convert to µ-law. */
function pcm16_16kToMulaw8k(buf: Buffer): Buffer {
  // buf is little-endian PCM16 samples at 16 kHz.
  const inSamples = Math.floor(buf.length / 2);
  const outLen = Math.floor(inSamples / 2);
  const out = Buffer.allocUnsafe(outLen);
  for (let i = 0, j = 0; j < outLen; i += 2, j++) {
    const s = buf.readInt16LE(i * 2);
    out[j] = pcm16ToMulawByte(s);
  }
  return out;
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

  ws.on("open", () => {
    logger.info({ callControlId }, "Vapi listen bridge opened");
  });

  ws.on("message", (raw: WebSocket.RawData, isBinary: boolean) => {
    if (!isBinary) return; // ignore JSON control frames
    try {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      const mulaw = pcm16_16kToMulaw8k(buf);
      const payload = mulaw.toString("base64");
      try {
        getIO().to(room).emit("call:audio", { callControlId, payload, side: "caller" as const });
      } catch {
        /* IO not initialised — ignore */
      }
    } catch (err) {
      logger.warn({ err: String(err), callControlId }, "Vapi listen bridge: frame conversion failed");
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
