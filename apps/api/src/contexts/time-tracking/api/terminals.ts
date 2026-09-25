import { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash, randomBytes } from "crypto";
import { requirePermission } from "../../platform";

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export async function terminalRoutes(app: FastifyInstance) {
  // GET / — list terminal keys for tenant (ADMIN only)
  app.get("/", {
    schema: { tags: ["Terminals"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("terminal:manage:ZUGEWIESEN"),
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
    preHandler: requirePermission("terminal:manage:ZUGEWIESEN"),
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

      // Audit log — routed through app.audit() (Issue #333): a direct auditLog.create would
      // write an API-key caller's `apikey:<id>` subject straight into AuditLog.userId, a
      // foreign key onto User.
      await app.audit({
        userId: req.user.sub,
        action: "CREATE",
        entity: "TerminalApiKey",
        entityId: key.id,
        newValue: { name: body.name, keyPrefix },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return { id: key.id, name: key.name, keyPrefix, rawKey, createdAt: key.createdAt };
    },
  });

  // GET /allowed-cards — list all NFC card IDs for the tenant (Terminal API Key auth)
  app.get("/allowed-cards", {
    schema: {
      tags: ["Terminals"],
      summary: "List registered NFC card IDs for the tenant",
      description:
        "Requires Terminal API Key (Bearer token). Returns all NFC card IDs registered to employees in the tenant. Used by NFC clients for local allowlist caching.",
      response: {
        200: {
          type: "object",
          properties: {
            cards: { type: "array", items: { type: "string" } },
          },
        },
        401: {
          type: "object",
          properties: { error: { type: "string" } },
        },
      },
    },
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
        .catch((err) => app.log.error({ err }, "Failed to update terminal API key lastUsedAt"));

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
    preHandler: requirePermission("terminal:manage:ZUGEWIESEN"),
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

      // Issue #333: routed through app.audit() — see the POST / handler's comment above.
      await app.audit({
        userId: req.user.sub,
        action: "REVOKE",
        entity: "TerminalApiKey",
        entityId: id,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return { success: true };
    },
  });
}
