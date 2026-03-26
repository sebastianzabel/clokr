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

  // GET /allowed-cards — list all NFC card IDs for the tenant (Terminal API Key auth)
  app.get("/allowed-cards", {
    schema: { tags: ["Terminals"] },
    handler: async (req, reply) => {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith("Bearer ")) {
        return reply.code(401).send({ error: "Terminal API Key erforderlich" });
      }
      const rawKey = authHeader.slice(7);
      const keyHash = hashKey(rawKey);

      const apiKey = await app.prisma.terminalApiKey.findUnique({
        where: { keyHash },
      });
      if (!apiKey || apiKey.revokedAt) {
        return reply.code(401).send({ error: "Ungültiger oder widerrufener API Key" });
      }

      const tenantId = apiKey.tenantId;

      // Update lastUsedAt (fire and forget)
      app.prisma.terminalApiKey
        .update({
          where: { id: apiKey.id },
          data: { lastUsedAt: new Date() },
        })
        .catch(() => {});

      const employees = await app.prisma.employee.findMany({
        where: { tenantId, nfcCardId: { not: null } },
        select: { nfcCardId: true },
      });

      const cards = employees.map((e) => e.nfcCardId).filter((id): id is string => id !== null);

      return { cards };
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
