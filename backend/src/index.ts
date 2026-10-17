import { app } from "./app";
import { env } from "./config";
import { prisma } from "./db";
import { emailQueue, queueConnection } from "./queue";
import { redis } from "./redis";
import { startWorker, stopWorkerRecovery } from "./worker";

async function main(): Promise<void> {
  const roleArg = process.argv.find((arg) => arg.startsWith("--role="));
  const role = roleArg?.split("=")[1] ?? "api";
  if (role !== "api" && role !== "worker") {
    throw new Error(`Unsupported process role: ${role}`);
  }
  await prisma.$connect();
  if (role === "worker") {
    const worker = await startWorker();
    const shutdown = async () => {
      stopWorkerRecovery();
      await worker.close();
      await emailQueue.close();
      await Promise.all([queueConnection.quit(), redis.quit()]);
      await prisma.$disconnect();
      process.exit(0);
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
    return;
  }

  const server = app.listen(env.PORT, () => {
    console.info(`API listening at ${env.API_URL}`);
  });
  const shutdown = async () => {
    server.close();
    await emailQueue.close();
    await Promise.all([queueConnection.quit(), redis.quit()]);
    await prisma.$disconnect();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  console.error("Service startup failed", error);
  process.exitCode = 1;
});
