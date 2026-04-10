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

router.post("/call/manual", authenticate, async (req, res): Promise<void> => {
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
  let script = campaign.agentPrompt ?? "Hello, this is an AI assistant calling on behalf of our team.";
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
    res.json({ message: `Call triggered to ${phone}`, data: result.data });
  } else {
    res.status(502).json({ error: `Worker error for ${phone}: ${result.error}` });
  }
});

export default router;
