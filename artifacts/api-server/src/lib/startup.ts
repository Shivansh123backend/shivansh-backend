import { db } from "@workspace/db";
import { usersTable, phoneNumbersTable } from "@workspace/db";
import { eq, count } from "drizzle-orm";
import bcrypt from "bcrypt";
import { logger } from "./logger.js";

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
