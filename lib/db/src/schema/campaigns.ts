import { pgTable, text, serial, timestamp, integer, pgEnum, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const campaignStatusEnum = pgEnum("campaign_status", ["draft", "active", "paused", "completed"]);
export const campaignTypeEnum = pgEnum("campaign_type", ["outbound", "inbound", "both"]);
export const routingTypeEnum = pgEnum("routing_type", ["ai", "human", "ai_then_human"]);
export const dialingModeEnum = pgEnum("dialing_mode", ["manual", "progressive", "predictive", "preview"]);

export const campaignsTable = pgTable("campaigns", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  agentId: integer("agent_id"),
  status: campaignStatusEnum("status").notNull().default("draft"),
  type: campaignTypeEnum("type").notNull().default("outbound"),
  routingType: routingTypeEnum("routing_type").notNull().default("ai"),
  maxConcurrentCalls: integer("max_concurrent_calls").notNull().default(5),
  transferRules: text("transfer_rules"),
  // AI calling configuration
  agentPrompt: text("agent_prompt"),
  knowledgeBase: text("knowledge_base"),
  recordingNotes: text("recording_notes"),
  voice: text("voice"),
  voiceProvider: text("voice_provider").default("elevenlabs"), // "elevenlabs" | "deepgram" | "cartesia"
  fromNumber: text("from_number"),
  transferNumber: text("transfer_number"),
  backgroundSound: text("background_sound").default("none"),
  holdMusic: text("hold_music").default("none"),
  humanLike: text("human_like").default("true"),
  // Dialing engine config
  dialingMode: dialingModeEnum("dialing_mode").notNull().default("progressive"),
  dialingRatio: integer("dialing_ratio").notNull().default(1),
  dialingSpeed: integer("dialing_speed").notNull().default(10),
  dropRateLimit: integer("drop_rate_limit").notNull().default(3),
  retryAttempts: integer("retry_attempts").notNull().default(2),
  retryIntervalMinutes: integer("retry_interval_minutes").notNull().default(60),
  // Working hours (HH:MM in 24h, null = always)
  workingHoursStart: text("working_hours_start"),
  workingHoursEnd: text("working_hours_end"),
  workingHoursTimezone: text("working_hours_timezone").default("UTC"),
  // AMD
  amdEnabled: boolean("amd_enabled").notNull().default(false),
  vmDropMessage: text("vm_drop_message"),   // TTS message to leave on voicemail (null = hang up)
  // Compliance
  tcpaEnabled: boolean("tcpa_enabled").notNull().default(false), // enforce 8am-9pm TCPA calling hours per lead timezone
  // Geo + voice profile (additive — empty = neutral defaults)
  region: text("region"),          // "US" | "UK" | "CA" | "AU" | "IN" | "OTHER"
  accent: text("accent"),          // "US" | "UK" | "neutral"
  voiceProfile: text("voice_profile"),  // JSON: { voiceId, speed, tone }
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertCampaignSchema = createInsertSchema(campaignsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCampaign = z.infer<typeof insertCampaignSchema>;
export type Campaign = typeof campaignsTable.$inferSelect;

export const campaignAgentsTable = pgTable("campaign_agents", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull(),
  agentId: integer("agent_id").notNull(),
});

export const insertCampaignAgentSchema = createInsertSchema(campaignAgentsTable).omit({ id: true });
export type InsertCampaignAgent = z.infer<typeof insertCampaignAgentSchema>;
export type CampaignAgent = typeof campaignAgentsTable.$inferSelect;
