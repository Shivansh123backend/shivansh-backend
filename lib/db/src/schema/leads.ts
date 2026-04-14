import { pgTable, text, serial, timestamp, integer, pgEnum, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const leadStatusEnum = pgEnum("lead_status", ["pending", "called", "callback", "do_not_call", "completed"]);
export const leadSourceEnum = pgEnum("lead_source", ["manual", "csv", "sheet"]);

export const leadsTable = pgTable("leads", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  email: text("email"),
  campaignId: integer("campaign_id").notNull(),
  source: leadSourceEnum("source").notNull().default("manual"),
  status: leadStatusEnum("status").notNull().default("pending"),
  metadata: text("metadata"),
  // Retry + priority
  retryCount: integer("retry_count").notNull().default(0),
  lastCalledAt: timestamp("last_called_at", { withTimezone: true }),
  priority: integer("priority").notNull().default(0),
  dncFlag: boolean("dnc_flag").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertLeadSchema = createInsertSchema(leadsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertLead = z.infer<typeof insertLeadSchema>;
export type Lead = typeof leadsTable.$inferSelect;
