#!/usr/bin/env node
// One-off: walk call_logs rows missing recording_id and ask Telnyx for it
// using the call_leg_id (= our stored call_control_id). Populates recording_id
// so the /api/recordings/:id/play proxy can fetch fresh signed URLs on demand.
//
// Usage on a VPS:
//   DATABASE_URL=... TELNYX_API_KEY=... node scripts/backfillRecordingIds.mjs
//
// Safe to re-run; only touches rows where recording_id IS NULL.

import pg from "pg";

const { DATABASE_URL, TELNYX_API_KEY } = process.env;
if (!DATABASE_URL || !TELNYX_API_KEY) {
  console.error("Missing DATABASE_URL or TELNYX_API_KEY env var");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function fetchRecordingId(callLegId) {
  const url = `https://api.telnyx.com/v2/recordings?filter[call_leg_id]=${encodeURIComponent(callLegId)}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${TELNYX_API_KEY}` },
  });
  if (!r.ok) {
    return { error: `${r.status} ${r.statusText}` };
  }
  const json = await r.json();
  const rec = (json?.data ?? [])[0];
  return { id: rec?.id ?? null };
}

async function main() {
  // Both tables can have stale rows. We unify them so a single pass covers
  // every recording the dashboard might display.
  const tables = ["call_logs", "calls"];
  let scanned = 0, fixed = 0, missing = 0, errored = 0;

  for (const table of tables) {
    const { rows } = await pool.query(
      `SELECT id, call_control_id
         FROM ${table}
        WHERE recording_id IS NULL
          AND call_control_id IS NOT NULL
          AND recording_url IS NOT NULL
        ORDER BY id DESC`,
    );
    console.log(`[${table}] ${rows.length} rows to check`);

    for (const row of rows) {
      scanned++;
      const { id: recId, error } = await fetchRecordingId(row.call_control_id);
      if (error) {
        errored++;
        console.warn(`[${table}#${row.id}] Telnyx error:`, error);
      } else if (!recId) {
        missing++;
      } else {
        await pool.query(
          `UPDATE ${table} SET recording_id = $1 WHERE id = $2`,
          [recId, row.id],
        );
        fixed++;
        if (fixed % 25 === 0) console.log(`  …${fixed} fixed so far`);
      }
      // be polite — Telnyx allows ~10 req/s for this endpoint
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  console.log(`\nDone. scanned=${scanned} fixed=${fixed} missing-on-telnyx=${missing} errors=${errored}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
