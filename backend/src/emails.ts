import { randomUUID } from "node:crypto";
import { EmailStatus, Prisma } from "@prisma/client";
import { Request, Response, Router } from "express";
import { z } from "zod";
import { requireAuth } from "./auth";
import { env } from "./config";
import { prisma } from "./db";
import { emailQueue } from "./queue";

export const emailRouter = Router();

const scheduleSchema = z.object({
  recipients: z.array(z.string().email().transform((email) => email.trim().toLowerCase()))
    .min(1).max(5000).transform((emails) => [...new Set(emails)]),
  senderEmail: z.string().email().transform((email) => email.trim().toLowerCase()),
  subject: z.string().trim().min(1).max(998),
  body: z.string().min(1).max(100_000),
  startAt: z.string().datetime({ offset: true }),
  delayBetweenMs: z.number().int().min(0).max(3_600_000),
  hourlyLimit: z.number().int().min(1).max(10_000)
});

emailRouter.post("/", requireAuth, async (req, res, next) => {
  try {
    const parsed = scheduleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid schedule request", details: parsed.error.flatten() });
      return;
    }
    const input = parsed.data;
    if (
      env.EMAIL_TRANSPORT === "gmail" &&
      input.senderEmail !== env.SMTP_USER?.toLowerCase()
    ) {
      res.status(400).json({
        error: `When Gmail SMTP is enabled, senderEmail must match the authenticated Gmail address (${env.SMTP_USER}).`
      });
      return;
    }
    const startAt = new Date(input.startAt);
    if (startAt.getTime() < Date.now() - 60_000) {
      res.status(400).json({ error: "Start time must not be more than one minute in the past" });
      return;
    }
    const requestKey = req.get("Idempotency-Key")?.trim() || randomUUID();
    if (requestKey.length > 200) {
      res.status(400).json({ error: "Idempotency-Key must be 200 characters or fewer" });
      return;
    }
    const batchId = `${req.user!.id}:${requestKey}`;
    const idempotencyKeys = input.recipients.map((_, index) => `${batchId}:${index}`);
    const recipientIndexByKey = new Map(idempotencyKeys.map((key, index) => [key, index]));
    const existing = await prisma.email.findMany({
      where: { batchId }
    });
    const matchesRequest = (email: typeof existing[number]) => {
      const recipientIndex = recipientIndexByKey.get(email.idempotencyKey);
      if (recipientIndex === undefined) return false;
      return email.recipientEmail === input.recipients[recipientIndex] &&
        email.senderEmail === input.senderEmail &&
        email.subject === input.subject &&
        email.body === input.body &&
        email.batchId === batchId &&
        email.scheduledAt.getTime() === startAt.getTime() + recipientIndex * input.delayBetweenMs &&
        email.delayBetweenMs === input.delayBetweenMs &&
        email.hourlyLimit === input.hourlyLimit;
    };
    if ((existing.length > 0 && existing.length !== input.recipients.length) ||
        existing.some((email) => !matchesRequest(email))) {
      res.status(409).json({ error: "Idempotency-Key was already used for a different request" });
      return;
    }

    if (!existing.length) {
      const rows: Prisma.EmailCreateManyInput[] = input.recipients.map((recipientEmail, index) => {
        const idempotencyKey = idempotencyKeys[index]!;
        return {
          userId: req.user!.id,
          batchId,
          idempotencyKey,
          recipientEmail,
          senderEmail: input.senderEmail,
          subject: input.subject,
          body: input.body,
          scheduledAt: new Date(startAt.getTime() + index * input.delayBetweenMs),
          delayBetweenMs: input.delayBetweenMs,
          hourlyLimit: input.hourlyLimit
        };
      });
      await prisma.email.createMany({ data: rows, skipDuplicates: true });
    }

    const emails = await prisma.email.findMany({
      where: { idempotencyKey: { in: idempotencyKeys } }
    });
    if (emails.length !== input.recipients.length || emails.some((email) => !matchesRequest(email))) {
      res.status(409).json({ error: "Idempotency-Key was concurrently used for a different request" });
      return;
    }
    emails.sort((left, right) =>
      recipientIndexByKey.get(left.idempotencyKey)! - recipientIndexByKey.get(right.idempotencyKey)!
    );
    try {
      await emailQueue.addBulk(emails.map((email) => ({
        name: "deliver-email",
        data: { emailId: email.id },
        opts: {
          jobId: email.id,
          delay: Math.max(0, email.scheduledAt.getTime() - Date.now())
        }
      })));
    } catch (error) {
      res.status(503).json({
        error: "Emails were saved, but queue publication failed; the worker recovery loop will retry",
        batchId,
        details: error instanceof Error ? error.message : String(error)
      });
      return;
    }
    await prisma.email.updateMany({
      where: { id: { in: emails.map((email) => email.id) }, queuePublishedAt: null },
      data: { queuePublishedAt: new Date() }
    });
    res.status(202).json({ batchId, count: emails.length, emails });
  } catch (error) {
    next(error);
  }
});

emailRouter.get("/", requireAuth, async (req: Request, res: Response, next) => {
  try {
    const view = req.query.view === "sent" || req.query.view === "scheduled"
      ? req.query.view
      : "all";
    const statusFilter: EmailStatus[] = view === "sent"
      ? [EmailStatus.SENT, EmailStatus.FAILED]
      : view === "scheduled"
        ? [EmailStatus.SCHEDULED, EmailStatus.PROCESSING]
        : [EmailStatus.SCHEDULED, EmailStatus.PROCESSING, EmailStatus.SENT, EmailStatus.FAILED];
    const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(String(req.query.pageSize ?? "50"), 10) || 50));
    const where: Prisma.EmailWhereInput = {
      userId: req.user!.id,
      status: { in: statusFilter }
    };
    if (query) {
      where.OR = [
        { recipientEmail: { contains: query, mode: "insensitive" } },
        { senderEmail: { contains: query, mode: "insensitive" } },
        { subject: { contains: query, mode: "insensitive" } },
        { body: { contains: query, mode: "insensitive" } }
      ];
    }
    const [emails, total] = await prisma.$transaction([
      prisma.email.findMany({
        where,
        orderBy: view === "sent"
          ? [{ sentAt: "desc" }, { createdAt: "desc" }]
          : view === "scheduled"
            ? [{ scheduledAt: "asc" }]
            : [{ updatedAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize
      }),
      prisma.email.count({ where })
    ]);
    res.json({ emails, total, page, pageSize });
  } catch (error) {
    next(error);
  }
});
