import { pgTable, text, serial, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const humanAgentStatusEnum = pgEnum("human_agent_status", ["available", "busy"]);

export const humanAgentsTable = pgTable("human_agents", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  phoneNumber: text("phone_number").notNull().unique(),
  status: humanAgentStatusEnum("status").notNull().default("available"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertHumanAgentSchema = createInsertSchema(humanAgentsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertHumanAgent = z.infer<typeof insertHumanAgentSchema>;
export type HumanAgent = typeof humanAgentsTable.$inferSelect;
