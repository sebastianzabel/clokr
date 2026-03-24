import fp from "fastify-plugin";
import { PrismaClient } from "@clokr/db";

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

export const prismaPlugin = fp(async (app) => {
  const prisma = new PrismaClient({
    log: app.log.level === "debug" ? ["query", "error", "warn"] : ["error"],
  });

  await prisma.$connect();

  app.decorate("prisma", prisma);

  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });
});
