import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import bcrypt from "bcrypt";
import { logger } from "../lib/logger.js";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "Admin@12345";

async function seedAdmin() {
  const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, ADMIN_EMAIL));

  if (existing) {
    logger.info({ email: ADMIN_EMAIL }, "Admin user already exists");
    return;
  }

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  const [user] = await db.insert(usersTable).values({
    name: "Admin",
    email: ADMIN_EMAIL,
    passwordHash,
    role: "admin",
    status: "available",
  }).returning();

  logger.info({ userId: user.id, email: ADMIN_EMAIL }, "Admin user seeded");
}

seedAdmin().catch((err) => {
  logger.error({ err }, "Seed failed");
  process.exit(1);
}).finally(() => process.exit(0));
