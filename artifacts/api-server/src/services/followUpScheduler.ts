/**
 * Background scheduler that sends due follow-ups (SMS + email).
 * Polls every 60s. Failsafe — individual failures never stop the loop.
 */
import { db } from "@workspace/db";
import { followUpsTable, leadsTable, campaignsTable } from "@workspace/db";
import { and, eq, lte } from "drizzle-orm";
import axios from "axios";
import { logger } from "../lib/logger.js";
import { generateMessage } from "./followUpGenerator.js";
import { sendEmail } from "./emailSender.js";

const POLL_INTERVAL_MS = 60_000;
const BATCH_SIZE = 25;

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_URL = "https://api.telnyx.com/v2/messages";

let _running = false;
let _timer: NodeJS.Timeout | null = null;

async function sendSmsViaTelnyx(to: string, from: string | null, text: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!TELNYX_API_KEY) return { ok: false, error: "no_telnyx_key" };
  try {
    const res = await axios.post(
      TELNYX_URL,
      { from: from ?? undefined, to, text, messaging_profile_id: process.env.TELNYX_MESSAGING_PROFILE_ID },
      { headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, "Content-Type": "application/json" }, timeout: 10_000 },
    );
    return { ok: true, id: res.data?.data?.id };
  } catch (err) {
    const msg = axios.isAxiosError(err) ? (err.response?.data?.errors?.[0]?.detail ?? err.message) : String(err);
    return { ok: false, error: msg.slice(0, 200) };
  }
}

async function processOne(row: typeof followUpsTable.$inferSelect): Promise<void> {
  try {
    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, row.leadId)).limit(1);
    if (!lead) {
      await db.update(followUpsTable).set({ status: "skipped", error: "lead_not_found", sentAt: new Date() }).where(eq(followUpsTable.id, row.id));
      return;
    }
    if (lead.dncFlag) {
      await db.update(followUpsTable).set({ status: "skipped", error: "dnc_flag", sentAt: new Date() }).where(eq(followUpsTable.id, row.id));
      return;
    }

    const [campaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, row.campaignId)).limit(1);

    const message = await generateMessage({
      step: { step: row.sequenceStep ?? 1, channel: row.channel as "sms" | "email", delayMinutes: 0, intent: (row.intent ?? "value_add") as never },
      industry: row.industry,
      callSummary: row.callSummary,
      disposition: row.disposition,
      ctx: {
        leadName: lead.name,
        agentName: campaign?.name ?? undefined,
        campaignName: campaign?.name ?? undefined,
        intent: (row.predictedLabel ?? "medium") as never,
      },
    });

    if (row.channel === "sms") {
      const r = await sendSmsViaTelnyx(lead.phone, campaign?.fromNumber ?? null, message.body);
      if (r.ok) {
        await db.update(followUpsTable).set({ status: "sent", sentAt: new Date(), content: message.body, providerId: r.id }).where(eq(followUpsTable.id, row.id));
      } else {
        await db.update(followUpsTable).set({ status: "failed", sentAt: new Date(), content: message.body, error: r.error ?? "unknown" }).where(eq(followUpsTable.id, row.id));
      }
      return;
    }

    if (row.channel === "email") {
      if (!lead.email) {
        await db.update(followUpsTable).set({ status: "skipped", error: "no_email", sentAt: new Date() }).where(eq(followUpsTable.id, row.id));
        return;
      }
      const r = await sendEmail({ to: lead.email, subject: message.subject ?? "Following up", body: message.body });
      if (r.success) {
        await db.update(followUpsTable).set({ status: "sent", sentAt: new Date(), content: message.body, providerId: r.messageId }).where(eq(followUpsTable.id, row.id));
      } else {
        await db.update(followUpsTable).set({ status: r.error === "no_email_provider_configured" ? "skipped" : "failed", sentAt: new Date(), content: message.body, error: r.error ?? "unknown" }).where(eq(followUpsTable.id, row.id));
      }
      return;
    }
  } catch (err) {
    logger.warn({ err: String(err), id: row.id }, "Follow-up processOne failed");
    await db.update(followUpsTable).set({ status: "failed", sentAt: new Date(), error: String(err).slice(0, 200) }).where(eq(followUpsTable.id, row.id)).catch(() => {});
  }
}

async function pollOnce(): Promise<void> {
  if (_running) return;
  _running = true;
  try {
    const now = new Date();
    const due = await db.select()
      .from(followUpsTable)
      .where(and(eq(followUpsTable.status, "pending"), lte(followUpsTable.scheduledAt, now)))
      .limit(BATCH_SIZE);
    if (!due.length) return;
    logger.info({ count: due.length }, "Follow-up scheduler — sending batch");
    for (const row of due) {
      await processOne(row);
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "Follow-up scheduler poll failed");
  } finally {
    _running = false;
  }
}

export function startFollowUpScheduler(): void {
  if (_timer) return;
  logger.info("Follow-up scheduler started (60s poll)");
  // Kick once on startup, then every 60s
  pollOnce().catch(() => {});
  _timer = setInterval(() => { pollOnce().catch(() => {}); }, POLL_INTERVAL_MS);
}

export function stopFollowUpScheduler(): void {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
