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
