/**
 * Intervention Engine (Step 15, 18 of enhancement plan).
 *
 * Translates a supervisor HealthSignal into a small system-prompt nudge that
 * is appended to the next LLM call. Does NOT replace the LLM's response —
 * it shapes its strategy for the upcoming turn.
 *
 * Also exposes a tiny prefix helper the coach can prepend if it wants the
 * AI to acknowledge the friction explicitly.
 */

import type { HealthSignal } from "./aiSupervisor.js";

export interface InterventionPlan {
  promptAddition: string | null;   // appended to system prompt for this turn
  prefix: string | null;           // optional natural opener to prepend to the reply
  forceSoftExit: boolean;          // signal to start moving toward end-of-call
}

export function planIntervention(signal: HealthSignal): InterventionPlan {
  switch (signal) {
    case "confused":
      return {
        promptAddition:
          "USER IS CONFUSED. Slow down. Use one short, plain-English sentence. Avoid jargon. Offer a quick example if helpful.",
        prefix: "Let me simplify that — ",
        forceSoftExit: false,
      };

    case "frustrated":
      return {
        promptAddition:
          "USER SOUNDS FRUSTRATED. Lower pressure. Be brief, calm, and respectful. Offer to keep it short or follow up later.",
        prefix: "I understand — let me keep this brief. ",
        forceSoftExit: false,
      };

    case "angry":
      return {
        promptAddition:
          "USER IS ANGRY. Stop persuading immediately. One short, calm, respectful sentence. Acknowledge, apologise once if appropriate, and offer a clean exit (callback or removal from list). Do not defend or explain.",
        prefix: "I hear you — ",
        forceSoftExit: true,
      };

    case "hesitant":
      return {
        promptAddition:
          "USER IS HESITANT. Build comfort. Use a soft, no-pressure question. Avoid commitment language. Reassure that there's no obligation.",
        prefix: null,
        forceSoftExit: false,
      };

    case "disengaged":
      return {
        promptAddition:
          "USER IS DISENGAGING. Re-engage with one direct, specific question that requires a one-word answer.",
        prefix: null,
        forceSoftExit: false,
      };

    case "degrading":
      return {
        promptAddition:
          "CALL QUALITY IS DEGRADING. Switch to a soft-exit close. Acknowledge their time, offer a follow-up, and prepare to end politely if they decline.",
        prefix: null,
        forceSoftExit: true,
      };

    case "ok":
    default:
      return { promptAddition: null, prefix: null, forceSoftExit: false };
  }
}
