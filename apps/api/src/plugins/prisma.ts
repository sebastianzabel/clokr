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
  const adapter = new PrismaPg(pool as any);

  const prisma = new PrismaClient({
    adapter,
    log: app.log.level === "debug" ? ["query", "error", "warn"] : ["error"],
  });

  await prisma.$connect();

  app.decorate("prisma", prisma);

  app.addHook("onClose", async () => {
    await prisma.$disconnect();
    await pool.end();
  });
});
