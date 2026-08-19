import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  getEffectiveSchedule,
  updateOvertimeAccount,
  computeOvertimeBalanceBreakdown,
  type OvertimeBalanceBreakdown,
} from "./time-entries";
import { getConfirmedCarryOver } from "../utils/confirmed-saldo"; // Phase 97-01
import { getTenantTimezone, dateStrInTz, monthRangeUtc, monthDayBounds } from "../utils/timezone";
import { getHolidays, STATE_MAP } from "../utils/holidays";
import { fetchCloseMonthData } from "../utils/close-month-data"; // PERF-V1814-01
import { periodStartWindow, isPeriodStartInMonth } from "../utils/snapshot-period";
import { closeEmployeeMonth } from "../utils/close-employee-month"; // Phase 76.26 — shared saldo core
import { findMissingWorkdays } from "../utils/find-missing-workdays"; // Phase 76.26 — gap detector
import {
  unconfirmedDaysFromEntries,
  findUnconfirmedBreakDays,
} from "../utils/find-unconfirmed-break-days"; // Phase 92 — BREAK-05 unconfirmed Pflichtpause gate
import { loadBsSlotOverrides } from "../utils/load-bs-slot-overrides"; // Phase 76.31 — D-06 slot overrides
import { computeMonthSaldo } from "../utils/month-saldo"; // §615 Team-Zeiten display fix
import { getCarryOverBase } from "../utils/carry-over-base"; // Phase 99 (OB-02) — shared chain-head seed
import { recalculateSnapshots } from "../utils/recalculate-snapshots"; // Phase 99 (OB-03) — full-history re-thread

const createPlanSchema = z.object({
  employeeId: z.string().uuid(),
  hoursToReduce: z.number().positive(),
  deadline: z.string().datetime(),
  note: z.string().optional(),
});

const payoutSchema = z.object({
  employeeId: z.string().uuid(),
  hours: z.number().positive(),
  note: z.string().optional(),
});

// Phase 99 (OB-03) — an opening balance is an assertion about time before tracking began.
// `.optional().nullable()` on every optional field, not bare `.optional()`: the Clokr web
// clients send `field: x ? x : null`, and a bare `.optional()` rejects an explicit `null`
// with a naked "Validierungsfehler" — this has shipped as a production bug once (v1.9.11).
const openingBalanceSchema = z.object({
  employeeId: z.string().uuid(),
  minutes: z.number().int(), // signed; negative = übernommene Minusstunden
  effectiveFrom: z.string().date(), // YYYY-MM-DD, @db.Date
  reason: z.string().min(10).max(500), // Pflichtfeld — Revisionssicherheit
  evidenceRef: z.string().max(200).optional().nullable(),
  approvedBy: z.string().uuid().optional().nullable(),
  supersededReason: z.string().max(500).optional().nullable(), // required when replacing an existing row
});

// Phase 76.7 (D-07) — § 18 ArbZG exempt employees never appear in close-month*
// status responses or snapshot creation. Single source of truth for the filter.
const EXCLUDE_EXEMPT_EMPLOYEE_FILTER = { isTimeTrackingExempt: false } as const;

export async function overtimeRoutes(app: FastifyInstance) {
  // GET /api/v1/overtime/:employeeId  – Kontostand
  app.get("/:employeeId", {
    schema: { tags: ["Überstunden"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { employeeId } = req.params as { employeeId: string };

      const account = await app.prisma.overtimeAccount.findUnique({
        where: { employeeId },
        include: {
          transactions: { orderBy: { createdAt: "desc" }, take: 20 },
        },
      });

      if (!account) return reply.code(404).send({ error: "Konto nicht gefunden" });

      const [schedule, employee] = await Promise.all([
        app.prisma.workSchedule.findFirst({
          where: { employeeId, validFrom: { lte: new Date() } },
          orderBy: { validFrom: "desc" },
        }),
        app.prisma.employee.findUnique({
          where: { id: employeeId },
          include: { tenant: { include: { config: true } } },
        }),
      ]);

      // Tenant isolation check (SEC-V1814-03 / D-02): compare via employee.tenantId
      if (!employee) return reply.code(404).send({ error: "Konto nicht gefunden" });
      if (employee.tenantId !== req.user.tenantId) {
        await app.audit({
          userId: req.user.sub,
          action: "CROSS_TENANT_ACCESS_DENIED",
          entity: "OvertimeAccount",
          entityId: account.id,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return reply.code(404).send({ error: "Konto nicht gefunden" });
      }
      // D-03: EMPLOYEE may only read their own overtime account
      if (req.user.role === "EMPLOYEE" && req.user.employeeId !== employeeId) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      const threshold = Number(schedule?.overtimeThreshold ?? 60);

      // v1.8.24 — return the LIVE lifetime overtime balance (through windowEnd: today only if today
      // has completed entries, else yesterday) instead of the stale event-driven
      // OvertimeAccount.balanceHours. Single source of truth = computeOvertimeBalanceBreakdown, the
      // same value updateOvertimeAccount persists (and that the §615 calendar/dashboard use). This
      // makes the Team-Zeiten GESAMT-SALDO tile month-INDEPENDENT (it no longer changes with the
      // viewed booking month) and correct. TRACK_ONLY → 0 (handled inside). Fail-safe: null
      // (§18-exempt) or any error → stored value, so this read never 500s.
      //
      // Phase 97-01 (SALDO-DISP-01/03/04) — the SAME call additively yields confirmedMinutes /
      // openMonthMinutes / hasClosedMonth / rosterIncomplete. Both non-happy branches (exempt →
      // breakdown null, or the catch) fall back identically, per 97-CONTEXT's post-research decision
      // 4: read confirmedMinutes/hasClosedMonth from the independent getConfirmedCarryOver query and
      // report openMonthMinutes: null so the forecast renders as unavailable — a fabricated 0 there
      // would be indistinguishable from a genuine zero forecast. That fallback query is itself
      // never-500 (own try/catch): a failure of getConfirmedCarryOver still yields the stored
      // balanceHours, just with confirmedMinutes/hasClosedMonth degraded to 0/false.
      let balance: number;
      let confirmedMinutes: number;
      let openMonthMinutes: number | null;
      let hasClosedMonth: boolean;
      let rosterIncomplete: boolean | undefined;

      let breakdown: OvertimeBalanceBreakdown | null = null;
      try {
        breakdown = await computeOvertimeBalanceBreakdown(app, employeeId);
      } catch (err) {
        app.log.warn({ err, employeeId }, "GET /overtime: live saldo failed, using stored");
        // breakdown stays null (its declared initial value) — never reassigned here.
      }

      if (breakdown !== null) {
        balance = breakdown.totalHours;
        confirmedMinutes = breakdown.confirmedMinutes;
        openMonthMinutes = breakdown.openMonthMinutes;
        hasClosedMonth = breakdown.hasClosedMonth;
        rosterIncomplete = breakdown.rosterIncomplete;
      } else {
        balance = Number(account.balanceHours);
        try {
          const confirmed = await getConfirmedCarryOver(app, employeeId);
          confirmedMinutes = confirmed.minutes;
          hasClosedMonth = confirmed.hasClosedMonth;
        } catch (fallbackErr) {
          app.log.warn(
            { err: fallbackErr, employeeId },
            "GET /overtime: confirmed carry-over fallback failed",
          );
          confirmedMinutes = 0;
          hasClosedMonth = false;
        }
        openMonthMinutes = null;
        rosterIncomplete = undefined;
      }
      const balanceMinutes = Math.round(balance * 60);

      // Max negative hours: per-employee override > tenant default > null (unlimited)
      const maxNegMinutes =
        schedule?.maxNegativeBalanceMinutes ??
        employee?.tenant?.config?.maxNegativeBalanceMinutes ??
        null;

      return {
        ...account,
        // Override the stored balanceHours with the live lifetime value (2-decimal so minutes survive).
        balanceHours: Math.round(balance * 100) / 100,
        status:
          balance >= threshold ? "CRITICAL" : balance >= threshold * 0.67 ? "ELEVATED" : "NORMAL",
        threshold,
        maxNegativeBalanceMinutes: maxNegMinutes,
        isNegativeLimitExceeded: maxNegMinutes != null && balanceMinutes < -maxNegMinutes,
        // Phase 97-01 (SALDO-DISP-01/03) — additive split fields. rosterIncomplete only present
        // when defined (SHIFT_BASED open partial month) — never a fabricated `false` key.
        confirmedMinutes,
        openMonthMinutes,
        hasClosedMonth,
        ...(rosterIncomplete !== undefined ? { rosterIncomplete } : {}),
      };
    },
  });

  // POST /api/v1/overtime/plans  – Abbauplan erstellen
  app.post("/plans", {
    schema: { tags: ["Überstunden"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const body = createPlanSchema.parse(req.body);

      // Tenant isolation check (SEC-V1814-03 / D-02): OvertimePlan has no tenantId — go via employee
      const planEmployee = await app.prisma.employee.findUnique({
        where: { id: body.employeeId },
        select: { tenantId: true },
      });
      if (!planEmployee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      if (planEmployee.tenantId !== req.user.tenantId) {
        await app.audit({
          userId: req.user.sub,
          action: "CROSS_TENANT_ACCESS_DENIED",
          entity: "Employee",
          entityId: body.employeeId,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      }

      const plan = await app.prisma.overtimePlan.create({
        data: {
          employeeId: body.employeeId,
          hoursToReduce: body.hoursToReduce,
          deadline: new Date(body.deadline),
          note: body.note,
          createdBy: req.user.sub,
        },
      });

      await app.audit({
        userId: req.user.sub,
        action: "CREATE",
        entity: "OvertimePlan",
        entityId: plan.id,
        newValue: plan,
      });

      return reply.code(201).send(plan);
    },
  });

  // POST /api/v1/overtime/payout  – Auszahlung beantragen
  app.post("/payout", {
    schema: { tags: ["Überstunden"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const body = payoutSchema.parse(req.body);

      // Tenant isolation check (SEC-V1814-03 / D-02): OvertimeAccount has no tenantId — go via employee
      const payoutEmployee = await app.prisma.employee.findUnique({
        where: { id: body.employeeId },
        select: { tenantId: true },
      });
      if (!payoutEmployee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      if (payoutEmployee.tenantId !== req.user.tenantId) {
        await app.audit({
          userId: req.user.sub,
          action: "CROSS_TENANT_ACCESS_DENIED",
          entity: "Employee",
          entityId: body.employeeId,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      }

      const schedule = await app.prisma.workSchedule.findFirst({
        where: { employeeId: body.employeeId, validFrom: { lte: new Date() } },
        orderBy: { validFrom: "desc" },
      });

      if (!schedule?.allowOvertimePayout) {
        return reply.code(400).send({ error: "Auszahlung für diesen Mitarbeiter nicht erlaubt" });
      }

      // PERF-V1814-02: SELECT … FOR UPDATE row lock inside interactive $transaction.
      // Prevents two concurrent payouts from both passing the balance check and both
      // decrementing, which would leave a negative balance (classic TOCTOU race).
      // Non-negative floor guard after the decrement provides defense-in-depth.
      // Audit stays OUTSIDE the transaction (COMP-V1814-05, deferred to 76.21).
      let result: { updatedAccount: { balanceHours: unknown; id: string }; txn: { id: string } };
      try {
        result = await app.prisma.$transaction(async (tx) => {
          // Lock the OvertimeAccount row — blocks any concurrent payout for this employee
          const [locked] = await tx.$queryRaw<Array<{ id: string; balanceHours: string }>>`
            SELECT id, "balanceHours"
            FROM "OvertimeAccount"
            WHERE "employeeId" = ${body.employeeId}
            FOR UPDATE
          `;

          if (!locked) {
            throw Object.assign(new Error("ACCOUNT_NOT_FOUND"), {
              httpStatus: 400,
              msg: "Nicht genug Überstunden auf dem Konto",
            });
          }

          if (Number(locked.balanceHours) < body.hours) {
            throw Object.assign(new Error("INSUFFICIENT_BALANCE"), {
              httpStatus: 400,
              msg: "Nicht genug Überstunden auf dem Konto",
            });
          }

          const updatedAccount = await tx.overtimeAccount.update({
            where: { employeeId: body.employeeId },
            data: { balanceHours: { decrement: body.hours } },
          });

          // Non-negative floor guard — REJECT (audit-proof), never clamp silently (CLAUDE.md)
          if (Number(updatedAccount.balanceHours) < 0) {
            throw Object.assign(new Error("OVERDRAW_PREVENTED"), {
              httpStatus: 400,
              msg: "Nicht genug Überstunden auf dem Konto",
            });
          }

          const txn = await tx.overtimeTransaction.create({
            data: {
              overtimeAccountId: locked.id,
              hours: -body.hours,
              type: "PAYOUT",
              description: body.note ?? `Auszahlung ${body.hours}h`,
              createdBy: req.user.sub,
            },
          });

          return { updatedAccount: { ...updatedAccount, id: updatedAccount.id }, txn };
        });
      } catch (err: unknown) {
        const e = err as { httpStatus?: number; msg?: string };
        if (e.httpStatus) {
          return reply.code(e.httpStatus).send({ error: e.msg });
        }
        throw err;
      }

      await app.audit({
        userId: req.user.sub,
        action: "PAYOUT",
        entity: "OvertimeAccount",
        entityId: result.updatedAccount.id,
        newValue: { hours: body.hours, transactionId: result.txn.id },
      });

      return { success: true, newBalance: Number(result.updatedAccount.balanceHours) };
    },
  });

  // ── Monatsabschluss ──────────────────────────────────────────────────────────

  // GET /api/v1/overtime/close-month/status?year=2026&month=2  – Status aller MA
  app.get("/close-month/status", {
    schema: { tags: ["Überstunden"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, _reply) => {
      const { year, month } = z
        .object({
          year: z.coerce.number().int().min(2020).max(2099),
          month: z.coerce.number().int().min(1).max(12),
        })
        .parse(req.query);

      const tenantId = req.user.tenantId;
      const tz = await getTenantTimezone(app.prisma, tenantId);
      const { start: monthStart, end: monthEnd } = monthRangeUtc(year, month, tz);
      // SNAP-05: use monthDayBounds for correct @db.Date filtering (shift query + findMissingWorkdays)
      const { firstDay: monthFirstDay, lastDay: monthLastDay } = monthDayBounds(
        monthStart,
        monthEnd,
        tz,
      );

      // PERF-V1814-01: Get employees with tenant JOIN (folds tenant.findUnique, no extra query)
      const employees = await app.prisma.employee.findMany({
        where: {
          tenantId,
          user: { isActive: true },
          ...EXCLUDE_EXEMPT_EMPLOYEE_FILTER, // Phase 76.7 (D-07, SALDO-V19-04a)
        },
        include: {
          user: { select: { isActive: true } },
          workSchedules: { orderBy: { validFrom: "desc" } },
          tenant: { select: { federalState: true } }, // fold tenant.findUnique (PERF-V1814-01)
        },
        orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      });

      // Phase 92 (BREAK-05): master gate — single tenant-config read outside the
      // per-employee loop (N+1-safe, PERF-V1814-01 preserved).
      const statusTenantConfig = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });
      const enforceBreakConfirmation = statusTenantConfig?.enforceBreakConfirmation ?? false;

      // PERF-V1814-01: bulk-fetch all per-employee data in 5 parallel queries (replaces N+1)
      const stateCode = STATE_MAP[employees[0]?.tenant?.federalState ?? "NIEDERSACHSEN"] ?? "NI";
      const holidayDateStrings = new Set<string>(getHolidays(year, stateCode).map((h) => h.date));
      const employeeIds = employees.map((e) => e.id);
      const {
        snapshotsByEmp,
        entriesByEmp,
        leaveByEmp,
        absencesByEmp,
        holidays: statusHolidays,
      } = await fetchCloseMonthData(app.prisma, tenantId, employeeIds, monthStart, monthEnd);
      // Add tenant-specific DB holidays to the computed holiday set
      for (const h of statusHolidays) {
        holidayDateStrings.add(dateStrInTz(h.date, tz));
      }

      const result: {
        employeeId: string;
        employeeName: string;
        employeeNumber: string;
        status: "ready" | "missing" | "closed";
        missingDates?: string[];
        snapshot?: Record<string, unknown>;
        unconfirmedBreakDays?: string[]; // Phase 92 (BREAK-05)
      }[] = [];

      for (const emp of employees) {
        // Skip employees hired after this month
        if (emp.hireDate > monthEnd) {
          continue;
        }

        // Check if snapshot already exists (= closed) — PERF-V1814-01: Map lookup, no DB call
        // isPeriodStartInMonth is REQUIRED here, not optional: fetchCloseMonthData's Q1 range
        // pre-fetch (periodStart gte start / lte end) is one day too wide at the upper bound
        // for the TZ-converted convention — month N+1's snapshot has periodStart equal to the
        // last UTC day of month N (e.g. July's snapshot carries periodStart=2026-06-30 for
        // Europe/Berlin), so it lands inside June's query range too. Taking `[0]` unfiltered
        // would attribute July's snapshot to June and report June as closed when it is not
        // (see debug session month-detail-shows-next-month-snapshot). year-status below already
        // guards against this the same way — keep both in sync.
        const existingSnapshot =
          (snapshotsByEmp.get(emp.id) ?? []).find((s) =>
            isPeriodStartInMonth(s.periodStart, monthStart),
          ) ?? null;

        if (existingSnapshot) {
          result.push({
            employeeId: emp.id,
            employeeName: `${emp.firstName} ${emp.lastName}`,
            employeeNumber: emp.employeeNumber,
            status: "closed",
            snapshot: {
              id: existingSnapshot.id,
              workedMinutes: existingSnapshot.workedMinutes,
              expectedMinutes: existingSnapshot.expectedMinutes,
              balanceMinutes: existingSnapshot.balanceMinutes,
              carryOver: existingSnapshot.carryOver,
              closedAt: existingSnapshot.closedAt,
              closedBy: existingSnapshot.closedBy,
            },
            unconfirmedBreakDays: [], // Pitfall 1 — closed months are done, never actionable
          });
          continue;
        }

        const schedule = emp.workSchedules[0];

        // No schedule or MONTHLY_HOURS → ready (no daily checks needed)
        // Phase 76.26: FLEXTIME is also gap-free (D-01 — no daily gap rule, like MONTHLY_HOURS).
        const scheduleTypeSt = String(schedule.type);
        if (!schedule || scheduleTypeSt === "MONTHLY_HOURS" || scheduleTypeSt === "FLEXTIME") {
          result.push({
            employeeId: emp.id,
            employeeName: `${emp.firstName} ${emp.lastName}`,
            employeeNumber: emp.employeeNumber,
            status: "ready",
            unconfirmedBreakDays: [], // RESOLVED Q1 — no daily gate for flexible schedules
          });
          continue;
        }

        // PERF-V1814-01: in-memory lookups from bulk-fetched Maps (no per-employee DB calls)
        // Find workdays without time entries
        const entries = entriesByEmp.get(emp.id) ?? [];
        const entryDates = new Set(entries.map((e) => dateStrInTz(e.date, tz)));

        // Check approved leave and absences (full rows from bulk-fetch — halfDay + type + source included)
        const approvedLeave = leaveByEmp.get(emp.id) ?? [];
        const absences = absencesByEmp.get(emp.id) ?? [];

        // Phase 76.26 Task 2: replace inline getDayHoursFromSchedule enumeration with findMissingWorkdays.
        // For SHIFT_BASED: fetch rosterDates (Shift.date set) from DB — pitfall A4 fix.
        // For FIXED types: rosterDates not needed (findMissingWorkdays uses getDayHoursFromSchedule internally).
        let statusRosterDates: Set<string> | undefined;
        if (scheduleTypeSt === "SHIFT_BASED") {
          const empShifts = await app.prisma.shift.findMany({
            where: {
              employeeId: emp.id,
              date: { gte: monthStart, lte: monthLastDay },
              deletedAt: null,
            },
            select: { date: true },
          });
          statusRosterDates = new Set(empShifts.map((sh) => dateStrInTz(sh.date, tz)));
        }

        const effectiveStartSt = emp.hireDate > monthFirstDay ? emp.hireDate : monthFirstDay;

        const gapResultSt = findMissingWorkdays({
          schedule: schedule as Record<string, unknown>,
          effectiveStart: effectiveStartSt,
          effectiveEnd: monthLastDay,
          tz,
          entryDates,
          approvedLeave: approvedLeave.map((lr) => ({
            startDate: lr.startDate,
            endDate: lr.endDate,
            halfDay: Boolean(lr.halfDay),
          })),
          absences: absences.map((ab) => ({
            startDate: ab.startDate,
            endDate: ab.endDate,
            halfDay: ab.halfDay,
          })),
          holidayDateStrings,
          rosterDates: statusRosterDates,
        });

        // Build missingDates from gaps (partial:true gaps also surfaced — 76.28 will style them)
        const missingDates = gapResultSt.gaps.map((g) => g.date);

        // Phase 92 (BREAK-05): derive unconfirmedBreakDays from the SAME bulk-fetched
        // `entries` (now carrying breakStatus+isLocked, close-month-data.ts Q2) — no
        // new DB call in the loop. Gated by enforceBreakConfirmation (master gate).
        // Additive/parallel to `status` — an employee can be gap-`ready` yet still
        // have unconfirmed AUTO breaks when the tenant is opted in.
        const unconfirmedBreakDays = unconfirmedDaysFromEntries(
          entries,
          tz,
          scheduleTypeSt,
          enforceBreakConfirmation,
        );

        if (missingDates.length > 0) {
          result.push({
            employeeId: emp.id,
            employeeName: `${emp.firstName} ${emp.lastName}`,
            employeeNumber: emp.employeeNumber,
            status: "missing",
            missingDates,
            unconfirmedBreakDays,
          });
        } else {
          result.push({
            employeeId: emp.id,
            employeeName: `${emp.firstName} ${emp.lastName}`,
            employeeNumber: emp.employeeNumber,
            status: "ready",
            unconfirmedBreakDays,
          });
        }
      }

      return { year, month, employees: result };
    },
  });

  // GET /api/v1/overtime/close-month/year-status?year=2026  – Year overview for all months
  app.get("/close-month/year-status", {
    schema: { tags: ["Überstunden"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, _reply) => {
      const { year } = z
        .object({
          year: z.coerce.number().int().min(2020).max(2099),
        })
        .parse(req.query);

      const MONTH_NAMES_DE = [
        "Januar",
        "Februar",
        "März",
        "April",
        "Mai",
        "Juni",
        "Juli",
        "August",
        "September",
        "Oktober",
        "November",
        "Dezember",
      ];

      const tenantId = req.user.tenantId;
      const tz = await getTenantTimezone(app.prisma, tenantId);
      const now = new Date();

      // PERF-V1814-01: Get employees with tenant JOIN (folds tenant.findUnique, no extra query)
      const employees = await app.prisma.employee.findMany({
        where: {
          tenantId,
          user: { isActive: true },
          ...EXCLUDE_EXEMPT_EMPLOYEE_FILTER, // Phase 76.7 (D-07, SALDO-V19-04a)
        },
        include: {
          user: { select: { isActive: true } },
          workSchedules: { orderBy: { validFrom: "desc" } },
          tenant: { select: { federalState: true } }, // fold tenant.findUnique (PERF-V1814-01)
        },
        orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      });

      // PERF-V1814-01: derive state code from joined tenant; bulk-fetch full-year data in 5 queries
      const yearStatusStateCode =
        STATE_MAP[employees[0]?.tenant?.federalState ?? "NIEDERSACHSEN"] ?? "NI";
      const { start: yearStart } = monthRangeUtc(year, 1, tz);
      const { end: yearEnd } = monthRangeUtc(year, 12, tz);
      const yearEmployeeIds = employees.map((e) => e.id);
      const {
        snapshotsByEmp,
        entriesByEmp,
        leaveByEmp,
        absencesByEmp,
        holidays: yearHolidays,
      } = await fetchCloseMonthData(app.prisma, tenantId, yearEmployeeIds, yearStart, yearEnd);

      // Build month statuses
      const months: {
        month: number;
        name: string;
        status: "closed" | "partial" | "ready" | "open" | "blocked" | "future" | "no_data";
        closedCount: number;
        totalCount: number;
        missing?: {
          employeeName: string;
          employeeNumber: string;
          missingDates: string[];
        }[];
      }[] = [];

      let previousOpen = false;

      for (let m = 1; m <= 12; m++) {
        const { start: monthStart, end: monthEnd } = monthRangeUtc(year, m, tz);

        // Determine which employees are relevant for this month (hired before month end)
        const relevantEmployees = employees.filter((emp) => emp.hireDate <= monthEnd);
        const totalCount = relevantEmployees.length;

        // No relevant employees for this month (no one hired yet)
        if (totalCount === 0) {
          months.push({
            month: m,
            name: MONTH_NAMES_DE[m - 1],
            status: "no_data",
            closedCount: 0,
            totalCount: 0,
          });
          continue;
        }

        // Check if this is a future month (month hasn't ended yet)
        if (monthEnd > now) {
          months.push({
            month: m,
            name: MONTH_NAMES_DE[m - 1],
            status: "future",
            closedCount: 0,
            totalCount,
          });
          continue;
        }

        // If a previous month is still open, this month is blocked
        if (previousOpen) {
          // PERF-V1814-01: count closed employees via pre-fetched snapshot Map (no DB call)
          // isPeriodStartInMonth: @db.Date values come back as UTC midnight — a getTime()
          // equality against the TZ-converted monthStart timestamp never matches.
          const closedCount = relevantEmployees.filter((e) =>
            (snapshotsByEmp.get(e.id) ?? []).some((s) =>
              isPeriodStartInMonth(s.periodStart, monthStart),
            ),
          ).length;
          months.push({
            month: m,
            name: MONTH_NAMES_DE[m - 1],
            status: "blocked",
            closedCount,
            totalCount,
          });
          continue;
        }

        // PERF-V1814-01: determine closed employees via pre-fetched snapshot Map (no DB call)
        const closedIds = new Set(
          relevantEmployees
            .filter((e) =>
              (snapshotsByEmp.get(e.id) ?? []).some((s) =>
                isPeriodStartInMonth(s.periodStart, monthStart),
              ),
            )
            .map((e) => e.id),
        );
        const closedCount = closedIds.size;

        if (closedCount === totalCount && totalCount > 0) {
          months.push({
            month: m,
            name: MONTH_NAMES_DE[m - 1],
            status: "closed",
            closedCount,
            totalCount,
          });
          continue;
        }

        // Not all closed — check for missing data on unclosed employees
        const unclosedEmployees = relevantEmployees.filter((e) => !closedIds.has(e.id));
        const missingDetails: {
          employeeName: string;
          employeeNumber: string;
          missingDates: string[];
        }[] = [];

        let anyMissing = false;

        // Phase 76.26 Task 2: build holiday set for this month (merged computed + DB).
        // Uses monthDayBounds for correct @db.Date filtering (SNAP-05).
        const { firstDay: ysMonthFirstDay, lastDay: ysMonthLastDay } = monthDayBounds(
          monthStart,
          monthEnd,
          tz,
        );
        const ysComputedHolidays = getHolidays(year, yearStatusStateCode);
        const ysMonthHolidayDateStrings = new Set<string>([
          ...ysComputedHolidays
            .filter(
              (h) =>
                h.date >= dateStrInTz(ysMonthFirstDay, tz) &&
                h.date <= dateStrInTz(ysMonthLastDay, tz),
            )
            .map((h) => h.date),
          ...yearHolidays
            .filter((h) => h.date >= monthStart && h.date <= monthEnd)
            .map((h) => dateStrInTz(h.date, tz)),
        ]);

        for (const emp of unclosedEmployees) {
          const schedule = emp.workSchedules[0];

          // No schedule or MONTHLY_HOURS → no missing dates
          // Phase 76.26: FLEXTIME is also gap-free (D-01 — no daily gap rule, like MONTHLY_HOURS).
          const scheduleTypeYs = String(schedule?.type ?? "");
          if (!schedule || scheduleTypeYs === "MONTHLY_HOURS" || scheduleTypeYs === "FLEXTIME") {
            continue;
          }

          // PERF-V1814-01: in-memory lookups from bulk-fetched Maps, filtered to this month
          // Find workdays without time entries
          const entries = (entriesByEmp.get(emp.id) ?? []).filter(
            (e) => e.date >= monthStart && e.date <= monthEnd,
          );
          const entryDates = new Set(entries.map((e) => dateStrInTz(e.date, tz)));

          // Check approved leave and absences (full rows — halfDay + type + source included)
          const approvedLeave = (leaveByEmp.get(emp.id) ?? []).filter(
            (lr) => lr.startDate <= monthEnd && lr.endDate >= monthStart,
          );
          const absences = (absencesByEmp.get(emp.id) ?? []).filter(
            (ab) => ab.startDate <= monthEnd && ab.endDate >= monthStart,
          );

          // Phase 76.26 Task 2: replace inline getDayHoursFromSchedule enumeration with findMissingWorkdays.
          // For SHIFT_BASED: fetch rosterDates (Shift.date set) from DB — pitfall A4 fix.
          let ysRosterDates: Set<string> | undefined;
          if (scheduleTypeYs === "SHIFT_BASED") {
            const empShiftsYs = await app.prisma.shift.findMany({
              where: {
                employeeId: emp.id,
                date: { gte: ysMonthFirstDay, lte: ysMonthLastDay },
                deletedAt: null,
              },
              select: { date: true },
            });
            ysRosterDates = new Set(empShiftsYs.map((sh) => dateStrInTz(sh.date, tz)));
          }

          const ysEffectiveStart = emp.hireDate > ysMonthFirstDay ? emp.hireDate : ysMonthFirstDay;

          const ysGapResult = findMissingWorkdays({
            schedule: schedule as Record<string, unknown>,
            effectiveStart: ysEffectiveStart,
            effectiveEnd: ysMonthLastDay,
            tz,
            entryDates,
            approvedLeave: approvedLeave.map((lr) => ({
              startDate: lr.startDate,
              endDate: lr.endDate,
              halfDay: Boolean(lr.halfDay),
            })),
            absences: absences.map((ab) => ({
              startDate: ab.startDate,
              endDate: ab.endDate,
              halfDay: ab.halfDay,
            })),
            holidayDateStrings: ysMonthHolidayDateStrings,
            rosterDates: ysRosterDates,
          });

          // Build empMissingDates from gaps (partial:true gaps also surfaced — 76.28 will style them)
          const empMissingDates = ysGapResult.gaps.map((g) => g.date);

          if (empMissingDates.length > 0) {
            anyMissing = true;
            missingDetails.push({
              employeeName: `${emp.firstName} ${emp.lastName}`,
              employeeNumber: emp.employeeNumber,
              missingDates: empMissingDates,
            });
          }
        }

        if (anyMissing) {
          previousOpen = true;
          months.push({
            month: m,
            name: MONTH_NAMES_DE[m - 1],
            status: "open",
            closedCount,
            totalCount,
            missing: missingDetails,
          });
        } else if (closedCount > 0 && closedCount < totalCount) {
          // Some closed, rest ready
          previousOpen = true;
          months.push({
            month: m,
            name: MONTH_NAMES_DE[m - 1],
            status: "partial",
            closedCount,
            totalCount,
          });
        } else {
          // None closed or all ready, no missing data
          previousOpen = true;
          months.push({
            month: m,
            name: MONTH_NAMES_DE[m - 1],
            status: "ready",
            closedCount,
            totalCount,
          });
        }
      }

      // Auto-close deadline: retry until 10th of following month
      const autoCloseDeadline = 10;

      // PERF-V1814-01: derive earliestYear from employee hire dates — no extra DB query.
      // hireDate is a reliable proxy: employees hired in year X started tracking time in X.
      const earliestYear =
        employees.length > 0
          ? Math.min(...employees.map((e) => new Date(e.hireDate).getFullYear()))
          : year;

      return { year, months, autoCloseDeadline, earliestYear };
    },
  });

  const closeMonthSchema = z.object({
    employeeId: z.string().uuid(),
    year: z.number().int().min(2020).max(2099),
    month: z.number().int().min(1).max(12),
    confirmGaps: z.boolean().optional(), // UX-01: manager acknowledgement gate (FORK-C)
  });

  // POST /api/v1/overtime/close-month  – Monat abschließen (Snapshot erzeugen)
  app.post("/close-month", {
    schema: { tags: ["Überstunden"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const body = closeMonthSchema.parse(req.body);
      const { employeeId, year, month } = body;

      const employee = await app.prisma.employee.findUnique({
        where: { id: employeeId },
        select: {
          tenantId: true,
          hireDate: true,
          exitDate: true, // CLOSE-04: clamp effectiveEnd to min(exitDate, monthLastDay)
          isTimeTrackingExempt: true, // Phase 76.7 (D-07, SALDO-V19-04a)
          breakOver6hOverride: true, // v1.8.9 — SHIFT_BASED netto saldo
          breakOver9hOverride: true, // v1.8.9 — SHIFT_BASED netto saldo
          tenant: { select: { federalState: true } },
        },
      });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      // Tenant isolation check (SEC-V1814-03 / D-02): tenantId already selected above
      if (employee.tenantId !== req.user.tenantId) {
        await app.audit({
          userId: req.user.sub,
          action: "CROSS_TENANT_ACCESS_DENIED",
          entity: "Employee",
          entityId: employeeId,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      }

      // Phase 76.7 (D-07) — exempt employees never get SaldoSnapshots created.
      // Return 200 with skipped flag so the bulk-close UI can short-circuit silently
      // without surfacing an error for the Inhaberin.
      if (employee.isTimeTrackingExempt) {
        app.log.info(
          { employeeId, year, month, exempt: true },
          "POST /close-month skipped (isTimeTrackingExempt)",
        );
        return reply.code(200).send({ skipped: true, reason: "isTimeTrackingExempt" });
      }

      const tz = await getTenantTimezone(app.prisma, employee.tenantId);
      const { start: monthStart, end: monthEnd } = monthRangeUtc(year, month, tz);

      // Reject if employee was hired after this month
      if (employee.hireDate > monthEnd) {
        return reply
          .code(400)
          .send({ error: "Mitarbeiter war in diesem Monat noch nicht eingestellt" });
      }

      // Sequential validation: all previous months of the same year must be closed
      const MONTH_NAMES_DE = [
        "Januar",
        "Februar",
        "März",
        "April",
        "Mai",
        "Juni",
        "Juli",
        "August",
        "September",
        "Oktober",
        "November",
        "Dezember",
      ];
      // Start from hire date or Jan 1 of the requested year, whichever is later
      const hireDateNormSeq = employee.hireDate
        ? new Date(dateStrInTz(employee.hireDate, tz) + "T00:00:00Z")
        : null;
      const jan1 = new Date(`${year}-01-01T00:00:00Z`);
      const seqStart = hireDateNormSeq && hireDateNormSeq > jan1 ? hireDateNormSeq : jan1;
      const seqStartMonth =
        seqStart.getUTCFullYear() === year
          ? seqStart.getUTCMonth() + 1 // 1-based month within the year
          : 1; // hire date is before this year, start from January

      for (let m = seqStartMonth; m < month; m++) {
        const { start: prevStart } = monthRangeUtc(year, m, tz);
        // Convention-robust window (see utils/snapshot-period.ts): matches both
        // TZ-converted and legacy UTC-naive periodStart rows.
        const prevSnapshot = await app.prisma.saldoSnapshot.findFirst({
          where: {
            employeeId,
            periodType: "MONTHLY",
            periodStart: periodStartWindow(prevStart),
            superseded: false,
          },
        });
        if (!prevSnapshot) {
          return reply.code(400).send({
            error: `Bitte zuerst ${MONTH_NAMES_DE[m - 1]} ${year} abschließen`,
          });
        }
      }

      // Check if snapshot already exists.
      // Convention-robust window: a legacy UTC-naive snapshot (periodStart = the 1st)
      // must also count as "closed" — an equality check on monthStart missed those
      // rows and allowed duplicate active snapshots for the same month.
      const existing = await app.prisma.saldoSnapshot.findFirst({
        where: {
          employeeId,
          periodType: "MONTHLY",
          periodStart: periodStartWindow(monthStart),
          superseded: false,
        },
      });
      if (existing) {
        return reply.code(409).send({ error: "Monat ist bereits abgeschlossen" });
      }

      // Reject closing month N while a LATER month is already closed: the later
      // snapshot's carryOver was computed WITHOUT this month's balance and would
      // become stale (the saldo chain silently drops this month). The operator
      // must unlock later months first, then close sequentially.
      // NOTE gte (not gt): the NEXT month's TZ-converted periodStart is the LAST day
      // of THIS month (e.g. July/Berlin summer → 2026-06-30), which equals monthEnd's
      // date part. gt would miss exactly that row.
      const laterSnapshot = await app.prisma.saldoSnapshot.findFirst({
        where: {
          employeeId,
          periodType: "MONTHLY",
          periodStart: { gte: monthEnd },
          superseded: false,
        },
        orderBy: { periodStart: "asc" },
      });
      if (laterSnapshot) {
        return reply.code(400).send({
          error:
            "Spätere Monate sind bereits abgeschlossen. Bitte zuerst die späteren Monate entsperren und dann sequentiell abschließen.",
        });
      }

      // Don't allow closing future months
      const now = new Date();
      if (monthEnd > now) {
        return reply
          .code(400)
          .send({ error: "Zukünftige Monate können nicht abgeschlossen werden" });
      }

      // Schedule valid for the MIDDLE of the target month — closing a past month
      // after a contract change must use the historical schedule (parity with
      // recalculate-snapshots.ts, which already selects by mid-month).
      const closeMidMonth = new Date((monthStart.getTime() + monthEnd.getTime()) / 2);
      const schedule = await getEffectiveSchedule(app, employeeId, closeMidMonth);
      const scheduleType = String(schedule.type ?? "");

      // Tenant-local day bounds for @db.Date column filters: the monthStart/monthEnd
      // TIMESTAMPS cast to the previous month's last day for UTC+ tenants (June/Berlin
      // monthStart = 2026-05-31T22:00Z → date '2026-05-31'), double-counting the
      // boundary day in adjacent snapshots.
      const { firstDay: monthFirstDay, lastDay: monthLastDay } = monthDayBounds(
        monthStart,
        monthEnd,
        tz,
      );

      // Effective start: hire date or first day of month, whichever is later
      const hireDateNorm = employee.hireDate
        ? new Date(dateStrInTz(employee.hireDate, tz) + "T00:00:00Z")
        : null;
      const effectiveStart =
        hireDateNorm && hireDateNorm > monthFirstDay ? hireDateNorm : monthFirstDay;

      // Phase 76.26 — P1 rewire: pre-fetch all data needed by closeEmployeeMonth.
      // The inline saldo computation (previously ~395 lines) is replaced by the shared
      // pure core. $transaction + app.audit + isLocked guard stay here (caller owns DB atomicity).

      const tenantConfig = await app.prisma.tenantConfig.findUnique({
        where: { tenantId: employee.tenantId },
      });

      // Build holiday set: merge computed German Feiertage + DB manual holidays.
      // Byte-identical to the previous inline path (overtime.ts old lines 1090–1113).
      const closeMonthStateCode = employee.tenant
        ? (STATE_MAP[employee.tenant.federalState] ?? "NI")
        : "NI";
      const closeMonthComputedHolidays = getHolidays(year, closeMonthStateCode).filter(
        (h) => h.date >= dateStrInTz(effectiveStart, tz) && h.date <= dateStrInTz(monthEnd, tz),
      );
      const closeMonthDbHolidays = await app.prisma.publicHoliday.findMany({
        where: {
          tenant: { employees: { some: { id: employeeId } } },
          date: { gte: effectiveStart, lte: monthLastDay },
        },
      });
      // Deduplicate by date string — same as the inline path had.
      const closeMonthHolidayDateSet = new Set<string>(
        closeMonthComputedHolidays.map((h) => h.date),
      );
      const holidayDateStrings = new Set<string>([
        ...closeMonthComputedHolidays.map((h) => h.date),
        ...closeMonthDbHolidays
          .filter((h) => !closeMonthHolidayDateSet.has(dateStrInTz(h.date, tz)))
          .map((h) => dateStrInTz(h.date, tz)),
      ]);

      // Pre-fetch all collections needed by closeEmployeeMonth.
      // Queries are byte-identical to those in the removed inline block.
      const [closeEntries, closeShifts, closeApprovedLeave, closeAbsences] = await Promise.all([
        // WORK entries — same filter as old inline path (effectiveStart..monthLastDay)
        app.prisma.timeEntry.findMany({
          where: {
            employeeId,
            deletedAt: null,
            date: { gte: effectiveStart, lte: monthLastDay },
            endTime: { not: null },
            type: "WORK",
            isInvalid: false,
          },
          select: { date: true, startTime: true, endTime: true, breakMinutes: true },
        }),
        // Shifts (SHIFT_BASED only — also fetch for non-SHIFT to avoid a branch here;
        // closeEmployeeMonth ignores the shifts array for non-SHIFT types).
        app.prisma.shift.findMany({
          where: {
            employeeId,
            date: { gte: effectiveStart, lte: monthLastDay },
            deletedAt: null, // Phase 67.2 — soft-deleted shifts excluded
          },
          select: { date: true, startTime: true, endTime: true },
        }),
        // Approved leave — same filter as old inline path
        app.prisma.leaveRequest.findMany({
          where: {
            employeeId,
            deletedAt: null,
            status: "APPROVED",
            startDate: { lte: monthEnd },
            endDate: { gte: monthStart },
          },
          select: { startDate: true, endDate: true, halfDay: true },
        }),
        // Absences — same filter as old inline path
        app.prisma.absence.findMany({
          where: {
            employeeId,
            deletedAt: null,
            startDate: { lte: monthEnd },
            endDate: { gte: effectiveStart },
          },
          select: {
            startDate: true,
            endDate: true,
            type: true,
            source: true,
            halfDay: true,
            // Phase 76.38 (D-11) — per-day Unterrichtszeit for duration-based BS slot.
            unterrichtsMinutes: true,
          },
        }),
      ]);

      // Get previous month's carry-over (unchanged from old path at :1254–1263)
      const prevSnapshot = await app.prisma.saldoSnapshot.findFirst({
        where: {
          employeeId,
          periodType: "MONTHLY",
          periodStart: { lt: monthStart },
          superseded: false,
        },
        orderBy: { periodStart: "desc" },
      });
      // Phase 99 (OB-02) — chain-head seeds resolve through the one shared helper;
      // identical to `?? 0` when the employee has no OpeningBalance.
      const carryOverIn = await getCarryOverBase(app.prisma, employeeId, prevSnapshot);

      // Phase 76.31 (D-06): load Employee + active-Pattern bsSlot* overrides so
      // the pure core resolves per-MA / per-pattern slot amounts (null → fallback).
      const { employeeSlots, patternSlots, patternUnterrichtsMinutenByDow } =
        await loadBsSlotOverrides(app.prisma, employeeId, monthFirstDay);

      // ── Phase 76.26: call the shared pure saldo core ──────────────────────────
      const r = closeEmployeeMonth({
        employeeId,
        monthStart,
        monthEnd,
        monthFirstDay,
        monthLastDay,
        tz,
        carryOverIn,
        schedule: schedule as Record<string, unknown>,
        hireDate: employee.hireDate,
        exitDate: employee.exitDate ?? null,
        isTimeTrackingExempt: false, // already short-circuited above
        breakOver6hOverride: employee.breakOver6hOverride ?? null,
        breakOver9hOverride: employee.breakOver9hOverride ?? null,
        entries: closeEntries.map((e) => ({
          date: e.date,
          startTime: e.startTime,
          endTime: e.endTime!,
          breakMinutes: e.breakMinutes,
        })),
        shifts: closeShifts.map((sh) => ({
          date: sh.date,
          startTime: sh.startTime,
          endTime: sh.endTime,
        })),
        approvedLeave: closeApprovedLeave.map((lr) => ({
          startDate: lr.startDate,
          endDate: lr.endDate,
          halfDay: Boolean(lr.halfDay),
        })),
        absences: closeAbsences.map((ab) => ({
          startDate: ab.startDate,
          endDate: ab.endDate,
          type: ab.type,
          source: ab.source,
          halfDay: Boolean(ab.halfDay),
          unterrichtsMinutes: ab.unterrichtsMinutes ?? null,
        })),
        holidayDateStrings,
        tenantConfig: tenantConfig
          ? {
              defaultBreakOver6h: tenantConfig.defaultBreakOver6h,
              defaultBreakOver9h: tenantConfig.defaultBreakOver9h,
              monthlyHoursHolidayDeduction: tenantConfig.monthlyHoursHolidayDeduction ?? undefined,
              vocationalSchoolMinutesPerDay:
                tenantConfig.vocationalSchoolMinutesPerDay ?? undefined,
              vocationalSchoolBlockMinutesPerWeek:
                tenantConfig.vocationalSchoolBlockMinutesPerWeek ?? undefined,
              // Phase 76.31 (D-06) — TenantConfig slot layer.
              bsSlotFirstLongDayMinutes: tenantConfig.bsSlotFirstLongDayMinutes ?? undefined,
              bsSlotSecondLongDayMinutes: tenantConfig.bsSlotSecondLongDayMinutes ?? undefined,
              bsSlotShortDayMinutes: tenantConfig.bsSlotShortDayMinutes ?? undefined,
              bsSlotBlockWeekMinutes: tenantConfig.bsSlotBlockWeekMinutes ?? undefined,
            }
          : null,
        // Phase 76.31 (D-06) — Employee/Pattern slot layers (null → fallback).
        employeeSlots,
        patternSlots,
        // Phase 76.38 (D-11) — Pattern per-DOW Unterrichtszeit fallback.
        patternUnterrichtsMinutenByDow,
      });

      // Unpack result — these replace the old inline-computed locals
      const {
        workedMinutes: closeWorkedMinutes,
        balanceMinutes,
        carryOverOut,
        effectiveCarryOverOut,
        snapshotExpectedMinutes,
        gaps,
      } = r;

      // UX-01 / FORK-C: confirmGaps gate (unconditional — no ADMIN bypass)
      // If gaps exist and caller has not acknowledged them, return 409 with gap metadata.
      if (gaps.length > 0 && !body.confirmGaps) {
        return reply.code(409).send({
          error: `${gaps.length} Tag${gaps.length === 1 ? "" : "e"} ohne Eintrag ${gaps.length === 1 ? "wird" : "werden"} als 0h gewertet. Bitte mit confirmGaps=true bestätigen.`,
          gapCount: gaps.length,
          gapDates: gaps.map((g) => g.date),
          requiresConfirmation: true,
        });
      }

      // Phase 92 (BREAK-05): hard block when the tenant has opted into BOTH the
      // master gate (enforceBreakConfirmation) AND the block flag
      // (blockMonthCloseOnUnconfirmedBreak) and unconfirmed AUTO Pflichtpause
      // days exist. Doubly-gated by design — findUnconfirmedBreakDays returns []
      // unless enforceBreakConfirmation is true, so an un-opted tenant is never
      // blocked. NO override-and-proceed bypass field (unlike gaps' confirmGaps) —
      // the block clears only by actually confirming/waiving the days via
      // PATCH /:id/break-status.
      // Read-only check — never mutates, audit-proof intact.
      if (tenantConfig?.blockMonthCloseOnUnconfirmedBreak) {
        const unconfirmedBreakDays = await findUnconfirmedBreakDays(app.prisma, {
          employeeId,
          monthFirstDay,
          monthLastDay,
          tz,
          scheduleType,
          enforceBreakConfirmation: tenantConfig?.enforceBreakConfirmation ?? false,
        });
        if (unconfirmedBreakDays.length > 0) {
          return reply.code(409).send({
            error: `${unconfirmedBreakDays.length} Tag${unconfirmedBreakDays.length === 1 ? "" : "e"} mit unbestätigter Pflichtpause. Bitte zuerst bestätigen oder „durchgearbeitet" erklären.`,
            unconfirmedBreakCount: unconfirmedBreakDays.length,
            unconfirmedBreakDays,
            requiresBreakConfirmation: true,
          });
        }
      }

      // Alias effectiveCarryOverOut → effectiveCarryOver for the $transaction below
      const effectiveCarryOver = effectiveCarryOverOut;
      const carryOver = carryOverOut;

      // Create snapshot + lock entries
      const snapshot = await app.prisma.$transaction(async (tx) => {
        const snap = await tx.saldoSnapshot.create({
          data: {
            employeeId,
            periodType: "MONTHLY",
            periodStart: monthStart,
            periodEnd: monthEnd,
            workedMinutes: closeWorkedMinutes,
            expectedMinutes: snapshotExpectedMinutes,
            balanceMinutes,
            carryOver: effectiveCarryOver,
            closedAt: new Date(),
            closedBy: req.user.sub,
            note:
              gaps.length > 0
                ? `${gaps.length} Lücke(n) als 0h geschlossen: ${gaps.map((g) => g.date).join(", ")}`
                : null,
          },
        });

        // Lock all time entries in this month (day bounds — the timestamp lower
        // bound casts to the previous month's last day for UTC+ tenants)
        await tx.timeEntry.updateMany({
          where: {
            employeeId,
            deletedAt: null,
            date: { gte: monthFirstDay, lte: monthLastDay },
          },
          data: { isLocked: true, lockedAt: new Date() },
        });

        // PERF-V1814-02: overtimeAccount.upsert inside the same tx as snapshot + entry-lock.
        // A crash between snapshot commit and upsert can no longer leave a stale live balance.
        // effectiveCarryOver=0 for TRACK_ONLY employees.
        await tx.overtimeAccount.upsert({
          where: { employeeId },
          create: { employeeId, balanceHours: effectiveCarryOver / 60 },
          update: { balanceHours: effectiveCarryOver / 60 },
        });

        // COMP-V1814-05 (audit F1): audit inside the same $transaction (pass tx) so a rollback
        // cannot leave the snapshot committed without its CREATE audit row (or vice-versa).
        await app.audit({
          tx,
          userId: req.user.sub,
          action: "CREATE",
          entity: "SaldoSnapshot",
          entityId: snap.id,
          newValue: snap,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });

        return snap;
      });

      // v1.8.24: refresh OvertimeAccount to the true RUNNING total (incl. the current
      // open month), mirroring the unlock-month path. Without this, closing a month
      // freezes balanceHours at the closed-month-end carryOver, so the displayed
      // GESAMT-SALDO would differ (lower) between a closed and a re-opened month even
      // though the §615 per-month balances are identical. Keeps GESAMT-SALDO consistent
      // regardless of a month's open/closed state.
      await updateOvertimeAccount(app, employeeId);

      // D-12: Informational hint if the request is made before the grace period ends.
      // gracePeriodEnds = the 15th of the month FOLLOWING the target month.
      // Note: Date.UTC(year, month, 15) — month here is 1-based, so passing it directly
      // (without -1) gives the first day of the FOLLOWING month in 0-based JS month index.
      // Example: year=2025, month=1 (January) → Date.UTC(2025, 1, 15) → Feb 15 2025 ✓
      const followingMonthDay15 = new Date(Date.UTC(year, month, 15));
      const isEarlyClose = now < followingMonthDay15;

      const responsePayload: Record<string, unknown> = { ...snapshot };
      if (isEarlyClose) {
        responsePayload.earlyClose = true;
        responsePayload.gracePeriodEnds = followingMonthDay15.toISOString();
      }

      return reply.code(201).send(responsePayload);
    },
  });

  const unlockMonthSchema = z.object({
    employeeId: z.string().uuid(),
    year: z.number().int().min(2020).max(2099),
    month: z.number().int().min(1).max(12),
    reason: z.string().min(1), // COMP-V1814-04: mandatory reason for supersede (Revisionssicherheit)
  });

  // POST /api/v1/overtime/unlock-month  – Monat entsperren (Snapshot als superseded markieren, Einträge entsperren)
  // COMP-V1814-04: ADMIN-only; supersedes snapshot (not hard-delete); mandatory reason required.
  app.post("/unlock-month", {
    schema: { tags: ["Überstunden"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { employeeId, year, month, reason } = unlockMonthSchema.parse(req.body);

      // Tenant isolation: verify the employee belongs to the caller's tenant
      const employee = await app.prisma.employee.findUnique({
        where: { id: employeeId },
        select: { tenantId: true },
      });
      if (!employee || employee.tenantId !== req.user.tenantId) {
        return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      }

      const tz = await getTenantTimezone(app.prisma, employee.tenantId);
      const { start: monthStart, end: monthEnd } = monthRangeUtc(year, month, tz);

      // Verify the month is actually closed — use findFirst with superseded:false
      // (compound accessor removed when @@unique replaced by partial unique index, COMP-V1814-04)
      // Convention-robust window: also matches legacy UTC-naive periodStart rows.
      const snap = await app.prisma.saldoSnapshot.findFirst({
        where: {
          employeeId,
          periodType: "MONTHLY",
          periodStart: periodStartWindow(monthStart),
          superseded: false,
        },
      });
      if (!snap) {
        return reply.code(404).send({ error: "Monat ist nicht abgeschlossen" });
      }

      // Day bounds for the @db.Date entry filter — the monthStart timestamp casts to
      // the PREVIOUS month's last day for UTC+ tenants and would unlock entries that
      // belong to the still-closed previous month.
      const { firstDay: unlockFirstDay, lastDay: unlockLastDay } = monthDayBounds(
        monthStart,
        monthEnd,
        tz,
      );

      // D-02/D-03: Atomic transaction — supersede snapshot + unlock all non-deleted entries
      // COMP-V1814-04: never hard-delete; mark superseded=true with reason (Revisionssicherheit)
      await app.prisma.$transaction(async (tx) => {
        await tx.saldoSnapshot.update({
          where: { id: snap.id },
          data: { superseded: true, supersededReason: reason },
        });
        await tx.timeEntry.updateMany({
          where: {
            employeeId,
            deletedAt: null,
            date: { gte: unlockFirstDay, lte: unlockLastDay },
          },
          data: { isLocked: false, lockedAt: null },
        });

        // D-02 / COMP-V1814-05 (audit F1): audit UNLOCK inside the same $transaction (pass tx) so a
        // rollback cannot leave the snapshot superseded without its UNLOCK audit row (or vice-versa).
        await app.audit({
          tx,
          userId: req.user.sub,
          action: "UNLOCK",
          entity: "SaldoSnapshot",
          entityId: snap.id,
          oldValue: snap,
          newValue: { superseded: true, reason },
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
      });

      // Recalculate live overtime balance now that the month is reopened (post-commit; idempotent)
      await updateOvertimeAccount(app, employeeId);

      return reply.code(200).send({ message: "Monat entsperrt" });
    },
  });

  // GET /api/v1/overtime/snapshots/:employeeId  – Alle Snapshots abrufen
  app.get("/snapshots/:employeeId", {
    schema: { tags: ["Überstunden"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { employeeId } = req.params as { employeeId: string };

      // Authorization: employees may only read their own snapshots; managers/admins may read any
      const isManager = ["ADMIN", "MANAGER"].includes(req.user.role);
      if (!isManager && req.user.employeeId !== employeeId) {
        return reply.code(403).send({ error: "Kein Zugriff" });
      }

      // Tenant isolation: verify the requested employee belongs to the caller's tenant
      const employee = await app.prisma.employee.findUnique({
        where: { id: employeeId },
        select: { tenantId: true },
      });
      if (!employee || employee.tenantId !== req.user.tenantId) {
        return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      }

      // PERF-V1814-03: cap at 120 (10 years × 12 monthly snapshots — defense-in-depth)
      const snapshots = await app.prisma.saldoSnapshot.findMany({
        where: { employeeId, superseded: false },
        orderBy: { periodStart: "desc" },
        take: 120,
      });
      return snapshots;
    },
  });

  // ── Jahresübertrag ───────────────────────────────────────────────────────────

  const closeYearSchema = z.object({
    employeeId: z.string().uuid(),
    year: z.number().int().min(2020).max(2099),
  });

  // POST /api/v1/overtime/close-year  – Jahresübertrag erstellen
  app.post("/close-year", {
    schema: { tags: ["Überstunden"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { employeeId, year } = closeYearSchema.parse(req.body);

      const employee = await app.prisma.employee.findUnique({
        where: { id: employeeId },
        select: { tenantId: true },
      });
      if (!employee || employee.tenantId !== req.user.tenantId) {
        return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      }

      // Year range
      const yearStart = new Date(`${year}-01-01T00:00:00Z`);
      const yearEnd = new Date(`${year}-12-31T23:59:59Z`);

      if (yearEnd > new Date()) {
        return reply.code(400).send({ error: "Laufendes Jahr kann nicht abgeschlossen werden" });
      }

      // Check if yearly snapshot already exists
      const existing = await app.prisma.saldoSnapshot.findFirst({
        where: {
          employeeId,
          periodType: "YEARLY",
          periodStart: { gte: new Date(`${year}-01-01`), lte: new Date(`${year}-01-02`) },
          superseded: false,
        },
      });
      if (existing) {
        return reply.code(409).send({ error: "Jahr ist bereits abgeschlossen" });
      }

      // Check all 12 months are closed
      const monthSnapshots = await app.prisma.saldoSnapshot.findMany({
        where: {
          employeeId,
          periodType: "MONTHLY",
          periodStart: { gte: yearStart, lte: yearEnd },
          superseded: false,
        },
        orderBy: { periodStart: "asc" },
      });

      if (monthSnapshots.length < 12) {
        const closedMonths = monthSnapshots.map((s) => new Date(s.periodStart).getUTCMonth() + 1);
        const missing = Array.from({ length: 12 }, (_, i) => i + 1).filter(
          (m) => !closedMonths.includes(m),
        );
        return reply.code(400).send({
          error: `Nicht alle Monate abgeschlossen. Fehlend: ${missing.join(", ")}`,
        });
      }

      // Calculate yearly totals from monthly snapshots
      const yearWorked = monthSnapshots.reduce((s, m) => s + m.workedMinutes, 0);
      const yearExpected = monthSnapshots.reduce((s, m) => s + m.expectedMinutes, 0);
      const yearBalance = monthSnapshots.reduce((s, m) => s + m.balanceMinutes, 0);

      // Last month's carryOver = cumulative balance through year-end
      //
      // Phase 99 (OB-02) — YEARLY roll-up review item, resolved: this handler does NOT seed a
      // chain head from a `?? 0` fallback and therefore does NOT call getCarryOverBase() here.
      // `decemberSnapshot.carryOver` is an ALREADY-RESOLVED value from a MONTHLY SaldoSnapshot
      // that was itself either a genuine mid-chain thread-forward (its own predecessor existed)
      // or — if December happened to be this employee's very first month ever — was already
      // seeded through getCarryOverBase() at ITS OWN close (overtime.ts manual close, or the
      // auto-close-month.ts head seed). Re-consulting the opening balance here would either be
      // a no-op (predecessor existed, so getCarryOverBase would just re-return the same value)
      // or, worse, incorrectly re-apply it if some future refactor ever loosened the "only at
      // the head" rule. The opening balance therefore reaches the yearly figure transitively
      // through the monthly chain it aggregates, never directly.
      const decemberSnapshot = monthSnapshots[monthSnapshots.length - 1];
      const finalCarryOver = decemberSnapshot.carryOver;

      // Apply carry-over rules from tenant config
      const tenantConfig = await app.prisma.tenantConfig.findUnique({
        where: { tenantId: employee.tenantId },
      });
      const mode = tenantConfig?.overtimeCarryOverMode ?? "FULL";
      const cap = tenantConfig?.overtimeCarryOverCap;

      let appliedCarryOver = finalCarryOver;
      if (mode === "RESET") {
        appliedCarryOver = 0;
      } else if (mode === "CAPPED" && cap != null && finalCarryOver > cap) {
        appliedCarryOver = cap;
      }
      // FULL: keep everything

      // PERF-V1814-02: saldoSnapshot.create + overtimeAccount.upsert in ONE $transaction.
      // A crash between the snapshot commit and the balance upsert can no longer leave
      // the live OvertimeAccount balance stale (previously no transaction at all here).
      const snapshot = await app.prisma.$transaction(async (tx) => {
        const snap = await tx.saldoSnapshot.create({
          data: {
            employeeId,
            periodType: "YEARLY",
            periodStart: yearStart,
            periodEnd: yearEnd,
            workedMinutes: yearWorked,
            expectedMinutes: yearExpected,
            balanceMinutes: yearBalance,
            carryOver: appliedCarryOver,
            closedAt: new Date(),
            closedBy: req.user.sub,
            note:
              mode === "RESET"
                ? "Jahresübertrag: Reset auf 0"
                : mode === "CAPPED" && cap != null && finalCarryOver > cap
                  ? `Jahresübertrag: gedeckelt auf ${Math.round(cap / 60)}h (${Math.round(finalCarryOver / 60)}h verfallen)`
                  : `Jahresübertrag: ${Math.round(appliedCarryOver / 60)}h`,
          },
        });

        await tx.overtimeAccount.upsert({
          where: { employeeId },
          create: { employeeId, balanceHours: appliedCarryOver / 60 },
          update: { balanceHours: appliedCarryOver / 60 },
        });

        return snap;
      });

      await app.audit({
        userId: req.user.sub,
        action: "CREATE",
        entity: "SaldoSnapshot",
        entityId: snapshot.id,
        newValue: { ...snapshot, mode, originalCarryOver: finalCarryOver },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return reply.code(201).send(snapshot);
    },
  });

  // ── Eröffnungssaldo (OB-03) ───────────────────────────────────────────────────

  // POST /api/v1/overtime/opening-balance – Eröffnungssaldo erfassen/korrigieren
  // ADMIN only (locked decision D-05): an opening balance is an assertion about time
  // before tracking began, not manager routine.
  app.post("/opening-balance", {
    schema: { tags: ["Überstunden"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const {
        employeeId,
        minutes,
        effectiveFrom,
        reason,
        evidenceRef,
        approvedBy,
        supersededReason,
      } = openingBalanceSchema.parse(req.body);

      const employee = await app.prisma.employee.findUnique({
        where: { id: employeeId },
        select: { tenantId: true, hireDate: true },
      });

      // Tenant isolation (mirrors leave.ts:1206-1216): fetch-then-compare via
      // employee.tenantId, 404 (never 403 — which would confirm the id exists).
      if (!employee || employee.tenantId !== req.user.tenantId) {
        await app.audit({
          userId: req.user.sub,
          action: "CROSS_TENANT_ACCESS_DENIED",
          entity: "OpeningBalance",
          entityId: employeeId,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      }

      const current = await app.prisma.openingBalance.findFirst({
        where: { employeeId, superseded: false },
      });

      if (current && !supersededReason) {
        return reply.code(400).send({
          error:
            "Für die Korrektur eines bestehenden Eröffnungssaldos ist eine Begründung erforderlich.",
        });
      }

      const effectiveFromDate = new Date(`${effectiveFrom}T00:00:00Z`);

      // ── ONE $transaction for the mutation + its audit (locked decision D-06) ──
      // ORDER MATTERS: the partial unique index allows at most ONE superseded=false
      // row per employee and is NOT deferrable — the old row must be deactivated
      // BEFORE the new row is created, never the other way round, not even
      // momentarily inside this transaction.
      const created = await app.prisma.$transaction(async (tx) => {
        if (current) {
          await tx.openingBalance.update({
            where: { id: current.id },
            data: { superseded: true, supersededReason },
          });
        }

        const row = await tx.openingBalance.create({
          data: {
            employeeId,
            minutes,
            effectiveFrom: effectiveFromDate,
            reason,
            evidenceRef: evidenceRef ?? null,
            source: "ADMIN_ENTRY",
            createdBy: req.user.sub,
            // approvedBy/approvedAt are POPULATED but NOT ENFORCED (locked decision D-05):
            // with a single admin in the real deployment, a mandatory second-person approval
            // would either block the operation outright or degrade into a self-approval
            // fiction. The columns stay for when a second admin exists. This is deliberately
            // weaker than the leave-cancellation four-eyes rule, stated as such rather than
            // left to look like an oversight.
            approvedBy: approvedBy ?? null,
            approvedAt: approvedBy ? new Date() : null,
          },
        });

        if (current) {
          await tx.openingBalance.update({
            where: { id: current.id },
            data: { supersededBy: row.id },
          });
        }

        await app.audit({
          userId: req.user.sub,
          action: current ? "SUPERSEDE" : "CREATE",
          entity: "OpeningBalance",
          entityId: row.id,
          oldValue: current ?? undefined,
          newValue: row,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
          tx,
        });

        return row;
      });

      // Phase 99 (D-06). recalculateSnapshots() opens its OWN $transaction per snapshot
      // and cannot join an external one, so this deliberately runs AFTER the commit above
      // rather than inside it. The improvement over the Phase-94 precedent (leave.ts:1510)
      // is NOT the transaction boundary — it is the absence of .catch(): a failed recalc
      // must surface as a 5xx so the operator retries, never be logged and forgotten while
      // the stored value and the chain disagree. recalculateSnapshots is documented
      // idempotent, so a retry after a partial failure is safe.
      //
      // recalcFrom must be at/before the employee's FIRST snapshot, otherwise prevSnapshot
      // is non-null and the opening balance is (correctly) ignored — the recalc would
      // appear to do nothing. Taking the earlier of effectiveFrom and hireDate guarantees
      // a full-history re-thread.
      const recalcFrom = new Date(
        Math.min(effectiveFromDate.getTime(), employee.hireDate.getTime()),
      );
      const { lockedMonthsSkipped } = await recalculateSnapshots(app, employeeId, recalcFrom);

      const warning =
        lockedMonthsSkipped.length > 0
          ? `Der Eröffnungssaldo wurde gespeichert. ${lockedMonthsSkipped.length} abgeschlossene(r) Monat(e) wurden nicht neu berechnet (Abschluss ist unveränderbar) und müssen ggf. manuell geprüft werden.`
          : undefined;

      return reply.code(201).send({
        openingBalance: created,
        supersededId: current?.id ?? null,
        lockedMonthsSkipped,
        ...(warning ? { warning } : {}),
      });
    },
  });

  // ── §615 Team-Zeiten monthly saldo display ──────────────────────────────────

  // GET /api/v1/overtime/month-saldo/:employeeId?year=&month=
  // Returns §615-consistent monthly saldo + per-day cumulative series.
  // EMPLOYEE may only read their own; ADMIN/MANAGER may read any in their tenant.
  app.get("/month-saldo/:employeeId", {
    schema: { tags: ["Überstunden"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { employeeId } = req.params as { employeeId: string };
      const { year, month } = z
        .object({
          year: z.coerce.number().int().min(2020).max(2099),
          month: z.coerce.number().int().min(1).max(12),
        })
        .parse(req.query);

      // D-03: EMPLOYEE may only read their own saldo (mirrors GET /:employeeId above)
      if (req.user.role === "EMPLOYEE" && req.user.employeeId !== employeeId) {
        return reply.code(403).send({ error: "Kein Zugriff" });
      }

      // Tenant isolation: employee must belong to the caller's tenant
      const employee = await app.prisma.employee.findUnique({
        where: { id: employeeId },
        select: { tenantId: true },
      });
      if (!employee || employee.tenantId !== req.user.tenantId) {
        return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      }

      const result = await computeMonthSaldo(app, employeeId, year, month);
      return result;
    },
  });
}
