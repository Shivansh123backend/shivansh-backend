import type { Region } from "./geoDetector.js";

const US_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bwhilst\b/gi, "while"],
  [/\bshall\b/gi, "will"],
  [/\bperhaps\b/gi, "maybe"],
  [/\bI would like to\b/gi, "I'd like to"],
  [/\bquite\b/gi, "really"],
  [/\bbrilliant\b/gi, "great"],
  [/\bcheers\b/gi, "thanks"],
  [/\blovely\b/gi, "great"],
];

const UK_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bawesome\b/gi, "brilliant"],
  [/\bgotcha\b/gi, "understood"],
  [/\bgonna\b/gi, "going to"],
  [/\bwanna\b/gi, "want to"],
  [/\byeah\b/gi, "yes"],
  [/\bsuper\b/gi, "very"],
  [/\bfolks\b/gi, "everyone"],
];

const UK_SOFTENERS: Array<[RegExp, string]> = [
  [/^Let me /i, "Allow me to "],
  [/^Tell me /i, "Could you tell me "],
  [/^I need /i, "I'd just need "],
  [/^Give me /i, "Could I have "],
];

export function applyAccent(text: string, region: Region): string {
  if (!text) return text;
  try {
    let out = text;
    if (region === "US") {
      for (const [re, rep] of US_REPLACEMENTS) out = out.replace(re, rep);
    } else if (region === "UK") {
      for (const [re, rep] of UK_REPLACEMENTS) out = out.replace(re, rep);
      for (const [re, rep] of UK_SOFTENERS) out = out.replace(re, rep);
    }
    return out;
  } catch {
    return text;
  }
}
