import { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash, randomBytes } from "crypto";
import { requireRole } from "../middleware/auth";

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export async function terminalRoutes(app: FastifyInstance) {
  // GET / — list terminal keys for tenant (ADMIN only)
  app.get("/", {
    schema: { tags: ["Terminals"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req) => {
      const keys = await app.prisma.terminalApiKey.findMany({
        where: { tenantId: req.user.tenantId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          keyPrefix: true,
          lastUsedAt: true,
          revokedAt: true,
          createdAt: true,
        },
      });
      return { keys };
    },
  });

  // POST / — create new terminal key (ADMIN only)
  app.post("/", {
    schema: { tags: ["Terminals"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req) => {
      const body = z.object({ name: z.string().min(1).max(100) }).parse(req.body);
      const rawKey = `clk_${randomBytes(32).toString("hex")}`;
      const keyHash = hashKey(rawKey);
      const keyPrefix = rawKey.substring(0, 12) + "...";

      const key = await app.prisma.terminalApiKey.create({
        data: {
          tenantId: req.user.tenantId,
          name: body.name,
          keyHash,
          keyPrefix,
        },
      });

      // Audit log
      await app.prisma.auditLog.create({
        data: {
          userId: req.user.sub,
          action: "CREATE",
          entity: "TerminalApiKey",
          entityId: key.id,
          newValue: { name: body.name, keyPrefix },
          ipAddress: req.ip,
        },
      });

      return { id: key.id, name: key.name, keyPrefix, rawKey, createdAt: key.createdAt };
    },
  });

  // DELETE /:id — revoke terminal key (ADMIN only)
  app.delete("/:id", {
    schema: { tags: ["Terminals"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

      const key = await app.prisma.terminalApiKey.findFirst({
        where: { id, tenantId: req.user.tenantId },
      });
      if (!key) return reply.code(404).send({ error: "Schlüssel nicht gefunden" });

      await app.prisma.terminalApiKey.update({
        where: { id },
        data: { revokedAt: new Date() },
      });

      await app.prisma.auditLog.create({
        data: {
          userId: req.user.sub,
          action: "REVOKE",
          entity: "TerminalApiKey",
          entityId: id,
          ipAddress: req.ip,
        },
      });

      return { success: true };
    },
  });
}
