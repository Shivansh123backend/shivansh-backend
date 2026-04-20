/**
 * Objection Handling Engine — premium-grade response system.
 *
 * Pipeline per turn:
 *   detectObjection → handleObjection → returns { reply, type, hardReject }
 *
 * Every non-reject reply follows: Acknowledge → Normalize → Redirect → Ask.
 * Tracks per-call memory so the engine softens after repeated objections,
 * avoids repeating itself, and switches to a firm-calm tone if the user
 * becomes hostile.
 */

export type ObjectionType =
  | "not_interested"
  | "price"
  | "time"
  | "already_have"
  | "info_brush"
  | "hard_reject"
  | null;

export interface ObjectionMemory {
  objectionCount: number;
  lastObjectionType: ObjectionType;
  usedReplies: Set<string>;
  firmToneLatched: boolean;
}

export function createObjectionMemory(): ObjectionMemory {
  return {
    objectionCount: 0,
    lastObjectionType: null,
    usedReplies: new Set(),
    firmToneLatched: false,
  };
}

// ── 1. Detection ────────────────────────────────────────────────────────────

const KEYWORDS: Record<Exclude<ObjectionType, null>, RegExp[]> = {
  hard_reject: [
    /\bdon'?t call\b/, /\bstop calling\b/, /\bremove me\b/, /\btake me off\b/,
    /\bnever call\b/, /\bleave me alone\b/, /\bgo away\b/, /\bfuck\b/,
    /\bshut up\b/, /\bdo not contact\b/, /\bunsubscribe\b/,
  ],
  price: [
    /\btoo expensive\b/, /\bcan'?t afford\b/, /\bprice\b/, /\bcost\b/,
    /\bexpensive\b/, /\bcheap(er)?\b/, /\bbudget\b/, /\bhow much\b/,
    /\bfees?\b/, /\bcharges?\b/,
  ],
  time: [
    /\bbusy\b/, /\bnot (a )?good time\b/, /\bcall (me )?(back|later)\b/,
    /\banother time\b/, /\bin a meeting\b/, /\bdriving\b/, /\bat work\b/,
    /\bno time\b/, /\blater\b/,
  ],
  already_have: [
    /\balready (have|got|use|using)\b/, /\bi have one\b/, /\bgot one\b/,
    /\bcurrent provider\b/, /\bwith (someone|another)\b/, /\bsorted\b/,
    /\bcovered\b/,
  ],
  info_brush: [
    /\bsend (me )?(info|details|email|brochure)\b/, /\bemail (me|it)\b/,
    /\bsend it (over|to me)\b/, /\bin writing\b/, /\bvia email\b/,
  ],
  not_interested: [
    /\bnot interested\b/, /\bno thanks\b/, /\bno thank you\b/,
    /\bdon'?t want\b/, /\bdon'?t need\b/, /\bnot for me\b/,
    /\bpass\b/, /\bnot right now\b/,
  ],
};

// Order matters — hard_reject and price beat not_interested when both match.
const DETECTION_ORDER: Exclude<ObjectionType, null>[] = [
  "hard_reject", "price", "time", "already_have", "info_brush", "not_interested",
];

export function detectObjection(input: string): ObjectionType {
  const t = input.toLowerCase();
  for (const type of DETECTION_ORDER) {
    if (KEYWORDS[type].some((re) => re.test(t))) return type;
  }
  return null;
}

// ── 2. Tone detection ───────────────────────────────────────────────────────

const HOSTILE_KEYWORDS = [
  /\bfuck\b/, /\bshit\b/, /\bbastard\b/, /\bidiot\b/, /\bstupid\b/,
  /\bshut up\b/, /\bbitch\b/, /\basshole\b/, /\bdamn you\b/, /\bpiss off\b/,
];

export function isHostile(input: string): boolean {
  const t = input.toLowerCase();
  return HOSTILE_KEYWORDS.some((re) => re.test(t));
}

// ── 3. Response variations ──────────────────────────────────────────────────

const RESPONSES: Record<Exclude<ObjectionType, null>, string[]> = {
  price: [
    "I understand — that's the first thing most people check. Just so I'm clear, are you comparing on price or overall coverage?",
    "Fair enough, price matters. Out of curiosity, is it the upfront cost or the long-term value you're weighing?",
    "Got it — most people start there. Would it help if I quickly walked you through how the pricing actually works?",
  ],
  not_interested: [
    "Got it — usually that's because it doesn't seem relevant at first. Just quickly, is it something you've already sorted, or just not looking right now?",
    "Makes sense. Can I ask — is it the timing, or just not something on your radar at the moment?",
    "Totally fair. Before I let you go, mind if I ask what would actually make this worth a look for you?",
  ],
  time: [
    "No worries — I'll keep it quick. Would later today be better, or tomorrow morning?",
    "Got it, I won't take much of your time. Is there a window in the next day or two that would work better?",
    "Fair enough. Would it be easier if I called back this evening, or sometime tomorrow?",
  ],
  already_have: [
    "Makes sense — most people already have something in place. This is more about seeing if there's a better fit. Would you be open to a quick comparison?",
    "Got it. Out of curiosity, when was the last time you actually checked what's out there? Things have moved a lot recently.",
    "Fair enough. Mind if I ask what you're using now? I can let you know in 30 seconds if it's worth a look.",
  ],
  info_brush: [
    "I can send details — just so I send the right thing, what matters more to you here, price or coverage?",
    "Happy to email it. Quick question first — is this for yourself or for someone else? It'll help me send the right info.",
    "Sure, I'll send something over. Before I do, what's the one thing you'd most want it to answer?",
  ],
  hard_reject: [
    "Understood, I won't push this further. Thanks for your time — have a good day.",
    "Got it, I'll mark you as do-not-contact. Apologies for the disturbance.",
    "Understood. I'll take you off the list right away. Take care.",
  ],
};

// ── 4. Micro-humanization fillers ──────────────────────────────────────────

const FILLERS = ["Got it.", "Makes sense.", "Fair enough."];

function maybePrefixFiller(reply: string): string {
  // Only ~25% of the time, and never if reply already starts with a filler
  if (Math.random() > 0.25) return reply;
  const lower = reply.toLowerCase();
  if (FILLERS.some((f) => lower.startsWith(f.toLowerCase()))) return reply;
  const filler = FILLERS[Math.floor(Math.random() * FILLERS.length)]!;
  return `${filler} ${reply}`;
}

// ── 5. Response selection (avoid repeats) ───────────────────────────────────

function pickReply(type: Exclude<ObjectionType, null>, mem: ObjectionMemory): string {
  const pool = RESPONSES[type];
  const fresh = pool.filter((r) => !mem.usedReplies.has(r));
  const choice = (fresh.length > 0 ? fresh : pool)[
    Math.floor(Math.random() * (fresh.length > 0 ? fresh.length : pool.length))
  ]!;
  mem.usedReplies.add(choice);
  return choice;
}

// ── 6. Main entry point ─────────────────────────────────────────────────────

export interface ObjectionResult {
  type: ObjectionType;
  reply: string | null;
  hardReject: boolean;
  endCall: boolean;        // true → bridge should hang up after speaking reply
  firmTone: boolean;       // true → user was hostile or fatigued
}

export function handleObjection(input: string, mem: ObjectionMemory): ObjectionResult {
  const hostile = isHostile(input);
  if (hostile) mem.firmToneLatched = true;

  const type = detectObjection(input);
  if (!type) {
    return { type: null, reply: null, hardReject: false, endCall: false, firmTone: mem.firmToneLatched };
  }

  mem.objectionCount += 1;
  mem.lastObjectionType = type;

  // Hard reject — single calm exit line, never push further.
  if (type === "hard_reject") {
    const reply = pickReply("hard_reject", mem);
    return { type, reply, hardReject: true, endCall: true, firmTone: true };
  }

  // After 3+ objections, soften and offer a graceful exit.
  if (mem.objectionCount > 2) {
    const reply =
      "I can hear this isn't the right time. Would you prefer I call back later, or take you off the list?";
    return { type, reply, hardReject: false, endCall: false, firmTone: true };
  }

  // Hostile but not an explicit hard reject — firm calm, short, offer exit.
  if (mem.firmToneLatched) {
    const reply = "Understood. I'll keep this brief — would you like me to call back another time, or stop entirely?";
    return { type, reply, hardReject: false, endCall: false, firmTone: true };
  }

  // Standard objection — Acknowledge → Normalize → Redirect → Ask
  const base = pickReply(type, mem);
  const reply = maybePrefixFiller(base);
  return { type, reply, hardReject: false, endCall: false, firmTone: false };
}
