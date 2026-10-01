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
import {
  preserveCarryOverDeadline, // Phase 104, Issue #445 (D-17)
  CARRY_OVER_REASONS, // Issue #445 (D-16)
  OTHER_CARRY_OVER_REASON, // Issue #445 (D-16)
  ILLNESS_CARRY_OVER_REASON, // Issue #445 (D-16)
} from "../illness-carryover-guard";
import {
  getVacationEntitlement,
  upsertVacationEntitlement,
  ensureVacationEntitlementForYear, // Issue #416 — first-access self-heal
} from "../facade/entitlements"; // Phase 100B Plan 10 — A11/A16
import { listLeaveTypes, updateLeaveType } from "../facade/leave-types"; // Phase 100B Plan 10 — A18/A19
import {
  resolveContractWorkDaysPerWeek, // Issue #416 — same-context internal import, the one resolution chain (CLAUDE.md)
  ensureRegularVacationEntitlement, // Issue #445 (D-05, P-07) — zero-placeholder heal
  REGULAR_ENTITLEMENT_REASON_SELF_HEAL,
  resolveVacationBaseDays, // Issue #435 (D-06) — person value ?? tenant default ?? 30
} from "../leave-days";

const vacationEntitlementSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  totalDays: z.number().min(0).max(365),
  carriedOverDays: z.number().min(0).max(365).optional(),
  carryOverDeadline: z.string().nullable().optional(), // ISO date string or null
  // Issue #445 (D-16): omitted keeps the stored value, explicit null removes the protection.
  carryOverReason: z.enum(CARRY_OVER_REASONS).nullable().optional(),
  carryOverNote: z.string().max(500).nullable().optional(),
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
      const { leaveTypeId } = result;
      let entitlement = result.entitlement;

      // Issue #416, CONTEXT.md decision 6 ("first access"): an active employee's row for the
      // CURRENT year that no code path ever created (either a genuinely new hire whose
      // POST /employees predates this phase, or a year-rollover — "Jahreswechsel") is healed
      // right here, on read. NEVER for a past/future year (that stays the repair script's job,
      // Task 6/8 — backfilling history is a deliberate, auditable, batch action, not a read-time
      // side effect) and NEVER for an inactive employee (`exitDate` set).
      const currentYear = new Date().getFullYear();
      if (!entitlement && employee.exitDate === null && year === currentYear) {
        const workDaysPerWeek = await resolveContractWorkDaysPerWeek(
          app.prisma,
          employeeId,
          employee.tenantId,
        );
        // Issue #435 (D-06): the ONE base-value resolution — person value ?? tenant default ?? 30
        // — replaces the previous direct TenantConfig.defaultVacationDays read.
        const baseDays = await resolveVacationBaseDays(app.prisma, employeeId, employee.tenantId);
        const healed = await ensureVacationEntitlementForYear(
          app.prisma,
          employeeId,
          employee.tenantId,
          year,
          employee.hireDate,
          employee.birthDate,
          workDaysPerWeek,
          baseDays,
          "Jahreswechsel — automatisch angelegt",
          (entry) =>
            app.audit({
              userId: req.user.sub,
              ...entry,
              request: { ip: req.ip, headers: req.headers as Record<string, string> },
            }),
        );
        if (healed?.entitlement) {
          return {
            year,
            leaveTypeId,
            totalDays: Number(healed.entitlement.totalDays),
            usedDays: Number(healed.entitlement.usedDays),
            carriedOverDays: Number(healed.entitlement.carriedOverDays),
            carryOverDeadline: healed.entitlement.carryOverDeadline ?? null,
          };
        }
      }

      // Issue #445 (D-05, P-07): an EXISTING zero placeholder for whatever year is queried heals
      // here too — no history is created (the row already exists), so this runs for a past year
      // as well, unlike the #416 missing-row block above.
      if (entitlement && Number(entitlement.totalDays) === 0 && !entitlement.isAutoCalculated) {
        const healResult = await ensureRegularVacationEntitlement(
          app.prisma,
          employeeId,
          employee.tenantId,
          year,
          leaveTypeId,
          REGULAR_ENTITLEMENT_REASON_SELF_HEAL,
        );
        if (healResult.healed) {
          entitlement = healResult.entitlement;
        }
      }

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
      // Issue #416: the row already fetched above tells us whether this write is the FIRST one
      // for this employee+year (no code path created it automatically before this phase) — the
      // audit action must say so instead of always claiming "UPDATE".
      const existedBefore = Boolean(existing);
      const existingProtected = preserveCarryOverDeadline(existing);
      const requestedDeadline = body.carryOverDeadline ? new Date(body.carryOverDeadline) : null;

      // Issue #445 (D-16, P-20): `carryOverReason`/`carryOverNote` are resolved BEFORE any
      // validation or write — omitted keeps the stored value, an explicit `null` removes the
      // protection.
      const reasonProvided = body.carryOverReason !== undefined;
      const nextReason = reasonProvided
        ? (body.carryOverReason ?? null)
        : (existing?.carryOverReason ?? null);
      const nextNote =
        body.carryOverNote !== undefined
          ? body.carryOverNote?.trim() || null
          : (existing?.carryOverNote ?? null);

      if (nextReason === OTHER_CARRY_OVER_REASON && !nextNote) {
        return reply.code(400).send({
          error:
            "Für den Übertragungsgrund OTHER (sonstiger Grund) ist eine Notiz (carryOverNote) erforderlich.",
        });
      }
      if (
        reasonProvided &&
        body.carryOverReason != null &&
        body.carryOverReason !== ILLNESS_CARRY_OVER_REASON &&
        !body.carryOverDeadline
      ) {
        return reply.code(400).send({
          error:
            "Für diesen Übertragungsgrund ist eine Übertragsfrist (carryOverDeadline) erforderlich.",
        });
      }

      // Issue #445 (D-16): when a reason is provided (and non-null), the deadline comes from the
      // request, falling back to the ILLNESS default (15 months — 31.03. of year + 1) only for
      // ILLNESS; every other reason already required an explicit deadline above. When the
      // reason is omitted, the pre-#445 Phase 104 logic applies: an EXPLICIT non-null deadline is
      // still allowed on a protected row — an admin must be able to correct a wrong date, and a
      // hard block would be the kind of dead end this phase exists to avoid. It is audited
      // separately (below) so the override is reconstructible.
      const deadlineOverride = existingProtected && !reasonProvided && requestedDeadline !== null;
      const nextDeadline = reasonProvided
        ? nextReason != null
          ? (requestedDeadline ?? new Date(Date.UTC(body.year + 1, 2, 31, 23, 59, 59)))
          : requestedDeadline
        : existingProtected
          ? (requestedDeadline ?? existing?.carryOverDeadline ?? null)
          : requestedDeadline;

      // Same silent-zeroing shape on the adjacent line: `?? 0` wipes a carry-over the admin never
      // mentioned. Protected rows (any documented reason) preserve it; every other row keeps
      // today's `?? 0` behaviour byte-for-byte, because clearing that input plausibly does mean
      // "zero" for a normal row.
      const nextCarriedOver =
        body.carriedOverDays ?? (nextReason != null ? Number(existing?.carriedOverDays ?? 0) : 0);

      const data = {
        totalDays: body.totalDays,
        carriedOverDays: nextCarriedOver,
        carryOverDeadline: nextDeadline,
        carryOverReason: nextReason,
        carryOverNote: nextNote,
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
        // Issue #416: CREATE when no row existed for this employee+year before this write,
        // UPDATE otherwise — previously hardcoded to "UPDATE" even on the first write.
        action: existedBefore ? "UPDATE" : "CREATE",
        entity: "LeaveEntitlement",
        entityId: entitlement.id,
        oldValue: existing
          ? {
              totalDays: Number(existing.totalDays),
              carriedOverDays: Number(existing.carriedOverDays),
              carryOverDeadline: existing.carryOverDeadline,
              carryOverReason: existing.carryOverReason,
              carryOverNote: existing.carryOverNote,
            }
          : null,
        // Issue #445 (D-18): carries the resolved reason/note/deadline, not just the raw body —
        // `totalDays` stays present so the Issue #445 human-write detection (isZeroVacationPlaceholder)
        // still recognises this as a human write.
        newValue: {
          ...body,
          carryOverDeadline: nextDeadline,
          carryOverReason: nextReason,
          carryOverNote: nextNote,
        },
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
        carryOverReason: entitlement.carryOverReason,
        carryOverNote: entitlement.carryOverNote,
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
