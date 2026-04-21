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

// PATCH /users/me/status — agent updates their own status
router.patch("/users/me/status", authenticate, async (req, res): Promise<void> => {
  const VALID = ["available", "busy", "break", "offline"] as const;
  const status = req.body?.status as string;
  if (!VALID.includes(status as typeof VALID[number])) {
    res.status(400).json({ error: `status must be one of: ${VALID.join(", ")}` });
    return;
  }
  const userId = req.user!.userId;
  const [updated] = await db
    .update(usersTable)
    .set({ status: status as typeof VALID[number] })
    .where(eq(usersTable.id, userId))
    .returning({ id: usersTable.id, name: usersTable.name, email: usersTable.email, role: usersTable.role, status: usersTable.status });
  res.json(updated);
});

// REST-conventional alias: POST /users → same as POST /users/create
router.post("/users", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { name, email, password, role } = parsed.data;

  if (role === "agent") {
    const [{ count: agentCount }] = await db.select({ count: count() }).from(usersTable).where(eq(usersTable.role, "agent"));
    if (agentCount >= config.maxAgents) {
      res.status(400).json({ error: `Maximum agent limit of ${config.maxAgents} reached` });
      return;
    }
  }

  const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, email));
  if (existing) { res.status(409).json({ error: "Email already in use" }); return; }

  const passwordHash = await bcrypt.hash(password, 12);
  const [user] = await db.insert(usersTable).values({ name, email, passwordHash, role, status: "available" }).returning({
    id: usersTable.id, name: usersTable.name, email: usersTable.email, role: usersTable.role,
  });
  res.status(201).json(user);
});

// DELETE /users/:id — admin removes a team member.
// Safeguards: cannot delete yourself; cannot delete the last admin.
router.delete("/users/:id", authenticate, requireRole("admin"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid user ID" });
    return;
  }

  if (req.user?.userId === id) {
    res.status(400).json({ error: "You cannot remove your own account" });
    return;
  }

  const [target] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  if (target.role === "admin") {
    const [{ count: adminCount }] = await db
      .select({ count: count() })
      .from(usersTable)
      .where(eq(usersTable.role, "admin"));
    if (adminCount <= 1) {
      res.status(400).json({ error: "Cannot remove the last admin" });
      return;
    }
  }

  await db.delete(usersTable).where(eq(usersTable.id, id));

  await createAuditLog({
    userId: req.user?.userId,
    action: "delete",
    resource: "user",
    resourceId: id,
  });

  res.json({ ok: true, id });
});

export default router;
