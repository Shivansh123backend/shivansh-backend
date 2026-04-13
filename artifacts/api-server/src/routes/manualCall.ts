import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { campaignsTable, aiAgentsTable, voicesTable, phoneNumbersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { authenticate } from "../middlewares/auth.js";
import { triggerCall } from "../services/workerService.js";
import { z } from "zod";

const router: IRouter = Router();

const manualCallSchema = z.object({
  phone: z.string().min(7),
  campaign_id: z.number().int().positive(),
});

async function handleManualCall(req: import("express").Request, res: import("express").Response): Promise<void> {
  const parsed = manualCallSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "phone and campaign_id are required" });
    return;
  }

  const { phone, campaign_id } = parsed.data;

  const [campaign] = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.id, campaign_id))
    .limit(1);

  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }

  // Use campaign's own fields first; fall back to AI agent lookup
  let script = campaign.agentPrompt ?? `You are a professional AI voice agent making an outbound call. Follow these steps:

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
  let voiceName = campaign.voice ?? "default";
  let fromNumber = campaign.fromNumber ?? process.env.DEFAULT_FROM_NUMBER ?? "+10000000000";
  const transferNumber = campaign.transferNumber ?? campaign.transferRules ?? undefined;

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

  // If no fromNumber on campaign, try campaign's assigned phone number
  if (!campaign.fromNumber) {
    const [phoneRow] = await db
      .select()
      .from(phoneNumbersTable)
      .where(and(eq(phoneNumbersTable.campaignId, campaign_id), eq(phoneNumbersTable.status, "active")))
      .limit(1);

    if (phoneRow) fromNumber = phoneRow.phoneNumber;
  }

  const result = await triggerCall({
    to: phone,
    from: fromNumber,
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
