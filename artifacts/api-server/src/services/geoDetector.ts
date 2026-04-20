export type Region = "US" | "UK" | "CA" | "AU" | "IN" | "OTHER";

export function detectRegionFromPhone(phone: string | null | undefined): Region {
  if (!phone) return "OTHER";
  const p = phone.replace(/[^\d+]/g, "");
  if (p.startsWith("+1") || p.startsWith("1")) return "US";
  if (p.startsWith("+44") || p.startsWith("44")) return "UK";
  if (p.startsWith("+61") || p.startsWith("61")) return "AU";
  if (p.startsWith("+91") || p.startsWith("91")) return "IN";
  return "OTHER";
}

export function detectRegion(input: {
  phone?: string | null;
  campaignRegion?: string | null;
  leadCountry?: string | null;
}): Region {
  if (input.campaignRegion) {
    const r = String(input.campaignRegion).toUpperCase();
    if (["US", "UK", "CA", "AU", "IN"].includes(r)) return r as Region;
  }
  if (input.leadCountry) {
    const c = String(input.leadCountry).toUpperCase();
    if (c === "GB") return "UK";
    if (["US", "UK", "CA", "AU", "IN"].includes(c)) return c as Region;
  }
  return detectRegionFromPhone(input.phone);
}
