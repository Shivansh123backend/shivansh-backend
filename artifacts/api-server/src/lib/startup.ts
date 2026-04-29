import { db } from "@workspace/db";
import { usersTable, phoneNumbersTable, voicesTable } from "@workspace/db";
import { eq, count, sql } from "drizzle-orm";
import bcrypt from "bcrypt";
import axios from "axios";
import { logger } from "./logger.js";
import { VOICE_CATALOG } from "../services/voiceRegistry.js";

export async function ensureAdminUser(): Promise<void> {
  const adminEmail = process.env.ADMIN_EMAIL ?? "admin@example.com";
  const adminPassword = process.env.ADMIN_PASSWORD ?? "Admin@12345";

  try {
    const [existing] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, adminEmail))
      .limit(1);

    if (existing) {
      logger.info({ email: adminEmail }, "Admin user already exists");
    } else {
      const passwordHash = await bcrypt.hash(adminPassword, 12);
      const [user] = await db
        .insert(usersTable)
        .values({ name: "Admin", email: adminEmail, passwordHash, role: "admin", status: "available" })
        .returning();
      logger.info({ userId: user.id, email: adminEmail }, "Admin user seeded");
    }

    await ensureDefaultUsers();
  } catch (err) {
    logger.error({ err }, "Failed to ensure admin user — database may not be ready yet");
  }
}

const DEFAULT_USERS = [
  { name: "Admin Shivansh", email: "admin@shivansh.com", password: "Admin@123", role: "admin" as const },
  { name: "Shivansh Agent", email: "agent@shivansh.com", password: "Agent@123", role: "agent" as const },
];

// ── Real Telnyx phone numbers ─────────────────────────────────────────────────
const REAL_TELNYX_NUMBERS = [
  "+12039199980", "+12038848654", "+12037913991", "+12037913988",
  "+12037913985", "+12037913971", "+12037913963", "+12037148373",
  "+12036642119", "+12035680709", "+12035680211", "+12034058605",
  "+12034052971", "+12034052961", "+12034037573",
];

export async function ensurePhoneNumbers(): Promise<void> {
  try {
    const [{ total }] = await db
      .select({ total: count() })
      .from(phoneNumbersTable)
      .where(eq(phoneNumbersTable.provider, "telnyx"));

    if (Number(total) > 0) {
      logger.info({ count: total }, "Phone numbers already seeded");
      return;
    }

    const values = REAL_TELNYX_NUMBERS.map((phoneNumber, i) => ({
      phoneNumber,
      provider: "telnyx" as const,
      priority: i === 0 ? 1 : 2,
      status: "active" as const,
    }));

    await db.insert(phoneNumbersTable).values(values);
    logger.info({ count: values.length }, "Seeded real Telnyx phone numbers");
  } catch (err) {
    logger.error({ err }, "Failed to seed phone numbers");
  }
}

export async function ensureElevenLabsVoices(): Promise<void> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    logger.info("ELEVENLABS_API_KEY not set — skipping voice sync");
    return;
  }
  try {
    const response = await axios.get("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": apiKey },
      timeout: 15000,
    });
    const elVoices: Array<{
      voice_id: string;
      name: string;
      preview_url?: string;
      labels?: Record<string, string>;
    }> = response.data?.voices ?? [];

    let synced = 0;
    for (const v of elVoices) {
      const gender = v.labels?.gender === "male" ? "male" : "female";
      const accentRaw = (v.labels?.accent ?? "us").toLowerCase();
      const accentMap: Record<string, string> = { american: "us", british: "uk", indian: "indian", australian: "australian", canadian: "canadian" };
      const accent = (accentMap[accentRaw] ?? (["us","uk","indian","australian","canadian"].includes(accentRaw) ? accentRaw : "other")) as "us"|"uk"|"indian"|"australian"|"canadian"|"other";
      const description = [v.labels?.description, v.labels?.use_case, v.labels?.age].filter(Boolean).join(", ");

      const existing = await db.select({ id: voicesTable.id }).from(voicesTable).where(eq(voicesTable.voiceId, v.voice_id)).limit(1);
      if (existing.length > 0) {
        await db.update(voicesTable).set({ name: v.name, previewUrl: v.preview_url ?? null, description: description || null }).where(eq(voicesTable.voiceId, v.voice_id));
      } else {
        await db.insert(voicesTable).values({ name: v.name, provider: "elevenlabs", voiceId: v.voice_id, gender, accent, language: "en", previewUrl: v.preview_url ?? null, description: description || null });
        synced++;
      }
    }
    logger.info({ synced, total: elVoices.length }, "ElevenLabs voices synced on startup");
  } catch (err) {
    logger.warn({ err }, "ElevenLabs voice sync failed on startup — continuing");
  }
}

export async function ensureCatalogVoices(): Promise<void> {
  const providers: Array<"deepgram" | "cartesia"> = ["deepgram", "cartesia"];
  let seeded = 0;
  for (const provider of providers) {
    const voices = VOICE_CATALOG[provider];
    for (const v of voices) {
      try {
        const existing = await db
          .select({ id: voicesTable.id })
          .from(voicesTable)
          .where(eq(voicesTable.voiceId, v.voice_id))
          .limit(1);
        if (existing.length === 0) {
          await db.insert(voicesTable).values({
            name: v.name,
            provider,
            voiceId: v.voice_id,
            gender: v.gender as "male" | "female",
            accent: (v.accent ?? "us") as "us" | "uk" | "indian" | "australian" | "canadian" | "other",
            language: "en",
            description: (v as { description?: string }).description ?? null,
          });
          seeded++;
        }
      } catch (err) {
        logger.warn({ err, provider, voiceId: v.voice_id }, "Failed to seed catalog voice — skipping");
      }
    }
  }
  logger.info({ seeded }, "Catalog voices (Deepgram + Cartesia) ensured in DB");
}

// ── Auto-migrate DB schema ────────────────────────────────────────────────────
// Adds any missing columns to the campaigns table so the server works even
// when drizzle-kit push hasn't been run manually after a schema change.
// Uses ADD COLUMN IF NOT EXISTS — completely safe to run on every startup.
export async function ensureSchema(): Promise<void> {
  try {
    await db.execute(sql`
      ALTER TABLE campaigns
        ADD COLUMN IF NOT EXISTS dialing_mode text NOT NULL DEFAULT 'progressive',
        ADD COLUMN IF NOT EXISTS dialing_ratio integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS dialing_speed integer NOT NULL DEFAULT 10,
        ADD COLUMN IF NOT EXISTS drop_rate_limit integer NOT NULL DEFAULT 3,
        ADD COLUMN IF NOT EXISTS retry_attempts integer NOT NULL DEFAULT 2,
        ADD COLUMN IF NOT EXISTS retry_interval_minutes integer NOT NULL DEFAULT 60,
        ADD COLUMN IF NOT EXISTS working_hours_start text,
        ADD COLUMN IF NOT EXISTS working_hours_end text,
        ADD COLUMN IF NOT EXISTS working_hours_timezone text DEFAULT 'UTC',
        ADD COLUMN IF NOT EXISTS amd_enabled boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS vm_drop_message text,
        ADD COLUMN IF NOT EXISTS tcpa_enabled boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS use_vapi boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS region text,
        ADD COLUMN IF NOT EXISTS accent text,
        ADD COLUMN IF NOT EXISTS voice_profile text,
        ADD COLUMN IF NOT EXISTS human_like text DEFAULT 'true',
        ADD COLUMN IF NOT EXISTS background_sound text DEFAULT 'none',
        ADD COLUMN IF NOT EXISTS hold_music text DEFAULT 'none',
        ADD COLUMN IF NOT EXISTS transfer_number text,
        ADD COLUMN IF NOT EXISTS knowledge_base text,
        ADD COLUMN IF NOT EXISTS recording_notes text,
        ADD COLUMN IF NOT EXISTS voice text,
        ADD COLUMN IF NOT EXISTS voice_provider text DEFAULT 'elevenlabs',
        ADD COLUMN IF NOT EXISTS routing_strategy text NOT NULL DEFAULT 'round_robin',
        ADD COLUMN IF NOT EXISTS transfer_rules text
    `);
    logger.info("ensureSchema — all campaign columns verified");

    // Also ensure audit_logs table exists (used by createAuditLog)
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id serial PRIMARY KEY,
        user_id integer,
        action text NOT NULL,
        resource text NOT NULL,
        resource_id text,
        metadata text,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    logger.info("ensureSchema — audit_logs table verified");
  } catch (err) {
    logger.error({ err }, "ensureSchema failed — server will continue but some features may not work");
  }
}

async function ensureDefaultUsers(): Promise<void> {
  for (const u of DEFAULT_USERS) {
    try {
      const [existing] = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(eq(usersTable.email, u.email))
        .limit(1);

      if (existing) {
        logger.info({ email: u.email }, "Default user already exists");
        continue;
      }

      const passwordHash = await bcrypt.hash(u.password, 12);
      const [user] = await db
        .insert(usersTable)
        .values({ name: u.name, email: u.email, passwordHash, role: u.role, status: "available" })
        .returning();
      logger.info({ userId: user.id, email: u.email }, "Default user seeded");
    } catch (err) {
      logger.error({ err, email: u.email }, "Failed to seed default user");
    }
  }
}
