/**
 * Follow-up message generator. Uses LLM when available, otherwise falls back
 * to deterministic templates. Always returns a valid message — never throws.
 */
import OpenAI from "openai";
import { logger } from "../lib/logger.js";
import { frameFor, type Industry } from "./persuasionEngine.js";
import { personalize, type PersonalizationContext } from "./personalizationEngine.js";
import type { FollowUpChannel, SequenceStep } from "./followUpSequence.js";

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI | null {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!_openai) {
    try { _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY }); }
    catch (err) { logger.warn({ err: String(err) }, "OpenAI init failed in follow-up generator"); return null; }
  }
  return _openai;
}

export interface GeneratorInput {
  step: SequenceStep;
  industry: Industry | string | null | undefined;
  callSummary?: string | null;
  disposition?: string | null;
  ctx: PersonalizationContext;
}

export interface GeneratedMessage {
  channel: FollowUpChannel;
  subject?: string;        // email only
  body: string;
  generator: "llm" | "template";
}

function templateFallback(input: GeneratorInput): GeneratedMessage {
  const frame = frameFor(input.industry as string);
  const name = input.ctx.leadName?.split(/\s+/)[0] ?? "there";
  const agent = input.ctx.agentName ?? "your representative";
  const campaign = input.ctx.campaignName ?? "our team";

  if (input.step.channel === "sms") {
    const bodies: Record<string, string> = {
      thank_you: `Hi ${name}, this is ${agent} from ${campaign}. Thanks for the quick chat — ${frame.closing}`,
      reminder:  `Hi ${name}, ${agent} here from ${campaign}. Just a quick reminder — ${frame.closing}`,
      value_add: `Hi ${name}, ${agent} from ${campaign}. ${frame.hooks[0] ?? "Wanted to share something useful"} — happy to share details if helpful.`,
      summary:   `Hi ${name}, sending a quick recap shortly. — ${agent}`,
      final:     `Hi ${name}, last note from me. ${frame.closing} Whenever you're ready.`,
    };
    return { channel: "sms", body: personalize(bodies[input.step.intent] ?? bodies.value_add, input.ctx), generator: "template" };
  }

  // email
  const subject =
    input.step.intent === "summary"   ? `Quick summary from ${campaign}`
  : input.step.intent === "reminder"  ? `Quick reminder from ${campaign}`
  : input.step.intent === "final"     ? `Last note from ${campaign}`
  : input.step.intent === "value_add" ? `Something useful from ${campaign}`
  : `Following up — ${campaign}`;

  const body =
    `Hi ${name},\n\n` +
    `Thanks for taking my call earlier. Wanted to follow up briefly.\n\n` +
    (input.callSummary ? `What we discussed:\n${input.callSummary}\n\n` : "") +
    `${frame.tone}\n\n${frame.closing}\n\n` +
    `— ${agent}\n${campaign}`;

  return { channel: "email", subject, body: personalize(body, input.ctx), generator: "template" };
}

export async function generateMessage(input: GeneratorInput): Promise<GeneratedMessage> {
  const openai = getOpenAI();
  if (!openai) return templateFallback(input);

  const frame = frameFor(input.industry as string);
  const channel = input.step.channel;
  const intent = input.step.intent;

  const prompt = `You write follow-up ${channel.toUpperCase()} messages after sales calls.

Lead name: ${input.ctx.leadName ?? "(unknown)"}
Agent: ${input.ctx.agentName ?? "Agent"}
Campaign: ${input.ctx.campaignName ?? "(none)"}
Industry: ${frame.industry}
Persuasion frame: ${frame.tone}
Hooks to consider: ${frame.hooks.join(", ")}
Avoid these words: ${frame.doNotSay.join(", ")}
Call disposition: ${input.disposition ?? "unknown"}
Call summary: ${input.callSummary ?? "(none)"}
Lead intent: ${input.ctx.intent ?? "medium"}
Step intent: ${intent}

Rules:
- Compliant, honest, no guarantees, no pressure.
- ${channel === "sms" ? "MAX 240 characters. No links unless essential." : "Under 120 words. Plain professional tone."}
- Match the persuasion frame for the industry.
- Keep it personal, not generic.
${channel === "email" ? "Return STRICT JSON: { \"subject\": string, \"body\": string }" : "Return STRICT JSON: { \"body\": string }"}`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.7,
    });
    const raw = completion.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as { subject?: string; body?: string };
    if (!parsed.body || typeof parsed.body !== "string") return templateFallback(input);
    return {
      channel,
      subject: channel === "email" ? (parsed.subject ?? "Following up") : undefined,
      body: personalize(parsed.body, input.ctx),
      generator: "llm",
    };
  } catch (err) {
    logger.warn({ err: String(err) }, "Follow-up LLM generation failed — using template");
    return templateFallback(input);
  }
}
