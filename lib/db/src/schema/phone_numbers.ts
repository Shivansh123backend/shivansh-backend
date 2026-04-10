import { pgTable, text, serial, timestamp, integer, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const phoneProviderEnum = pgEnum("phone_provider", ["voip", "telnyx", "twilio"]);
export const phoneStatusEnum = pgEnum("phone_status", ["active", "inactive"]);

export const phoneNumbersTable = pgTable("phone_numbers", {
  id: serial("id").primaryKey(),
  phoneNumber: text("phone_number").notNull().unique(),
  provider: phoneProviderEnum("provider").notNull(),
  campaignId: integer("campaign_id"),
  status: phoneStatusEnum("status").notNull().default("active"),
  priority: integer("priority").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertPhoneNumberSchema = createInsertSchema(phoneNumbersTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertPhoneNumber = z.infer<typeof insertPhoneNumberSchema>;
export type PhoneNumber = typeof phoneNumbersTable.$inferSelect;
