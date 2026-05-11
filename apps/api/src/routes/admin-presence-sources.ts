import { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash, randomBytes } from "crypto";
import { requireRole } from "../middleware/auth";
import { normalizeMac } from "../utils/normalize-mac";

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export async function adminPresenceSourcesRoutes(app: FastifyInstance) {
  // ── GET /opted-in — list employees with wifi presence enabled ─
  // IMPORTANT: Registered BEFORE /:id routes to avoid path collision
  app.get("/opted-in", {
    schema: { tags: ["Admin - Presence Sources"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req) => {
      const employees = await app.prisma.employee.findMany({
        where: {
          tenantId: req.user.tenantId,
          wifiPresenceEnabled: true,
        },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          wifiPresenceEnabled: true,
          wifiOptInAt: true,
          wifiMacs: true,
        },
        orderBy: { lastName: "asc" },
      });
      return { employees };
    },
  });

  // ── GET / — list presence sources for tenant ──────────────────
  app.get("/", {
    schema: { tags: ["Admin - Presence Sources"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req) => {
      const sources = await app.prisma.presenceSource.findMany({
        where: { tenantId: req.user.tenantId, deletedAt: null },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          keyPrefix: true,
          adapterUrl: true,
          isActive: true,
          lastUsedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      return { sources };
    },
  });

  // ── POST / — create new presence source ───────────────────────
  app.post("/", {
    schema: { tags: ["Admin - Presence Sources"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const body = z
        .object({
          name: z.string().min(1).max(100),
          kind: z.literal("FRITZBOX").default("FRITZBOX"),
          adapterUrl: z.string().url().optional(),
        })
        .parse(req.body);

      const rawKey = `clk_${randomBytes(32).toString("hex")}`;
      const keyHash = hashKey(rawKey);
      const keyPrefix = rawKey.substring(0, 12) + "...";

      const source = await app.prisma.presenceSource.create({
        data: {
          tenantId: req.user.tenantId,
          name: body.name,
          keyHash,
          keyPrefix,
          adapterUrl: body.adapterUrl,
        },
      });

      await app.prisma.auditLog.create({
        data: {
          userId: req.user.sub,
          action: "CREATE",
          entity: "PresenceSource",
          entityId: source.id,
          newValue: { name: body.name, keyPrefix, adapterUrl: body.adapterUrl ?? null },
          ipAddress: req.ip,
        },
      });

      return reply.code(201).send({
        id: source.id,
        name: source.name,
        keyPrefix,
        adapterUrl: source.adapterUrl,
        isActive: source.isActive,
        createdAt: source.createdAt,
        rawKey,
      });
    },
  });

  // ── PATCH /:id — update name, adapterUrl, and/or isActive ────
  app.patch("/:id", {
    schema: { tags: ["Admin - Presence Sources"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({
          name: z.string().min(1).max(100).optional(),
          adapterUrl: z.string().url().nullable().optional(),
          isActive: z.boolean().optional(),
        })
        .refine((b) => Object.keys(b).length > 0, {
          message: "Mindestens ein Feld erforderlich",
        })
        .parse(req.body);

      const source = await app.prisma.presenceSource.findFirst({
        where: { id, tenantId: req.user.tenantId, deletedAt: null },
      });
      if (!source) return reply.code(404).send({ error: "Präsenzquelle nicht gefunden" });

      const oldValue = {
        name: source.name,
        adapterUrl: source.adapterUrl,
        isActive: source.isActive,
      };

      const updated = await app.prisma.presenceSource.update({
        where: { id },
        data: {
          ...(body.name !== undefined && { name: body.name }),
          ...(body.adapterUrl !== undefined && { adapterUrl: body.adapterUrl }),
          ...(body.isActive !== undefined && { isActive: body.isActive }),
        },
        select: {
          id: true,
          name: true,
          keyPrefix: true,
          adapterUrl: true,
          isActive: true,
          lastUsedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      await app.prisma.auditLog.create({
        data: {
          userId: req.user.sub,
          action: "UPDATE",
          entity: "PresenceSource",
          entityId: id,
          oldValue,
          newValue: {
            ...(body.name !== undefined && { name: body.name }),
            ...(body.adapterUrl !== undefined && { adapterUrl: body.adapterUrl }),
            ...(body.isActive !== undefined && { isActive: body.isActive }),
          },
          ipAddress: req.ip,
        },
      });

      return updated;
    },
  });

  // ── DELETE /:id — soft delete (deletedAt + isActive=false) ───
  app.delete("/:id", {
    schema: { tags: ["Admin - Presence Sources"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

      const source = await app.prisma.presenceSource.findFirst({
        where: { id, tenantId: req.user.tenantId, deletedAt: null },
      });
      if (!source) return reply.code(404).send({ error: "Präsenzquelle nicht gefunden" });

      await app.prisma.presenceSource.update({
        where: { id },
        data: { deletedAt: new Date(), isActive: false },
      });

      await app.prisma.auditLog.create({
        data: {
          userId: req.user.sub,
          action: "DELETE",
          entity: "PresenceSource",
          entityId: id,
          oldValue: { name: source.name },
          ipAddress: req.ip,
        },
      });

      return { success: true };
    },
  });

  // ── GET /:id/devices — proxy live device list from adapter ───
  app.get("/:id/devices", {
    schema: { tags: ["Admin - Presence Sources"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

      const source = await app.prisma.presenceSource.findFirst({
        where: { id, tenantId: req.user.tenantId, deletedAt: null },
      });
      if (!source) return reply.code(404).send({ error: "Präsenzquelle nicht gefunden" });

      if (!source.adapterUrl) {
        return reply.code(502).send({ error: "Kein Adapter-URL konfiguriert" });
      }

      try {
        const adapterRes = await fetch(`${source.adapterUrl}/devices`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!adapterRes.ok) {
          return reply.code(502).send({ error: "Adapter nicht erreichbar" });
        }
        return reply.send(await adapterRes.json());
      } catch {
        return reply.code(502).send({ error: "Adapter nicht erreichbar" });
      }
    },
  });

  // ── POST /:id/devices/:mac/assign — assign MAC to employee ───
  app.post("/:id/devices/:mac/assign", {
    schema: { tags: ["Admin - Presence Sources"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { id, mac: rawMac } = z
        .object({ id: z.string().uuid(), mac: z.string() })
        .parse(req.params);
      const body = z.object({ employeeId: z.string().uuid() }).parse(req.body);

      const source = await app.prisma.presenceSource.findFirst({
        where: { id, tenantId: req.user.tenantId, deletedAt: null },
      });
      if (!source) return reply.code(404).send({ error: "Präsenzquelle nicht gefunden" });

      let mac: string;
      try {
        mac = normalizeMac(rawMac);
      } catch {
        return reply.code(400).send({ error: "Ungültige MAC-Adresse" });
      }

      const employee = await app.prisma.employee.findFirst({
        where: { id: body.employeeId, tenantId: req.user.tenantId },
      });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

      const device = await app.prisma.presenceDevice.upsert({
        where: { tenantId_mac: { tenantId: req.user.tenantId, mac } },
        create: {
          tenantId: req.user.tenantId,
          employeeId: body.employeeId,
          mac,
          addedByUserId: req.user.sub,
        },
        update: {
          employeeId: body.employeeId,
          addedByUserId: req.user.sub,
        },
      });

      await app.prisma.auditLog.create({
        data: {
          userId: req.user.sub,
          action: "ASSIGN_DEVICE",
          entity: "PresenceDevice",
          entityId: device.id,
          newValue: { mac, employeeId: body.employeeId },
          ipAddress: req.ip,
        },
      });

      return { employeeId: device.employeeId, mac: device.mac };
    },
  });
}
