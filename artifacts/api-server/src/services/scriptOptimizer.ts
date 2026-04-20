/**
 * Script Optimizer (Steps 4–9 of enhancement plan).
 *
 * Periodic learning loop:
 *   1. Look at recent low-scoring calls per campaign.
 *   2. Use the LLM to propose 2 variations of the campaign's intro/pitch.
 *   3. Persist them to script_variations as candidates the bridge can rotate.
 *   4. After enough A/B usage, promote the best-performing variation by
 *      stamping promotedAt on the row with the highest avg score.
 *
 * Runs offline on a 30-minute interval. Never blocks call execution.
 * Respects safety rules: only refines phrasing, never adds aggressive content.
 */

import OpenAI from "openai";
import { db, callLogsTable, campaignsTable, scriptVariationsTable } from "@workspace/db";
import { and, desc, eq, gte, isNotNull } from "drizzle-orm";
import { logger } from "../lib/logger.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "" });

const TICK_MS = 30 * 60_000;
const MIN_USES_FOR_PROMOTION = 5;
const RECENT_DAYS = 3;
const LOW_SCORE_THRESHOLD = 50;

const SAFETY_GUARDS = `
SAFETY RULES (must follow):
- Same meaning and intent as the original — only rephrase.
- Keep it short (≤ 2 sentences), warm, professional, human.
- Never make it pushy, aggressive, manipulative, or misleading.
- Never invent claims, prices, or guarantees that aren't in the original.
- Output a JSON array of exactly 2 strings, no commentary.
`.trim();

async function generateVariations(slot: string, original: string): Promise<string[]> {
  if (!original.trim()) return [];
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `You refine phone-call opening lines. ${SAFETY_GUARDS}` },
        { role: "user", content: `Slot: ${slot}\nOriginal:\n"""${original}"""\n\nGenerate 2 alternative phrasings.` },
      ],
      max_completion_tokens: 200,
      temperature: 0.7,
      response_format: { type: "json_object" },
    });
    const raw = completion.choices[0]?.message?.content ?? "";
    // Accept either {"variations":[...]} or a top-level array
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : parsed.variations;
    if (!Array.isArray(arr)) return [];
    return arr.filter((s) => typeof s === "string" && s.trim().length > 0).slice(0, 2);
  } catch (err) {
    logger.warn({ err: String(err), slot }, "Variation generation failed");
    return [];
  }
}

/** One pass of the learning loop. */
async function runOptimizerTick(): Promise<void> {
  const since = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000);

  // For each campaign, check whether recent average score is poor enough to need help
  const lowCalls = await db
    .select({
      campaignId: callLogsTable.campaignId,
      score: callLogsTable.score,
    })
    .from(callLogsTable)
    .where(and(gte(callLogsTable.timestamp, since), isNotNull(callLogsTable.score)));

  const byCampaign = new Map<number, number[]>();
  for (const r of lowCalls) {
    if (typeof r.score !== "number") continue;
    if (!byCampaign.has(r.campaignId)) byCampaign.set(r.campaignId, []);
    byCampaign.get(r.campaignId)!.push(r.score);
  }

  for (const [campaignId, scores] of byCampaign) {
    if (scores.length < 5) continue;  // not enough signal yet
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    if (avg >= LOW_SCORE_THRESHOLD) continue;

    const [camp] = await db
      .select({ name: campaignsTable.name, agentPrompt: campaignsTable.agentPrompt })
      .from(campaignsTable)
      .where(eq(campaignsTable.id, campaignId))
      .limit(1);
    if (!camp?.agentPrompt) continue;

    // Skip if we've already generated variations for this slot recently
    const existing = await db
      .select()
      .from(scriptVariationsTable)
      .where(and(eq(scriptVariationsTable.campaignId, campaignId), eq(scriptVariationsTable.slot, "intro")));

    if (existing.length >= 3) {
      // Try promoting the best one if it has enough usage
      await maybePromote(campaignId, "intro");
      continue;
    }

    const variations = await generateVariations("intro", camp.agentPrompt.slice(0, 600));
    if (variations.length === 0) continue;

    await db.insert(scriptVariationsTable).values([
      ...(existing.length === 0
        ? [{
            campaignId,
            slot: "intro",
            text: camp.agentPrompt.slice(0, 600),
            isOriginal: true,
          }]
        : []),
      ...variations.map((text) => ({
        campaignId,
        slot: "intro",
        text,
        isOriginal: false,
      })),
    ]).catch((err) => logger.warn({ err: String(err), campaignId }, "Variation insert failed"));

    logger.info({ campaignId, count: variations.length, avg }, "Script variations generated");
  }
}

/** Promote the best-performing variation (highest avg score, min uses). */
async function maybePromote(campaignId: number, slot: string): Promise<void> {
  const rows = await db
    .select()
    .from(scriptVariationsTable)
    .where(and(eq(scriptVariationsTable.campaignId, campaignId), eq(scriptVariationsTable.slot, slot)));

  const eligible = rows.filter((r) => r.uses >= MIN_USES_FOR_PROMOTION);
  if (eligible.length < 2) return;

  const best = eligible.reduce((a, b) => {
    const avgA = a.uses > 0 ? a.totalScore / a.uses : 0;
    const avgB = b.uses > 0 ? b.totalScore / b.uses : 0;
    return avgB > avgA ? b : a;
  });

  if (best.promotedAt) return; // already winning

  await db.update(scriptVariationsTable)
    .set({ promotedAt: null })
    .where(and(eq(scriptVariationsTable.campaignId, campaignId), eq(scriptVariationsTable.slot, slot)));

  await db.update(scriptVariationsTable)
    .set({ promotedAt: new Date() })
    .where(eq(scriptVariationsTable.id, best.id));

  logger.info({ campaignId, slot, variationId: best.id, avg: best.totalScore / best.uses }, "Variation promoted");
}

/** Public: pick a variation for a campaign+slot using ε-greedy A/B rotation. */
export async function pickVariation(campaignId: number, slot: string): Promise<string | null> {
  try {
    const rows = await db
      .select()
      .from(scriptVariationsTable)
      .where(and(eq(scriptVariationsTable.campaignId, campaignId), eq(scriptVariationsTable.slot, slot)));
    if (rows.length === 0) return null;

    // 80% of the time use the promoted winner if one exists, else uniform random;
    // 20% of the time explore a non-winner to keep gathering data.
    const promoted = rows.find((r) => r.promotedAt !== null);
    if (promoted && Math.random() < 0.8) return promoted.text;
    const pick = rows[Math.floor(Math.random() * rows.length)]!;
    return pick.text;
  } catch {
    return null;
  }
}

/** Public: record the call score against the variation that was used. */
export async function recordVariationOutcome(opts: {
  campaignId: number;
  slot: string;
  text: string;
  score: number;
}): Promise<void> {
  try {
    const rows = await db
      .select()
      .from(scriptVariationsTable)
      .where(and(eq(scriptVariationsTable.campaignId, opts.campaignId), eq(scriptVariationsTable.slot, opts.slot)));
    const match = rows.find((r) => r.text === opts.text);
    if (!match) return;
    await db.update(scriptVariationsTable)
      .set({ uses: match.uses + 1, totalScore: match.totalScore + opts.score })
      .where(eq(scriptVariationsTable.id, match.id));
  } catch { /* ignore — analytics shouldn't break call flow */ }
}

/** Start the periodic learning loop. Called once from server startup. */
export function startScriptOptimizer(): void {
  logger.info({ tickMin: TICK_MS / 60_000 }, "Script optimizer started");
  // Stagger first run by 2 min so startup isn't noisy
  setTimeout(() => {
    runOptimizerTick().catch((err) => logger.warn({ err: String(err) }, "Optimizer first tick failed"));
    setInterval(() => {
      runOptimizerTick().catch((err) => logger.warn({ err: String(err) }, "Optimizer tick failed"));
    }, TICK_MS);
  }, 2 * 60_000);
}

/** Read current variations for a campaign (admin route). */
export async function listVariations(campaignId: number) {
  return db.select().from(scriptVariationsTable)
    .where(eq(scriptVariationsTable.campaignId, campaignId))
    .orderBy(desc(scriptVariationsTable.promotedAt), desc(scriptVariationsTable.uses));
}
