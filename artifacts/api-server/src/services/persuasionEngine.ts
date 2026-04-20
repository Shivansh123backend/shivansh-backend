/**
 * Industry-aware persuasion framing.
 * Returns hint phrases, do/don't lists, and tone keywords used by the
 * follow-up message generator. Pure helper — no I/O, never throws.
 */
export type Industry =
  | "insurance"
  | "solar"
  | "real_estate"
  | "finance"
  | "healthcare"
  | "education"
  | "saas"
  | "other";

export interface PersuasionFrame {
  industry: Industry;
  hooks: string[];
  hints: string[];
  tone: string;
  closing: string;
  doNotSay: string[];
}

const FRAMES: Record<Industry, Omit<PersuasionFrame, "industry">> = {
  insurance: {
    hooks: ["protection", "peace of mind", "what-if scenarios", "family security"],
    hints: ["risk framing", "loss aversion", "security focus"],
    tone: "Calm, reassuring, professional. Frame around protection — never fear.",
    closing: "Would it be worth a quick review of what you have today?",
    doNotSay: ["guarantee", "always", "never"],
  },
  solar: {
    hooks: ["monthly savings", "long-term ROI", "energy independence", "rebate eligibility"],
    hints: ["savings + ROI", "long-term benefits", "trust signals"],
    tone: "Optimistic, practical. Lead with concrete savings and timelines.",
    closing: "Want me to share a quick estimate based on your home?",
    doNotSay: ["guaranteed savings", "free", "instant"],
  },
  real_estate: {
    hooks: ["right time", "neighborhood trends", "personalized matches"],
    hints: ["scarcity", "expert local insight"],
    tone: "Confident, neighborhood-aware, helpful.",
    closing: "Want a quick look at what's matching your criteria right now?",
    doNotSay: ["best ever", "guaranteed appreciation"],
  },
  finance: {
    hooks: ["credibility", "long-term planning", "risk reduction"],
    hints: ["trust", "credibility", "risk reduction"],
    tone: "Calm, credible, transparent. Avoid hype.",
    closing: "Would you be open to a brief, no-pressure conversation?",
    doNotSay: ["guaranteed returns", "risk-free"],
  },
  healthcare: {
    hooks: ["clarity", "eligibility", "simple next step"],
    hints: ["clarity + reassurance", "simplicity", "respect"],
    tone: "Patient, simple, respectful. Short sentences.",
    closing: "Would you like me to walk through your options briefly?",
    doNotSay: ["cure", "guaranteed", "diagnose"],
  },
  education: {
    hooks: ["outcomes", "flexibility", "real impact"],
    hints: ["growth", "credibility", "flexibility"],
    tone: "Encouraging, practical, outcome-focused.",
    closing: "Would you like to see if it fits your goals?",
    doNotSay: ["guaranteed job", "easiest"],
  },
  saas: {
    hooks: ["time savings", "team productivity", "ROI"],
    hints: ["efficiency", "concrete metrics"],
    tone: "Direct, helpful, value-driven.",
    closing: "Want a quick demo tailored to your stack?",
    doNotSay: ["revolutionary", "10x guaranteed"],
  },
  other: {
    hooks: ["value", "fit", "next step"],
    hints: ["clarity", "relevance"],
    tone: "Friendly, professional, clear.",
    closing: "Would it be worth a quick conversation?",
    doNotSay: ["guarantee"],
  },
};

export function frameFor(industry: string | null | undefined): PersuasionFrame {
  const key = (industry ?? "other").toLowerCase() as Industry;
  const f = FRAMES[key] ?? FRAMES.other;
  return { industry: key in FRAMES ? key : "other", ...f };
}

export function detectIndustryFromText(text: string): Industry {
  const d = (text ?? "").toLowerCase();
  if (/insurance|policy|coverage|premium/.test(d)) return "insurance";
  if (/solar|panel|renewable/.test(d)) return "solar";
  if (/real estate|property|mortgage|home/.test(d)) return "real_estate";
  if (/finance|loan|credit|invest/.test(d)) return "finance";
  if (/health|medic|senior|medicare/.test(d)) return "healthcare";
  if (/edu|course|tutor|learn/.test(d)) return "education";
  if (/saas|software|app|platform/.test(d)) return "saas";
  return "other";
}
