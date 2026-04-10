import { Router, type IRouter } from "express";
import bcrypt from "bcrypt";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq, count } from "drizzle-orm";
import { authenticate, requireRole } from "../middlewares/auth.js";
import { createAuditLog } from "../lib/audit.js";
import { config } from "../config/index.js";
import { z } from "zod";

const router: IRouter = Router();

const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(["admin", "supervisor", "agent"]).default("agent"),
});

router.post("/users/create", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { name, email, password, role } = parsed.data;

  // Enforce max 25 agents
  if (role === "agent") {
    const [{ count: agentCount }] = await db
      .select({ count: count() })
      .from(usersTable)
      .where(eq(usersTable.role, "agent"));

    if (agentCount >= config.maxAgents) {
      res.status(400).json({ error: `Maximum agent limit of ${config.maxAgents} reached` });
      return;
    }
  }

  const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, email));
  if (existing) {
    res.status(409).json({ error: "Email already in use" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const [user] = await db.insert(usersTable).values({ name, email, passwordHash, role }).returning();

  await createAuditLog({
    userId: req.user?.userId,
    action: "create",
    resource: "user",
    resourceId: user.id,
  });

  res.status(201).json({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
  });
});

router.get("/users", authenticate, requireRole("admin", "supervisor"), async (req, res): Promise<void> => {
  const users = await db.select({
    id: usersTable.id,
    name: usersTable.name,
    email: usersTable.email,
    role: usersTable.role,
    status: usersTable.status,
    createdAt: usersTable.createdAt,
  }).from(usersTable);

  res.json(users);
});

export default router;
