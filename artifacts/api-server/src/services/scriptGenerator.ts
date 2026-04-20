import OpenAI from "openai";
import { logger } from "../lib/logger.js";
import type { Region } from "./geoDetector.js";

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI | null {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!_openai) {
    try {
      _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    } catch (err) {
      logger.warn({ err: String(err) }, "OpenAI client init failed");
      return null;
    }
  }
  return _openai;
}

export interface GeneratedScript {
  industry: string;
  region: Region;
  audience: string;
  intro: string[];
  qualify: string[];
  discover: string[];
  pitch: string[];
  objections: Array<{ objection: string; response: string }>;
  close: string[];
  fullScript: string;
}

const INDUSTRIES = ["insurance", "solar", "real_estate", "finance", "healthcare", "education", "saas", "other"] as const;

function detectIndustry(desc: string): string {
  const d = desc.toLowerCase();
  if (/insurance|policy|coverage|premium/.test(d)) return "insurance";
  if (/solar|panel|renewable/.test(d)) return "solar";
  if (/real estate|property|mortgage|home/.test(d)) return "real_estate";
  if (/finance|loan|credit|invest/.test(d)) return "finance";
  if (/health|medic|senior|medicare/.test(d)) return "healthcare";
  if (/edu|course|tutor|learn/.test(d)) return "education";
  if (/saas|software|app|platform/.test(d)) return "saas";
  return "other";
}

function detectRegionFromDesc(desc: string): Region {
  const d = desc.toLowerCase();
  if (/\busa?\b|\bus\b|america/.test(d)) return "US";
  if (/\buk\b|britain|england/.test(d)) return "UK";
  if (/\bcanada\b/.test(d)) return "CA";
  if (/\baustralia\b|aussie/.test(d)) return "AU";
  if (/\bindia\b/.test(d)) return "IN";
  return "OTHER";
}

const FALLBACK_SCRIPT: Omit<GeneratedScript, "industry" | "region" | "audience" | "fullScript"> = {
  intro: ["Hi, this is Alex calling — do you have a quick moment?"],
  qualify: ["Are you the right person to speak with about this?", "How are you currently handling this?"],
  discover: ["What's the biggest challenge you're facing right now?"],
  pitch: ["We help people like you save time and money with a simple, proven approach."],
  objections: [
    { objection: "I'm not interested", response: "Totally fair — could I ask what would make this worth a minute of your time?" },
    { objection: "Send me an email", response: "Happy to — and if I could explain it in 30 seconds first, would that be okay?" },
  ],
  close: ["Would it make sense to set up a quick follow-up?"],
};

function buildFullScript(s: Omit<GeneratedScript, "fullScript">): string {
  const lines: string[] = [];
  lines.push("INTRO:");
  s.intro.forEach((l) => lines.push(`- ${l}`));
  lines.push("\nQUALIFY:");
  s.qualify.forEach((l) => lines.push(`- ${l}`));
  lines.push("\nDISCOVER:");
  s.discover.forEach((l) => lines.push(`- ${l}`));
  lines.push("\nPITCH:");
  s.pitch.forEach((l) => lines.push(`- ${l}`));
  lines.push("\nOBJECTION HANDLING:");
  s.objections.forEach((o) => lines.push(`- "${o.objection}" → ${o.response}`));
  lines.push("\nCLOSE:");
  s.close.forEach((l) => lines.push(`- ${l}`));
  return lines.join("\n");
}

export async function generateScript(description: string): Promise<GeneratedScript> {
  const industry = detectIndustry(description);
  const region = detectRegionFromDesc(description);
  const audience = description.slice(0, 200);

  const openai = getOpenAI();
  if (!openai) {
    logger.warn("OPENAI_API_KEY missing — using fallback script");
    const partial = { industry, region, audience, ...FALLBACK_SCRIPT };
    return { ...partial, fullScript: buildFullScript(partial) };
  }

  const regionGuidance =
    region === "US"
      ? "Use confident, direct American English. Short sentences. Assumptive close."
      : region === "UK"
        ? "Use polite, slightly formal British English. Softer phrasing. Soft close."
        : "Use clear, professional, neutral English.";

  const prompt = `You are a senior outbound sales script writer. Generate a compliant, honest call script.

Campaign description: "${description}"
Detected industry: ${industry}
Detected region: ${region}

${regionGuidance}

Compliance rules:
- No misleading claims, no guarantees, no pressure tactics.
- Honest, professional tone.
- Short, conversational lines (under 25 words each).

Return STRICT JSON only:
{
  "intro": [string, string, string],
  "qualify": [string, string, string],
  "discover": [string, string],
  "pitch": [string, string, string],
  "objections": [{"objection": string, "response": string}, ... at least 4 industry-specific],
  "close": [string, string, string]
}`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.7,
    });
    const raw = completion.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw);
    const partial: Omit<GeneratedScript, "fullScript"> = {
      industry,
      region,
      audience,
      intro: Array.isArray(parsed.intro) ? parsed.intro : FALLBACK_SCRIPT.intro,
      qualify: Array.isArray(parsed.qualify) ? parsed.qualify : FALLBACK_SCRIPT.qualify,
      discover: Array.isArray(parsed.discover) ? parsed.discover : FALLBACK_SCRIPT.discover,
      pitch: Array.isArray(parsed.pitch) ? parsed.pitch : FALLBACK_SCRIPT.pitch,
      objections: Array.isArray(parsed.objections) ? parsed.objections : FALLBACK_SCRIPT.objections,
      close: Array.isArray(parsed.close) ? parsed.close : FALLBACK_SCRIPT.close,
    };
    return { ...partial, fullScript: buildFullScript(partial) };
  } catch (err) {
    logger.warn({ err: String(err) }, "Script generation failed — using fallback");
    const partial = { industry, region, audience, ...FALLBACK_SCRIPT };
    return { ...partial, fullScript: buildFullScript(partial) };
  }
}

export const SUPPORTED_INDUSTRIES = INDUSTRIES;
