import fp from "fastify-plugin";
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

export const prismaPlugin = fp(async (app) => {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    min: parseInt(process.env.POOL_MIN || "2"),
    max: parseInt(process.env.POOL_MAX || "20"),
  });
  const adapter = new PrismaPg(pool);

  const prisma = new PrismaClient({
    adapter,
    // Issue #799: `Break.isAuto` is an internal marker for the clock replacement. Omitted by default
    // so no `include: { breaks }` response grows a field; queries filter on it in `where` freely.
    omit: { break: { isAuto: true } },
    log: app.log.level === "debug" ? ["query", "error", "warn"] : ["error"],
  });

  await prisma.$connect();

  app.decorate("prisma", prisma as unknown as PrismaClient);

  app.addHook("onClose", async () => {
    await prisma.$disconnect();
    await pool.end();
  });
});
