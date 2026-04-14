import { pgTable, text, serial, timestamp, pgEnum, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const voiceProviderEnum = pgEnum("voice_provider", ["elevenlabs", "playht", "azure", "deepgram", "cartesia"]);
export const voiceGenderEnum = pgEnum("voice_gender", ["male", "female"]);
export const voiceAccentEnum = pgEnum("voice_accent", ["us", "uk", "indian", "australian", "canadian", "other"]);

export const voicesTable = pgTable("voices", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  provider: voiceProviderEnum("provider").notNull(),
  voiceId: text("voice_id").notNull(),
  previewUrl: text("preview_url"),
  description: text("description"),
  gender: voiceGenderEnum("gender").notNull(),
  accent: voiceAccentEnum("accent").notNull().default("us"),
  language: text("language").notNull().default("en"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertVoiceSchema = createInsertSchema(voicesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertVoice = z.infer<typeof insertVoiceSchema>;
export type Voice = typeof voicesTable.$inferSelect;

export const agentVoicesTable = pgTable("agent_voices", {
  id: serial("id").primaryKey(),
  agentId: integer("agent_id").notNull(),
  voiceId: integer("voice_id").notNull(),
  priority: integer("priority").notNull().default(1),
});

export const insertAgentVoiceSchema = createInsertSchema(agentVoicesTable).omit({ id: true });
export type InsertAgentVoice = z.infer<typeof insertAgentVoiceSchema>;
export type AgentVoice = typeof agentVoicesTable.$inferSelect;
