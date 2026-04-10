import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
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
      return;
    }

    const passwordHash = await bcrypt.hash(adminPassword, 12);
    const [user] = await db
      .insert(usersTable)
      .values({
        name: "Admin",
        email: adminEmail,
        passwordHash,
        role: "admin",
        status: "available",
      })
      .returning();

    logger.info({ userId: user.id, email: adminEmail }, "Admin user seeded");
  } catch (err) {
    logger.error({ err }, "Failed to ensure admin user — database may not be ready yet");
  }
}
