/** Normalise a phone string toward E.164.
 *  Strips spaces/symbols/parens/dashes, preserves leading +.
 *  Auto-prepends +1 for US/Canada numbers entered without a country code.
 *  Examples:
 *    "813-872-4841"   → "+18138724841"
 *    "8138724841"     → "+18138724841"
 *    "(813) 872-4841" → "+18138724841"
 *    "1-813-872-4841" → "+18138724841"
 *    "+18138724841"   → "+18138724841"
 *    "+447700900123"  → "+447700900123"  (international untouched)
 *  Returns null for numbers with fewer than 10 or more than 15 digits (invalid). */
export function normalisePhone(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let s = String(raw).trim().replace(/[^\d+]/g, "");
  s = s.replace(/(?!^\+)\+/g, "");
  const digits = s.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  if (s.startsWith("+")) return s;
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return "+" + digits;
}
