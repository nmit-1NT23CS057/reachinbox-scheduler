import { Queue } from "bullmq";
import Redis from "ioredis";
import { env } from "./config";

export const EMAIL_QUEUE = "scheduled-email-delivery";
export const queueConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
export const emailQueue = new Queue(EMAIL_QUEUE, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: env.EMAIL_JOB_MAX_ATTEMPTS,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { age: 60 * 60 * 24 * 14, count: 10000 },
    removeOnFail: { age: 60 * 60 * 24 * 30 }
  }
});
