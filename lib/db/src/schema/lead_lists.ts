import { pgTable, text, serial, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const leadListsTable = pgTable("lead_lists", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  campaignId: integer("campaign_id"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertLeadListSchema = createInsertSchema(leadListsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertLeadList = z.infer<typeof insertLeadListSchema>;
export type LeadList = typeof leadListsTable.$inferSelect;
