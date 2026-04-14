import { Router, type IRouter } from "express";
import axios from "axios";
import { db } from "@workspace/db";
import { smsLogsTable, leadsTable, campaignsTable, phoneNumbersTable } from "@workspace/db";
import { eq, and, notInArray } from "drizzle-orm";
import { authenticate, requireRole } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";
import { z } from "zod";

const router: IRouter = Router();

/** Prevents firing the same campaign SMS blast twice simultaneously. */
const activeSmsCampaigns = new Set<number>();

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_URL = "https://api.telnyx.com/v2/messages";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Replace {{variable}} placeholders with values from the data object. */
function personalise(template: string, data: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => data[key] ?? `{{${key}}}`);
}

/** Send a single SMS via Telnyx. Returns the provider message id on success. */
async function sendViaTelnyx(
  to: string,
  from: string,
  text: string
): Promise<{ success: true; messageId: string } | { success: false; error: string }> {
  if (!TELNYX_API_KEY) {
    return { success: false, error: "TELNYX_API_KEY is not configured" };
  }
  try {
    const res = await axios.post(
      TELNYX_URL,
      { from, to, text },
      {
        headers: {
          Authorization: `Bearer ${TELNYX_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 10_000,
      }
    );
    const messageId: string = res.data?.data?.id ?? "";
    return { success: true, messageId };
  } catch (err: unknown) {
    const msg =
      axios.isAxiosError(err)
        ? (err.response?.data?.errors?.[0]?.detail ?? err.message)
        : String(err);
    return { success: false, error: msg };
  }
}

/** Log SMS result to DB. */
async function logSms(opts: {
  phoneNumber: string;
  campaignId: number | null;
  message: string;
  status: "sent" | "failed";
  providerMessageId?: string;
  errorMessage?: string;
}) {
  try {
    await db.insert(smsLogsTable).values({
      phoneNumber: opts.phoneNumber,
      campaignId: opts.campaignId,
      message: opts.message,
      status: opts.status,
      providerMessageId: opts.providerMessageId ?? null,
      errorMessage: opts.errorMessage ?? null,
    });
  } catch (err) {
    logger.warn({ err }, "Failed to write SMS log");
  }
}

/** Sleep for ms milliseconds. */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── POST /sms/send ───────────────────────────────────────────────────────────
// Send a single SMS message

const sendSmsSchema = z.object({
  to: z.string().min(1),
  from: z.string().optional(),
  message: z.string().min(1),
});

/** Pick an active Telnyx number from DB, priority 1 first. */
async function pickFromNumber(): Promise<string | null> {
  const [row] = await db
    .select({ phoneNumber: phoneNumbersTable.phoneNumber })
    .from(phoneNumbersTable)
    .where(and(eq(phoneNumbersTable.provider, "telnyx"), eq(phoneNumbersTable.status, "active")))
    .orderBy(phoneNumbersTable.priority)
    .limit(1);
  return row?.phoneNumber ?? null;
}

router.post("/sms/send", authenticate, async (req, res): Promise<void> => {
  if (!TELNYX_API_KEY) {
    res.status(503).json({ error: "TELNYX_API_KEY is not configured on this server" });
    return;
  }

  const parsed = sendSmsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    return;
  }

  const { to, message } = parsed.data;
  const from = parsed.data.from ?? await pickFromNumber();
  if (!from) {
    res.status(503).json({ error: "No active Telnyx phone number available for sending" });
    return;
  }
  const result = await sendViaTelnyx(to, from, message);

  await logSms({
    phoneNumber: to,
    campaignId: null,
    message,
    status: result.success ? "sent" : "failed",
    providerMessageId: result.success ? result.messageId : undefined,
    errorMessage: result.success ? undefined : result.error,
  });

  if (!result.success) {
    res.status(502).json({ error: result.error });
    return;
  }

  res.status(200).json({
    ok: true,
    to,
    message_id: result.messageId,
  });
});

// ── POST /sms/campaign/:campaign_id ─────────────────────────────────────────
// Send personalised SMS to every lead in a campaign

const campaignSmsSchema = z.object({
  from: z.string().optional(),
  message: z.string().min(1), // supports {{name}}, {{phone_number}}, {{email}}
});

router.post(
  "/sms/campaign/:campaign_id",
  authenticate,
  requireRole("admin"),
  async (req, res): Promise<void> => {
    if (!TELNYX_API_KEY) {
      res.status(503).json({ error: "TELNYX_API_KEY is not configured on this server" });
      return;
    }

    const campaignId = parseInt(req.params.campaign_id, 10);
    if (isNaN(campaignId)) {
      res.status(400).json({ error: "Invalid campaign_id" });
      return;
    }

    // Lock: prevent duplicate blasts for the same campaign
    if (activeSmsCampaigns.has(campaignId)) {
      res.status(409).json({ error: "An SMS blast for this campaign is already in progress" });
      return;
    }

    const parsed = campaignSmsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
      return;
    }

    const from = parsed.data.from ?? await pickFromNumber();
    if (!from) {
      res.status(503).json({ error: "No active Telnyx phone number available for sending" });
      return;
    }
    const { message: template } = parsed.data;

    // Verify campaign exists
    const [campaign] = await db
      .select()
      .from(campaignsTable)
      .where(eq(campaignsTable.id, campaignId));

    if (!campaign) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }

    // Fetch leads — exclude DNC and do_not_call to stay compliant
    const leads = await db
      .select()
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.campaignId, campaignId),
          notInArray(leadsTable.status, ["do_not_call"]),
          eq(leadsTable.dncFlag, false)
        )
      );

    if (leads.length === 0) {
      res.json({ total_sent: 0, total_failed: 0, total_leads: 0, message: "No eligible leads" });
      return;
    }

    // Respond immediately — sending loop runs in background
    res.status(202).json({
      accepted: true,
      campaign_id: campaignId,
      total_leads: leads.length,
      message: `SMS campaign started — ${leads.length} eligible leads queued`,
    });

    // ── Background sending loop ────────────────────────────────────────────
    activeSmsCampaigns.add(campaignId);
    let sent = 0;
    let failed = 0;

    for (const lead of leads) {
      const personalised = personalise(template, {
        name: lead.name,
        phone_number: lead.phone,
        email: lead.email ?? "",
      });

      const result = await sendViaTelnyx(lead.phone, from, personalised);

      await logSms({
        phoneNumber: lead.phone,
        campaignId,
        message: personalised,
        status: result.success ? "sent" : "failed",
        providerMessageId: result.success ? result.messageId : undefined,
        errorMessage: result.success ? undefined : result.error,
      });

      if (result.success) { sent++; } else { failed++; }

      // Polite delay between messages (200–500 ms) to avoid rate limits
      await sleep(200 + Math.floor(Math.random() * 300));
    }

    activeSmsCampaigns.delete(campaignId);
    logger.info({ campaignId, sent, failed }, "SMS campaign completed");
  }
);

// ── GET /sms/logs/:campaign_id ───────────────────────────────────────────────
// Retrieve SMS logs for a campaign

router.get("/sms/logs/:campaign_id", authenticate, async (req, res): Promise<void> => {
  const campaignId = parseInt(req.params.campaign_id, 10);
  if (isNaN(campaignId)) {
    res.status(400).json({ error: "Invalid campaign_id" });
    return;
  }

  const logs = await db
    .select()
    .from(smsLogsTable)
    .where(eq(smsLogsTable.campaignId, campaignId))
    .orderBy(smsLogsTable.createdAt);

  res.json(
    logs.map((l) => ({
      id: l.id,
      phone_number: l.phoneNumber,
      campaign_id: l.campaignId,
      message: l.message,
      status: l.status,
      provider_message_id: l.providerMessageId,
      error: l.errorMessage,
      timestamp: l.createdAt,
    }))
  );
});

// ── GET /sms/logs ────────────────────────────────────────────────────────────
// All SMS logs (admin)
router.get("/sms/logs", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const logs = await db
    .select()
    .from(smsLogsTable)
    .orderBy(smsLogsTable.createdAt);

  res.json(
    logs.map((l) => ({
      id: l.id,
      phone_number: l.phoneNumber,
      campaign_id: l.campaignId,
      message: l.message,
      status: l.status,
      provider_message_id: l.providerMessageId,
      error: l.errorMessage,
      timestamp: l.createdAt,
    }))
  );
});

export default router;
