// Phase 243 Plan 02 (B1) — moved verbatim from contexts/platform/api/settings.ts.
//
// ADR 0001: Abwesenheiten owns LeaveType and LeaveEntitlement. These routes lived in the
// Unterbau's settings.ts only because the "/settings" URL prefix reads like a tenant-config
// concern — but a URL prefix is a UI grouping, not a context boundary. The prefix is unchanged;
// only the file (and the context that owns it) moves. See GitHub issue #243.

import { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  requirePermission,
  accessContextFromRequest, // Phase 91b Plan 10 (#91), D-10/D-14
  resolveAccessReach, // Phase 91b Plan 10 (#91), D-10/D-14
  isStammsalonScopeMatch, // Phase 91b Plan 10 (#91), D-10/D-14
} from "../../platform";
import { preserveIllnessDeadline } from "../illness-carryover-guard"; // Phase 104
import { getVacationEntitlement, upsertVacationEntitlement } from "../facade/entitlements"; // Phase 100B Plan 10 — A11/A16
import { listLeaveTypes, updateLeaveType } from "../facade/leave-types"; // Phase 100B Plan 10 — A18/A19

const vacationEntitlementSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  totalDays: z.number().min(0).max(365),
  carriedOverDays: z.number().min(0).max(365).optional(),
  carryOverDeadline: z.string().nullable().optional(), // ISO date string or null
});

export async function leaveSettingsRoutes(app: FastifyInstance) {
  // GET /api/v1/settings/vacation/:employeeId?year=  — Urlaubsanspruch eines Mitarbeiters
  app.get("/vacation/:employeeId", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("leave-entitlement:read:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { employeeId } = req.params as { employeeId: string };
      const { year: yearStr } = req.query as { year?: string };
      const year = yearStr ? parseInt(yearStr, 10) : new Date().getFullYear();

      const employee = await app.prisma.employee.findUnique({ where: { id: employeeId } });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

      // Phase 104 review (CR-01): tenant isolation guard, mirroring settings.ts work/:employeeId.
      // Without it an ADMIN/MANAGER of tenant A could read another tenant's Urlaubsanspruch by
      // UUID, because tenantId was derived from the FETCHED row instead of req.user. The 404 body
      // is IDENTICAL to the not-found branch above so this cannot be used as a membership oracle.
      if (employee.tenantId !== req.user.tenantId) {
        await app.audit({
          userId: req.user.sub,
          action: "CROSS_TENANT_ACCESS_DENIED",
          entity: "LeaveEntitlement",
          entityId: employeeId,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      }
      // Phase 91b Plan 10 (Issue #91), D-10/D-14: leave-entitlement is Stammsalon-only (same
      // family as leave-request/absence, D-10), Stichtag = Dec 31 of the queried year — matches
      // Plan 91b-07's own convention for entitlement/report-adjacent per-year data.
      {
        const access = accessContextFromRequest(req);
        const scopeReach = await resolveAccessReach(
          app.prisma,
          access,
          "leave-entitlement:read:ZUGEWIESEN",
        );
        if (
          !(await isStammsalonScopeMatch(
            app.prisma,
            req.user.tenantId,
            scopeReach,
            employeeId,
            new Date(Date.UTC(year, 11, 31)),
          ))
        ) {
          await app.audit({
            userId: req.user.sub,
            action: "SCOPE_ACCESS_DENIED",
            entity: "LeaveEntitlement",
            entityId: employeeId,
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });
          return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
        }
      }

      // Phase 97 (D-24): the vacation type is identified by its stable code. Issue #196's
      // deterministic name resolver is obsolete and its helper module is gone —
      // @@unique([tenantId, code]) makes the ambiguity it worked around structurally impossible.
      // Do not name that module here: this plan asserts repo-wide that no reference to it
      // survives, and a comment counts as a reference.
      // Phase 100B Plan 10 (A11): resolves the VACATION type AND the entitlement in one call.
      const result = await getVacationEntitlement(app.prisma, employeeId, employee.tenantId, year);
      if (!result) return reply.code(404).send({ error: "Urlaubstyp nicht konfiguriert" });
      const { leaveTypeId, entitlement } = result;

      return {
        year,
        leaveTypeId,
        totalDays: entitlement ? Number(entitlement.totalDays) : null,
        usedDays: entitlement ? Number(entitlement.usedDays) : 0,
        carriedOverDays: entitlement ? Number(entitlement.carriedOverDays) : 0,
        carryOverDeadline: entitlement?.carryOverDeadline ?? null,
      };
    },
  });

  // PUT /api/v1/settings/vacation/:employeeId  — Urlaubsanspruch setzen
  app.put("/vacation/:employeeId", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("leave-entitlement:update:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { employeeId } = req.params as { employeeId: string };
      const body = vacationEntitlementSchema.parse(req.body);

      const employee = await app.prisma.employee.findUnique({ where: { id: employeeId } });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

      // Phase 104 review (CR-01): tenant isolation guard. This handler is the THIRD writer of
      // carryOverDeadline (see the D-19/R9 note below) — the row a § 9 BUrlG credit extends under
      // EuGH KHS C-214/10. A cross-tenant write here silently destroyed a legally protected
      // deadline in a foreign tenant and attributed the audit row to the foreign actor.
      if (employee.tenantId !== req.user.tenantId) {
        await app.audit({
          userId: req.user.sub,
          action: "CROSS_TENANT_ACCESS_DENIED",
          entity: "LeaveEntitlement",
          entityId: employeeId,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      }
      // Phase 91b Plan 10 (Issue #91), D-10/D-14: same rule as GET above, Stichtag = Dec 31 of
      // the request's own body.year (the year being written).
      {
        const access = accessContextFromRequest(req);
        const scopeReach = await resolveAccessReach(
          app.prisma,
          access,
          "leave-entitlement:update:ZUGEWIESEN",
        );
        if (
          !(await isStammsalonScopeMatch(
            app.prisma,
            req.user.tenantId,
            scopeReach,
            employeeId,
            new Date(Date.UTC(body.year, 11, 31)),
          ))
        ) {
          await app.audit({
            userId: req.user.sub,
            action: "SCOPE_ACCESS_DENIED",
            entity: "LeaveEntitlement",
            entityId: employeeId,
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });
          return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
        }
      }

      // Phase 97 (D-24): the vacation type is identified by its stable code. Issue #196's
      // deterministic name resolver is obsolete and its helper module is gone —
      // @@unique([tenantId, code]) makes the ambiguity it worked around structurally impossible.
      // Do not name that module here: this plan asserts repo-wide that no reference to it
      // survives, and a comment counts as a reference.
      // Phase 100B Plan 10 (A11): resolves the VACATION type AND the entitlement in one call.
      //
      // Phase 104 (D-19 / R9): this endpoint is the THIRD writer of carryOverDeadline. An omitted
      // or null field previously became `null` unconditionally, which silently discards the
      // extended EuGH KHS C-214/10 deadline that a § 9 BUrlG credit sets on this exact row
      // (104-06 marks the originYear+1 row, and this form always posts the current year).
      // The admin form round-trips the loaded value, so the UI does not trigger it today — but a
      // direct API call, a bulk-setup script or a future UI change does, and nothing in the audit
      // trail would distinguish that from a routine update.
      const result = await getVacationEntitlement(
        app.prisma,
        employeeId,
        employee.tenantId,
        body.year,
      );
      if (!result) return reply.code(404).send({ error: "Urlaubstyp nicht konfiguriert" });
      const { entitlement: existing } = result;
      const illnessProtected = preserveIllnessDeadline(existing);
      const requestedDeadline = body.carryOverDeadline ? new Date(body.carryOverDeadline) : null;

      // An EXPLICIT non-null deadline is still allowed on a protected row — an admin must be able
      // to correct a wrong date, and a hard block would be the kind of dead end this phase exists
      // to avoid. It is audited separately (below) so the override is reconstructible.
      const deadlineOverride = illnessProtected && requestedDeadline !== null;
      const nextDeadline = illnessProtected
        ? (requestedDeadline ?? existing?.carryOverDeadline ?? null)
        : requestedDeadline;

      // Same silent-zeroing shape on the adjacent line: `?? 0` wipes a carry-over the admin never
      // mentioned. Protected rows preserve it; every other row keeps today's `?? 0` behaviour
      // byte-for-byte, because clearing that input plausibly does mean "zero" for a normal row.
      const nextCarriedOver =
        body.carriedOverDays ?? (illnessProtected ? Number(existing?.carriedOverDays ?? 0) : 0);

      const data = {
        totalDays: body.totalDays,
        carriedOverDays: nextCarriedOver,
        carryOverDeadline: nextDeadline,
      };

      // Phase 100B Plan 10 (A16): re-resolves the VACATION type by code (a cheap, indexed
      // lookup) rather than threading leaveTypeId through — matches the facade's own signature.
      const entitlement = await upsertVacationEntitlement(
        app.prisma,
        employeeId,
        employee.tenantId,
        body.year,
        data,
      );
      if (!entitlement) return reply.code(404).send({ error: "Urlaubstyp nicht konfiguriert" });

      await app.audit({
        userId: req.user.sub,
        action: "UPDATE",
        entity: "LeaveEntitlement",
        entityId: entitlement.id,
        oldValue: existing
          ? {
              totalDays: Number(existing.totalDays),
              carriedOverDays: Number(existing.carriedOverDays),
              carryOverDeadline: existing.carryOverDeadline,
              carryOverReason: existing.carryOverReason,
            }
          : null,
        newValue: body,
      });

      if (deadlineOverride) {
        await app.audit({
          userId: req.user.sub,
          action: "LEAVE_ENTITLEMENT_ILLNESS_DEADLINE_OVERRIDDEN",
          entity: "LeaveEntitlement",
          entityId: entitlement.id,
          oldValue: {
            carryOverDeadline: existing?.carryOverDeadline,
            carryOverReason: existing?.carryOverReason,
          },
          newValue: { carryOverDeadline: nextDeadline },
        });
      }

      return {
        year: body.year,
        totalDays: Number(entitlement.totalDays),
        usedDays: Number(entitlement.usedDays),
        carriedOverDays: Number(entitlement.carriedOverDays),
        carryOverDeadline: entitlement.carryOverDeadline,
      };
    },
  });

  // GET /api/v1/settings/leave-types — all leave types with config
  app.get("/leave-types", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("leave-config:read:ZUGEWIESEN"),
    handler: async (req) => {
      const types = await listLeaveTypes(app.prisma, req.user.tenantId);
      return types;
    },
  });

  // PUT /api/v1/settings/leave-types/:id — update leave type config
  app.put("/leave-types/:id", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("leave-config:manage:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = z
        .object({
          allowHalfDay: z.boolean().optional(),
          maxDaysPerYear: z.number().int().min(0).nullable().optional(),
          leadTimeDays: z.number().int().min(0).nullable().optional(),
          color: z.string().optional(),
        })
        .parse(req.body);

      // Tenant scope: LeaveType carries tenantId directly, so a combined filter is
      // the shorter equivalent to a separate lookup + compare — same 404 either way,
      // no tenant-membership oracle. No extra CROSS_TENANT_ACCESS_DENIED audit here:
      // this mirrors the established sibling guard (GET /special-leave/rules/:id),
      // and the row itself stays untouched by a rejected request either way.
      // Phase 100B Plan 10 (A19, H3): both the guard-fetch AND the update below now carry
      // tenantId in their OWN where — a query-level proof, not a handler-level one.
      const result = await updateLeaveType(app.prisma, req.user.tenantId, id, body);
      if (!result) return reply.code(404).send({ error: "Abwesenheitstyp nicht gefunden" });
      const { existing, updated } = result;

      await app.audit({
        userId: req.user.sub,
        action: "UPDATE",
        entity: "LeaveType",
        entityId: id,
        oldValue: { allowHalfDay: existing.allowHalfDay, maxDaysPerYear: existing.maxDaysPerYear },
        newValue: body,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return updated;
    },
  });
}
