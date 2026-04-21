import { pgTable, text, serial, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const dncListTable = pgTable("dnc_list", {
  id: serial("id").primaryKey(),
  phoneNumber: text("phone_number").notNull().unique(),
  reason: text("reason"),
  // ── Spam profiling (populated on-demand by spamCheck service) ──────────────
  spamScore: integer("spam_score").default(0).notNull(),       // 0-100; >=80 → auto-blocked
  lineType: text("line_type"),                                  // mobile | landline | voip | toll_free | shared_cost | premium_rate | unknown
  carrierName: text("carrier_name"),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  autoBlocked: boolean("auto_blocked").default(false).notNull(), // true = blocked by spam scan, not manual add
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertDncSchema = createInsertSchema(dncListTable).omit({ id: true, createdAt: true });
export type InsertDnc = z.infer<typeof insertDncSchema>;
export type DncEntry = typeof dncListTable.$inferSelect;
