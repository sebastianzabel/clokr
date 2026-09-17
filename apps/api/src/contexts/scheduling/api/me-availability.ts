// Phase 243 Plan 02 (B3) — moved verbatim from contexts/platform/api/me.ts.
//
// ADR 0001: employee availability declarations are a Schichtplanung concern. These two routes
// lived in the Unterbau's me.ts only because the "/me" URL prefix reads like a generic
// caller-scoped concern — but a URL prefix is a UI grouping, not a context boundary. The prefix
// is unchanged; only the file (and the context that owns it) moves. See GitHub issue #243.
//
// This is a SIBLING file to ./availability.ts, not an addition to `availabilityRoutes` itself:
// availability.ts:107 carries a plugin-level `app.addHook("preHandler", requireAuth)`. Folding
// these two routes into that plugin would silently change which hook chain they run under. Both
// routes here carry their own inline `preHandler: requireAuth`, matching what they had in me.ts.

import { FastifyInstance } from "fastify";
import { requireAuth } from "../../../middleware/auth";
import { formatEntry, putAvailabilitySchema, replaceAvailability } from "./availability";
import { isAvailabilityEnabled } from "../tenant-availability";
import { getEmployeeAvailability } from "../facade/availability"; // Phase 100B Plan 05 — S4

export async function meAvailabilityRoutes(app: FastifyInstance) {
  // ── Availability (Phase 46) ─────────────────────────────────────────────────
  // Shortcut for the caller's own availability, resolved from JWT.employeeId.
  // Mirrors GET/PUT /api/v1/employees/:id/availability but without the id param.

  // GET /api/v1/me/availability
  app.get("/availability", {
    preHandler: requireAuth,
    schema: {
      tags: ["Verfügbarkeit"],
      description: "Get the caller's availability entries (resolved from JWT.employeeId)",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const employeeId = req.user.employeeId;
      if (!employeeId) {
        return reply.code(404).send({ error: "Kein Mitarbeiterkonto verknüpft" });
      }

      // Tenant-scoped lookup to confirm employee still exists in the caller's tenant
      const employee = await app.prisma.employee.findFirst({
        where: { id: employeeId, tenantId: req.user.tenantId },
        select: { id: true },
      });
      if (!employee) {
        return reply.code(404).send({ error: "Kein Mitarbeiterkonto verknüpft" });
      }

      // Phase 47.3 — Feature toggle: 410 Gone when disabled (truthful, not 404).
      const featureOn = await isAvailabilityEnabled(app.prisma, req.user.tenantId);
      if (!featureOn) {
        return reply.code(410).send({
          error: "Verfügbarkeits-System deaktiviert",
          code: "AVAILABILITY_FEATURE_DISABLED",
        });
      }

      // Phase 100B Plan 05 — S4, contexts/scheduling facade.
      const entries = await getEmployeeAvailability(app.prisma, employeeId, req.user.tenantId);

      return reply.code(200).send({ entries: entries.map(formatEntry) });
    },
  });

  // PUT /api/v1/me/availability
  app.put("/availability", {
    preHandler: requireAuth,
    schema: {
      tags: ["Verfügbarkeit"],
      description: "Replace the caller's availability entries (REPLACE semantics)",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const employeeId = req.user.employeeId;
      if (!employeeId) {
        return reply.code(404).send({ error: "Kein Mitarbeiterkonto verknüpft" });
      }

      const body = putAvailabilitySchema.parse(req.body);

      // Tenant-scoped lookup to confirm employee still exists in the caller's tenant
      const employee = await app.prisma.employee.findFirst({
        where: { id: employeeId, tenantId: req.user.tenantId },
        select: { id: true },
      });
      if (!employee) {
        return reply.code(404).send({ error: "Kein Mitarbeiterkonto verknüpft" });
      }

      // Phase 47.3 — Feature toggle: 410 Gone when disabled (truthful, not 404).
      const featureOn = await isAvailabilityEnabled(app.prisma, req.user.tenantId);
      if (!featureOn) {
        return reply.code(410).send({
          error: "Verfügbarkeits-System deaktiviert",
          code: "AVAILABILITY_FEATURE_DISABLED",
        });
      }

      // Audit before-snapshot (Phase 100B Plan 05 — S4, contexts/scheduling facade)
      const oldEntries = await getEmployeeAvailability(app.prisma, employeeId, req.user.tenantId);

      const created = await replaceAvailability(app, employeeId, body.entries, req.user.sub);

      await app.audit({
        userId: req.user.sub,
        action: "REPLACE",
        entity: "EmployeeAvailability",
        entityId: employeeId,
        oldValue: { entries: oldEntries.map(formatEntry) },
        newValue: { entries: created.map(formatEntry) },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return reply.code(200).send({ entries: created.map(formatEntry) });
    },
  });
}
