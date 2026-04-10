import { Queue, Worker, type Job } from "bullmq";
import { getRedisClient } from "../lib/redis.js";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";

export interface CallJobData {
  leadId: number;
  campaignId: number;
  phone: string;
  selectedVoice: string;
  selectedNumber: string;
  provider: "voip" | "telnyx" | "twilio";
  agentId: number;
  callId: number;
  attemptNumber?: number;
}

let callQueue: Queue<CallJobData> | null = null;
let callWorker: Worker<CallJobData> | null = null;

export function getCallQueue(): Queue<CallJobData> {
  if (!callQueue) {
    const connection = getRedisClient();
    callQueue = new Queue<CallJobData>(config.queue.name, {
      connection,
      defaultJobOptions: config.queue.defaultJobOptions,
    });

    callQueue.on("error", (err) => {
      logger.error({ err }, "Call queue error");
    });
  }
  return callQueue;
}

export async function enqueueCall(data: CallJobData): Promise<string> {
  if (!process.env.REDIS_HOST && !process.env.REDIS_URL) {
    logger.warn({ data }, "Redis not configured — call job logged but not queued");
    return `no-queue-${data.callId}`;
  }
  const queue = getCallQueue();
  const job = await queue.add(`call:${data.leadId}:${data.campaignId}`, data, {
    jobId: `call-${data.callId}`,
  });
  logger.info({ jobId: job.id, leadId: data.leadId, campaignId: data.campaignId }, "Call job enqueued");
  return job.id ?? "";
}

export async function pauseQueue(): Promise<void> {
  const queue = getCallQueue();
  await queue.pause();
  logger.info("Call queue paused");
}

export async function resumeQueue(): Promise<void> {
  const queue = getCallQueue();
  await queue.resume();
  logger.info("Call queue resumed");
}

export async function startCallWorker(
  processor: (job: Job<CallJobData>) => Promise<void>,
): Promise<void> {
  if (callWorker) return;

  const connection = getRedisClient().duplicate();
  callWorker = new Worker<CallJobData>(
    config.queue.name,
    async (job) => {
      logger.info({ jobId: job.id, data: job.data }, "Processing call job");
      await processor(job);
    },
    {
      connection,
      concurrency: 10,
    },
  );

  callWorker.on("completed", (job) => {
    logger.info({ jobId: job.id }, "Call job completed");
  });

  callWorker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "Call job failed");
  });

  callWorker.on("error", (err) => {
    logger.error({ err }, "Call worker error");
  });
}

export async function closeQueue(): Promise<void> {
  if (callWorker) {
    await callWorker.close();
    callWorker = null;
  }
  if (callQueue) {
    await callQueue.close();
    callQueue = null;
  }
}
