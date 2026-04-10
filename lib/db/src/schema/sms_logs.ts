import { pgTable, text, serial, timestamp, integer, pgEnum } from "drizzle-orm/pg-core";

export const smsStatusEnum = pgEnum("sms_status", ["sent", "failed", "queued"]);

export const smsLogsTable = pgTable("sms_logs", {
  id: serial("id").primaryKey(),
  phoneNumber: text("phone_number").notNull(),
  campaignId: integer("campaign_id"),
  message: text("message").notNull(),
  status: smsStatusEnum("status").notNull().default("queued"),
  providerMessageId: text("provider_message_id"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SmsLog = typeof smsLogsTable.$inferSelect;
