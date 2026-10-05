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
  loadVacationContractSegments, // Issue #450 (D-09) — the segment history for the heal and both thresholds
  ensureRegularVacationEntitlement, // Issue #445 (D-05, P-07) — zero-placeholder heal
  REGULAR_ENTITLEMENT_REASON_SELF_HEAL,
  resolveVacationBaseDays, // Issue #482 — the classification-aware base value
  resolveRegularVacationDays, // Issue #435 (D-14) — the GET suggestion value, never a client formula
  daysDiffer, // Issue #435 (D-10) — 2-decimal-precision "did totalDays actually change" test
} from "../leave-days";
import {
  statutoryMinimumVacationThresholdBySegments, // Issue #450 (D-09) — the ONE segment-aware floor, GET and PUT
  statutoryMinimumViolationMessage, // Issue #435 (D-10) — the ONE German 400 message builder
} from "../vacation-calc";
import {
  activeParentalReductionMonths, // Issue #468 plan 07 (D-07/D-09) — § 17 BEEG reduces the floor too
  remainingAfterParentalMonths,
} from "../parental-leave-reduction";

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

      // Issue #435 (D-14): the Urlaub tab's suggestion values, computed server-side ONCE — never
      // a client-side formula. Hoisted here (before the #416 heal block below) so the heal branch
      // reuses this SAME segment history instead of resolving it a second time.
      // Issue #450 (D-09): the full contract-segment history, loaded once and reused by the
      // first-access heal below AND the statutory-minimum threshold — the newest-row-only
      // workday count is no longer the input to either.
      const contractSegments = await loadVacationContractSegments(
        app.prisma,
        employeeId,
        employee.tenantId,
      );
      const regularDays = await resolveRegularVacationDays(
        app.prisma,
        employeeId,
        employee.tenantId,
        year,
      );
      const statutoryThresholdForYear = statutoryMinimumVacationThresholdBySegments({
        birthDate: employee.birthDate,
        year,
        segments: contractSegments,
        hireDate: employee.hireDate,
        exitDate: employee.exitDate,
      });
      // Issue #468 plan 07 (D-07/D-09): § 17 Abs. 1 BEEG reduces the STATUTORY entitlement too —
      // the GET suggestion follows the same reduced floor the PUT guard below enforces (one rule
      // for read and write).
      const parentalMonthsForYear = await activeParentalReductionMonths(
        app.prisma,
        employeeId,
        employee.tenantId,
        year,
      );
      const statutoryMinimumDays = remainingAfterParentalMonths(
        statutoryThresholdForYear,
        parentalMonthsForYear,
      );

      // Issue #416, CONTEXT.md decision 6 ("first access"): an active employee's row for the
      // CURRENT year that no code path ever created (either a genuinely new hire whose
      // POST /employees predates this phase, or a year-rollover — "Jahreswechsel") is healed
      // right here, on read. NEVER for a past/future year (that stays the repair script's job,
      // Task 6/8 — backfilling history is a deliberate, auditable, batch action, not a read-time
      // side effect) and NEVER for an inactive employee (`exitDate` set).
      const currentYear = new Date().getFullYear();
      if (!entitlement && employee.exitDate === null && year === currentYear) {
        // Issue #482: the ONE base-value resolution — the classification-aware base value from
        // resolveVacationBaseDays() — replaces a direct TenantConfig column read.
        const baseDays = await resolveVacationBaseDays(app.prisma, employeeId, employee.tenantId);
        const healed = await ensureVacationEntitlementForYear(
          app.prisma,
          employeeId,
          employee.tenantId,
          year,
          employee.hireDate,
          employee.birthDate,
          // Issue #447 (D-05): this branch is only reached when employee.exitDate === null
          // (see the guard above) — passed through anyway, now that the parameter is required.
          employee.exitDate,
          // Issue #450 (D-09): the segment history, not the newest-row-only workDaysPerWeek — a
          // mid-year contract change is reflected in the healed row from the very first read.
          contractSegments,
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
            // Issue #451 / #445 addendum (D-09): additive — the Urlaub tab's carry-over reason
            // field reads these on every GET, including the first-access heal branch.
            carryOverReason: healed.entitlement.carryOverReason ?? null,
            carryOverNote: healed.entitlement.carryOverNote ?? null,
            regularDays, // Issue #435 (D-14)
            statutoryMinimumDays, // Issue #435 (D-14)
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
        // Issue #451 / #445 addendum (D-09): additive — the admin Urlaub tab's carry-over
        // reason field (ILLNESS/MATERNITY/PARENTAL_LEAVE/OTHER, or the legacy OPERATIONAL
        // value) and its note, so the form can show what PUT already accepts since #445.
        carryOverReason: entitlement?.carryOverReason ?? null,
        carryOverNote: entitlement?.carryOverNote ?? null,
        regularDays, // Issue #435 (D-14)
        statutoryMinimumDays, // Issue #435 (D-14)
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

      // Issue #435 (D-10): a totalDays write below the statutory minimum is rejected before any
      // other validation or write. An UNCHANGED totalDays on a legacy row (e.g. only
      // carryOverDeadline/carriedOverDays edited) stays editable — otherwise Bestand rows below
      // the minimum would become uneditable; correcting those rows is the follow-up
      // "Prüfbericht" ticket (CONTEXT.md, out of scope here).
      // Issue #450 (D-09): the floor follows the SAME per-segment apportionment as the regular
      // entitlement — a correct segment value is never rejected against a newest-row-only floor.
      const contractSegments = await loadVacationContractSegments(
        app.prisma,
        employeeId,
        employee.tenantId,
      );
      const statutoryThresholdUnreduced = statutoryMinimumVacationThresholdBySegments({
        birthDate: employee.birthDate,
        year: body.year,
        segments: contractSegments,
        hireDate: employee.hireDate,
        exitDate: employee.exitDate,
      });
      // Issue #468 plan 07 (D-07/D-09): § 17 Abs. 1 BEEG reduces the statutory entitlement by the
      // same one-twelfth-per-full-month rule as the regular one — this guard uses
      // remainingAfterParentalMonths(threshold, months), the SAME § 421 rounding the Elternzeit-
      // Kürzung itself applies, instead of the unreduced threshold.
      const parentalMonths = await activeParentalReductionMonths(
        app.prisma,
        employeeId,
        employee.tenantId,
        body.year,
      );
      const statutoryThreshold = remainingAfterParentalMonths(
        statutoryThresholdUnreduced,
        parentalMonths,
      );
      const totalDaysChanged = !existing || daysDiffer(Number(existing.totalDays), body.totalDays);
      if (
        totalDaysChanged &&
        Math.round(body.totalDays * 100) < Math.round(statutoryThreshold * 100)
      ) {
        return reply.code(400).send({
          error: statutoryMinimumViolationMessage(
            statutoryThreshold,
            employee.birthDate,
            body.year,
          ),
        });
      }

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
