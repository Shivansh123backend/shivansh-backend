/**
 * Vapi monitor URL store.
 *
 * When we initiate a Vapi call we ask Vapi to enable monitoring (listen +
 * control). Vapi returns a `monitor.listenUrl` (wss://) and `monitor.controlUrl`
 * for that call. We persist them in Redis (so the supervisor's `listen:join`
 * event can resolve the URL even if it lands on a different VPS than the one
 * that originated the call) and fall back to in-process memory when Redis is
 * not available.
 *
 * Keys are namespaced `vapi:monitor:<vapiCallId>` and expire after 4 hours
 * (well beyond any sane call duration).
 */

import { logger } from "../lib/logger.js";
import { getRedisClient } from "../lib/redis.js";

const TTL_SECONDS = 4 * 60 * 60;
const memCache = new Map<string, { listenUrl?: string; controlUrl?: string }>();

function key(vapiCallId: string): string {
  return `vapi:monitor:${vapiCallId}`;
}

export async function setVapiMonitorUrls(
  vapiCallId: string,
  urls: { listenUrl?: string; controlUrl?: string },
): Promise<void> {
  if (!vapiCallId) return;
  memCache.set(vapiCallId, urls);
  try {
    const c = getRedisClient();
    await c.set(key(vapiCallId), JSON.stringify(urls), "EX", TTL_SECONDS);
  } catch (err) {
    logger.warn({ err: String(err), vapiCallId }, "setVapiMonitorUrls Redis write failed (mem-cache only)");
  }
}

export async function getVapiMonitorUrls(
  vapiCallId: string,
): Promise<{ listenUrl?: string; controlUrl?: string } | null> {
  if (!vapiCallId) return null;
  const local = memCache.get(vapiCallId);
  if (local) return local;
  try {
    const c = getRedisClient();
    const raw = await c.get(key(vapiCallId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { listenUrl?: string; controlUrl?: string };
    memCache.set(vapiCallId, parsed);
    return parsed;
  } catch (err) {
    logger.warn({ err: String(err), vapiCallId }, "getVapiMonitorUrls Redis read failed");
    return null;
  }
}

export async function clearVapiMonitorUrls(vapiCallId: string): Promise<void> {
  if (!vapiCallId) return;
  memCache.delete(vapiCallId);
  try {
    const c = getRedisClient();
    await c.del(key(vapiCallId));
  } catch {
    /* non-fatal */
  }
}
