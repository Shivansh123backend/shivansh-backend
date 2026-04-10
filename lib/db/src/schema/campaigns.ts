import { pgTable, text, serial, timestamp, integer, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const campaignStatusEnum = pgEnum("campaign_status", ["draft", "active", "paused", "completed"]);
export const campaignTypeEnum = pgEnum("campaign_type", ["outbound", "inbound"]);
export const routingTypeEnum = pgEnum("routing_type", ["ai", "human", "ai_then_human"]);

export const campaignsTable = pgTable("campaigns", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  agentId: integer("agent_id"),
  status: campaignStatusEnum("status").notNull().default("draft"),
  type: campaignTypeEnum("type").notNull().default("outbound"),
  routingType: routingTypeEnum("routing_type").notNull().default("ai"),
  maxConcurrentCalls: integer("max_concurrent_calls").notNull().default(5),
  transferRules: text("transfer_rules"),
  // AI calling configuration — used directly by worker service
  agentPrompt: text("agent_prompt"),
  voice: text("voice"),
  fromNumber: text("from_number"),
  transferNumber: text("transfer_number"),
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
