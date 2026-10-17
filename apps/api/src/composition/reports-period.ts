import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  requirePermission,
  hasPermission,
  accessContextFromRequest,
  resolveAccessReach,
  resolveStammsalonScopedEmployeeIds,
  reportPopulationWhere,
  isEmployedInPeriod,
  type PermissionKey,
} from "../contexts/platform";
import {
  getTenantTimezone,
  monthRangeUtc,
  monthDateRange,
  todayInTz,
  computeMonthReportFigures,
} from "../contexts/working-time-account";
import {
  buildEmployeeInclude,
  computeEmployeeSummary,
  fetchConfirmedSection9CreditsByEmp,
  fetchLeaveDaysByCodeForMonthlyReport,
  dayBeforeStr,
  type EmployeeWithIncludes,
} from "./reports";

/**
 * Issue #612 — `GET /api/v1/reports/period`: the period report of the reports page.
 *
 * It SUMS what the working-time account and the absence kernels already answer per month
 * (Pattern 3, D-612-2) and computes no figure of its own: per month it runs exactly the
 * `/reports/monthly` assembly (P-03) — the #613 population of that month, the Stammsalon scope of
 * the caller's reach at that month's end, `computeMonthReportFigures` for Soll/Ist/Saldo/Gesamtsaldo
 * and `computeEmployeeSummary` for the sick days — through the helpers `reports.ts` exports, never
 * by editing the frozen `/monthly` handler. A person is listed with the months whose population
 * contains them; the row and the KPIs are sums of those months.
 *
 * Opening saldo (P-01) = the Gesamtsaldo at the end of the month BEFORE `from`, the very figure the
 * Monatsexport of that month prints; closing saldo (P-02) = the Gesamtsaldo of the person's last
 * listed month (a closed month's stored carry-over, an open month's value through yesterday).
 * Issue #681 made an open month's series start at the account chain through the day before the
 * month, so with several unclosed months the closing equals the live saldo at the same Stichtag.
 *
 * Soll follows the saldo gate (P-04): Soll and Ist together reveal the month saldo, so where
 * `overtime:read` does not cover a person in every listed month, Soll, saldo, opening and closing
 * are `null` (with `sollUnavailableReason: "NO_PERMISSION"`) and only Ist stays.
 *
 * The evaluation is sequential on purpose (P-09): every month of every person is an account read,
 * and the 12-month cap bounds the work. No parallel fan-out over persons or months.
 */

export const MAX_PERIOD_MONTHS = 12;

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const periodQuerySchema = z.object({
  from: z.string().regex(MONTH_PATTERN, "Ungültiger Monat (JJJJ-MM)"),
  to: z.string().regex(MONTH_PATTERN, "Ungültiger Monat (JJJJ-MM)"),
  employeeId: z.string().uuid().optional(),
});
type PeriodQuery = z.infer<typeof periodQuerySchema>;

type YearMonth = { year: number; month: number };

function parseMonth(value: string): YearMonth {
  return { year: Number(value.slice(0, 4)), month: Number(value.slice(5, 7)) };
}

/** Months between two year-months, both inclusive. */
function monthSpan(from: YearMonth, to: YearMonth): number {
  return (to.year - from.year) * 12 + (to.month - from.month) + 1;
}

function monthsOf(from: YearMonth, to: YearMonth): YearMonth[] {
  const months: YearMonth[] = [];
  let year = from.year;
  let month = from.month;
  for (let i = 0; i < monthSpan(from, to); i++) {
    months.push({ year, month });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

function monthBefore(ym: YearMonth): YearMonth {
  return ym.month === 1 ? { year: ym.year - 1, month: 12 } : { year: ym.year, month: ym.month - 1 };
}

export type PeriodMonthEntry = {
  year: number;
  month: number;
  workedMinutes: number;
  expectedMinutes: number | null;
  balanceMinutes: number | null;
  closingBalanceMinutes: number | null;
  confirmed: boolean;
  labelled: boolean;
  sickDays: number;
};

type PersonAccumulator = {
  employeeId: string;
  employeeName: string;
  firstName: string;
  lastName: string;
  employeeNumber: string;
  hireDate: Date;
  exitDate: Date | null;
  months: PeriodMonthEntry[];
  covered: boolean;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

export class PeriodRangeError extends Error {}

/** The range rules of P-09, answered before anything is read. */
function validateRange(query: PeriodQuery, currentMonth: YearMonth): YearMonth[] {
  const from = parseMonth(query.from);
  const to = parseMonth(query.to);
  const span = monthSpan(from, to);
  if (span < 1) throw new PeriodRangeError("„Bis“ liegt vor „Von“.");
  if (span > MAX_PERIOD_MONTHS) throw new PeriodRangeError("Höchstens 12 Monate auf einmal.");
  if (monthSpan(currentMonth, to) > 1) {
    throw new PeriodRangeError("Der Zeitraum darf nicht in der Zukunft liegen.");
  }
  return monthsOf(from, to);
}

async function assemblePeriodReport(
  app: FastifyInstance,
  req: FastifyRequest,
  query: PeriodQuery,
  permission: PermissionKey,
) {
  const tenantId = req.user.tenantId;
  const tz = await getTenantTimezone(app.prisma, tenantId);
  const today = todayInTz(tz);
  const currentMonth: YearMonth = { year: today.getUTCFullYear(), month: today.getUTCMonth() + 1 };
  const months = validateRange(query, currentMonth);

  const access = accessContextFromRequest(req);
  const reach = await resolveAccessReach(app.prisma, access, permission);
  // P-04: Soll and saldo follow overtime:read; the reach of that permission is judged per month.
  const canSeeSaldo = await hasPermission(req, "overtime:read:ZUGEWIESEN");
  const overtimeReach = canSeeSaldo
    ? await resolveAccessReach(app.prisma, access, "overtime:read:ZUGEWIESEN")
    : null;

  const persons = new Map<string, PersonAccumulator>();
  for (const ym of months) {
    const { start, end } = monthRangeUtc(ym.year, ym.month, tz);
    const { firstDay, lastDay } = monthDateRange(ym.year, ym.month, tz);

    const scopedIds =
      reach.kind === "wholeTenant"
        ? "all"
        : await resolveStammsalonScopedEmployeeIds(app.prisma, tenantId, reach, end);
    const overtimeIds =
      overtimeReach === null
        ? new Set<string>()
        : overtimeReach.kind === "wholeTenant"
          ? "all"
          : new Set(
              await resolveStammsalonScopedEmployeeIds(app.prisma, tenantId, overtimeReach, end),
            );

    const employees = (await app.prisma.employee.findMany({
      where: {
        tenantId,
        AND: [
          reportPopulationWhere(start, end),
          ...(query.employeeId ? [{ id: query.employeeId }] : []),
          ...(scopedIds !== "all" ? [{ id: { in: scopedIds } }] : []),
        ],
      },
      include: buildEmployeeInclude(firstDay, lastDay),
      orderBy: { lastName: "asc" },
    })) as unknown as EmployeeWithIncludes[];

    const section9ByEmp = await fetchConfirmedSection9CreditsByEmp(
      app,
      tenantId,
      firstDay,
      lastDay,
    );
    const leaveDaysByEmp = await fetchLeaveDaysByCodeForMonthlyReport(
      app,
      tenantId,
      employees,
      ym.year,
      ym.month,
    );

    for (const emp of employees) {
      const summary = computeEmployeeSummary(
        emp,
        firstDay,
        lastDay,
        tz,
        leaveDaysByEmp.get(emp.id) ?? new Map(),
        section9ByEmp.get(emp.id) ?? [],
      );
      const figures = await computeMonthReportFigures(app, emp.id, ym.year, ym.month);
      const monthCovered = overtimeIds === "all" || overtimeIds.has(emp.id);

      let person = persons.get(emp.id);
      if (!person) {
        person = {
          employeeId: emp.id,
          employeeName: `${emp.firstName} ${emp.lastName}`,
          firstName: emp.firstName,
          lastName: emp.lastName,
          employeeNumber: emp.employeeNumber,
          hireDate: emp.hireDate,
          exitDate: emp.exitDate,
          months: [],
          covered: canSeeSaldo,
        };
        persons.set(emp.id, person);
      }
      // A row is covered only if every listed month is.
      person.covered = person.covered && canSeeSaldo && monthCovered;
      person.months.push({
        year: ym.year,
        month: ym.month,
        workedMinutes: figures.workedMinutes,
        expectedMinutes: figures.expectedMinutes,
        balanceMinutes: figures.balanceMinutes,
        closingBalanceMinutes: figures.closingBalanceMinutes,
        confirmed: figures.confirmed,
        labelled: figures.labelled,
        sickDays: summary.sickDays,
      });
    }
  }

  // P-01: the opening saldo is the Gesamtsaldo of the month before `from`, for the persons that
  // belonged to that month. Only read where the row shows saldo values at all.
  const before = monthBefore(months[0]);
  const beforeRange = monthRangeUtc(before.year, before.month, tz);

  const ordered = [...persons.values()].sort(
    (a, b) =>
      a.lastName.localeCompare(b.lastName, "de") ||
      a.firstName.localeCompare(b.firstName, "de") ||
      a.employeeId.localeCompare(b.employeeId),
  );

  const rows = [];
  for (const person of ordered) {
    const covered = person.covered;
    let opening: number | null = null;
    if (covered && isEmployedInPeriod(person, beforeRange.start, beforeRange.end)) {
      opening = (await computeMonthReportFigures(app, person.employeeId, before.year, before.month))
        .closingBalanceMinutes;
    }
    const last = person.months[person.months.length - 1];
    const sum = (pick: (m: PeriodMonthEntry) => number | null): number =>
      person.months.reduce((s, m) => s + (pick(m) ?? 0), 0);
    rows.push({
      employeeId: person.employeeId,
      employeeName: person.employeeName,
      employeeNumber: person.employeeNumber,
      workedMinutes: sum((m) => m.workedMinutes),
      expectedMinutes: covered ? sum((m) => m.expectedMinutes) : null,
      balanceMinutes: covered ? sum((m) => m.balanceMinutes) : null,
      openingBalanceMinutes: opening,
      closingBalanceMinutes: covered ? last.closingBalanceMinutes : null,
      monthCount: person.months.length,
      confirmedMonthCount: person.months.filter((m) => m.confirmed).length,
      labelled: person.months.some((m) => m.labelled),
      sickDays: round2(sum((m) => m.sickDays)),
      ...(covered ? {} : { sollUnavailableReason: "NO_PERMISSION" as const }),
      months: person.months.map((m) =>
        covered
          ? m
          : { ...m, expectedMinutes: null, balanceMinutes: null, closingBalanceMinutes: null },
      ),
    });
  }

  const coveredRows = rows.filter((r) => r.sollUnavailableReason === undefined);
  const lastMonth = months[months.length - 1];
  const toIsCurrent =
    lastMonth.year === currentMonth.year && lastMonth.month === currentMonth.month;
  const closingAsOf = toIsCurrent
    ? new Date(today.getTime() - 86_400_000).toISOString().slice(0, 10)
    : dayBeforeStr(
        lastMonth.month === 12
          ? `${lastMonth.year + 1}-01-01`
          : `${lastMonth.year}-${String(lastMonth.month + 1).padStart(2, "0")}-01`,
      );
  const labelledMonths = rows.flatMap((r) => r.months.filter((m) => m.labelled));

  return {
    from: query.from,
    to: query.to,
    months,
    kpis: {
      personCount: rows.length,
      saldoPersonCount: coveredRows.length,
      workedMinutes: rows.reduce((s, r) => s + r.workedMinutes, 0),
      expectedMinutes:
        coveredRows.length > 0
          ? coveredRows.reduce((s, r) => s + (r.expectedMinutes ?? 0), 0)
          : null,
      balanceMinutes:
        coveredRows.length > 0
          ? coveredRows.reduce((s, r) => s + (r.balanceMinutes ?? 0), 0)
          : null,
      closingBalanceMinutes:
        coveredRows.length > 0
          ? coveredRows.reduce((s, r) => s + (r.closingBalanceMinutes ?? 0), 0)
          : null,
      closingAsOf,
      closingConfirmed:
        coveredRows.length > 0 && coveredRows.every((r) => r.months[r.months.length - 1].confirmed),
      allMonthsConfirmed: labelledMonths.length > 0 && labelledMonths.every((m) => m.confirmed),
      sickDays: round2(rows.reduce((s, r) => s + r.sickDays, 0)),
    },
    rows,
  };
}

export async function reportsPeriodRoutes(app: FastifyInstance) {
  // GET /api/v1/reports/period?from=YYYY-MM&to=YYYY-MM&employeeId=
  app.get("/period", {
    schema: {
      tags: ["Reporting"],
      security: [{ bearerAuth: [] }],
      description:
        "Period report: one row per person of the period with the per-month series (Soll, Ist, saldo, Gesamtsaldo, confirmation) taken from the working-time account, and the row and KPI sums of those months. At most 12 months, none in the future. Soll and saldo values are null without overtime:read over the person.",
    },
    preHandler: requirePermission("report:read:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const query = periodQuerySchema.parse(req.query);
      try {
        return await assemblePeriodReport(app, req, query, "report:read:ZUGEWIESEN");
      } catch (err) {
        if (err instanceof PeriodRangeError) return reply.code(400).send({ error: err.message });
        throw err;
      }
    },
  });
}
