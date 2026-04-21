// ────────────────────────────────────────────────────────────────────────────
// Spam + DNC profiling service.
// Combines:
//   • Local DNC list (manual entries — explicit blocks)
//   • Telnyx Number Lookup (carrier + line_type)
//   • Heuristic spam score derived from line_type + risk signals
//
// Used at the three call entry points:
//   • Outbound /calls/initiate  → reject before dialing
//   • Inbound  webhooks.ts call.initiated → hangup on caller block
//   • Campaign processLead → skip + mark do_not_call
//
// Results are cached in the dnc_list row for 30 days, so repeat checks are free.
// ────────────────────────────────────────────────────────────────────────────

import { db, dncListTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger.js";

const TELNYX_API_KEY = process.env.TELNYX_API_KEY ?? "";
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days
export const BLOCK_THRESHOLD = 80;               // spam_score >= this → blocked

export interface SpamProfile {
  phoneNumber: string;
  onDnc: boolean;          // present in dnc_list table
  spamScore: number;       // 0-100, higher = more likely spam
  lineType: string | null; // mobile | landline | voip | toll_free | shared_cost | premium_rate | unknown
  carrierName: string | null;
  blocked: boolean;        // final decision: onDnc OR spamScore >= BLOCK_THRESHOLD
  reason: string | null;   // human-readable explanation
  cached: boolean;         // true if served from dnc_list cache
}

function normalize(phone: string): string {
  return phone.replace(/[^\d+]/g, "");
}

// ── Permanent allow-list ────────────────────────────────────────────────────
// Numbers in this list are NEVER blocked, NEVER added to the dnc_list, and
// NEVER auto-marked as do_not_call by any code path. Use for owner test lines,
// known-good business contacts, etc. Source: ALWAYS_ALLOWED_NUMBERS env
// (comma-separated E.164) plus a small hard-coded fallback the operator can
// always rely on even if the env var is unset.
const HARDCODED_ALLOW = ["+14843040647"];
const ENV_ALLOW = (process.env.ALWAYS_ALLOWED_NUMBERS ?? "")
  .split(",")
  .map((s) => normalize(s.trim()))
  .filter((s) => s.length > 4);
const ALLOW_LIST = new Set<string>([...HARDCODED_ALLOW, ...ENV_ALLOW]);

export function isAlwaysAllowed(phone: string): boolean {
  return ALLOW_LIST.has(normalize(phone));
}

/** Heuristic spam score from Telnyx line_type + carrier signals.
 *  Scoring rationale:
 *    shared_cost / premium → almost always spam scams or toll fraud → 95
 *    voip → very common spam vector (cheap, disposable) → 60
 *    toll_free → often spam call centers but legitimate too → 30
 *    mobile / landline → mostly legitimate → 5
 *    unknown → suspicious → 40
 */
function scoreFromLineType(lineType: string | null | undefined): number {
  switch ((lineType ?? "").toLowerCase()) {
    case "shared_cost":
    case "premium_rate":
    case "premium":
      return 95;
    case "voip":
    case "non-fixed voip":
    case "non_fixed_voip":
      return 60;
    case "toll_free":
    case "tollfree":
      return 30;
    case "mobile":
    case "fixed_line":
    case "landline":
    case "fixed line":
      return 5;
    case "":
    case "unknown":
    case "null":
      return 40;
    default:
      return 20;
  }
}

/** Hit Telnyx Number Lookup API (carrier + type). Returns null on any failure
 *  so the caller can fall back to a neutral score and never block a real call. */
async function telnyxLookup(phoneNumber: string): Promise<{ lineType: string | null; carrierName: string | null } | null> {
  if (!TELNYX_API_KEY) {
    logger.debug({ phoneNumber }, "spamCheck: no TELNYX_API_KEY — skipping live lookup");
    return null;
  }
  try {
    const url = `https://api.telnyx.com/v2/number_lookup/${encodeURIComponent(phoneNumber)}?type=carrier`;
    const r = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${TELNYX_API_KEY}` },
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) {
      logger.debug({ phoneNumber, status: r.status }, "spamCheck: Telnyx lookup non-200");
      return null;
    }
    const json = await r.json() as { data?: { carrier?: { type?: string; name?: string } } };
    return {
      lineType: json.data?.carrier?.type ?? null,
      carrierName: json.data?.carrier?.name ?? null,
    };
  } catch (err) {
    logger.debug({ err: String(err), phoneNumber }, "spamCheck: Telnyx lookup error");
    return null;
  }
}

/**
 * Get the full DNC + spam profile for a number. Cheap when cached.
 *
 * @param phoneNumber  Any format — will be normalised to E.164-ish digits/+.
 * @param opts.forceRefresh  Bypass the 30-day cache and re-query Telnyx.
 */
export async function getSpamProfile(
  phoneNumber: string,
  opts: { forceRefresh?: boolean } = {},
): Promise<SpamProfile> {
  const normalised = normalize(phoneNumber);

  // 0. Permanent allow-list short-circuit — never block, never cache, never DB-write.
  if (ALLOW_LIST.has(normalised)) {
    return {
      phoneNumber: normalised,
      onDnc: false,
      spamScore: 0,
      lineType: null,
      carrierName: null,
      blocked: false,
      reason: null,
      cached: false,
    };
  }

  // 1. Check existing dnc_list row (covers both manual blocks AND prior auto-scans)
  const [existing] = await db
    .select()
    .from(dncListTable)
    .where(eq(dncListTable.phoneNumber, normalised));

  const fresh = existing?.lastCheckedAt
    && (Date.now() - new Date(existing.lastCheckedAt).getTime()) < CACHE_TTL_MS;

  // Manual DNC entries ALWAYS win — never auto-refresh them.
  // A row counts as a manual block iff autoBlocked=false AND reason IS NOT NULL.
  // (autoBlocked=false + reason=null is a non-blocking score-cache row written
  // by *this* service to memoize Telnyx lookups — it must not be treated as a
  // block, otherwise every benign number we ever scanned becomes "blocked".)
  if (existing && !existing.autoBlocked && existing.reason !== null) {
    return {
      phoneNumber: normalised,
      onDnc: true,
      spamScore: existing.spamScore ?? 100,
      lineType: existing.lineType,
      carrierName: existing.carrierName,
      blocked: true,
      reason: existing.reason,
      cached: true,
    };
  }

  // Use cache if fresh and we already auto-scored this one
  if (existing && fresh && !opts.forceRefresh) {
    const blocked = (existing.spamScore ?? 0) >= BLOCK_THRESHOLD;
    return {
      phoneNumber: normalised,
      onDnc: blocked,
      spamScore: existing.spamScore ?? 0,
      lineType: existing.lineType,
      carrierName: existing.carrierName,
      blocked,
      reason: blocked ? (existing.reason ?? `Spam score ${existing.spamScore}`) : null,
      cached: true,
    };
  }

  // 2. Live Telnyx lookup → score
  const lookup = await telnyxLookup(normalised);
  const lineType = lookup?.lineType ?? null;
  const carrierName = lookup?.carrierName ?? null;
  const spamScore = scoreFromLineType(lineType);
  const blocked = spamScore >= BLOCK_THRESHOLD;
  const reason = blocked
    ? `Auto-blocked: ${lineType ?? "unknown line type"} (score ${spamScore})`
    : null;

  // 3. Persist score in dnc_list (insert if new, update if exists). We only
  //    auto-add to the DNC list when blocked=true; otherwise we keep the score
  //    in cache for future fast reads but DON'T add a "blocking" row.
  try {
    if (existing) {
      await db
        .update(dncListTable)
        .set({
          spamScore,
          lineType,
          carrierName,
          lastCheckedAt: new Date(),
          autoBlocked: blocked || existing.autoBlocked,
          ...(blocked && !existing.reason ? { reason } : {}),
        })
        .where(eq(dncListTable.id, existing.id));
    } else if (blocked) {
      await db
        .insert(dncListTable)
        .values({
          phoneNumber: normalised,
          reason,
          spamScore,
          lineType,
          carrierName,
          lastCheckedAt: new Date(),
          autoBlocked: true,
        })
        .onConflictDoNothing();
    } else {
      // Not blocked, but we still want to remember the score so we don't
      // re-scan every call. Insert as a non-blocking score-cache row.
      await db
        .insert(dncListTable)
        .values({
          phoneNumber: normalised,
          reason: null,
          spamScore,
          lineType,
          carrierName,
          lastCheckedAt: new Date(),
          autoBlocked: false,  // ← critical: not a manual block, but score is cached
        })
        .onConflictDoNothing();
    }
  } catch (err) {
    logger.warn({ err: String(err), normalised }, "spamCheck: cache write failed (continuing)");
  }

  return {
    phoneNumber: normalised,
    onDnc: blocked,
    spamScore,
    lineType,
    carrierName,
    blocked,
    reason,
    cached: false,
  };
}

/** Convenience wrapper: just true/false. Never throws. */
export async function isBlocked(phoneNumber: string): Promise<boolean> {
  try {
    const p = await getSpamProfile(phoneNumber);
    return p.blocked;
  } catch (err) {
    logger.warn({ err: String(err), phoneNumber }, "spamCheck: isBlocked errored — fail-open");
    return false;  // fail-open: never block a real call due to lookup failure
  }
}

/** Bulk scan helper — used by /dnc/scan-campaign/:id endpoint. */
export async function scanNumbers(numbers: string[]): Promise<{ scanned: number; blocked: number; results: SpamProfile[] }> {
  const results: SpamProfile[] = [];
  let blocked = 0;
  // Sequential with small concurrency to avoid hammering Telnyx
  const CONC = 5;
  for (let i = 0; i < numbers.length; i += CONC) {
    const batch = numbers.slice(i, i + CONC);
    const profiles = await Promise.all(batch.map(n => getSpamProfile(n).catch(() => null)));
    for (const p of profiles) {
      if (!p) continue;
      results.push(p);
      if (p.blocked) blocked++;
    }
  }
  return { scanned: results.length, blocked, results };
}
