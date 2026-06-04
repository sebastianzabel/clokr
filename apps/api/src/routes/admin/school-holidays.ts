// Phase 67.2 — Admin endpoints for the School-Holidays cache.
//
// Endpoints:
//   GET  /api/v1/admin/school-holidays         — list cache entries (per tenant)
//   POST /api/v1/admin/school-holidays/refresh — trigger on-demand sync
//
// Both are ADMIN-only. The refresh endpoint writes an AuditLog entry
// (Revisionssicherheit) so the trigger is traceable.
//
// Out of scope for this plan (RESEARCH §129, fallback strategy): the ICS upload
// endpoint (`POST /admin/school-holidays/ics-upload`) is deferred — admins can
// still seed MANUAL rows directly via DB if needed.

import { FastifyInstance } from "fastify";
import { requireAuth, requireRole } from "../../middleware/auth";
import { FederalState } from "@clokr/db";
import { syncSchoolHolidaysForTenant } from "../../plugins/school-holidays-sync";

export async function adminSchoolHolidaysRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // ── GET / — cache inspection ──────────────────────────────────
  app.get("/", {
    schema: { tags: ["Admin - School Holidays"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req) => {
      const rows = await app.prisma.schoolHolidayPeriod.findMany({
        where: { tenantId: req.user.tenantId },
        orderBy: [{ federalState: "asc" }, { startDate: "asc" }],
      });
      return rows.map((r) => ({
        id: r.id,
        federalState: r.federalState,
        startDate: r.startDate.toISOString().slice(0, 10),
        endDate: r.endDate.toISOString().slice(0, 10),
        name: r.name,
        source: r.source,
        externalId: r.externalId,
        fetchedAt: r.fetchedAt.toISOString(),
      }));
    },
  });

  // ── POST /refresh — on-demand sync ────────────────────────────
  app.post("/refresh", {
    schema: { tags: ["Admin - School Holidays"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const tenant = await app.prisma.tenant.findUniqueOrThrow({
        where: { id: req.user.tenantId },
        select: { id: true, federalState: true },
      });

      // Collect ALL federal states the tenant needs: tenant default +
      // every Pattern.federalStateOverride that is non-null and active.
      const overrides = await app.prisma.employeeVocationalSchoolPattern.findMany({
        where: {
          isActive: true,
          employee: { tenantId: tenant.id },
          federalStateOverride: { not: null },
        },
        select: { federalStateOverride: true },
      });

      const needed = new Set<FederalState>([tenant.federalState]);
      for (const o of overrides) {
        if (o.federalStateOverride) needed.add(o.federalStateOverride);
      }

      const now = new Date();
      const result = await syncSchoolHolidaysForTenant(
        app.prisma,
        tenant.id,
        [...needed],
        { from: now.getFullYear(), to: now.getFullYear() + 1 },
        app.log,
      );

      await app.audit({
        userId: req.user.sub,
        action: "SCHOOL_HOLIDAYS_REFRESH",
        entity: "SchoolHolidayPeriod",
        entityId: tenant.id,
        newValue: {
          syncedAt: result.syncedAt.toISOString(),
          perState: result.perState,
        },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return reply.code(200).send({
        syncedAt: result.syncedAt.toISOString(),
        perState: result.perState,
      });
    },
  });
}
