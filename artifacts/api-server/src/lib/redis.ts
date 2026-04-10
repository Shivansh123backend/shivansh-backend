import Redis from "ioredis";
import { logger } from "./logger.js";

let redisClient: Redis | null = null;

function isRedisConfigured(): boolean {
  return !!(process.env.REDIS_URL || process.env.REDIS_HOST);
}

export function getRedisClient(): Redis {
  if (!redisClient) {
    // Prefer REDIS_URL (full connection string) — fallback to host/port/password
    if (process.env.REDIS_URL) {
      redisClient = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        lazyConnect: true,
      });
    } else {
      redisClient = new Redis({
        host: process.env.REDIS_HOST ?? "localhost",
        port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
        password: process.env.REDIS_PASSWORD,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        lazyConnect: true,
      });
    }

    redisClient.on("error", (err) => {
      logger.error({ err }, "Redis connection error");
    });

    redisClient.on("connect", () => {
      logger.info(
        process.env.REDIS_URL ? "Redis connected (URL)" : "Redis connected (host)",
        "Redis connected"
      );
    });
  }
  return redisClient;
}

export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}

/** Returns true when Redis is reachable */
async function isRedisReady(): Promise<boolean> {
  if (!isRedisConfigured()) return false;
  try {
    const client = getRedisClient();
    await client.ping();
    return true;
  } catch {
    return false;
  }
}

// ── Active call tracking ─────────────────────────────────────────────────────
// Key:   active_calls:{call_id}
// Value: JSON blob — ActiveCallRecord
// TTL:   2 hours (safety net; worker removes on completion via POST /dashboard/update)

const ACTIVE_CALL_TTL = 7200; // seconds
const AGENT_STATUS_TTL = 86400; // 24 hours

export interface ActiveCallRecord {
  call_id: string;
  phone_number: string;
  campaign_id: number;
  campaign_name?: string;
  status: "ringing" | "in-call" | "completed";
  started_at: string;
}

export interface AgentStatusRecord {
  agent_id: number;
  status: "available" | "busy";
  current_call?: string; // call_id
  updated_at: string;
}

function activeCallKey(callId: string): string {
  return `active_calls:${callId}`;
}

function agentStatusKey(agentId: number): string {
  return `agent_status:${agentId}`;
}

/** Store an active call in Redis. No-op when Redis is not configured. */
export async function setActiveCall(record: ActiveCallRecord): Promise<void> {
  if (!(await isRedisReady())) return;
  try {
    const client = getRedisClient();
    await client.set(activeCallKey(record.call_id), JSON.stringify(record), "EX", ACTIVE_CALL_TTL);
  } catch (err) {
    logger.warn({ err, callId: record.call_id }, "Redis setActiveCall failed");
  }
}

/** Update a call's status in Redis. Removes the key if status is terminal. */
export async function updateActiveCall(
  callId: string,
  status: ActiveCallRecord["status"]
): Promise<ActiveCallRecord | null> {
  if (!(await isRedisReady())) return null;
  try {
    const client = getRedisClient();
    const key = activeCallKey(callId);
    const raw = await client.get(key);
    if (!raw) return null;

    const record = JSON.parse(raw) as ActiveCallRecord;
    record.status = status;

    if (status === "completed") {
      await client.del(key);
    } else {
      await client.set(key, JSON.stringify(record), "EX", ACTIVE_CALL_TTL);
    }
    return record;
  } catch (err) {
    logger.warn({ err, callId }, "Redis updateActiveCall failed");
    return null;
  }
}

/** Remove an active call from Redis (call ended). No-op when Redis is not configured. */
export async function removeActiveCall(callId: string): Promise<void> {
  if (!(await isRedisReady())) return;
  try {
    const client = getRedisClient();
    await client.del(activeCallKey(callId));
  } catch (err) {
    logger.warn({ err, callId }, "Redis removeActiveCall failed");
  }
}

/** Return all active calls currently in Redis. Returns [] when Redis is not configured. */
export async function getAllActiveCalls(): Promise<ActiveCallRecord[]> {
  if (!(await isRedisReady())) return [];
  try {
    const client = getRedisClient();
    const keys: string[] = [];

    let cursor = "0";
    do {
      const [nextCursor, batch] = await client.scan(cursor, "MATCH", "active_calls:*", "COUNT", 100);
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== "0");

    if (keys.length === 0) return [];

    const values = await client.mget(...keys);
    return values
      .filter((v): v is string => v !== null)
      .map((v) => {
        try { return JSON.parse(v) as ActiveCallRecord; } catch { return null; }
      })
      .filter((v): v is ActiveCallRecord => v !== null);
  } catch (err) {
    logger.warn({ err }, "Redis getAllActiveCalls failed");
    return [];
  }
}

// ── Agent status tracking ────────────────────────────────────────────────────
// Key:   agent_status:{agent_id}
// Value: JSON blob — AgentStatusRecord

/** Set a human agent's live status in Redis. */
export async function setAgentStatus(record: AgentStatusRecord): Promise<void> {
  if (!(await isRedisReady())) return;
  try {
    const client = getRedisClient();
    await client.set(
      agentStatusKey(record.agent_id),
      JSON.stringify({ ...record, updated_at: new Date().toISOString() }),
      "EX",
      AGENT_STATUS_TTL
    );
  } catch (err) {
    logger.warn({ err, agentId: record.agent_id }, "Redis setAgentStatus failed");
  }
}

/** Get a human agent's live status from Redis. Returns null if not set. */
export async function getAgentStatus(agentId: number): Promise<AgentStatusRecord | null> {
  if (!(await isRedisReady())) return null;
  try {
    const client = getRedisClient();
    const raw = await client.get(agentStatusKey(agentId));
    if (!raw) return null;
    return JSON.parse(raw) as AgentStatusRecord;
  } catch (err) {
    logger.warn({ err, agentId }, "Redis getAgentStatus failed");
    return null;
  }
}

/** Get all agent statuses from Redis. */
export async function getAllAgentStatuses(): Promise<AgentStatusRecord[]> {
  if (!(await isRedisReady())) return [];
  try {
    const client = getRedisClient();
    const keys: string[] = [];

    let cursor = "0";
    do {
      const [nextCursor, batch] = await client.scan(cursor, "MATCH", "agent_status:*", "COUNT", 100);
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== "0");

    if (keys.length === 0) return [];

    const values = await client.mget(...keys);
    return values
      .filter((v): v is string => v !== null)
      .map((v) => {
        try { return JSON.parse(v) as AgentStatusRecord; } catch { return null; }
      })
      .filter((v): v is AgentStatusRecord => v !== null);
  } catch (err) {
    logger.warn({ err }, "Redis getAllAgentStatuses failed");
    return [];
  }
}
