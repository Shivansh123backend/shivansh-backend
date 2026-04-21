import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { campaignsTable, aiAgentsTable, voicesTable, phoneNumbersTable } from "@workspace/db";
import { eq, and, asc, desc } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { triggerCall } from "../services/workerService.js";
import { z } from "zod";

const router: IRouter = Router();

const manualCallSchema = z.object({
  phone: z.string().min(7),
  // Accept both camelCase (campaignId) and snake_case (campaign_id) from frontend
  campaign_id: z.union([z.number().int().positive(), z.string().transform(Number)]).optional().nullable(),
  campaignId: z.union([z.number().int().positive(), z.string().transform(Number)]).optional().nullable(),
  // Optional caller ID override (softphone dialpad)
  from: z.string().optional().nullable(),
  fromNumber: z.string().optional().nullable(),
}).transform((data) => ({
  phone: data.phone,
  campaign_id: Number(data.campaign_id ?? data.campaignId ?? 0) || 0,
  fromOverride: data.from ?? data.fromNumber ?? null,
}));

const DEFAULT_AGENT_SCRIPT = `You are a professional AI voice agent making an outbound call. Follow these steps:

1. GREETING: Introduce yourself warmly — "Hello, I'm an AI assistant calling on behalf of our team. Am I speaking with [Lead Name]?"

2. CONFIRM DETAILS: Verify the contact's information one by one:
   - Full name: "Could you please confirm your full name?"
   - Phone number: "Is this still the best number to reach you?"
   - Email address: "Could you confirm or provide your email address?"
   - Address: "Could you confirm your current mailing or home address?"

3. PURPOSE: After confirming their details, proceed with the reason for your call and assist them.

4. TONE: Always be warm, professional, and concise. Never rush the contact.

5. OPT-OUT: If the contact asks to be removed from the list, acknowledge immediately, apologise for the interruption, and end the call respectfully.

6. UNAVAILABLE: If the contact is unavailable or requests a callback, note their preferred time and close politely.`;

async function handleManualCall(req: import("express").Request, res: import("express").Response): Promise<void> {
  const parsed = manualCallSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "phone is required" });
    return;
  }

  const { phone, campaign_id, fromOverride } = parsed.data;

  // Defaults for ad-hoc / agent-initiated dials (no campaign attached)
  let script = DEFAULT_AGENT_SCRIPT;
  let voiceName = "default";
  let fromNumber: string | null = fromOverride ?? null;
  let transferNumber: string | undefined = undefined;

  // If a campaign was supplied, hydrate from it
  if (campaign_id > 0) {
    const [campaign] = await db
      .select()
      .from(campaignsTable)
      .where(eq(campaignsTable.id, campaign_id))
      .limit(1);

    if (!campaign) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }

    script = campaign.agentPrompt ?? `You are a professional AI voice agent making an outbound call. Follow these steps:

1. GREETING: Introduce yourself warmly — "Hello, I'm an AI assistant calling on behalf of our team. Am I speaking with [Lead Name]?"

2. CONFIRM DETAILS: Verify the contact's information one by one:
   - Full name: "Could you please confirm your full name?"
   - Phone number: "Is this still the best number to reach you?"
   - Email address: "Could you confirm or provide your email address?"
   - Address: "Could you confirm your current mailing or home address?"

3. PURPOSE: After confirming their details, proceed with the reason for your call and assist them.

4. TONE: Always be warm, professional, and concise. Never rush the contact.

5. OPT-OUT: If the contact asks to be removed from the list, acknowledge immediately, apologise for the interruption, and end the call respectfully.

6. UNAVAILABLE: If the contact is unavailable or requests a callback, note their preferred time and close politely.`;
    voiceName = campaign.voice ?? "default";
    if (!fromNumber) fromNumber = campaign.fromNumber ?? process.env.DEFAULT_FROM_NUMBER ?? null;
    transferNumber = campaign.transferNumber ?? campaign.transferRules ?? undefined;

    // If no direct prompt on campaign, try linked AI agent
    if (!campaign.agentPrompt && campaign.agentId) {
      const [agent] = await db
        .select()
        .from(aiAgentsTable)
        .where(eq(aiAgentsTable.id, campaign.agentId))
        .limit(1);

      if (agent) {
        script = agent.prompt;

        if (!campaign.voice && agent.defaultVoiceId) {
          const [voice] = await db
            .select()
            .from(voicesTable)
            .where(eq(voicesTable.id, agent.defaultVoiceId))
            .limit(1);

          if (voice) voiceName = voice.voiceId;
        }
      }
    }

    // Resolve fromNumber: campaign field → campaign-assigned pool → any active DB number
    if (!fromNumber) {
      const [campaignRow] = await db
        .select()
        .from(phoneNumbersTable)
        .where(and(eq(phoneNumbersTable.campaignId, campaign_id), eq(phoneNumbersTable.status, "active")))
        .limit(1);

      if (campaignRow) {
        fromNumber = campaignRow.phoneNumber;
      }
    }
  }

  // Final fallback: any active number in the pool (works for ad-hoc dials too)
  if (!fromNumber) {
    const [anyRow] = await db
      .select()
      .from(phoneNumbersTable)
      .where(eq(phoneNumbersTable.status, "active"))
      .orderBy(asc(phoneNumbersTable.priority), desc(phoneNumbersTable.id))
      .limit(1);
    if (anyRow) fromNumber = anyRow.phoneNumber;
  }
  if (!fromNumber) fromNumber = process.env.DEFAULT_FROM_NUMBER ?? null;

  const result = await triggerCall({
    to: phone,
    from: fromNumber ?? "+10000000000",
    script,
    voice: voiceName,
    transfer_number: transferNumber,
    campaign_id,
  });

  if (result.success) {
    res.json({
      success: true,
      message: `Call triggered to ${phone}`,
      phone,
      campaignId: campaign_id,
      data: result.data,
    });
  } else {
    const isMissingConfig = result.error?.includes("TELNYX_CONNECTION_ID") || result.error?.includes("TELNYX_API_KEY");
    res.status(isMissingConfig ? 503 : 502).json({
      success: false,
      error: result.error,
      hint: isMissingConfig
        ? "Set TELNYX_CONNECTION_ID in Replit Secrets. Get it from portal.telnyx.com → Call Control Applications."
        : undefined,
    });
  }
}

// Both /call/manual and /calls/manual are accepted
router.post("/call/manual", authenticate, handleManualCall);
router.post("/calls/manual", authenticate, handleManualCall);

export default router;
