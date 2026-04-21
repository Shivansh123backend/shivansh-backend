import { pgTable, text, serial, timestamp, integer, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const callStatusEnum = pgEnum("call_status", ["queued", "initiated", "ringing", "in_progress", "transferred", "completed", "failed", "no_answer", "busy"]);
export const callDispositionEnum = pgEnum("call_disposition", ["interested", "not_interested", "vm", "no_answer", "busy", "connected", "transferred", "disconnected"]);
export const callProviderEnum = pgEnum("call_provider", ["voip", "telnyx", "twilio"]);
export const transferStatusEnum = pgEnum("transfer_status", ["pending", "completed", "failed"]);

export const callsTable = pgTable("calls", {
  id: serial("id").primaryKey(),
  leadId: integer("lead_id").notNull(),
  campaignId: integer("campaign_id").notNull(),
  agentId: integer("agent_id"),
  humanAgentId: integer("human_agent_id"),
  providerUsed: callProviderEnum("provider_used").notNull(),
  selectedVoice: text("selected_voice"),
  selectedNumber: text("selected_number"),
  status: callStatusEnum("status").notNull().default("queued"),
  disposition: callDispositionEnum("disposition"),
  duration: integer("duration"),
  recordingUrl: text("recording_url"),
  recordingId: text("recording_id"),
  transcript: text("transcript"),
  summary: text("summary"),
  transferStatus: transferStatusEnum("transfer_status"),
  externalCallId: text("external_call_id"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertCallSchema = createInsertSchema(callsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCall = z.infer<typeof insertCallSchema>;
export type Call = typeof callsTable.$inferSelect;

export const auditLogsTable = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  action: text("action").notNull(),
  resource: text("resource").notNull(),
  resourceId: text("resource_id"),
  metadata: text("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAuditLogSchema = createInsertSchema(auditLogsTable).omit({ id: true, createdAt: true });
export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;
export type AuditLog = typeof auditLogsTable.$inferSelect;
