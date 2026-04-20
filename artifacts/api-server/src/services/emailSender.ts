/**
 * Email sender with graceful fallback.
 * If no SMTP/RESEND/SENDGRID env is configured, returns success=false and logs intent.
 * This keeps the follow-up pipeline from breaking when no email provider is wired.
 */
import { logger } from "../lib/logger.js";

export interface SendEmailInput {
  to: string;
  subject: string;
  body: string;        // plain text or HTML
  from?: string;
}

export interface SendEmailResult {
  success: boolean;
  provider?: string;
  messageId?: string;
  error?: string;
}

const FROM_DEFAULT = process.env.EMAIL_FROM ?? "noreply@shivansh.local";

async function sendViaResend(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { success: false, error: "no_resend_key" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: input.from ?? FROM_DEFAULT,
        to: input.to,
        subject: input.subject,
        html: input.body,
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { success: false, error: `resend_${res.status}_${txt.slice(0, 100)}` };
    }
    const data = await res.json().catch(() => ({}));
    return { success: true, provider: "resend", messageId: (data as { id?: string }).id };
  } catch (err) {
    return { success: false, error: `resend_throw_${String(err).slice(0, 100)}` };
  }
}

async function sendViaSendgrid(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) return { success: false, error: "no_sendgrid_key" };
  try {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: input.to }] }],
        from: { email: input.from ?? FROM_DEFAULT },
        subject: input.subject,
        content: [{ type: "text/html", value: input.body }],
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { success: false, error: `sg_${res.status}_${txt.slice(0, 100)}` };
    }
    return { success: true, provider: "sendgrid", messageId: res.headers.get("x-message-id") ?? undefined };
  } catch (err) {
    return { success: false, error: `sg_throw_${String(err).slice(0, 100)}` };
  }
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  if (!input.to || !input.subject) {
    return { success: false, error: "invalid_input" };
  }
  // Try Resend first, then SendGrid, then no-op (logged) so pipeline never breaks.
  if (process.env.RESEND_API_KEY) {
    const r = await sendViaResend(input);
    if (r.success) return r;
    logger.warn({ error: r.error, to: input.to }, "Resend send failed");
  }
  if (process.env.SENDGRID_API_KEY) {
    const r = await sendViaSendgrid(input);
    if (r.success) return r;
    logger.warn({ error: r.error, to: input.to }, "SendGrid send failed");
  }
  logger.info({ to: input.to, subject: input.subject }, "Email send skipped — no provider configured");
  return { success: false, provider: "none", error: "no_email_provider_configured" };
}

export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY || process.env.SENDGRID_API_KEY);
}
