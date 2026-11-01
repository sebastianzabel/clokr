import { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash, randomBytes } from "crypto";
import { assertModuleBooked, requirePermission } from "../../platform";
import { validateTerminalSalon } from "../terminal-salon";

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

// Issue #541 (D-04): the list item carries the bound salon flattened to `salonName` / `salonActive`
// (both null when unbound), never a nested `salon` object.
const TERMINAL_LIST_SELECT = {
  id: true,
  name: true,
  keyPrefix: true,
  lastUsedAt: true,
  revokedAt: true,
  createdAt: true,
  salonId: true,
  salon: { select: { name: true, isActive: true } },
} as const;

function toTerminalListItem<T extends { salon: { name: string; isActive: boolean } | null }>(
  row: T,
) {
  const { salon, ...rest } = row;
  return { ...rest, salonName: salon?.name ?? null, salonActive: salon?.isActive ?? null };
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
      // D-05: setting up a NEW terminal needs the module; existing keys, revoke and punching stay free (Issue #566).
      await assertModuleBooked(app.prisma, req.user.tenantId, "HARDWARE_CLOCK");
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
        403: {
          type: "object",
          properties: { error: { type: "string" }, code: { type: "string" } },
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

      // Phase 88 (D-05): the device key stays valid for reactivation, but a deactivated tenant gets nothing.
      if (!(await app.tenantIsActive(tenantId))) {
        return reply.code(403).send(app.tenantDeactivatedError);
      }

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

  // PATCH /:id — bind, change or remove the salon of a terminal key (Issue #541, D-03).
  // Deliberately NOT module-gated: changing an existing setup is not setting up something new
  // (#566 "never retroactive"); only creating a key needs the module.
  app.patch("/:id", {
    schema: {
      tags: ["Terminals"],
      summary: "Bind, change or remove the salon of a terminal key",
      security: [{ bearerAuth: [] }],
    },
    preHandler: requirePermission("terminal:manage:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z.object({ salonId: z.string().uuid().nullable() }).strict().parse(req.body);
      const tenantId = req.user.tenantId;

      const key = await app.prisma.terminalApiKey.findFirst({ where: { id, tenantId } });
      if (!key) return reply.code(404).send({ error: "Schlüssel nicht gefunden" });
      // D-10: a revoked key is not edited.
      if (key.revokedAt) {
        return reply.code(409).send({ error: "Schlüssel ist widerrufen", code: "KEY_REVOKED" });
      }

      const readItem = async () =>
        toTerminalListItem(
          await app.prisma.terminalApiKey.findFirstOrThrow({
            where: { id, tenantId },
            select: TERMINAL_LIST_SELECT,
          }),
        );

      // D-10: an unchanged value is a no-op, checked BEFORE the salon validation so re-sending the
      // current id of a since-deactivated salon is a 200 and writes no audit noise.
      if (body.salonId === key.salonId) return readItem();

      if (body.salonId !== null) {
        const validation = await validateTerminalSalon(app.prisma, tenantId, body.salonId);
        if (!validation.ok) return reply.code(validation.status).send(validation.body);
      }

      await app.prisma.terminalApiKey.update({
        where: { id },
        data: { salonId: body.salonId },
      });

      await app.audit({
        userId: req.user.sub,
        action: "UPDATE",
        entity: "TerminalApiKey",
        entityId: id,
        oldValue: { salonId: key.salonId },
        newValue: { salonId: body.salonId },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return readItem();
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
