import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const callLogsTable = pgTable("call_logs", {
  id: serial("id").primaryKey(),
  phoneNumber: text("phone_number").notNull(),
  campaignId: integer("campaign_id").notNull(),
  status: text("status").notNull().default("initiated"),
  disposition: text("disposition"),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
});

export const insertCallLogSchema = createInsertSchema(callLogsTable).omit({ id: true, timestamp: true });
export type InsertCallLog = z.infer<typeof insertCallLogSchema>;
export type CallLog = typeof callLogsTable.$inferSelect;
