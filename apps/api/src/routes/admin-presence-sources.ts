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

  // ── PATCH /:id — update name, adapterUrl, adapterSecret, and/or isActive ────
  app.patch("/:id", {
    schema: { tags: ["Admin - Presence Sources"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({
          name: z.string().min(1).max(100).optional(),
          adapterUrl: z.string().url().nullable().optional(),
          // CR-02: secret the API forwards as Bearer token to the adapter's /devices endpoint
          adapterSecret: z.string().min(1).nullable().optional(),
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
          ...(body.adapterSecret !== undefined && { adapterSecret: body.adapterSecret }),
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
            // Note: adapterSecret intentionally omitted from audit log (not logged in plaintext)
            ...(body.adapterSecret !== undefined && {
              adapterSecret: body.adapterSecret !== null ? "[set]" : null,
            }),
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

      // ── SSRF guard: validate adapterUrl before proxying ───────────────────────
      // CR-01: Reject private/loopback IPs and non-http(s) schemes to prevent
      // SSRF attacks via admin-controlled adapterUrl field.
      const ALLOWED_SCHEMES = new Set(["http:", "https:"]);
      // Patterns for private / link-local / loopback ranges
      const PRIVATE_IP_PATTERNS = [
        /^127\./,
        /^10\./,
        /^172\.(1[6-9]|2\d|3[01])\./,
        /^192\.168\./,
        /^169\.254\./, // link-local / cloud metadata (AWS, GCP)
        /^::1$/,
        /^fd[0-9a-f]{2}:/i, // ULA IPv6
        /^fe80:/i, // link-local IPv6
      ];
      // Allowlisted service hostnames (Docker Compose internal network)
      const ALLOWED_HOSTNAMES = new Set(["fritzbox-adapter"]);

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(source.adapterUrl);
      } catch {
        return reply.code(502).send({ error: "Ungültige Adapter-URL" });
      }

      if (!ALLOWED_SCHEMES.has(parsedUrl.protocol)) {
        return reply.code(502).send({ error: "Adapter-URL muss http oder https verwenden" });
      }

      const hostname = parsedUrl.hostname;

      // Allow known Docker service hostnames without IP check
      if (!ALLOWED_HOSTNAMES.has(hostname)) {
        if (
          hostname === "localhost" ||
          PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(hostname))
        ) {
          app.log.warn(
            { hostname, sourceId: id },
            "SSRF guard: blocked private/loopback adapter URL",
          );
          return reply
            .code(502)
            .send({ error: "Adapter-URL zeigt auf eine nicht erlaubte Adresse" });
        }
      }

      // Forward the adapter secret if configured (CR-02: authenticated proxy)
      const proxyHeaders: Record<string, string> = {};
      if (source.adapterSecret) {
        proxyHeaders["Authorization"] = `Bearer ${source.adapterSecret}`;
      }

      try {
        const adapterRes = await fetch(`${source.adapterUrl}/devices`, {
          headers: proxyHeaders,
          signal: AbortSignal.timeout(5000),
        });
        if (!adapterRes.ok) {
          return reply.code(502).send({ error: "Adapter nicht erreichbar" });
        }

        type AdapterDevice = { mac: string; hostname: string; active: boolean; ip?: string };
        const rawDevices = (await adapterRes.json()) as AdapterDevice[];

        // Cross-reference with PresenceDevice mapping table to enrich with employee assignment
        const macs = rawDevices.map((d) => d.mac.toLowerCase());
        const mappings = await app.prisma.presenceDevice.findMany({
          where: { tenantId: req.user.tenantId, mac: { in: macs } },
          include: { employee: { select: { id: true, firstName: true, lastName: true } } },
        });
        const mappingByMac = new Map(mappings.map((m) => [m.mac, m]));

        const devices = rawDevices.map((d) => {
          const mac = d.mac.toLowerCase();
          const mapping = mappingByMac.get(mac);
          return {
            mac,
            hostname: d.hostname,
            online: d.active,
            lastSeen: null as string | null,
            assignedEmployeeId: mapping?.employee.id ?? null,
            assignedEmployeeName: mapping
              ? `${mapping.employee.firstName} ${mapping.employee.lastName}`.trim()
              : null,
          };
        });

        return reply.send({ devices });
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

      // Auto-enable WiFi-presence opt-in if not already active (DSGVO note in audit log).
      // Assumes consent is covered by Betriebsvereinbarung / Arbeitsvertrag — admin acts on
      // behalf of the employee. The MA can revoke at any time via /settings.
      let optInWasEnabled = false;
      if (!employee.wifiPresenceEnabled) {
        await app.prisma.employee.update({
          where: { id: body.employeeId },
          data: {
            wifiPresenceEnabled: true,
            wifiOptInAt: employee.wifiOptInAt ?? new Date(),
          },
        });
        optInWasEnabled = true;

        await app.prisma.auditLog.create({
          data: {
            userId: req.user.sub,
            action: "WIFI_OPT_IN_BY_ADMIN",
            entity: "Employee",
            entityId: body.employeeId,
            oldValue: { wifiPresenceEnabled: false },
            newValue: { wifiPresenceEnabled: true, source: "admin-device-assignment" },
            ipAddress: req.ip,
          },
        });
      }

      await app.prisma.auditLog.create({
        data: {
          userId: req.user.sub,
          action: "ASSIGN_DEVICE",
          entity: "PresenceDevice",
          entityId: device.id,
          newValue: { mac, employeeId: body.employeeId, optInAutoEnabled: optInWasEnabled },
          ipAddress: req.ip,
        },
      });

      return {
        employeeId: device.employeeId,
        mac: device.mac,
        optInAutoEnabled: optInWasEnabled,
      };
    },
  });

  // ── DELETE /:id/devices/:mac — remove MAC ↔ employee mapping ───
  app.delete("/:id/devices/:mac", {
    schema: { tags: ["Admin - Presence Sources"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { id, mac: rawMac } = z
        .object({ id: z.string().uuid(), mac: z.string() })
        .parse(req.params);

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

      const device = await app.prisma.presenceDevice.findUnique({
        where: { tenantId_mac: { tenantId: req.user.tenantId, mac } },
      });
      if (!device) return reply.code(404).send({ error: "Zuweisung nicht gefunden" });

      await app.prisma.presenceDevice.delete({
        where: { id: device.id },
      });

      // If this was the employee's last device, also disable opt-in
      // (wifiOptInAt is preserved as audit trail of past consent).
      let optInWasDisabled = false;
      const remainingDevices = await app.prisma.presenceDevice.count({
        where: { tenantId: req.user.tenantId, employeeId: device.employeeId },
      });
      if (remainingDevices === 0) {
        const employee = await app.prisma.employee.findUnique({
          where: { id: device.employeeId },
          select: { wifiPresenceEnabled: true },
        });
        if (employee?.wifiPresenceEnabled) {
          await app.prisma.employee.update({
            where: { id: device.employeeId },
            data: { wifiPresenceEnabled: false },
          });
          optInWasDisabled = true;
          await app.prisma.auditLog.create({
            data: {
              userId: req.user.sub,
              action: "WIFI_OPT_OUT_BY_ADMIN",
              entity: "Employee",
              entityId: device.employeeId,
              oldValue: { wifiPresenceEnabled: true },
              newValue: { wifiPresenceEnabled: false, source: "last-device-unassigned" },
              ipAddress: req.ip,
            },
          });
        }
      }

      await app.prisma.auditLog.create({
        data: {
          userId: req.user.sub,
          action: "UNASSIGN_DEVICE",
          entity: "PresenceDevice",
          entityId: device.id,
          oldValue: { mac: device.mac, employeeId: device.employeeId },
          newValue: { optInAutoDisabled: optInWasDisabled, remainingDevices },
          ipAddress: req.ip,
        },
      });

      return { success: true, optInAutoDisabled: optInWasDisabled };
    },
  });
}
