import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const callLogsTable = pgTable("call_logs", {
  id: serial("id").primaryKey(),
  phoneNumber: text("phone_number").notNull(),
  campaignId: integer("campaign_id").notNull(),
  status: text("status").notNull().default("initiated"),
  disposition: text("disposition"),
  direction: text("direction").notNull().default("outbound"),
  duration: integer("duration"),
  recordingUrl: text("recording_url"),
  transcript: text("transcript"),
  summary: text("summary"),
  callControlId: text("call_control_id"),
  numberUsed: text("number_used"),
  answerType: text("answer_type"),
  score: integer("score"),                // 0–100 quality score (callScorer)
  objections: text("objections"),         // JSON array of detected objection types
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
});

export const insertCallLogSchema = createInsertSchema(callLogsTable).omit({ id: true, timestamp: true });
export type InsertCallLog = z.infer<typeof insertCallLogSchema>;
export type CallLog = typeof callLogsTable.$inferSelect;
