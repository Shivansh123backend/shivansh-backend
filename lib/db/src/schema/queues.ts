import { pgTable, text, serial, timestamp, pgEnum, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const queueStrategyEnum = pgEnum("queue_strategy", ["round-robin", "least-busy", "priority"]);
export const queueStatusEnum   = pgEnum("queue_status",   ["active", "inactive"]);

/** A named pool of human agents that inbound calls can be routed to. */
export const queuesTable = pgTable("queues", {
  id:          serial("id").primaryKey(),
  name:        text("name").notNull(),
  description: text("description"),
  strategy:    queueStrategyEnum("strategy").notNull().default("round-robin"),
  status:      queueStatusEnum("status").notNull().default("active"),
  createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:   timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

/** Maps human agents into a queue with an optional priority order. */
export const queueMembersTable = pgTable("queue_members", {
  id:           serial("id").primaryKey(),
  queueId:      integer("queue_id").notNull(),
  humanAgentId: integer("human_agent_id").notNull(),
  priority:     integer("priority").notNull().default(1),  // lower = higher priority
  createdAt:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertQueueSchema       = createInsertSchema(queuesTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertQueueMemberSchema = createInsertSchema(queueMembersTable).omit({ id: true, createdAt: true });

export type Queue       = typeof queuesTable.$inferSelect;
export type QueueMember = typeof queueMembersTable.$inferSelect;
export type InsertQueue = z.infer<typeof insertQueueSchema>;
