import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import { getEffectiveSchedule, updateOvertimeAccount } from "./time-entries";
import {
  getTenantTimezone,
  dateStrInTz,
  monthRangeUtc,
  calcExpectedMinutesTz,
  calcLeaveAbsenceMinutesTz,
  getDayOfWeekInTz,
  getDayHoursFromSchedule,
} from "../utils/timezone";
import { getHolidays, STATE_MAP } from "../utils/holidays";
import { getVocationalSchoolMinutesForDate } from "../utils/vocational-school-saldo";
import { getEffectiveBreakDuration } from "../utils/break-effective"; // v1.8.9 — SHIFT_BASED netto
import { fetchCloseMonthData } from "../utils/close-month-data"; // PERF-V1814-01

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
      const balance = Number(account.balanceHours);
      const balanceMinutes = Math.round(balance * 60);

      // Max negative hours: per-employee override > tenant default > null (unlimited)
      const maxNegMinutes =
        schedule?.maxNegativeBalanceMinutes ??
        employee?.tenant?.config?.maxNegativeBalanceMinutes ??
        null;

      return {
        ...account,
        status:
          balance >= threshold ? "CRITICAL" : balance >= threshold * 0.67 ? "ELEVATED" : "NORMAL",
        threshold,
        maxNegativeBalanceMinutes: maxNegMinutes,
        isNegativeLimitExceeded: maxNegMinutes != null && balanceMinutes < -maxNegMinutes,
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
      }[] = [];

      for (const emp of employees) {
        // Skip employees hired after this month
        if (emp.hireDate > monthEnd) {
          continue;
        }

        // Check if snapshot already exists (= closed) — PERF-V1814-01: Map lookup, no DB call
        const existingSnapshot = (snapshotsByEmp.get(emp.id) ?? [])[0] ?? null;

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
          });
          continue;
        }

        const schedule = emp.workSchedules[0];

        // No schedule or MONTHLY_HOURS → ready (no daily checks needed)
        if (!schedule || String(schedule.type) === "MONTHLY_HOURS") {
          result.push({
            employeeId: emp.id,
            employeeName: `${emp.firstName} ${emp.lastName}`,
            employeeNumber: emp.employeeNumber,
            status: "ready",
          });
          continue;
        }

        // PERF-V1814-01: in-memory lookups from bulk-fetched Maps (no per-employee DB calls)
        // Find workdays without time entries
        const entries = entriesByEmp.get(emp.id) ?? [];
        const entryDates = new Set(entries.map((e) => dateStrInTz(e.date, tz)));

        // Check approved leave and absences
        const approvedLeave = leaveByEmp.get(emp.id) ?? [];
        const absences = absencesByEmp.get(emp.id) ?? [];

        // Build set of leave/absence dates (TZ-aware)
        const coveredDates = new Set<string>();
        for (const lr of approvedLeave) {
          const s = lr.startDate < monthStart ? monthStart : lr.startDate;
          const e = lr.endDate > monthEnd ? monthEnd : lr.endDate;
          const cur = new Date(s);
          while (cur <= e) {
            coveredDates.add(dateStrInTz(cur, tz));
            cur.setDate(cur.getDate() + 1);
          }
        }
        for (const ab of absences) {
          const s = ab.startDate < monthStart ? monthStart : ab.startDate;
          const e = ab.endDate > monthEnd ? monthEnd : ab.endDate;
          const cur = new Date(s);
          while (cur <= e) {
            coveredDates.add(dateStrInTz(cur, tz));
            cur.setDate(cur.getDate() + 1);
          }
        }

        // Add holidays (computed + manual) to coveredDates
        for (const dateStr of holidayDateStrings) {
          coveredDates.add(dateStr);
        }

        // Iterate workdays and find missing ones (TZ-aware date strings)
        const missingDates: string[] = [];
        const effectiveStart = emp.hireDate > monthStart ? emp.hireDate : monthStart;
        const cur = new Date(effectiveStart);
        while (cur <= monthEnd) {
          const dateStr = dateStrInTz(cur, tz);
          const dow = getDayOfWeekInTz(cur, tz);
          const expectedHours = getDayHoursFromSchedule(schedule as Record<string, unknown>, dow);

          if (expectedHours > 0 && !entryDates.has(dateStr) && !coveredDates.has(dateStr)) {
            missingDates.push(dateStr);
          }

          cur.setDate(cur.getDate() + 1);
        }

        if (missingDates.length > 0) {
          result.push({
            employeeId: emp.id,
            employeeName: `${emp.firstName} ${emp.lastName}`,
            employeeNumber: emp.employeeNumber,
            status: "missing",
            missingDates,
          });
        } else {
          result.push({
            employeeId: emp.id,
            employeeName: `${emp.firstName} ${emp.lastName}`,
            employeeNumber: emp.employeeNumber,
            status: "ready",
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
          const closedCount = relevantEmployees.filter((e) =>
            (snapshotsByEmp.get(e.id) ?? []).some(
              (s) => s.periodStart.getTime() === monthStart.getTime(),
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
              (snapshotsByEmp.get(e.id) ?? []).some(
                (s) => s.periodStart.getTime() === monthStart.getTime(),
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

        for (const emp of unclosedEmployees) {
          const schedule = emp.workSchedules[0];

          // No schedule or MONTHLY_HOURS → no missing dates
          if (!schedule || String(schedule.type) === "MONTHLY_HOURS") {
            continue;
          }

          // PERF-V1814-01: in-memory lookups from bulk-fetched Maps, filtered to this month
          // Find workdays without time entries
          const entries = (entriesByEmp.get(emp.id) ?? []).filter(
            (e) => e.date >= monthStart && e.date <= monthEnd,
          );
          const entryDates = new Set(entries.map((e) => dateStrInTz(e.date, tz)));

          // Check approved leave and absences
          const approvedLeave = (leaveByEmp.get(emp.id) ?? []).filter(
            (lr) => lr.startDate <= monthEnd && lr.endDate >= monthStart,
          );
          const absences = (absencesByEmp.get(emp.id) ?? []).filter(
            (ab) => ab.startDate <= monthEnd && ab.endDate >= monthStart,
          );

          // Build set of leave/absence dates (TZ-aware)
          const coveredDates = new Set<string>();
          for (const lr of approvedLeave) {
            const s = lr.startDate < monthStart ? monthStart : lr.startDate;
            const e = lr.endDate > monthEnd ? monthEnd : lr.endDate;
            const cur = new Date(s);
            while (cur <= e) {
              coveredDates.add(dateStrInTz(cur, tz));
              cur.setDate(cur.getDate() + 1);
            }
          }
          for (const ab of absences) {
            const s = ab.startDate < monthStart ? monthStart : ab.startDate;
            const e = ab.endDate > monthEnd ? monthEnd : ab.endDate;
            const cur = new Date(s);
            while (cur <= e) {
              coveredDates.add(dateStrInTz(cur, tz));
              cur.setDate(cur.getDate() + 1);
            }
          }

          // Check holidays: merge computed German Feiertage with pre-fetched DB holidays
          const computedHolidaysYS = getHolidays(year, yearStatusStateCode);
          for (const h of computedHolidaysYS) {
            coveredDates.add(h.date);
          }
          // PERF-V1814-01: filter year-range holidays to this month in memory (no DB call)
          const monthHolidays = yearHolidays.filter(
            (h) => h.date >= monthStart && h.date <= monthEnd,
          );
          for (const h of monthHolidays) {
            coveredDates.add(dateStrInTz(h.date, tz));
          }

          // Iterate workdays and find missing ones (TZ-aware date strings)
          const empMissingDates: string[] = [];
          const effectiveStart = emp.hireDate > monthStart ? emp.hireDate : monthStart;
          const cur = new Date(effectiveStart);
          while (cur <= monthEnd) {
            const dateStr = dateStrInTz(cur, tz);
            const dow = getDayOfWeekInTz(cur, tz);
            const expectedHours = getDayHoursFromSchedule(schedule as Record<string, unknown>, dow);

            if (expectedHours > 0 && !entryDates.has(dateStr) && !coveredDates.has(dateStr)) {
              empMissingDates.push(dateStr);
            }

            cur.setDate(cur.getDate() + 1);
          }

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
  });

  // POST /api/v1/overtime/close-month  – Monat abschließen (Snapshot erzeugen)
  app.post("/close-month", {
    schema: { tags: ["Überstunden"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { employeeId, year, month } = closeMonthSchema.parse(req.body);

      const employee = await app.prisma.employee.findUnique({
        where: { id: employeeId },
        select: {
          tenantId: true,
          hireDate: true,
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
        const prevSnapshot = await app.prisma.saldoSnapshot.findFirst({
          where: {
            employeeId,
            periodType: "MONTHLY",
            periodStart: prevStart,
            superseded: false,
          },
        });
        if (!prevSnapshot) {
          return reply.code(400).send({
            error: `Bitte zuerst ${MONTH_NAMES_DE[m - 1]} ${year} abschließen`,
          });
        }
      }

      // Check if snapshot already exists
      const existing = await app.prisma.saldoSnapshot.findFirst({
        where: {
          employeeId,
          periodType: "MONTHLY",
          periodStart: monthStart,
          superseded: false,
        },
      });
      if (existing) {
        return reply.code(409).send({ error: "Monat ist bereits abgeschlossen" });
      }

      // Don't allow closing future months
      const now = new Date();
      if (monthEnd > now) {
        return reply
          .code(400)
          .send({ error: "Zukünftige Monate können nicht abgeschlossen werden" });
      }

      const schedule = await getEffectiveSchedule(app, employeeId);
      const scheduleType = String(schedule.type ?? "");

      // Calculate worked minutes for the month
      const entries = await app.prisma.timeEntry.findMany({
        where: {
          employeeId,
          deletedAt: null,
          date: { gte: monthStart, lte: monthEnd },
          endTime: { not: null },
          type: "WORK",
          isInvalid: false,
        },
      });

      const workedMinutes = entries.reduce((sum, e) => {
        if (!e.endTime) return sum;
        return sum + (e.endTime.getTime() - e.startTime.getTime()) / 60000 - Number(e.breakMinutes);
      }, 0);

      // Effective start: hire date or month start, whichever is later
      const hireDateNorm = employee.hireDate
        ? new Date(dateStrInTz(employee.hireDate, tz) + "T00:00:00Z")
        : null;
      const effectiveStart = hireDateNorm && hireDateNorm > monthStart ? hireDateNorm : monthStart;

      const tenantConfig = await app.prisma.tenantConfig.findUnique({
        where: { tenantId: employee.tenantId },
      });
      // Phase 58 (#192): the previous isPureTracking-only leave/absence guard has been
      // superseded by a broader `scheduleType !== "MONTHLY_HOURS"` gate below. The
      // declaration was removed because no other site in this file consults it.

      // Phase 63 — Berufsschule (BS) doubling accumulator. Each branch (SHIFT_BASED,
      // standard) sets this from VOCATIONAL_SCHOOL absences; we add to workedMinutes
      // once at the end so both paths share a single integration point.
      let workedMinutesBs = 0;

      // ── Schedule-type-aware expected/holiday/leave/absence ─────────────────────
      // SHIFT_BASED: Σ Shift durations skipping leave/absence-covered days;
      // holiday/leave/absence subtractions stay at 0 (already excluded).
      // Otherwise: existing calcExpectedMinutesTz + holiday/leave/absence path.
      let expectedMinutes: number;
      let holidayMinutes: number;
      let leaveMinutes: number;
      let absenceMinutes: number;

      if (scheduleType === "SHIFT_BASED") {
        const shifts = await app.prisma.shift.findMany({
          where: {
            employeeId,
            date: { gte: effectiveStart, lte: monthEnd },
            deletedAt: null, // Phase 67.2 — overtime saldo ignores soft-deleted shifts
          },
          select: { date: true, startTime: true, endTime: true },
        });
        const approvedLeave = await app.prisma.leaveRequest.findMany({
          where: {
            employeeId,
            deletedAt: null, // required by soft-delete convention
            status: "APPROVED",
            startDate: { lte: monthEnd },
            endDate: { gte: effectiveStart },
          },
        });
        const absences = await app.prisma.absence.findMany({
          where: {
            employeeId,
            deletedAt: null, // required by soft-delete convention
            startDate: { lte: monthEnd },
            endDate: { gte: effectiveStart },
          },
        });

        // Phase 63 — Berufsschule (BS) doubling for the SHIFT_BASED close-month path.
        // Per D-01..D-04: a VOCATIONAL_SCHOOL Absence on a workday adds the same minutes
        // to BOTH workedMinutes AND expectedMinutes (FIXED_SCHEDULE / SHIFT_BASED) so the
        // balance stays neutral. Block-week cap (D-02 revised) is enforced inside
        // getVocationalSchoolMinutesForDate. MONTHLY_HOURS (D-04) adds to worked only.
        let bsWorkedMinutes = 0;
        let bsExpectedMinutes = 0;
        for (const ab of absences) {
          if (ab.type !== "VOCATIONAL_SCHOOL") continue;
          // VOCATIONAL_SCHOOL Absences from Phase 62 generator are single-day rows
          // (startDate === endDate). Defensive fallback: iterate the date range.
          const start = ab.startDate < effectiveStart ? effectiveStart : ab.startDate;
          const end = ab.endDate > monthEnd ? monthEnd : ab.endDate;
          const cur = new Date(start);
          while (cur <= end) {
            const bsMin = await getVocationalSchoolMinutesForDate(
              app.prisma,
              employeeId,
              cur,
              tenantConfig,
            );
            bsWorkedMinutes += bsMin;
            // SHIFT_BASED behaves like FIXED_SCHEDULE for BS doubling — both Soll-bearing.
            bsExpectedMinutes += bsMin;
            cur.setUTCDate(cur.getUTCDate() + 1);
          }
        }

        const coveredDates = new Set<string>();
        const addRange = (s: Date, e: Date) => {
          const cur = new Date(dateStrInTz(s, tz) + "T00:00:00Z");
          const end = new Date(dateStrInTz(e, tz) + "T00:00:00Z");
          while (cur <= end) {
            coveredDates.add(dateStrInTz(cur, tz));
            cur.setUTCDate(cur.getUTCDate() + 1);
          }
        };
        for (const lr of approvedLeave) {
          const s = lr.startDate < effectiveStart ? effectiveStart : lr.startDate;
          const e = lr.endDate > monthEnd ? monthEnd : lr.endDate;
          if (s <= e) addRange(s, e);
        }
        for (const ab of absences) {
          const s = ab.startDate < effectiveStart ? effectiveStart : ab.startDate;
          const e = ab.endDate > monthEnd ? monthEnd : ab.endDate;
          if (s <= e) addRange(s, e);
        }
        const hmToMin = (hm: string) => {
          const [h, m] = hm.split(":").map(Number);
          return (h ?? 0) * 60 + (m ?? 0);
        };
        // v1.8.9 — SHIFT_BASED netto: subtract configured break from brutto shift duration.
        // Fixes brutto-vs-netto mismatch in SaldoSnapshot.expectedMinutes.
        // Cross-midnight fix: if brutto < 0, add 1440 (mirrors shifts.ts /range endpoint).
        const employeeBreakShape = {
          breakOver6hOverride: employee.breakOver6hOverride ?? null,
          breakOver9hOverride: employee.breakOver9hOverride ?? null,
        };
        const tenantConfigShape = {
          defaultBreakOver6h: tenantConfig?.defaultBreakOver6h ?? 30,
          defaultBreakOver9h: tenantConfig?.defaultBreakOver9h ?? 45,
        };
        let shiftMinutes = 0;
        for (const sh of shifts) {
          if (coveredDates.has(dateStrInTz(sh.date, tz))) continue;
          let brutto = hmToMin(sh.endTime) - hmToMin(sh.startTime);
          if (brutto < 0) brutto += 24 * 60; // cross-midnight (e.g. 22:00–06:00)
          if (brutto <= 0) continue;
          const breakMin = getEffectiveBreakDuration(employeeBreakShape, tenantConfigShape, brutto);
          shiftMinutes += Math.max(0, brutto - breakMin);
        }
        expectedMinutes = shiftMinutes + bsExpectedMinutes;
        workedMinutesBs += bsWorkedMinutes;
        leaveMinutes = 0;
        absenceMinutes = 0;
        holidayMinutes = 0;
      } else {
        expectedMinutes = calcExpectedMinutesTz(schedule, effectiveStart, monthEnd, tz);

        // Subtract holidays: merge computed German Feiertage with DB-stored manual holidays
        const closeMonthStateCode = employee.tenant
          ? (STATE_MAP[employee.tenant.federalState] ?? "NI")
          : "NI";
        const closeMonthComputedHolidays = getHolidays(year, closeMonthStateCode).filter(
          (h) => h.date >= dateStrInTz(effectiveStart, tz) && h.date <= dateStrInTz(monthEnd, tz),
        );
        const closeMonthDbHolidays = await app.prisma.publicHoliday.findMany({
          where: {
            tenant: { employees: { some: { id: employeeId } } },
            date: { gte: effectiveStart, lte: monthEnd },
          },
        });
        // Deduplicate by date string
        const holidayDateSet = new Set<string>(closeMonthComputedHolidays.map((h) => h.date));
        const allCloseMonthHolidays: { date: Date; name?: string }[] = [
          ...closeMonthComputedHolidays.map((h) => ({ date: new Date(h.date + "T00:00:00Z") })),
          ...closeMonthDbHolidays.filter((h) => !holidayDateSet.has(dateStrInTz(h.date, tz))),
        ];
        // D-06: holiday dates as tenant-TZ strings, passed to calcLeaveAbsenceMinutesTz so a
        // holiday inside approved leave/absence is NOT double-deducted (holidayMinutes already
        // subtracts it separately). Brings overtime.ts manual close into parity with time-entries.ts
        // and recalculate-snapshots.ts (all three saldo paths now use the same single-deduction fix).
        const closeHolidayDateStrSet = new Set(
          allCloseMonthHolidays.map((h) => dateStrInTz(h.date, tz)),
        );

        // MONTHLY_HOURS Feiertagsabzug (Phase 15 — TENANT-01)
        const isMonthlyHoursDeduction =
          scheduleType === "MONTHLY_HOURS" &&
          Number(schedule.monthlyHours ?? 0) > 0 &&
          tenantConfig?.monthlyHoursHolidayDeduction === true;

        let workingDaysInRange = 0;
        if (isMonthlyHoursDeduction) {
          const wdCur = new Date(effectiveStart);
          while (wdCur <= monthEnd) {
            const wdDow = getDayOfWeekInTz(wdCur, tz);
            if (getDayHoursFromSchedule(schedule, wdDow) > 0) workingDaysInRange++;
            wdCur.setDate(wdCur.getDate() + 1);
          }
        }
        const dailySollMin =
          isMonthlyHoursDeduction && workingDaysInRange > 0
            ? (Number(schedule.monthlyHours!) * 60) / workingDaysInRange
            : 0;

        holidayMinutes = allCloseMonthHolidays.reduce((sum, h) => {
          const dow = getDayOfWeekInTz(h.date, tz);
          if (isMonthlyHoursDeduction) {
            return getDayHoursFromSchedule(schedule, dow) > 0 ? sum + dailySollMin : sum;
          }
          return sum + getDayHoursFromSchedule(schedule, dow) * 60;
        }, 0);

        // Subtract approved leave
        const approvedLeave = await app.prisma.leaveRequest.findMany({
          where: {
            employeeId,
            deletedAt: null, // required by soft-delete convention
            status: "APPROVED",
            startDate: { lte: monthEnd },
            endDate: { gte: monthStart },
          },
        });
        leaveMinutes = 0;
        // CLAUDE.md "Schedule Types": MONTHLY_HOURS — holiday/absence deductions do NOT
        // apply. Broader gate than the pre-#192 isPureTracking guard (which only covered
        // monthlyHours = 0); this extends the skip to all MONTHLY_HOURS schedules.
        if (scheduleType !== "MONTHLY_HOURS") {
          leaveMinutes = approvedLeave.reduce((sum, lr) => {
            const leaveStart = lr.startDate < effectiveStart ? effectiveStart : lr.startDate;
            const leaveEnd = lr.endDate > monthEnd ? monthEnd : lr.endDate;
            if (leaveStart > leaveEnd) return sum;
            // D-06: use calcLeaveAbsenceMinutesTz (not calcExpectedMinutesTz) to skip holidays
            // already counted in holidayMinutes — single-deduction parity with time-entries.ts.
            return (
              sum +
              calcLeaveAbsenceMinutesTz(schedule, leaveStart, leaveEnd, tz, {
                halfDay: Boolean(lr.halfDay),
                excludeHolidays: closeHolidayDateStrSet, // D-06: holiday inside leave deducted once
              })
            );
          }, 0);
        }

        // Subtract approved/recorded absences (Krank, Sonderurlaub, etc.)
        const absences = await app.prisma.absence.findMany({
          where: {
            employeeId,
            deletedAt: null, // required by soft-delete convention
            startDate: { lte: monthEnd },
            endDate: { gte: effectiveStart },
          },
        });
        absenceMinutes = 0;
        if (scheduleType !== "MONTHLY_HOURS") {
          absenceMinutes = absences.reduce((sum, ab) => {
            const absStart = ab.startDate < effectiveStart ? effectiveStart : ab.startDate;
            const absEnd = ab.endDate > monthEnd ? monthEnd : ab.endDate;
            if (absStart > absEnd) return sum;
            // D-06: use calcLeaveAbsenceMinutesTz to skip holidays already in holidayMinutes.
            return (
              sum +
              calcLeaveAbsenceMinutesTz(schedule, absStart, absEnd, tz, {
                excludeHolidays: closeHolidayDateStrSet, // D-06: holiday inside absence deducted once
              })
            );
          }, 0);
        }

        // Phase 63 — Berufsschule (BS) doubling for the standard close-month path.
        // Per D-01..D-04 the BS day contributes the same minutes to BOTH workedMinutes
        // AND expectedMinutes for FIXED_SCHEDULE / FLEXTIME (balance neutral).
        // MONTHLY_HOURS (D-04) only adds to workedMinutes — the Phase 58 rule already
        // skips absence-deduction from expected, so we mirror that with skip-on-expected.
        // The absenceMinutes subtractor is left unchanged: BS days are normal absences
        // that subtract the schedule's daily target; adding bsExpectedMinutes restores
        // the same magnitude, achieving the D-01 net-zero on saldo.
        let bsWorkedMinutes = 0;
        let bsExpectedMinutes = 0;
        for (const ab of absences) {
          if (ab.type !== "VOCATIONAL_SCHOOL") continue;
          const start = ab.startDate < effectiveStart ? effectiveStart : ab.startDate;
          const end = ab.endDate > monthEnd ? monthEnd : ab.endDate;
          const cur = new Date(start);
          while (cur <= end) {
            const bsMin = await getVocationalSchoolMinutesForDate(
              app.prisma,
              employeeId,
              cur,
              tenantConfig,
            );
            bsWorkedMinutes += bsMin;
            if (scheduleType !== "MONTHLY_HOURS") {
              bsExpectedMinutes += bsMin;
            }
            cur.setUTCDate(cur.getUTCDate() + 1);
          }
        }
        expectedMinutes += bsExpectedMinutes;
        // bsWorkedMinutes is added to workedMinutes below (post-branch) so both
        // SHIFT_BASED and standard paths share a single accumulator update.
        // Stash on a function-scoped binding via direct mutation of workedMinutesBs:
        workedMinutesBs += bsWorkedMinutes;
      }

      const netExpected = Math.max(
        0,
        expectedMinutes - holidayMinutes - leaveMinutes - absenceMinutes,
      );
      // Phase 63 — add BS-doubled minutes to worked (mirror of the +bsExpectedMinutes
      // we applied inside each branch). Net effect on balance is 0 for FIXED_SCHEDULE
      // (worked+=N, expected+=N — D-01) and "+ N to worked, 0 to expected" for
      // MONTHLY_HOURS (D-04 — already absence-skipped on expected side).
      const totalWorked = workedMinutes + workedMinutesBs;
      const balanceMinutes = Math.round(totalWorked - netExpected);

      // Get previous month's carry-over
      const prevSnapshot = await app.prisma.saldoSnapshot.findFirst({
        where: {
          employeeId,
          periodType: "MONTHLY",
          periodStart: { lt: monthStart },
          superseded: false,
        },
        orderBy: { periodStart: "desc" },
      });
      const prevCarryOver = prevSnapshot?.carryOver ?? 0;
      const carryOver = prevCarryOver + balanceMinutes;

      // D-05/D-06: Bifurcate on overtimeMode
      const isTrackOnly =
        String(schedule.type) === "MONTHLY_HOURS" && schedule.overtimeMode === "TRACK_ONLY";
      const effectiveCarryOver = isTrackOnly ? 0 : carryOver;

      // Create snapshot + lock entries
      const snapshot = await app.prisma.$transaction(async (tx) => {
        const snap = await tx.saldoSnapshot.create({
          data: {
            employeeId,
            periodType: "MONTHLY",
            periodStart: monthStart,
            periodEnd: monthEnd,
            workedMinutes: Math.round(totalWorked),
            expectedMinutes: Math.round(netExpected),
            balanceMinutes,
            carryOver: effectiveCarryOver,
            closedAt: new Date(),
            closedBy: req.user.sub,
          },
        });

        // Lock all time entries in this month
        await tx.timeEntry.updateMany({
          where: {
            employeeId,
            deletedAt: null,
            date: { gte: monthStart, lte: monthEnd },
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
      const snap = await app.prisma.saldoSnapshot.findFirst({
        where: {
          employeeId,
          periodType: "MONTHLY",
          periodStart: monthStart,
          superseded: false,
        },
      });
      if (!snap) {
        return reply.code(404).send({ error: "Monat ist nicht abgeschlossen" });
      }

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
            date: { gte: monthStart, lte: monthEnd },
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
}
