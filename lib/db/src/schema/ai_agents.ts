import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const aiAgentsTable = pgTable("ai_agents", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  prompt: text("prompt").notNull(),
  language: text("language").notNull().default("en"),
  defaultVoiceId: integer("default_voice_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertAiAgentSchema = createInsertSchema(aiAgentsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertAiAgent = z.infer<typeof insertAiAgentSchema>;
export type AiAgent = typeof aiAgentsTable.$inferSelect;
