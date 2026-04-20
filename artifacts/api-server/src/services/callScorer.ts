/**
 * Call Scoring System (Step 6 of enhancement plan).
 *
 * Pure, side-effect-free function. Scores a finished call 0–100 based on:
 *   - flow completion (did we reach pitch/close vs drop at intro)
 *   - engagement (turn count, duration)
 *   - objection handling (acknowledged vs hard reject)
 *   - outcome (disposition)
 *
 * Also extracts the list of objection types that surfaced during the call.
 * Both are stored on the call_logs row for analytics + the optimizer.
 */

import { detectObjection, type ObjectionType } from "./objectionEngine.js";

export interface CallScoreResult {
  score: number;                                    // 0–100
  objections: Exclude<ObjectionType, null>[];       // unique types that appeared
  breakdown: {
    flow: number;
    engagement: number;
    objectionHandling: number;
    outcome: number;
  };
}

const POSITIVE_DISPOSITIONS = new Set([
  "interested", "callback_requested", "transferred", "qualified", "appointment_set", "sale",
]);
const NEUTRAL_DISPOSITIONS = new Set([
  "info_provided", "follow_up", "completed",
]);
const NEGATIVE_DISPOSITIONS = new Set([
  "not_interested", "do_not_call", "vm", "no_answer", "wrong_number",
]);

export function scoreCall(opts: {
  transcript: string;
  durationSecs: number;
  disposition: string | null | undefined;
}): CallScoreResult {
  const transcript = opts.transcript ?? "";
  const lines = transcript.split("\n").filter((l) => l.trim().length > 0);

  // Count user vs agent turns. Lines look like: "AI Agent: ..." or "User: ..."
  const userTurns = lines.filter((l) => /^(user|customer|caller)\s*:/i.test(l)).length;
  const agentTurns = lines.filter((l) => /^(ai\s*agent|assistant|agent)\s*:/i.test(l)).length;
  const totalTurns = userTurns + agentTurns;

  // Detect objections from caller lines
  const objectionSet = new Set<Exclude<ObjectionType, null>>();
  for (const l of lines) {
    if (!/^(user|customer|caller)\s*:/i.test(l)) continue;
    const text = l.replace(/^[^:]+:\s*/, "");
    const t = detectObjection(text);
    if (t) objectionSet.add(t);
  }
  const objections = [...objectionSet];

  // ── 1. Flow completion (max 30) ────────────────────────────────────────────
  // Reaching more turns implies progressing further through the state machine.
  let flow = 0;
  if (totalTurns >= 2)  flow = 8;
  if (totalTurns >= 6)  flow = 16;
  if (totalTurns >= 12) flow = 24;
  if (totalTurns >= 20) flow = 30;

  // ── 2. Engagement (max 25) ─────────────────────────────────────────────────
  // Reward both duration and balanced back-and-forth.
  let engagement = 0;
  if (opts.durationSecs >= 15) engagement += 5;
  if (opts.durationSecs >= 45) engagement += 5;
  if (opts.durationSecs >= 90) engagement += 5;
  if (userTurns >= 2)          engagement += 5;
  if (userTurns >= 6)          engagement += 5;

  // ── 3. Objection handling (max 20) ─────────────────────────────────────────
  // No hard reject is good; gracefully working through soft objections is good.
  let objectionHandling = 20;
  if (objections.includes("hard_reject"))  objectionHandling -= 12;
  if (objections.length >= 3)              objectionHandling -= 4;
  if (objectionHandling < 0)               objectionHandling = 0;

  // ── 4. Outcome (max 25) ────────────────────────────────────────────────────
  let outcome = 10; // neutral default
  const d = (opts.disposition ?? "").toLowerCase();
  if (POSITIVE_DISPOSITIONS.has(d))      outcome = 25;
  else if (NEUTRAL_DISPOSITIONS.has(d))  outcome = 15;
  else if (NEGATIVE_DISPOSITIONS.has(d)) outcome = d === "no_answer" || d === "vm" ? 0 : 5;

  const total = flow + engagement + objectionHandling + outcome;
  const score = Math.max(0, Math.min(100, Math.round(total)));

  return {
    score,
    objections,
    breakdown: { flow, engagement, objectionHandling, outcome },
  };
}
