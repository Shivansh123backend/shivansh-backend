export const config = {
  jwt: {
    secret: process.env.SESSION_SECRET ?? "change-me-in-production",
    expiresIn: "24h",
  },
  redis: {
    host: process.env.REDIS_HOST ?? "localhost",
    port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
    password: process.env.REDIS_PASSWORD,
  },
  maxAgents: 25,
  queue: {
    name: "calls",
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential" as const,
        delay: 5000,
      },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  },
};
