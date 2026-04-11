/**
 * Export routes — download call data as TXT or PDF
 *
 * GET /api/calls/:id/export?format=txt|pdf
 * GET /api/call-logs/:id/export?format=txt|pdf
 */

import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { callsTable, callLogsTable, campaignsTable, leadsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import PDFDocument from "pdfkit";

const router: IRouter = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function pad(label: string): string {
  return label.padEnd(20);
}

function formatDuration(secs: number | null | undefined): string {
  if (!secs) return "—";
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s}s`;
}

function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-US", { timeZone: "UTC", hour12: true });
}

function buildTxt(sections: Array<{ heading: string; content: string }>): string {
  const DIVIDER = "═".repeat(60);
  const lines: string[] = ["SHIVANSH AI CALLING — CALL REPORT", DIVIDER];
  for (const { heading, content } of sections) {
    lines.push(`\n${heading.toUpperCase()}`);
    lines.push("─".repeat(40));
    lines.push(content);
  }
  lines.push(`\n${DIVIDER}`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  return lines.join("\n");
}

function buildPdf(
  res: import("express").Response,
  title: string,
  sections: Array<{ heading: string; content: string }>
): void {
  const doc = new PDFDocument({ margin: 50, size: "A4" });
  res.setHeader("Content-Type", "application/pdf");

  doc.pipe(res);

  // Header
  doc.fontSize(20).font("Helvetica-Bold").text("SHIVANSH AI CALLING", { align: "center" });
  doc.fontSize(13).font("Helvetica").text("Call Report", { align: "center" });
  doc.moveDown(0.5);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(1);

  // Title
  doc.fontSize(16).font("Helvetica-Bold").text(title);
  doc.moveDown(0.5);

  // Sections
  for (const { heading, content } of sections) {
    doc.fontSize(12).font("Helvetica-Bold").fillColor("#333").text(heading.toUpperCase());
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke("#ccc");
    doc.moveDown(0.3);
    doc.fontSize(10).font("Helvetica").fillColor("#000").text(content, { lineGap: 3 });
    doc.moveDown(1);
  }

  // Footer
  doc.fontSize(8).fillColor("#888").text(`Generated: ${new Date().toISOString()}`, { align: "center" });
  doc.end();
}

// ── GET /calls/:id/export ─────────────────────────────────────────────────────
router.get("/calls/:id/export", authenticate, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid call ID" }); return; }

  const format = (req.query.format as string ?? "txt").toLowerCase();

  const [call] = await db.select().from(callsTable).where(eq(callsTable.id, id)).limit(1);
  if (!call) { res.status(404).json({ error: "Call not found" }); return; }

  // Enrich with campaign and lead names
  let campaignName = `Campaign #${call.campaignId}`;
  let leadName = "Unknown";
  let leadPhone = "Unknown";

  const [campaign] = await db.select({ name: campaignsTable.name }).from(campaignsTable).where(eq(campaignsTable.id, call.campaignId)).limit(1);
  if (campaign) campaignName = campaign.name;

  if (call.leadId && call.leadId > 0) {
    const [lead] = await db.select({ name: leadsTable.name, phone: leadsTable.phone }).from(leadsTable).where(eq(leadsTable.id, call.leadId)).limit(1);
    if (lead) { leadName = lead.name; leadPhone = lead.phone; }
  }

  const metaContent = [
    `${pad("Call ID:")}${call.id}`,
    `${pad("Direction:")}Outbound`,
    `${pad("Campaign:")}${campaignName}`,
    `${pad("Lead Name:")}${leadName}`,
    `${pad("Phone Number:")}${leadPhone}`,
    `${pad("Status:")}${call.status}`,
    `${pad("Disposition:")}${call.disposition ?? "—"}`,
    `${pad("Provider:")}${call.providerUsed}`,
    `${pad("Voice Used:")}${call.selectedVoice ?? "—"}`,
    `${pad("From Number:")}${call.selectedNumber ?? "—"}`,
    `${pad("Duration:")}${formatDuration(call.duration)}`,
    `${pad("Started:")}${formatDate(call.startedAt)}`,
    `${pad("Ended:")}${formatDate(call.endedAt)}`,
    `${pad("Created:")}${formatDate(call.createdAt)}`,
    `${pad("Recording URL:")}${call.recordingUrl ?? "Not available"}`,
  ].join("\n");

  const transcriptContent = call.transcript?.trim() || "No transcript available for this call.";
  const summaryContent = call.summary?.trim() || "No summary available.";

  const sections = [
    { heading: "Call Details", content: metaContent },
    { heading: "AI Summary", content: summaryContent },
    { heading: "Conversation Transcript", content: transcriptContent },
  ];

  const filename = `call-${id}-${call.status}`;

  if (format === "pdf") {
    res.setHeader("Content-Disposition", `attachment; filename="${filename}.pdf"`);
    buildPdf(res, `Outbound Call #${id} — ${campaignName}`, sections);
  } else {
    const txt = buildTxt(sections);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}.txt"`);
    res.send(txt);
  }
});

// ── GET /call-logs/:id/export ─────────────────────────────────────────────────
router.get("/call-logs/:id/export", authenticate, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid call log ID" }); return; }

  const format = (req.query.format as string ?? "txt").toLowerCase();

  const [log] = await db.select().from(callLogsTable).where(eq(callLogsTable.id, id)).limit(1);
  if (!log) { res.status(404).json({ error: "Call log not found" }); return; }

  let campaignName = `Campaign #${log.campaignId}`;
  const [campaign] = await db.select({ name: campaignsTable.name }).from(campaignsTable).where(eq(campaignsTable.id, log.campaignId)).limit(1);
  if (campaign) campaignName = campaign.name;

  const metaContent = [
    `${pad("Log ID:")}${log.id}`,
    `${pad("Direction:")}${log.direction ?? "inbound"}`,
    `${pad("Campaign:")}${campaignName}`,
    `${pad("Phone Number:")}${log.phoneNumber}`,
    `${pad("Status:")}${log.status}`,
    `${pad("Disposition:")}${log.disposition ?? "—"}`,
    `${pad("Duration:")}${formatDuration(log.duration)}`,
    `${pad("Timestamp:")}${formatDate(log.timestamp)}`,
    `${pad("Recording URL:")}${log.recordingUrl ?? "Not available"}`,
  ].join("\n");

  const transcriptContent = log.transcript?.trim() || "No transcript available.";
  const summaryContent = log.summary?.trim() || "No summary available.";

  const sections = [
    { heading: "Call Details", content: metaContent },
    { heading: "AI Summary", content: summaryContent },
    { heading: "Conversation Transcript", content: transcriptContent },
  ];

  const filename = `call-log-${id}-${log.direction ?? "inbound"}`;

  if (format === "pdf") {
    res.setHeader("Content-Disposition", `attachment; filename="${filename}.pdf"`);
    buildPdf(res, `${log.direction === "inbound" ? "Inbound" : "Outbound"} Call Log #${id} — ${campaignName}`, sections);
  } else {
    const txt = buildTxt(sections);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}.txt"`);
    res.send(txt);
  }
});

export default router;
