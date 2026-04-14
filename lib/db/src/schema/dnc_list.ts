import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const dncListTable = pgTable("dnc_list", {
  id: serial("id").primaryKey(),
  phoneNumber: text("phone_number").notNull().unique(),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertDncSchema = createInsertSchema(dncListTable).omit({ id: true, createdAt: true });
export type InsertDnc = z.infer<typeof insertDncSchema>;
export type DncEntry = typeof dncListTable.$inferSelect;
