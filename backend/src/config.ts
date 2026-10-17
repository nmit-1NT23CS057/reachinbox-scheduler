import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  FRONTEND_URL: z.string().url().default("http://localhost:5173"),
  API_URL: z.string().url().default("http://localhost:4000"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  SESSION_SECRET: z.string().min(24),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CALLBACK_URL: z.string().url(),
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  SLACK_CALLBACK_URL: z.string().url(),
  SLACK_TOKEN_ENCRYPTION_KEY: z.string().optional(),
  EMAIL_TRANSPORT: z.enum(["ethereal", "gmail"]).default("ethereal"),
  SMTP_USER: z.preprocess(
    (value) => typeof value === "string" && !value.trim() ? undefined : value,
    z.string().email().optional()
  ),
  SMTP_PASS: z.preprocess(
    (value) => typeof value === "string" && !value.trim() ? undefined : value,
    z.string().optional()
  ),
  ETHEREAL_USER: z.string().optional(),
  ETHEREAL_PASS: z.string().optional(),
  MAX_EMAILS_PER_HOUR_PER_SENDER: z.coerce.number().int().positive().default(200),
  MIN_SEND_INTERVAL_MS: z.coerce.number().int().nonnegative().default(2000),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(10),
  EMAIL_JOB_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5)
}).superRefine((value, context) => {
  if (Boolean(value.GOOGLE_CLIENT_ID) !== Boolean(value.GOOGLE_CLIENT_SECRET)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["GOOGLE_CLIENT_SECRET"],
      message: "Set both Google OAuth credentials or leave both unset"
    });
  }
  if (Boolean(value.SLACK_CLIENT_ID) !== Boolean(value.SLACK_CLIENT_SECRET)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["SLACK_CLIENT_SECRET"],
      message: "Set both Slack OAuth credentials or leave both unset"
    });
  }
  if (value.SLACK_CLIENT_ID && value.SLACK_CLIENT_SECRET &&
      !/^[a-f0-9]{64}$/i.test(value.SLACK_TOKEN_ENCRYPTION_KEY ?? "")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["SLACK_TOKEN_ENCRYPTION_KEY"],
      message: "Set a 64-character hex key when Slack OAuth is enabled"
    });
  }
  if (value.EMAIL_TRANSPORT === "gmail" && (!value.SMTP_USER || !value.SMTP_PASS)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["SMTP_USER"],
      message: "Set SMTP_USER and SMTP_PASS when EMAIL_TRANSPORT=gmail"
    });
  }
});

export const env = envSchema.parse(process.env);
