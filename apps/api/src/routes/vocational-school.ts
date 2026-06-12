// Phase 62 — Berufsschultag manual trigger + preview routes.
//
// POST /api/v1/vocational-school/generate         — ADMIN/MANAGER trigger the generator on-demand
//                                                    for their tenant. Returns counts.
// GET  /api/v1/vocational-school/preview          — Dry-run that shows what would be created
//                                                    without persisting anything.
//
// Phase 63 Plan 04 — additive endpoints (D-18 + D-23):
// GET  /api/v1/vocational-school/upcoming         — read-only list of BS rows in a window.
//                                                    Scoped to caller's tenant. Safe response
//                                                    shape (no birthDate/email/classification).
// POST /api/v1/vocational-school/manual-insert    — manager-side one-off BS day insert.
//                                                    AZUBI-only (server-enforced), locked-month
//                                                    gate, DB-level dedupe via @@unique([employeeId,
//                                                    startDate, type]) → P2002 → HTTP 409.
//
// Phase 79 Plan 04 — BC PROXY LAYER.
//
// This file is the deprecation runway for the v1.8 Berufsschule API. New code MUST
// target /api/v1/work-events/* (Plans 79-02 + 79-03). Every response from this file
// carries `Deprecation: true` + `Sunset: Wed, 31 Dec 2026 23:59:59 GMT` (RFC 8594).
//
// Internal routing depends on `tenantConfig.workEventModelLive`:
//   - false (default): legacy path → Absence rows (preserved verbatim, Phase 80 retires)
//   - true            : new path → WorkEvent rows (Plan 79-01/02/03 utilities)
//
// DELETE additionally falls through from WorkEvent → Absence on id-miss to support
// stale client ids during the post-migration grace window. The fall-through still
// honors the legacy type guard (DR8) and soft-delete invariant (DR7).
//
// /generate + /preview (PATTERN-generation triggers) intentionally stay on Absence —
// those are rewritten by Phase 80's PATTERN engine, NOT here.

import { FastifyInstance } from "fastify";
import { z } from "zod";
import { AbsenceType, WorkEventType, ScheduleType } from "@clokr/db";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  runVocationalSchoolGeneration,
  previewVocationalSchoolGeneration,
  dispatchShiftCleanupForCreatedAbsences,
} from "../utils/vocational-school-generator";
import {
  assertMonthNotLocked,
  LockedMonthError,
  LOCKED_MONTH_ERROR_DE,
} from "../utils/locked-month";
import {
  assertClassificationAllowed,
  ClassificationNotAllowedError,
} from "../utils/work-event-rules";
import { getTenantTimezone } from "../utils/timezone";
// REVISION (W6): reuse the EXPORTED routing helper from work-event.ts instead of
// rolling our own private compat-routing helper. Same cached TTL pattern.
// REVISION (WR-02, Phase 79 review): use getTenantWorkEventModelLive for ALL
// BC-proxy endpoints (/upcoming, /manual-insert, /:absenceId DELETE) so they
// share the 5-minute cache. The BC-proxy surface only needs the flag, not the
// per-tenant BS minute config that getRoutingConfig also returns.
import { getTenantWorkEventModelLive } from "../utils/work-event";

// ── Phase 79 Plan 04 — RFC 8594 deprecation headers ───────────────────────
// Surface on EVERY response from this route file (success + error — INCLUDING
// the global Zod-error-handler short-circuit path; see B4 below).
// Removal slated for v1.10 (per ROADMAP + 79-CONTEXT.md). New code should target
// /api/v1/work-events/* (Plans 79-02 + 79-03).
const DEPRECATION_HEADER_VALUE = "true";
const SUNSET_HEADER_VALUE = "Wed, 31 Dec 2026 23:59:59 GMT";

const previewQuerySchema = z.object({
  weeks: z.coerce.number().int().min(1).max(26).optional(),
});

// Phase 63 D-18 — date-range filter for /upcoming. Both bounds are required (the manager UI
// supplies both); a default-window fallback can be added later without breaking the schema.
//
// 260611-ly6 — optional employeeId narrows the result to a single employee. ADMIN/MANAGER
// callers can use it to limit the response to one team member (the /team/time-entries page
// always sends it). EMPLOYEE callers are server-side overridden to self-scope and the
// param is therefore ignored for them (defense in depth — never trust client input for
// self-query scoping).
const upcomingQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "from muss im Format YYYY-MM-DD sein"),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "to muss im Format YYYY-MM-DD sein"),
  employeeId: z.string().uuid("employeeId muss eine UUID sein").optional(),
});

// Phase 63 D-23 — body shape for /manual-insert. UUID enforced server-side so the cross-tenant
// lookup short-circuits on malformed input.
const manualInsertSchema = z.object({
  employeeId: z.string().uuid("employeeId muss eine UUID sein"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date muss im Format YYYY-MM-DD sein"),
});

// 260601-g8l — path-param shape for DELETE /:absenceId. UUID enforced server-side so the
// cross-tenant lookup short-circuits on malformed input (mirrors manualInsertSchema).
const deleteParamsSchema = z.object({
  absenceId: z.string().uuid("absenceId muss eine UUID sein"),
});

// First-of-month UTC midnight — matches SaldoSnapshot.periodStart semantics.
function monthStartUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/**
 * Compute workedMinutes for a BC-proxy live-branch BS-Tag write.
 *
 * REVISION (B3, Phase 79 Plan 04): writing `workedMinutes: 0` would silently
 * break the Phase 78 saldo adapter (loadWorkEventsForRange sums this field).
 * Instead: read the employee's effective WorkSchedule at `dateString`, map
 * weekday → per-day hours, × 60 → minutes.
 *
 * MONTHLY_HOURS schedules (no daily Soll, no per-day target) default to 480
 * minutes (pauschal 8h) per Phase 78 D-08 adapter parity invariant and D-11
 * Variante B max-merge convention. Same default applies when no WorkSchedule
 * row exists for the employee (mirrors Phase 78 D-08 conservative default).
 *
 * Anchor the weekday lookup at UTC noon to dodge any DST quirks at midnight.
 */
async function computeBsWorkedMinutes(
  prisma: FastifyInstance["prisma"],
  employeeId: string,
  dateString: string,
): Promise<number> {
  const [y, m, d] = dateString.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d, 12, 0, 0, 0));
  const dow = day.getUTCDay(); // 0=Sun..6=Sat

  const schedule = await prisma.workSchedule.findFirst({
    where: { employeeId, validFrom: { lte: day } },
    orderBy: { validFrom: "desc" },
    select: {
      type: true,
      mondayHours: true,
      tuesdayHours: true,
      wednesdayHours: true,
      thursdayHours: true,
      fridayHours: true,
      saturdayHours: true,
      sundayHours: true,
    },
  });
  if (!schedule) {
    // No WorkSchedule row → conservative pauschal 8h. Mirrors Phase 78 D-08 default.
    return 480;
  }
  if (schedule.type === ScheduleType.MONTHLY_HOURS) {
    // MONTHLY_HOURS: no daily target → pauschal 8h per Phase 78 D-11 Variante B.
    return 480;
  }
  const dailyHours = [
    Number(schedule.sundayHours),
    Number(schedule.mondayHours),
    Number(schedule.tuesdayHours),
    Number(schedule.wednesdayHours),
    Number(schedule.thursdayHours),
    Number(schedule.fridayHours),
    Number(schedule.saturdayHours),
  ][dow];
  return Math.round(dailyHours * 60);
}

export async function vocationalSchoolRoutes(app: FastifyInstance) {
  // REVISION (B4): Set RFC 8594 deprecation headers via onRequest (NOT onSend) so
  // they survive the global Zod error-handler short-circuit at apps/api/src/app.ts.
  // onSend is NOT guaranteed to run when a 4xx is produced by setErrorHandler —
  // onRequest IS guaranteed to run before any handler or error handler fires.
  //
  // addHook registered on the route plugin (i.e. inside vocationalSchoolRoutes)
  // is scoped to routes registered in that plugin only. This is the correct
  // scope — the headers MUST NOT leak to /work-events/* or other routes.
  app.addHook("onRequest", async (_req, reply) => {
    reply.header("Deprecation", DEPRECATION_HEADER_VALUE);
    reply.header("Sunset", SUNSET_HEADER_VALUE);
  });

  app.addHook("preHandler", requireAuth);

  // POST /api/v1/vocational-school/generate — manual trigger (ADMIN/MANAGER)
  app.post("/generate", {
    schema: { tags: ["Berufsschule"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const tenantId = req.user.tenantId;

      // Read tenant's configured preview window (default 4 weeks).
      const config = await app.prisma.tenantConfig.findUnique({
        where: { tenantId },
        select: { vocationalSchoolPreviewWeeks: true },
      });
      const weeksAhead = config?.vocationalSchoolPreviewWeeks ?? 13;

      const result = await runVocationalSchoolGeneration(app.prisma, app.audit, {
        tenantId,
        weeksAhead,
      });
      return reply.code(200).send(result);
    },
  });

  // GET /api/v1/vocational-school/preview?weeks=N — dry-run (ADMIN/MANAGER)
  app.get("/preview", {
    schema: { tags: ["Berufsschule"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const tenantId = req.user.tenantId;
      const q = previewQuerySchema.parse(req.query);

      let weeksAhead = q.weeks;
      if (!weeksAhead) {
        const config = await app.prisma.tenantConfig.findUnique({
          where: { tenantId },
          select: { vocationalSchoolPreviewWeeks: true },
        });
        weeksAhead = config?.vocationalSchoolPreviewWeeks ?? 13;
      }

      const result = await previewVocationalSchoolGeneration(app.prisma, {
        tenantId,
        weeksAhead,
      });
      return reply.code(200).send(result);
    },
  });

  // ── Phase 63 D-18 + 260611-ly6: GET /upcoming ──────────────────────────────
  // Returns BS Absences within [from, to] for the caller's tenant. Response shape is
  // explicit-allowlist (T-63-15) — no birthDate/email/classification leak. Soft-deleted
  // rows are excluded (deletedAt: null), and the dataset is scoped to the caller's
  // tenant via employee.tenantId.
  //
  // Role-branched scoping (260611-ly6):
  //   - ADMIN / MANAGER: tenant-scoped (all employees in the tenant). Optional
  //     ?employeeId=UUID narrows the result to a single employee. The Employee model
  //     has no managerId field, so a team-level filter is not available in this code
  //     base; tenant-scope is the established convention (see
  //     apps/api/src/routes/leave.ts:1345 for the same pattern).
  //   - EMPLOYEE: server forces employeeId = req.user.employeeId. Any ?employeeId=
  //     query param is IGNORED (defense in depth — never trust client input for a
  //     self-query scope). Mirrors the role-branched scoping in
  //     apps/api/src/routes/time-entries.ts:663-696 (`GET /` returns own entries for
  //     EMPLOYEE, optional employeeId for managers). If req.user.employeeId is falsy
  //     (e.g. user without linked employee row), an empty array is returned — no rows
  //     visible, no error noise.
  app.get("/upcoming", {
    schema: { tags: ["Berufsschule"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER", "EMPLOYEE"),
    handler: async (req, reply) => {
      const tenantId = req.user.tenantId;
      const q = upcomingQuerySchema.parse(req.query);

      // Role-branched employeeId scoping (260611-ly6).
      // EMPLOYEE callers are forced to self-scope; any client-supplied ?employeeId is
      // dropped. ADMIN/MANAGER may optionally narrow the result via ?employeeId.
      let employeeIdFilter: string | undefined;
      if (req.user.role === "EMPLOYEE") {
        if (!req.user.employeeId) {
          // User without linked employee row — nothing they can see. Return empty
          // rather than 4xx so the frontend renders an empty list without an error
          // toast.
          return reply.code(200).send([]);
        }
        employeeIdFilter = req.user.employeeId;
      } else {
        employeeIdFilter = q.employeeId;
      }

      // Inclusive [from..to] in UTC. startDate is a DATE column, so a >= fromIso AND
      // <= toIso comparison is sufficient — no T00:00 / T23:59 fudge needed.
      const fromDate = new Date(q.from + "T00:00:00.000Z");
      const toDate = new Date(q.to + "T00:00:00.000Z");

      // BC proxy: routes to WorkEvent when tenantConfig.workEventModelLive=true
      // (Phase 79 Plan 04); else preserves legacy Absence path until Phase 80
      // retires it. The list endpoint operates across the tenant, so we read
      // the flag at the tenant level. REVISION (WR-02, Phase 79 review): use
      // the cached getTenantWorkEventModelLive helper so this list endpoint
      // shares the 5-minute cache with /manual-insert instead of incurring a
      // per-request DB round-trip on every paged listing.
      const live = await getTenantWorkEventModelLive(app.prisma, tenantId);

      if (live) {
        const events = await app.prisma.workEvent.findMany({
          where: {
            deletedAt: null,
            type: WorkEventType.VOCATIONAL_SCHOOL,
            date: { gte: fromDate, lte: toDate },
            employee: { tenantId },
            ...(employeeIdFilter ? { employeeId: employeeIdFilter } : {}),
          },
          select: {
            id: true,
            employeeId: true,
            date: true,
            source: true,
            employee: {
              select: { firstName: true, lastName: true, employeeNumber: true },
            },
          },
          orderBy: { date: "asc" },
        });

        return reply.code(200).send(
          events.map((e) => ({
            id: e.id,
            employeeId: e.employeeId,
            date: e.date.toISOString().slice(0, 10),
            source: e.source,
            employee: e.employee,
          })),
        );
      }

      // LEGACY PATH (preserved verbatim) — Absence-backed read.
      const absences = await app.prisma.absence.findMany({
        where: {
          deletedAt: null,
          type: AbsenceType.VOCATIONAL_SCHOOL,
          startDate: { gte: fromDate, lte: toDate },
          employee: { tenantId },
          ...(employeeIdFilter ? { employeeId: employeeIdFilter } : {}),
        },
        select: {
          id: true,
          employeeId: true,
          startDate: true,
          source: true,
          employee: {
            select: { firstName: true, lastName: true, employeeNumber: true },
          },
        },
        orderBy: { startDate: "asc" },
      });

      return reply.code(200).send(
        absences.map((a) => ({
          id: a.id,
          employeeId: a.employeeId,
          date: a.startDate.toISOString().slice(0, 10),
          source: a.source,
          employee: a.employee,
        })),
      );
    },
  });

  // ── Phase 63 D-23: POST /manual-insert ─────────────────────────────────────
  // Inserts a one-off BS day for an AZUBI employee. Gates (in order):
  //   1. AuthN/AuthZ via requireRole ADMIN/MANAGER (T-63-19).
  //   2. Zod payload parse (returns 400 via global error handler).
  //   3. Cross-tenant employee lookup (T-63-16) — 404 if employee.tenantId !== caller.
  //   4. AZUBI gate (server-enforced) — 400 with German message if non-AZUBI.
  //   5. Locked-month gate (CLAUDE.md Revisionssicherheit) — 403 if SaldoSnapshot exists
  //      for (employeeId, MONTHLY, monthStart(date)).
  //   6. DB-level @@unique([employeeId, startDate, type]) — Prisma P2002 → 409 (T-63-17).
  // On success: writes Absence with source=MANUAL + emits VOCATIONAL_SCHOOL_MANUAL_INSERTED
  // audit row carrying the originator's userId + new value snapshot.
  app.post("/manual-insert", {
    schema: { tags: ["Berufsschule"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const tenantId = req.user.tenantId;
      const body = manualInsertSchema.parse(req.body);
      const dateUtc = new Date(body.date + "T00:00:00.000Z");

      // (3) cross-tenant employee lookup. Note: Employee model has no `deletedAt`
      // field — DSGVO deletion is implemented as anonymization (CLAUDE.md "DSGVO
      // Employee Deletion = Anonymization"), so the row stays present. Tenant scoping
      // is therefore sufficient for cross-tenant isolation (T-63-16).
      const employee = await app.prisma.employee.findFirst({
        where: { id: body.employeeId, tenantId },
        select: { id: true, classification: true },
      });
      if (!employee) {
        return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      }

      // BC proxy: routes to WorkEvent when tenantConfig.workEventModelLive=true
      // (Phase 79 Plan 04); else preserves legacy Absence path until Phase 80
      // retires it.
      // REVISION (W6): reuse the routing helper from utils/work-event.ts.
      // REVISION (WR-02, Phase 79 review): /manual-insert only needs the flag
      // (not the per-tenant BS minute config), so use the cached tenant-level
      // helper to share the 5-minute cache with /upcoming and the DELETE
      // handler. getRoutingConfig (per-employee) is reserved for callers that
      // need the additional BS minute config fields it returns.
      const live = await getTenantWorkEventModelLive(app.prisma, tenantId);

      if (live) {
        // NEW PATH — route to WorkEvent. Same gates as Plan 79-03 POST handler.
        // The classification gate (Plan 79-01 data-driven AZUBI rule) surfaces the
        // canonical message "Berufsschule ist nur für Azubis zulässig" — distinct
        // from the legacy branch's longer wording "Berufsschultage sind nur für
        // Auszubildende vorgesehen." so reviewers can tell which branch produced
        // the 400.
        try {
          assertClassificationAllowed(WorkEventType.VOCATIONAL_SCHOOL, employee.classification);
        } catch (err) {
          if (err instanceof ClassificationNotAllowedError) {
            return reply.code(err.statusCode).send({ error: err.message });
          }
          throw err;
        }

        // REVISION (B2): pass body.date STRING to the helper, not dateUtc.
        const tz = await getTenantTimezone(app.prisma, tenantId);
        try {
          await assertMonthNotLocked(app.prisma, employee.id, body.date, tz);
        } catch (err) {
          if (err instanceof LockedMonthError) {
            return reply.code(err.statusCode).send({ error: LOCKED_MONTH_ERROR_DE });
          }
          throw err;
        }

        // REVISION (B3): compute workedMinutes from the employee's WorkSchedule.
        // Writing 0 would silently zero out the BS-Tag saldo credit once Phase 80
        // flips workEventModelLive=true. See Phase 78 D-08 adapter parity invariant.
        const workedMinutes = await computeBsWorkedMinutes(app.prisma, employee.id, body.date);

        // REVISION (CR-01, Phase 79 review): honor schedule type when writing
        // expectedMinutes. aggregateLegacyAbsences (utils/work-event.ts:375) only
        // ADDs the expected-side amount when scheduleType !== MONTHLY_HOURS, and
        // aggregateWorkEvents sums row.expectedMinutes unconditionally. To preserve
        // strict 0-tolerance saldo parity across flag flip (CONTEXT D-08), we MUST
        // write expectedMinutes=NULL for MONTHLY_HOURS — matching Phase 63 D-04
        // ("expectedMinutes is NULL for MONTHLY_HOURS"). Otherwise the BC-proxy
        // live branch would contribute 480 to the Soll while the legacy branch
        // contributes 0 for the same scenario.
        const schedule = await app.prisma.workSchedule.findFirst({
          where: { employeeId: employee.id, validFrom: { lte: dateUtc } },
          orderBy: { validFrom: "desc" },
          select: { type: true },
        });
        const isMonthlyHours = schedule?.type === ScheduleType.MONTHLY_HOURS;
        const expectedMinutes = isMonthlyHours ? null : workedMinutes;

        try {
          const created = await app.prisma.workEvent.create({
            data: {
              employeeId: employee.id,
              type: WorkEventType.VOCATIONAL_SCHOOL,
              source: "MANUAL",
              date: dateUtc,
              workedMinutes,
              expectedMinutes,
              createdBy: req.user.sub,
            },
          });

          // REVISION (B6): dual AuditLog. The primary action matches Plan 79-03's
          // canonical WORK_EVENT_CREATED so reviewers see consistent action strings
          // across the migration; the breadcrumb says "this mutation came via the
          // legacy /vocational-school surface" so reviewers can trace it back.
          await app.audit({
            userId: req.user.sub,
            action: "WORK_EVENT_CREATED",
            entity: "WorkEvent",
            entityId: created.id,
            newValue: {
              employeeId: created.employeeId,
              date: body.date,
              type: created.type,
              source: created.source,
              workedMinutes: created.workedMinutes,
              expectedMinutes: created.expectedMinutes,
              viaBcProxy: true, // breadcrumb on newValue
            },
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });
          await app.audit({
            userId: req.user.sub,
            action: "VOCATIONAL_SCHOOL_MANUAL_INSERTED_VIA_BC_PROXY",
            entity: "WorkEvent",
            entityId: created.id,
            newValue: {
              employeeId: created.employeeId,
              date: body.date,
              note: "Created via BC proxy /vocational-school/manual-insert (Phase 79 Plan 04). Primary action: WORK_EVENT_CREATED.",
            },
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });

          return reply.code(201).send(created);
        } catch (err: unknown) {
          if (
            typeof err === "object" &&
            err !== null &&
            "code" in err &&
            (err as { code: unknown }).code === "P2002"
          ) {
            return reply.code(409).send({
              error: "Berufsschultag existiert bereits für diesen Tag.",
            });
          }
          throw err;
        }
      }

      // LEGACY PATH — preserved verbatim from Phase 63 D-23. Phase 80 retires this branch.
      // (4) AZUBI gate — server is the source of truth even when the UI hides the
      // action for non-AZUBI rows (defense in depth).
      if (employee.classification !== "AZUBI") {
        return reply.code(400).send({
          error: "Berufsschultage sind nur für Auszubildende vorgesehen.",
        });
      }

      // (5) locked-month gate
      const monthStart = monthStartUtc(dateUtc);
      const snapshot = await app.prisma.saldoSnapshot.findUnique({
        where: {
          employeeId_periodType_periodStart: {
            employeeId: employee.id,
            periodType: "MONTHLY",
            periodStart: monthStart,
          },
        },
        select: { id: true },
      });
      if (snapshot) {
        return reply.code(403).send({
          error: "Monat ist abgeschlossen und kann nicht bearbeitet werden.",
        });
      }

      // (6) try INSERT; rely on @@unique([employeeId, startDate, type]) for dedupe.
      try {
        const created = await app.prisma.absence.create({
          data: {
            employeeId: employee.id,
            type: AbsenceType.VOCATIONAL_SCHOOL,
            source: "MANUAL",
            startDate: dateUtc,
            endDate: dateUtc,
            days: 1.0,
            createdBy: req.user.sub,
          },
        });

        await app.audit({
          userId: req.user.sub,
          action: "VOCATIONAL_SCHOOL_MANUAL_INSERTED",
          entity: "Absence",
          entityId: created.id,
          newValue: {
            employeeId: created.employeeId,
            date: body.date,
            source: "MANUAL",
          },
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });

        // Phase 67.2 Plan 04 — Shift-Auto-Cleanup hook for MANUAL insert.
        // Reuses the same dispatcher as the Generator (PATTERN trigger) so the
        // cleanup + batched-notification surface is identical. Wrapped in try/catch
        // because the manual-insert MUST succeed even if cleanup fails — the
        // Absence is the user-visible artifact; cleanup is best-effort follow-up.
        try {
          const created_map = new Map<string, Date[]>();
          created_map.set(employee.id, [dateUtc]);
          await dispatchShiftCleanupForCreatedAbsences(
            app.prisma,
            app.audit,
            tenantId,
            created_map,
            new Date(),
            "MANUAL",
          );
        } catch (cleanupErr) {
          app.log.warn({ err: cleanupErr }, "Shift-Cleanup after manual BS insert failed");
        }

        return reply.code(201).send(created);
      } catch (err: unknown) {
        // Prisma P2002 = unique constraint violation. The @@unique([employeeId,
        // startDate, type]) on Absence (Phase 63 Plan 01) catches concurrent inserts.
        if (
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          (err as { code: unknown }).code === "P2002"
        ) {
          return reply.code(409).send({
            error: "Berufsschultag existiert bereits für diesen Tag.",
          });
        }
        throw err;
      }
    },
  });

  // ── 260601-g8l: DELETE /:absenceId (BS-Tag removal) ───────────────────────
  // Removes a manually-inserted Berufsschultag via soft delete. Symmetric counterpart
  // to D-23 manual-insert. Gates (in order — short-circuit on first failure):
  //   1. AuthN/AuthZ via requireRole ADMIN/MANAGER (T-g8l-06).
  //   2. Zod path-param parse (UUID) → 400 via global error handler.
  //   3. Cross-tenant Absence lookup (T-g8l-01) — 404 if employee.tenantId !== caller.
  //      Same 404 shape as already-deleted (gate 5) to avoid leaking existence.
  //   4. Type guard: type !== AbsenceType.VOCATIONAL_SCHOOL → 400. Protects against id-guessing
  //      across Absence subtypes — the route is BS-only.
  //   5. Idempotency / already-deleted guard (T-g8l-08) — 404 if deletedAt !== null.
  //      Soft-deleted rows are invisible to the API surface.
  //   6. Locked-month gate (CLAUDE.md Revisionssicherheit, T-g8l-07) — 403 if a
  //      SaldoSnapshot exists for (employeeId, MONTHLY, monthStart(startDate)).
  // On success: soft delete (deletedAt = now; Absence has no deletedBy column — the
  // deleter is captured exclusively in the AuditLog row) + emits
  // VOCATIONAL_SCHOOL_MANUAL_DELETED audit row with oldValue snapshot. Returns 204
  // (canonical for DELETE in this codebase — see apps/api/src/routes/shifts.ts).
  app.delete("/:absenceId", {
    schema: { tags: ["Berufsschule"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const tenantId = req.user.tenantId;
      const { absenceId } = deleteParamsSchema.parse(req.params);

      // BC proxy: routes to WorkEvent when tenantConfig.workEventModelLive=true
      // (Phase 79 Plan 04). The id might match a WorkEvent OR an Absence row;
      // the LIVE branch tries WorkEvent first and falls through to Absence on
      // miss (supports stale client ids during the post-migration grace window).
      // REVISION (WR-02, Phase 79 review): use the cached tenant-level helper.
      const live = await getTenantWorkEventModelLive(app.prisma, tenantId);

      if (live) {
        // Try WorkEvent first. REVISION (W3 DR7): filters deletedAt: null so a
        // soft-deleted WorkEvent id falls through to the Absence lookup, which
        // won't find it either → 404 (correct semantic, never resurrect a
        // soft-deleted row).
        const we = await app.prisma.workEvent.findFirst({
          where: {
            id: absenceId,
            deletedAt: null,
            type: WorkEventType.VOCATIONAL_SCHOOL,
            employee: { tenantId },
          },
          select: {
            id: true,
            employeeId: true,
            type: true,
            source: true,
            date: true,
            workedMinutes: true,
            expectedMinutes: true,
            payload: true,
            note: true,
          },
        });
        if (we) {
          // Locked-month gate.
          // REVISION (B2): convert we.date to YYYY-MM-DD string for the helper.
          const tz = await getTenantTimezone(app.prisma, tenantId);
          const weDateStr = we.date.toISOString().slice(0, 10);
          try {
            await assertMonthNotLocked(app.prisma, we.employeeId, weDateStr, tz);
          } catch (err) {
            if (err instanceof LockedMonthError) {
              return reply.code(err.statusCode).send({ error: LOCKED_MONTH_ERROR_DE });
            }
            throw err;
          }
          await app.prisma.workEvent.update({
            where: { id: we.id },
            data: { deletedAt: new Date() },
          });
          await app.audit({
            userId: req.user.sub,
            action: "WORK_EVENT_DELETED",
            entity: "WorkEvent",
            entityId: we.id,
            oldValue: {
              employeeId: we.employeeId,
              date: weDateStr,
              type: we.type,
              source: we.source,
              workedMinutes: we.workedMinutes,
              expectedMinutes: we.expectedMinutes,
              payload: we.payload,
              note: we.note,
              viaBcProxy: true,
            },
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });
          return reply.code(204).send();
        }
        // Fall through to Absence lookup — supports stale ids in the grace window
        // after migration. (Continues into the legacy block below.)
        // REVISION (W3 DR7): the WorkEvent findFirst above already filters
        // deletedAt: null, so a soft-deleted WorkEvent id falls through to the
        // Absence lookup, which won't find it either → 404 (correct semantic).
      }

      // LEGACY PATH (or post-fall-through) — preserved verbatim from Phase 63 /
      // 260601-g8l. Tenant-scoped Absence lookup, type guard (REVISION W3 DR8:
      // SICK absences fail this cleanly), idempotency, locked-month gate,
      // AuditLog VOCATIONAL_SCHOOL_MANUAL_DELETED.

      // (3) cross-tenant Absence lookup. We select the columns we need for the audit
      // snapshot in the same query — no second round trip on the happy path.
      const absence = await app.prisma.absence.findFirst({
        where: { id: absenceId, employee: { tenantId } },
        select: {
          id: true,
          type: true,
          startDate: true,
          employeeId: true,
          source: true,
          deletedAt: true,
        },
      });
      if (!absence) {
        return reply.code(404).send({ error: "Berufsschultag nicht gefunden" });
      }

      // (4) type guard — only BS-Tage are removable via this route.
      // REVISION (W3 DR8): when flag=true and the id matches a SICK/UNPAID
      // absence in the same tenant, the fall-through still produces the correct
      // 400 here. Test DR8 confirms.
      if (absence.type !== AbsenceType.VOCATIONAL_SCHOOL) {
        return reply.code(400).send({ error: "Eintrag ist kein Berufsschultag." });
      }

      // (5) idempotency — soft-deleted rows are invisible.
      if (absence.deletedAt !== null) {
        return reply.code(404).send({ error: "Berufsschultag nicht gefunden" });
      }

      // (6) locked-month gate — identical message + status to manual-insert's gate (5)
      // for UI consistency.
      const monthStart = monthStartUtc(absence.startDate);
      const snapshot = await app.prisma.saldoSnapshot.findUnique({
        where: {
          employeeId_periodType_periodStart: {
            employeeId: absence.employeeId,
            periodType: "MONTHLY",
            periodStart: monthStart,
          },
        },
        select: { id: true },
      });
      if (snapshot) {
        return reply.code(403).send({
          error: "Monat ist abgeschlossen und kann nicht bearbeitet werden.",
        });
      }

      // Soft delete — Absence model has NO `deletedBy` column (verified in
      // schema.prisma — only `deletedAt`, `createdBy`). The deleter is captured in
      // the AuditLog row, not on the row itself. Matches the soft-delete convention
      // on TimeEntry and LeaveRequest.
      await app.prisma.absence.update({
        where: { id: absence.id },
        data: { deletedAt: new Date() },
      });

      await app.audit({
        userId: req.user.sub,
        action: "VOCATIONAL_SCHOOL_MANUAL_DELETED",
        entity: "Absence",
        entityId: absence.id,
        oldValue: {
          employeeId: absence.employeeId,
          date: absence.startDate.toISOString().slice(0, 10),
          source: absence.source,
        },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return reply.code(204).send();
    },
  });
}
