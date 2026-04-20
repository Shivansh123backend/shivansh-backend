import { pgTable, text, serial, timestamp, integer, boolean } from "drizzle-orm/pg-core";

export const followUpsTable = pgTable("follow_ups", {
  id: serial("id").primaryKey(),
  leadId: integer("lead_id").notNull(),
  campaignId: integer("campaign_id").notNull(),
  channel: text("channel").notNull(),         // "sms" | "email"
  sequenceStep: integer("sequence_step").default(1),
  intent: text("intent"),                      // "thank_you" | "summary" | "reminder" | "value_add" | "final"
  industry: text("industry"),                  // for analytics + persuasion frame
  disposition: text("disposition"),            // call disposition that triggered this follow-up
  callSummary: text("call_summary"),
  predictedLabel: text("predicted_label"),     // "high" | "medium" | "low"
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  status: text("status").notNull().default("pending"),  // "pending" | "sent" | "failed" | "skipped"
  content: text("content"),                    // the actual sent body
  providerId: text("provider_id"),             // SMS/email message id from provider
  error: text("error"),
  retarget: boolean("retarget").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type FollowUp = typeof followUpsTable.$inferSelect;
