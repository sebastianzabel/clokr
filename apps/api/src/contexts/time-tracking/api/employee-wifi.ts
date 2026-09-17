// Phase 243 Plan 02 (B2) — moved verbatim from contexts/platform/api/employees.ts.
//
// ADR 0001: PresenceDevice (WLAN self-service, GDPR opt-in enrollment) is a Zeiterfassung
// model. These routes lived in the Unterbau's employees.ts only because the "/employees" URL
// prefix reads like an employee-management concern — but a URL prefix is a UI grouping, not a
// context boundary. The prefix is unchanged; only the file (and the context that owns it)
// moves. See GitHub issue #243.

import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../../middleware/auth";
import { normalizeMac } from "../normalize-mac";
import {
  listPresenceDevices,
  findPresenceDeviceByMac,
  createPresenceDevice,
  getPresenceDevice,
  deletePresenceDevice,
} from "../facade/presence-devices";

export async function employeeWifiRoutes(app: FastifyInstance) {
  // ── WiFi self-service schemas ───────────────────────────────────────────────
  const meWifiPatchSchema = z.object({
    wifiPresenceEnabled: z.boolean().optional(),
  });

  const meWifiDeviceCreateSchema = z.object({
    mac: z.string().min(1),
    label: z.string().max(64).optional(),
  });

  const deviceIdParamSchema = z.object({ id: z.string().uuid() });

  // ── WiFi self-service routes (GDPR opt-in + MAC enrollment) ────────────────

  // GET /api/v1/employees/me/wifi — Read own wifi opt-in status and device list
  app.get("/me/wifi", {
    schema: { tags: ["Mitarbeiter"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const employeeId = req.user.employeeId;
      const tenantId = req.user.tenantId;
      if (!employeeId) return reply.code(401).send({ error: "Nicht authentifiziert" });

      const employee = await app.prisma.employee.findUnique({
        where: { id: employeeId, tenantId },
        select: { wifiPresenceEnabled: true, wifiOptInAt: true },
      });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

      const devices = await listPresenceDevices(app.prisma, employeeId, tenantId);

      return reply.send({
        wifiPresenceEnabled: employee.wifiPresenceEnabled,
        wifiOptInAt: employee.wifiOptInAt,
        devices,
      });
    },
  });

  // PATCH /api/v1/employees/me/wifi — Toggle wifi opt-in (GDPR consent)
  app.patch("/me/wifi", {
    schema: { tags: ["Mitarbeiter"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const body = meWifiPatchSchema.parse(req.body);
      const employeeId = req.user.employeeId;
      const tenantId = req.user.tenantId;

      const employee = await app.prisma.employee.findUnique({
        where: { id: employeeId, tenantId },
        select: { wifiPresenceEnabled: true, wifiOptInAt: true },
      });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

      if (body.wifiPresenceEnabled === undefined) {
        return reply.send({
          wifiPresenceEnabled: employee.wifiPresenceEnabled,
          wifiOptInAt: employee.wifiOptInAt,
        });
      }

      const oldVal = employee.wifiPresenceEnabled;
      const newVal = body.wifiPresenceEnabled;

      // When enabling for the first time (or re-enabling), stamp wifiOptInAt
      // When disabling, preserve wifiOptInAt as GDPR consent withdrawal trace
      const updateData: { wifiPresenceEnabled: boolean; wifiOptInAt?: Date } = {
        wifiPresenceEnabled: newVal,
      };
      if (newVal && !employee.wifiOptInAt) {
        updateData.wifiOptInAt = new Date();
      }

      const updated = await app.prisma.employee.update({
        where: { id: employeeId },
        data: updateData,
        select: { wifiPresenceEnabled: true, wifiOptInAt: true },
      });

      // Consent changes are permanently retained — purgeable MUST NOT be set true
      await app.audit({
        userId: req.user.sub,
        action: "UPDATE",
        entity: "Employee",
        entityId: employeeId,
        oldValue: { wifiPresenceEnabled: oldVal },
        newValue: { wifiPresenceEnabled: newVal },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return reply.send({
        wifiPresenceEnabled: updated.wifiPresenceEnabled,
        wifiOptInAt: updated.wifiOptInAt,
      });
    },
  });

  // POST /api/v1/employees/me/wifi/devices — Register a new MAC device
  app.post("/me/wifi/devices", {
    schema: { tags: ["Mitarbeiter"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const body = meWifiDeviceCreateSchema.parse(req.body);
      const employeeId = req.user.employeeId;
      const tenantId = req.user.tenantId;

      if (!employeeId) return reply.code(401).send({ error: "Nicht authentifiziert" });

      // Normalize and validate MAC address
      let mac: string;
      try {
        mac = normalizeMac(body.mac);
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : "Ungültige MAC-Adresse" });
      }

      // Check for duplicate: unique per tenant+mac
      const existing = await findPresenceDeviceByMac(app.prisma, mac, tenantId);
      if (existing) {
        return reply.code(409).send({ error: "Dieses Gerät ist bereits registriert" });
      }

      const device = await createPresenceDevice(app.prisma, {
        tenantId,
        employeeId,
        mac,
        label: body.label,
      });

      await app.audit({
        userId: req.user.sub,
        action: "CREATE",
        entity: "PresenceDevice",
        entityId: device.id,
        newValue: { mac, label: body.label },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return reply.code(201).send(device);
    },
  });

  // DELETE /api/v1/employees/me/wifi/devices/:id — Remove own MAC device
  app.delete("/me/wifi/devices/:id", {
    schema: { tags: ["Mitarbeiter"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { id } = deviceIdParamSchema.parse(req.params);
      const employeeId = req.user.employeeId;
      if (!employeeId) return reply.code(401).send({ error: "Nicht authentifiziert" });

      // Own-data guard: the query itself is scoped to employeeId (Phase 100B Plan 09) — a device
      // belonging to another employee is not found, exactly like a device that does not exist at
      // all. See contexts/time-tracking/facade/presence-devices.ts's module header: this
      // collapses the route's former separate 403 "Forbidden" branch into the SAME 404 "Gerät
      // nicht gefunden" a missing device already returned, deliberately (the safer of the two).
      const device = await getPresenceDevice(app.prisma, id, employeeId);
      if (!device) return reply.code(404).send({ error: "Gerät nicht gefunden" });

      await deletePresenceDevice(app.prisma, id, employeeId);

      await app.audit({
        userId: req.user.sub,
        action: "DELETE",
        entity: "PresenceDevice",
        entityId: id,
        oldValue: { mac: device.mac, label: device.label },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return reply.code(204).send();
    },
  });
}
