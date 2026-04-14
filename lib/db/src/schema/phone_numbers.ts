import { pgTable, text, serial, timestamp, integer, pgEnum, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const phoneProviderEnum = pgEnum("phone_provider", ["voip", "telnyx", "twilio"]);
export const phoneStatusEnum = pgEnum("phone_status", ["active", "inactive"]);

export const phoneDirectionEnum = pgEnum("phone_direction", ["inbound", "outbound", "both"]);

export const phoneNumbersTable = pgTable("phone_numbers", {
  id: serial("id").primaryKey(),
  phoneNumber: text("phone_number").notNull().unique(),
  label: text("label"),
  provider: phoneProviderEnum("provider").notNull(),
  campaignId: integer("campaign_id"),
  direction: phoneDirectionEnum("direction").notNull().default("both"),
  forwardNumber: text("forward_number"),        // direct E.164 forward (highest priority)
  queueId: integer("queue_id"),                 // route inbound to a queue of human agents
  humanAgentId: integer("human_agent_id"),      // route inbound directly to one human agent
  status: phoneStatusEnum("status").notNull().default("active"),
  priority: integer("priority").notNull().default(1),
  // Spam / usage tracking
  usageCount: integer("usage_count").notNull().default(0),
  spamScore: integer("spam_score").notNull().default(0),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  isBusy: boolean("is_busy").notNull().default(false),
  isBlocked: boolean("is_blocked").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertPhoneNumberSchema = createInsertSchema(phoneNumbersTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertPhoneNumber = z.infer<typeof insertPhoneNumberSchema>;
export type PhoneNumber = typeof phoneNumbersTable.$inferSelect;
