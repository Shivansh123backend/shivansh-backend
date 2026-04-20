import { pgTable, text, serial, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Script variations produced by the auto-optimizer learning loop.
 * Each row is a candidate replacement for a "slot" of script (e.g. "intro", "pitch",
 * "objection_price"). The optimizer rotates them in A/B fashion and tracks performance.
 *
 * Non-destructive: the original script always remains in the campaign — variations
 * are *augmentations* selected at runtime when they outperform the original.
 */
export const scriptVariationsTable = pgTable("script_variations", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull(),
  slot: text("slot").notNull(),               // logical slot: "intro" | "pitch" | "objection_price" | ...
  text: text("text").notNull(),               // the variation text
  isOriginal: boolean("is_original").notNull().default(false),
  // Performance metrics (updated by the optimizer)
  uses: integer("uses").notNull().default(0),
  totalScore: integer("total_score").notNull().default(0),     // sum of call scores using this variation
  promotedAt: timestamp("promoted_at", { withTimezone: true }),// non-null = currently the winning variation
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertScriptVariationSchema = createInsertSchema(scriptVariationsTable).omit({ id: true, createdAt: true });
export type InsertScriptVariation = z.infer<typeof insertScriptVariationSchema>;
export type ScriptVariation = typeof scriptVariationsTable.$inferSelect;
