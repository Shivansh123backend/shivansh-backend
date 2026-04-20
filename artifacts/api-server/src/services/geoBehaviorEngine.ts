import type { Region } from "./geoDetector.js";

export interface GeoBehavior {
  paceMultiplier: number;
  pauseIntensity: number;
  closingStyle: "assumptive" | "soft" | "neutral";
  toneHint: string;
  closingExample: string;
}

export function geoBehaviorFor(region: Region): GeoBehavior {
  switch (region) {
    case "US":
      return {
        paceMultiplier: 1.05,
        pauseIntensity: 0.85,
        closingStyle: "assumptive",
        toneHint: "Confident, direct, casual. Shorter sentences. Quick to the point.",
        closingExample: "Would mornings or afternoons work better for you?",
      };
    case "UK":
      return {
        paceMultiplier: 0.92,
        pauseIntensity: 1.15,
        closingStyle: "soft",
        toneHint: "Polite, slightly formal. Softer phrasing. Allow the caller room.",
        closingExample: "Would you be open to exploring this a bit further?",
      };
    case "AU":
      return {
        paceMultiplier: 1.0,
        pauseIntensity: 1.0,
        closingStyle: "neutral",
        toneHint: "Friendly and relaxed. Plainspoken.",
        closingExample: "Want to have a quick chat about it?",
      };
    case "IN":
      return {
        paceMultiplier: 0.95,
        pauseIntensity: 1.05,
        closingStyle: "neutral",
        toneHint: "Respectful and clear. Avoid slang.",
        closingExample: "Would it be convenient to discuss this further?",
      };
    default:
      return {
        paceMultiplier: 1.0,
        pauseIntensity: 1.0,
        closingStyle: "neutral",
        toneHint: "Professional and clear.",
        closingExample: "Would you like to learn more?",
      };
  }
}
