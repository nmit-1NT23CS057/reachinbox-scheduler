import express, { ErrorRequestHandler } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import passport from "passport";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { env } from "./config";
import { emailRouter } from "./emails";
import { authRouter, requireAuth } from "./auth";
import { emailQueue } from "./queue";
import { prisma } from "./db";
import { redis } from "./redis";

const app = express();
const PgSessionStore = connectPgSimple(session);

app.set("trust proxy", 1);
app.use((req, res, next) => {
  const origin = req.get("origin");
  if (origin === env.FRONTEND_URL) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Idempotency-Key");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});
app.use(express.json({ limit: "2mb" }));
app.use(session({
  name: "scheduler.sid",
  store: new PgSessionStore({
    conString: env.DATABASE_URL,
    createTableIfMissing: true,
    tableName: "user_sessions"
  }),
  secret: env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: env.NODE_ENV === "production" ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));
app.use(passport.initialize());
app.use(passport.session());

app.get("/health", async (_req, res, next) => {
  try {
    await Promise.all([prisma.$queryRaw`SELECT 1`, redis.ping()]);
    res.json({ status: "ok" });
  } catch (error) {
    next(error);
  }
});
app.use("/auth", authRouter);
app.use("/api/emails", emailRouter);

app.get("/api/queue/stats", requireAuth, async (_req, res, next) => {
  try {
    res.json(await emailQueue.getJobCounts(
      "waiting", "active", "delayed", "completed", "failed", "paused"
    ));
  } catch (error) {
    next(error);
  }
});

const bullBoardAdapter = new ExpressAdapter();
bullBoardAdapter.setBasePath("/admin/queues");
createBullBoard({ queues: [new BullMQAdapter(emailQueue)], serverAdapter: bullBoardAdapter });
app.use("/admin/queues", requireAuth, bullBoardAdapter.getRouter());

app.get("/favicon.ico", (_req, res) => res.status(204).end());
app.get("/", (_req, res) => res.json({ service: "ReachInbox Email Scheduler", status: "running" }));
app.use(((error: unknown, _req, res, _next) => {
  console.error("Request failed", error);
  const message = error instanceof Error ? error.message : "Unexpected server error";
  res.status(500).json({ error: env.NODE_ENV === "production" ? "Internal server error" : message });
}) as ErrorRequestHandler);

export { app };
