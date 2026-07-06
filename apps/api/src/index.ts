import { buildApp } from "./app";
import { config } from "./config";

async function main() {
  const app = await buildApp();

  try {
    await app.listen({ port: config.API_PORT, host: config.API_HOST });
    app.log.info(`API läuft auf http://${config.API_HOST}:${config.API_PORT}`);
    app.log.info(`Swagger UI: http://${config.API_HOST}:${config.API_PORT}/docs`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // OPS-V1814-02 (F-H6): graceful shutdown. Without this, SIGTERM (docker/k8s)
  // kills the process without firing Fastify onClose hooks — cron tasks are not
  // stopped, the Prisma pool is not drained, and an in-flight request can be
  // dropped between its mutation and its app.audit() call. No new dependency.
  let closing = false;
  const gracefulShutdown = async () => {
    if (closing) return; // idempotent — ignore a second signal while closing
    closing = true;
    app.log.info("Graceful shutdown: signal received, closing");
    const timer = setTimeout(() => {
      app.log.error("Graceful shutdown: timed out after 10s, forcing exit(1)");
      process.exit(1);
    }, 10_000).unref();
    try {
      await app.close(); // fires onClose hooks: cron task.stop(), prisma.$disconnect(), pool.end()
      clearTimeout(timer);
      app.log.info("Graceful shutdown: complete");
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "Graceful shutdown: close failed");
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void gracefulShutdown());
  process.on("SIGINT", () => void gracefulShutdown());
}

void main();
