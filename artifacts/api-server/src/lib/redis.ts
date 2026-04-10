import Redis from "ioredis";
import { config } from "../config/index.js";
import { logger } from "./logger.js";

let redisClient: Redis | null = null;

export function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
    });

    redisClient.on("error", (err) => {
      logger.error({ err }, "Redis connection error");
    });

    redisClient.on("connect", () => {
      logger.info("Redis connected");
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

// ── Active call tracking ────────────────────────────────────────────────────
// Key format: active_calls:<call_id>
// Value: JSON blob with call details
// TTL: 2 hours (safety net — worker should remove on completion)

const ACTIVE_CALL_TTL = 7200; // seconds

export interface ActiveCallRecord {
  call_id: string;
  phone_number: string;
  campaign_id: number;
  campaign_name?: string;
  status: "ringing" | "in-call" | "completed";
  started_at: string;
}

function activeCallKey(callId: string): string {
  return `active_calls:${callId}`;
}

/** Returns true when Redis is reachable */
async function isRedisReady(): Promise<boolean> {
  if (!process.env.REDIS_HOST && !process.env.REDIS_URL) return false;
  try {
    const client = getRedisClient();
    await client.ping();
    return true;
  } catch {
    return false;
  }
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

    // Use SCAN instead of KEYS to avoid blocking on large keyspaces
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
        try {
          return JSON.parse(v) as ActiveCallRecord;
        } catch {
          return null;
        }
      })
      .filter((v): v is ActiveCallRecord => v !== null);
  } catch (err) {
    logger.warn({ err }, "Redis getAllActiveCalls failed");
    return [];
  }
}
