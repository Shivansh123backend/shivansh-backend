import { db } from "@workspace/db";
import { auditLogsTable } from "@workspace/db";
import { logger } from "./logger.js";

export async function createAuditLog(params: {
  userId?: number;
  action: string;
  resource: string;
  resourceId?: string | number;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(auditLogsTable).values({
      userId: params.userId,
      action: params.action,
      resource: params.resource,
      resourceId: params.resourceId?.toString(),
      metadata: params.metadata ? JSON.stringify(params.metadata) : undefined,
    });
  } catch (err) {
    logger.error({ err, params }, "Failed to create audit log");
  }
}
