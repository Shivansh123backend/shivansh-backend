/**
 * Stale Call Sweeper
 *
 * Every 30s, finds calls that have been stuck in a non-terminal status
 * (queued / initiated / ringing) for longer than STALE_AFTER_MS and force-marks
 * them as failed. Without this, missed Telnyx hangup webhooks (network blips,
 * provider retries during a deploy, etc.) leave the live monitor showing
 * "ringing" rows forever — a self-inflicted phantom.
 *
 * On every flip we emit `call:ended` over WS so connected dashboards prune
 * their local Maps instantly without waiting for the next 10s poll.
 */

import { db, callsTable } from "@workspace/db";
import { sql, and, inArray, lt } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { emitToSupervisors } from "../websocket/index.js";
import { closeBridge, getAllActiveBridges } from "./elevenBridge.js";

const POLL_INTERVAL_MS = 30_000;
const STALE_AFTER_MS = 90_000; // 90 s — anything stuck this long is dead
const BRIDGE_STALE_AFTER_MS = 5 * 60_000; // bridges live longer; 5 min is safe

let _timer: NodeJS.Timeout | null = null;

async function sweepDb(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - STALE_AFTER_MS);
    const stale = await db
      .select({ id: callsTable.id, externalCallId: callsTable.externalCallId })
      .from(callsTable)
      .where(
        and(
          inArray(callsTable.status, ["queued", "initiated", "ringing"]),
          lt(callsTable.createdAt, cutoff),
        )
      )
      .limit(200);

    if (stale.length === 0) return;

    // Update ONLY the rows we selected, so every flipped row gets a WS event.
    // If there's a backlog >200 the next sweep (30s later) handles the rest.
    await db
      .update(callsTable)
      .set({ status: "failed", endedAt: new Date() })
      .where(inArray(callsTable.id, stale.map(r => r.id)));

    for (const row of stale) {
      try {
        emitToSupervisors("call:ended", {
          id: row.id,
          callControlId: row.externalCallId ?? undefined,
          disposition: "stale_no_webhook",
        });
        emitToSupervisors("call_update", {
          callId: row.id,
          call_id: row.externalCallId ?? null,
          status: "failed",
          is_terminal: true,
        });
      } catch {
        // emit failures are non-fatal
      }
    }

    logger.info({ count: stale.length }, "Stale call sweeper — flipped ringing → failed");
  } catch (err) {
    logger.warn({ err: String(err) }, "Stale call sweep failed");
  }
}

function sweepBridges(): void {
  try {
    const cutoff = Date.now() - BRIDGE_STALE_AFTER_MS;
    const bridges = getAllActiveBridges();
    for (const b of bridges) {
      if (b.startedAt.getTime() < cutoff) {
        logger.warn({ callControlId: b.callControlId, age_ms: Date.now() - b.startedAt.getTime() }, "Closing orphan bridge — stuck > 5 min");
        try { closeBridge(b.callControlId); } catch { /* ignore */ }
        try {
          emitToSupervisors("call:ended", {
            callControlId: b.callControlId,
            disposition: "stale_bridge",
          });
        } catch { /* ignore */ }
      }
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "Bridge sweep failed");
  }
}

export function startStaleCallSweeper(): void {
  if (_timer) return;
  // Stagger first run 15 s after boot so startup logs aren't noisy.
  setTimeout(() => {
    sweepDb().catch(() => {});
    sweepBridges();
  }, 15_000);
  _timer = setInterval(() => {
    sweepDb().catch(() => {});
    sweepBridges();
  }, POLL_INTERVAL_MS);
  logger.info({ pollMs: POLL_INTERVAL_MS, staleAfterMs: STALE_AFTER_MS }, "Stale call sweeper started");
}

export function stopStaleCallSweeper(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
