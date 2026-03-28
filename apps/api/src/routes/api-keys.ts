import { FastifyInstance } from "fastify";
import { z } from "zod";
import crypto, { createHash } from "crypto";
import { requireRole } from "../middleware/auth";

const VALID_SCOPES = [
  "read:employees",
  "write:employees",
  "read:time-entries",
  "write:time-entries",
  "read:leave",
  "write:leave",
  "read:reports",
  "read:overtime",
  "admin",
] as const;

const createKeySchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.enum(VALID_SCOPES)).min(1),
  expiresAt: z.string().datetime().nullable().optional(),
});

export async function apiKeyRoutes(app: FastifyInstance) {
  // GET /api/v1/api-keys — list all keys for tenant
  app.get("/", {
    schema: { tags: ["API Keys"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req) => {
      const keys = await app.prisma.apiKey.findMany({
        where: { tenantId: req.user.tenantId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          keyPrefix: true,
          scopes: true,
          expiresAt: true,
          lastUsedAt: true,
          revokedAt: true,
          createdBy: true,
          createdAt: true,
        },
      });
      return keys;
    },
  });

  // POST /api/v1/api-keys — create a new API key
  app.post("/", {
    schema: { tags: ["API Keys"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req) => {
      const body = createKeySchema.parse(req.body);
      const tenantId = req.user.tenantId;

      // Generate key: clk_ prefix + 40 random hex chars
      const rawKey = `clk_${crypto.randomBytes(20).toString("hex")}`;
      const keyHash = createHash("sha256").update(rawKey).digest("hex");
      const keyPrefix = rawKey.slice(0, 12); // "clk_abcd1234"

      const apiKey = await app.prisma.apiKey.create({
        data: {
          tenantId,
          name: body.name,
          keyHash,
          keyPrefix,
          scopes: body.scopes,
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
          createdBy: req.user.sub,
        },
      });

      await app.audit({
        userId: req.user.sub,
        action: "CREATE",
        entity: "ApiKey",
        entityId: apiKey.id,
        newValue: { name: body.name, scopes: body.scopes, keyPrefix },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      // Return raw key ONCE — it cannot be retrieved later
      return { ...apiKey, rawKey };
    },
  });

  // DELETE /api/v1/api-keys/:id — revoke a key
  app.delete("/:id", {
    schema: { tags: ["API Keys"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };

      const key = await app.prisma.apiKey.findUnique({ where: { id } });
      if (!key || key.tenantId !== req.user.tenantId) {
        return reply.code(404).send({ error: "API Key nicht gefunden" });
      }

      await app.prisma.apiKey.update({
        where: { id },
        data: { revokedAt: new Date() },
      });

      await app.audit({
        userId: req.user.sub,
        action: "DELETE",
        entity: "ApiKey",
        entityId: id,
        oldValue: { name: key.name, keyPrefix: key.keyPrefix },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return { success: true };
    },
  });

  // GET /api/v1/api-keys/scopes — list available scopes
  app.get("/scopes", {
    schema: { tags: ["API Keys"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async () => {
      return VALID_SCOPES.map((s) => ({ scope: s, description: scopeDescription(s) }));
    },
  });
}

function scopeDescription(scope: string): string {
  const map: Record<string, string> = {
    "read:employees": "Mitarbeiterdaten lesen",
    "write:employees": "Mitarbeiterdaten bearbeiten",
    "read:time-entries": "Zeiteinträge lesen",
    "write:time-entries": "Zeiteinträge erstellen/bearbeiten",
    "read:leave": "Abwesenheiten lesen",
    "write:leave": "Abwesenheiten erstellen",
    "read:reports": "Berichte/Exporte lesen",
    "read:overtime": "Überstundenkonto lesen",
    admin: "Voller Zugriff (alle Berechtigungen)",
  };
  return map[scope] ?? scope;
}
