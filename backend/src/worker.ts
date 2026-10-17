import { DelayedError, Job, UnrecoverableError, Worker } from "bullmq";
import Redis from "ioredis";
import nodemailer, { Transporter } from "nodemailer";
import { decryptSlackCredentials } from "./auth";
import { env } from "./config";
import { prisma } from "./db";
import { EMAIL_QUEUE, emailQueue } from "./queue";
import { redis } from "./redis";

type EmailJob = { emailId: string };
type RateDecision = { status: number; dueAt: number; notify: number; windowStart: number };

const rateSlotScript = `
local now = tonumber(ARGV[1])
local interval = tonumber(ARGV[2])
local senderLimit = tonumber(ARGV[3])
local batchLimit = tonumber(ARGV[4])
local hour = 3600000
local reservation = redis.call('GET', KEYS[3])
if reservation then
  local reservedAt = tonumber(reservation)
  if reservedAt > now then
    return {0, reservedAt, 0, math.floor(reservedAt / hour) * hour}
  end
  return {1, reservedAt, 0, math.floor(reservedAt / hour) * hour}
end

local last = tonumber(redis.call('GET', KEYS[2]) or '0')
local candidate = math.max(now, last + interval)
local windowStart = math.floor(candidate / hour) * hour
local countKey = string.gsub(KEYS[1], 'WINDOW', tostring(windowStart))
local count = tonumber(redis.call('GET', countKey) or '0')
local batchCountKey = string.gsub(KEYS[5], 'WINDOW', tostring(windowStart))
local batchCount = tonumber(redis.call('GET', batchCountKey) or '0')
if count >= senderLimit or batchCount >= batchLimit then
  local notifyKey = string.gsub(KEYS[4], 'WINDOW', tostring(windowStart))
  local notify = redis.call('SET', notifyKey, '1', 'PX', 7200000, 'NX') and 1 or 0
  candidate = math.max(windowStart + hour, last + interval)
  windowStart = math.floor(candidate / hour) * hour
  countKey = string.gsub(KEYS[1], 'WINDOW', tostring(windowStart))
  count = tonumber(redis.call('GET', countKey) or '0')
  batchCountKey = string.gsub(KEYS[5], 'WINDOW', tostring(windowStart))
  batchCount = tonumber(redis.call('GET', batchCountKey) or '0')
  while count >= senderLimit or batchCount >= batchLimit do
    candidate = math.max(windowStart + hour, last + interval)
    windowStart = math.floor(candidate / hour) * hour
    countKey = string.gsub(KEYS[1], 'WINDOW', tostring(windowStart))
    count = tonumber(redis.call('GET', countKey) or '0')
    batchCountKey = string.gsub(KEYS[5], 'WINDOW', tostring(windowStart))
    batchCount = tonumber(redis.call('GET', batchCountKey) or '0')
  end
  redis.call('SET', KEYS[3], tostring(candidate), 'PX', 172800000)
  redis.call('SET', KEYS[2], tostring(candidate), 'PX', 172800000)
  redis.call('INCR', countKey)
  redis.call('INCR', batchCountKey)
  redis.call('PEXPIRE', countKey, 172800000)
  redis.call('PEXPIRE', batchCountKey, 172800000)
  return {0, candidate, notify, windowStart}
end

redis.call('SET', KEYS[2], tostring(candidate), 'PX', 172800000)
redis.call('INCR', countKey)
redis.call('INCR', batchCountKey)
redis.call('PEXPIRE', countKey, 172800000)
redis.call('PEXPIRE', batchCountKey, 172800000)
redis.call('SET', KEYS[3], tostring(candidate), 'PX', 172800000)
return {1, candidate, 0, windowStart}
`;

let transporter: Transporter;
let recoveryTimer: NodeJS.Timeout | undefined;
let recoveryRunning = false;

function isSafelyRetryableSmtpFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const failure = error as Error & {
    code?: string;
    command?: string;
    responseCode?: number;
    accepted?: string[];
  };
  if (failure.accepted?.length || failure.command === "DATA") return false;
  if (failure.responseCode !== undefined) {
    return failure.responseCode >= 400 && failure.responseCode < 500;
  }
  return ["CONN", "EHLO", "STARTTLS", "AUTH", "MAIL FROM", "RCPT TO"].includes(failure.command ?? "");
}

async function createTransporter(): Promise<Transporter> {
  if (env.EMAIL_TRANSPORT === "gmail") {
    console.info("Using Gmail SMTP transport", { account: env.SMTP_USER });
    return nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      auth: { user: env.SMTP_USER!, pass: env.SMTP_PASS! }
    });
  }
  if (env.ETHEREAL_USER && env.ETHEREAL_PASS) {
    return nodemailer.createTransport({
      host: "smtp.ethereal.email",
      port: 587,
      secure: false,
      auth: { user: env.ETHEREAL_USER, pass: env.ETHEREAL_PASS }
    });
  }
  const account = await nodemailer.createTestAccount();
  console.info("Using generated Ethereal account", { user: account.user });
  return nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth: { user: account.user, pass: account.pass }
  });
}

async function notifyRateLimit(userId: string, senderEmail: string, hourStart: number): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { slackWebhookEncrypted: true }
    });
    if (!user?.slackWebhookEncrypted) return;
    const { webhookUrl } = decryptSlackCredentials(user.slackWebhookEncrypted);
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: `Email rate limit reached for sender ${senderEmail} at ${new Date(hourStart).toISOString()}. Remaining emails have been deferred to the next available hourly window.`
      })
    });
    if (!response.ok) throw new Error(`Slack webhook returned HTTP ${response.status}`);
    console.info("Slack rate-limit notification sent", { userId, senderEmail, hourStart });
  } catch (error) {
    console.error("Unable to deliver Slack rate-limit notification", { userId, senderEmail, error });
  }
}

async function reserveSendSlot(email: {
  id: string;
  userId: string;
  batchId: string;
  senderEmail: string;
  delayBetweenMs: number;
  hourlyLimit: number;
}): Promise<RateDecision> {
  const senderKey = `${email.userId}:${email.senderEmail.toLowerCase()}`;
  const bucketKey = `email-rate:${senderKey}:WINDOW`;
  const batchBucketKey = `email-batch-rate:${email.batchId}:WINDOW`;
  const lastKey = `email-delay:${senderKey}`;
  const reservationKey = `email-reservation:${email.id}`;
  const notifyKey = `email-notified:${senderKey}:WINDOW`;
  const result = await redis.eval(
    rateSlotScript,
    5,
    bucketKey,
    lastKey,
    reservationKey,
    notifyKey,
    batchBucketKey,
    String(Date.now()),
    String(Math.max(env.MIN_SEND_INTERVAL_MS, email.delayBetweenMs)),
    String(env.MAX_EMAILS_PER_HOUR_PER_SENDER),
    String(email.hourlyLimit)
  ) as [number, number, number, number];
  return {
    status: result[0]!,
    dueAt: result[1]!,
    notify: result[2]!,
    windowStart: result[3]!
  };
}

async function deliver(job: Job<EmailJob>, token?: string): Promise<void> {
  const email = await prisma.email.findUnique({ where: { id: job.data.emailId } });
  if (!email) {
    console.error("Queue job references a missing email", { emailId: job.data.emailId });
    return;
  }
  if (email.status === "SENT" || email.status === "FAILED") return;

  const slot = await reserveSendSlot(email);
  if (slot.notify) {
    await notifyRateLimit(email.userId, email.senderEmail, slot.windowStart);
  }
  if (slot.status === 0) {
    await job.moveToDelayed(slot.dueAt, token);
    throw new DelayedError();
  }

  const claim = await prisma.email.updateMany({
    where: { id: email.id, status: "SCHEDULED" },
    data: { status: "PROCESSING" }
  });
  if (claim.count === 0) {
    const current = await prisma.email.findUnique({ where: { id: email.id } });
    if (current?.status === "PROCESSING") {
      const failed = await prisma.email.update({
        where: { id: email.id },
        data: {
          status: "FAILED",
          failureReason: "Previous SMTP attempt ended without a recorded result; not retried to avoid duplicate delivery."
        }
      });
      console.error("Marked ambiguous SMTP delivery as failed to prevent duplicate send", { emailId: email.id });
    }
    await redis.del(`email-reservation:${email.id}`);
    return;
  }

  try {
    let result;
    try {
      result = await transporter.sendMail({
        from: email.senderEmail,
        to: email.recipientEmail,
        subject: email.subject,
        text: email.body,
        messageId: `<${email.id}@reachinbox-scheduler.local>`
      });
    } catch (error) {
      const retryable = isSafelyRetryableSmtpFailure(error);
      const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      const updated = await prisma.email.update({
        where: { id: email.id },
        data: {
          status: retryable && !isLastAttempt ? "SCHEDULED" : "FAILED",
          failureReason: retryable
            ? (error instanceof Error ? error.message : String(error))
            : `SMTP outcome was not safely retryable; not retried to avoid duplicate delivery. ${error instanceof Error ? error.message : String(error)}`
        }
      });
      if (retryable && !isLastAttempt) throw error;
      throw new UnrecoverableError(error instanceof Error ? error.message : String(error));
    }

    const sent = await prisma.email.update({
      where: { id: email.id },
      data: { status: "SENT", sentAt: new Date(), failureReason: null }
    });
    console.info("Email sent", {
      emailId: email.id,
      recipient: email.recipientEmail,
      subject: email.subject,
      transport: env.EMAIL_TRANSPORT,
      previewUrl: env.EMAIL_TRANSPORT === "ethereal"
        ? nodemailer.getTestMessageUrl(result)
        : undefined
    });
  } finally {
    await redis.del(`email-reservation:${email.id}`);
  }
}

export async function startWorker(): Promise<Worker<EmailJob>> {
  transporter = await createTransporter();
  const worker = new Worker<EmailJob>(EMAIL_QUEUE, deliver, {
    connection: new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }),
    concurrency: env.WORKER_CONCURRENCY
  });
  worker.on("failed", (job, error) => {
    console.error("Email queue job failed", { emailId: job?.data.emailId, error });
  });
  worker.on("error", (error) => console.error("Email worker error", error));

  const recoveredJobs = await recoverUnpublishedJobs();
  recoveryTimer = setInterval(() => {
    if (recoveryRunning) return;
    recoveryRunning = true;
    void recoverUnpublishedJobs()
      .catch((error) => console.error("Scheduled-email recovery failed", error))
      .finally(() => { recoveryRunning = false; });
  }, 15_000);
  recoveryTimer.unref();
  console.info("Email worker started", {
    concurrency: env.WORKER_CONCURRENCY,
    recoveredJobs
  });
  return worker;
}

async function recoverUnpublishedJobs(): Promise<number> {
  const pending = await prisma.email.findMany({
    where: { status: "SCHEDULED", queuePublishedAt: null },
    select: { id: true, scheduledAt: true }
  });
  if (!pending.length) return 0;
  await emailQueue.addBulk(pending.map((email) => ({
    name: "deliver-email",
    data: { emailId: email.id },
    opts: {
      jobId: email.id,
      delay: Math.max(0, email.scheduledAt.getTime() - Date.now())
    }
  })));
  await prisma.email.updateMany({
    where: { id: { in: pending.map((email) => email.id) }, queuePublishedAt: null },
    data: { queuePublishedAt: new Date() }
  });
  return pending.length;
}

export function stopWorkerRecovery(): void {
  if (recoveryTimer) clearInterval(recoveryTimer);
}
