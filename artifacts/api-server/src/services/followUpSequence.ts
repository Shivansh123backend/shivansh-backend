/**
 * Multi-step follow-up sequences keyed by call disposition.
 * Returns an array of scheduled steps (channel + delay + sequence step).
 * Pure data — no I/O.
 */

export type FollowUpChannel = "sms" | "email";
export type Disposition =
  | "interested"
  | "not_interested"
  | "vm"
  | "no_answer"
  | "busy"
  | "connected"
  | "callback_requested"
  | "transferred"
  | "completed"
  | "dropped";

export interface SequenceStep {
  step: number;
  channel: FollowUpChannel;
  delayMinutes: number;       // delay from "now" (call end)
  intent: "thank_you" | "summary" | "reminder" | "value_add" | "final";
}

const MIN = 1;
const HOUR = 60;
const DAY = 60 * 24;

function build(steps: SequenceStep[]): SequenceStep[] {
  return steps.map((s, i) => ({ ...s, step: i + 1 }));
}

export function sequenceFor(disposition: Disposition | string): SequenceStep[] {
  switch (disposition) {
    // Interested → fast SMS thanks, next-day email summary, day-3 SMS reminder, day-7 final.
    case "interested":
    case "callback_requested":
      return build([
        { step: 0, channel: "sms",   delayMinutes: 5 * MIN,   intent: "thank_you" },
        { step: 0, channel: "email", delayMinutes: 1 * DAY,   intent: "summary" },
        { step: 0, channel: "sms",   delayMinutes: 3 * DAY,   intent: "reminder" },
        { step: 0, channel: "email", delayMinutes: 7 * DAY,   intent: "final" },
      ]);

    case "transferred":
    case "completed":
    case "connected":
      return build([
        { step: 0, channel: "sms",   delayMinutes: 10 * MIN,  intent: "thank_you" },
        { step: 0, channel: "email", delayMinutes: 1 * DAY,   intent: "summary" },
      ]);

    // Dropped or VM → immediate SMS so they have your name + reason.
    case "dropped":
    case "vm":
      return build([
        { step: 0, channel: "sms",   delayMinutes: 1 * MIN,   intent: "thank_you" },
        { step: 0, channel: "email", delayMinutes: 1 * DAY,   intent: "value_add" },
      ]);

    // No answer / busy → next-day SMS, then email value-add 3 days later.
    case "no_answer":
    case "busy":
      return build([
        { step: 0, channel: "sms",   delayMinutes: 1 * DAY,   intent: "value_add" },
        { step: 0, channel: "email", delayMinutes: 3 * DAY,   intent: "value_add" },
      ]);

    // Not interested → soft retargeting after a week.
    case "not_interested":
      return build([
        { step: 0, channel: "email", delayMinutes: 7 * DAY,   intent: "value_add" },
      ]);

    default:
      return build([
        { step: 0, channel: "sms",   delayMinutes: 1 * HOUR,  intent: "thank_you" },
      ]);
  }
}
