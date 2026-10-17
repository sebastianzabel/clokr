import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  requirePermission,
  hasPermission,
  accessContextFromRequest,
  resolveAccessReach,
  resolveStammsalonScopedEmployeeIds,
  resolveSalonInReach,
  homeSalonsForDays,
  type AccessReach,
  reportPopulationWhere,
  isEmployedInPeriod,
  type PermissionKey,
} from "../contexts/platform";
import {
  getTenantTimezone,
  monthRangeUtc,
  monthDateRange,
  dateStrInTz,
  dayRangeUtc,
  todayInTz,
  computeMonthReportFigures,
} from "../contexts/working-time-account";
import { employeesWithValidWorkSince, addWorkingMinutes } from "../contexts/time-tracking";
import { listEntitlementsForYear, vacationEntitlementWarning } from "../contexts/absence";
import type { LeaveTypeCode } from "@clokr/db";
import type { LeaveDaysForCode } from "../contexts/absence";
import {
  buildEmployeeInclude,
  computeEmployeeSummary,
  fetchConfirmedSection9CreditsByEmp,
  fetchLeaveDaysByCodeForMonthlyReport,
  dayBeforeStr,
  calendarDaysBetween,
  salonPersonsAtStichtag,
  vacationYearFigures,
  yearPopulationPeriod,
  type EmployeeWithIncludes,
} from "./reports";
import { salonViewMemberIds, SALON_VIEW_NOT_FOUND } from "./salon-view";
import { periodCsvFilename, periodTableCsv } from "./period-csv";

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
  // Issue #542 rules (P-04): a malformed id answers 400 through the global handler before anything is read.
  salonId: z.string().uuid().optional(),
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

/** Why Soll and saldo are withheld on a row: no `overtime:read` (wins) or the salon filter (#542). */
export type SollUnavailableReason = "NO_PERMISSION" | "SALON_FILTER";

/** The salon the chosen id does not name (foreign, unknown, inactive or outside the reach): one 404. */
export class PeriodSalonNotFoundError extends Error {}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * What an evaluation reads: `"all"` is the page's answer; `"times"` (the CSV export of 612-03) needs
 * neither the vacation tables nor the absence statistics and skips their reads.
 */
export type PeriodSections = "all" | "times";
export type PeriodOptions = { sections?: PeriodSections };

// P-07: the per-kind absence counts of `computeEmployeeSummary`, keyed by CODE — never by a display
// name (leave-type identity guard). The sick row is separate: it counts calendar days (#84 kernel).
const ABSENCE_KIND_ORDER = [
  "VACATION",
  "OVERTIME_COMP",
  "SPECIAL",
  "EDUCATION",
  "UNPAID",
  "MATERNITY",
  "PARENTAL",
] as const satisfies readonly LeaveTypeCode[];
type AbsenceKindCode = (typeof ABSENCE_KIND_ORDER)[number];

function absenceKindDays(
  summary: ReturnType<typeof computeEmployeeSummary>,
): Record<AbsenceKindCode, number> {
  return {
    VACATION: summary.vacationDays,
    OVERTIME_COMP: summary.overtimeCompDays,
    SPECIAL: summary.specialLeaveDays,
    EDUCATION: summary.educationDays,
    UNPAID: summary.unpaidDays,
    MATERNITY: summary.maternityDays,
    PARENTAL: summary.parentalDays,
  };
}

type AbsenceTotal = { totalDays: number; persons: Set<string> };

export type PeriodAbsence = {
  code: AbsenceKindCode | "SICK";
  /** Arbeitstage (priced, § 9 netted) for the leave kinds, Kalendertage for sickness. */
  unit: "WORKDAYS" | "CALENDAR_DAYS";
  personCount: number;
  totalDays: number;
};

export type PeriodVacationRow = {
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  year: number;
  entitlementId: string | null;
  entitlementDays: number | null;
  carriedOverDays: number | null;
  carriedOverEffectiveDays: number | null;
  carriedOverExpiredDays: number | null;
  exitReductionDays: number | null;
  availableDays: number | null;
  takenDays: number | null;
  approvedUpcomingDays: number | null;
  pendingDays: number | null;
  remainingDays: number | null;
  atRiskDays: number | null;
  /** `YYYY-MM-DD` (the `@db.Date` value), or `null`. */
  carryOverDeadline: string | null;
  /** ISO instant of the newest CARRYOVER_WARNED audit row of the entitlement, or `null`. */
  lastWarningSentAt: string | null;
  missingEntitlement: boolean;
  entitlementWarning: string | null;
};

export type PeriodVacationYear = { year: number; asOf: string; rows: PeriodVacationRow[] };

/** Stichtag of a vacation year inside the period: its last period day, never later than yesterday. */
function vacationStichtag(
  year: number,
  months: readonly YearMonth[],
  tz: string,
  yesterday: string,
): string {
  const inYear = months.filter((m) => m.year === year);
  const last = inYear[inYear.length - 1];
  const lastDay = monthDateRange(last.year, last.month, tz).lastDay.toISOString().slice(0, 10);
  return lastDay < yesterday ? lastDay : yesterday;
}

/**
 * The Urlaub table of ONE calendar year at its Stichtag. It mirrors `GET /reports/leave-overview`
 * field by field (one assembly, #617): the year's population (#613), the caller's reach at 31
 * December, the VACATION allow-list by CODE, `vacationYearFigures` (which runs the audited
 * `usedDays` self-heal — never for an anonymised person) and the placeholder rows for population
 * persons without a VACATION entitlement. Two things differ on purpose: the facade is asked for the
 * Stichtag (`now` = its last instant, `asOf` = the day), so a past period re-reads the same figures
 * (P-06), and the Verfall facts (deadline, date of the last Hinweis, entitlement id) are added.
 * It carries no vacation rule of its own.
 */
async function vacationYearRows(
  app: FastifyInstance,
  params: {
    tenantId: string;
    tz: string;
    reach: AccessReach;
    year: number;
    stichtag: string;
    employeeId?: string;
    /** Under a salon filter: the persons homed in the salon at the period end (P-06). */
    onlyEmployeeIds?: ReadonlySet<string>;
  },
): Promise<PeriodVacationRow[]> {
  const { tenantId, tz, reach, year, stichtag, employeeId, onlyEmployeeIds } = params;
  const populationPeriod = await yearPopulationPeriod(app, tenantId, year);
  const allEntitlements = await listEntitlementsForYear(
    app.prisma,
    tenantId,
    year,
    populationPeriod,
  );
  // Narrow to the Stammsalon-scoped persons BEFORE the heal: an out-of-scope person's usedDays must
  // not even be written by this route (as on /leave-overview). Stichtag of the reach: 31 December.
  const scopedIds =
    reach.kind === "wholeTenant"
      ? "all"
      : await resolveStammsalonScopedEmployeeIds(
          app.prisma,
          tenantId,
          reach,
          new Date(`${year}-12-31T23:59:59.999Z`),
        );
  const entitlements = allEntitlements
    .filter((e) => scopedIds === "all" || scopedIds.includes(e.employeeId))
    .filter((e) => employeeId === undefined || e.employeeId === employeeId)
    // A salon filter only narrows: the persons homed there at the period end, whole personal values.
    .filter((e) => onlyEmployeeIds === undefined || onlyEmployeeIds.has(e.employeeId))
    // The allow-list is the code, never a name: no other entitlement type can appear in a report:read answer.
    .filter((e) => e.leaveType.code === "VACATION");

  const balances = await vacationYearFigures(
    app,
    tenantId,
    entitlements,
    dayRangeUtc(stichtag, tz).end,
    stichtag,
  );

  // ONE bulk lookup of the newest Hinweis per entitlement (the /carryover-at-risk idiom, no N+1).
  const lastWarning = new Map<string, Date>();
  if (entitlements.length > 0) {
    const warnings = await app.prisma.auditLog.findMany({
      where: {
        action: "CARRYOVER_WARNED",
        entity: "LeaveEntitlement",
        entityId: { in: entitlements.map((e) => e.id) },
      },
      orderBy: { createdAt: "desc" },
      select: { entityId: true, createdAt: true },
    });
    for (const w of warnings) {
      if (w.entityId && !lastWarning.has(w.entityId)) lastWarning.set(w.entityId, w.createdAt);
    }
  }

  const rows: PeriodVacationRow[] = [];
  const personOrder = new Map<string, { firstName: string; lastName: string }>();
  for (const e of entitlements) {
    const balance = balances.get(e.id)!;
    personOrder.set(e.employeeId, e.employee);
    rows.push({
      employeeId: e.employeeId,
      employeeName: `${e.employee.firstName} ${e.employee.lastName}`,
      employeeNumber: e.employee.employeeNumber,
      year: e.year,
      entitlementId: e.id,
      entitlementDays: Number(e.totalDays),
      carriedOverDays: Number(e.carriedOverDays),
      carriedOverEffectiveDays: balance.carriedOverEffectiveDays,
      carriedOverExpiredDays: balance.carriedOverExpiredDays,
      exitReductionDays: balance.exitReductionDays,
      availableDays: balance.availableDays,
      takenDays: balance.takenDays,
      approvedUpcomingDays: balance.approvedUpcomingDays,
      pendingDays: balance.pendingDays,
      remainingDays: balance.remainingDays,
      atRiskDays: balance.atRiskDays,
      carryOverDeadline: e.carryOverDeadline
        ? e.carryOverDeadline.toISOString().slice(0, 10)
        : null,
      lastWarningSentAt: lastWarning.get(e.id)?.toISOString() ?? null,
      missingEntitlement: false,
      entitlementWarning: vacationEntitlementWarning({
        leaveTypeCode: e.leaveType.code,
        year: e.year,
        needsReview: (e as { needsReview?: boolean }).needsReview,
      }),
    });
  }

  // Population persons without a VACATION row stay visible (Issue #416, #613) — display only, never created here.
  const withRow = new Set(entitlements.map((e) => e.employeeId));
  const population = await app.prisma.employee.findMany({
    where: {
      tenantId,
      AND: [
        reportPopulationWhere(populationPeriod.start, populationPeriod.end),
        ...(employeeId ? [{ id: employeeId }] : []),
        ...(onlyEmployeeIds ? [{ id: { in: [...onlyEmployeeIds] } }] : []),
        ...(scopedIds !== "all" ? [{ id: { in: scopedIds } }] : []),
      ],
    },
    select: { id: true, firstName: true, lastName: true, employeeNumber: true },
  });
  for (const emp of population) {
    if (withRow.has(emp.id)) continue;
    personOrder.set(emp.id, emp);
    rows.push({
      employeeId: emp.id,
      employeeName: `${emp.firstName} ${emp.lastName}`,
      employeeNumber: emp.employeeNumber,
      year,
      entitlementId: null,
      entitlementDays: null,
      carriedOverDays: null,
      carriedOverEffectiveDays: null,
      carriedOverExpiredDays: null,
      exitReductionDays: null,
      availableDays: null,
      takenDays: null,
      approvedUpcomingDays: null,
      pendingDays: null,
      remainingDays: null,
      atRiskDays: null,
      carryOverDeadline: null,
      lastWarningSentAt: null,
      missingEntitlement: true,
      entitlementWarning: null,
    });
  }
  // The order of the time rows: last name, first name, id.
  return rows
    .map((row) => ({ row, order: personOrder.get(row.employeeId)! }))
    .sort(
      (a, b) =>
        a.order.lastName.localeCompare(b.order.lastName, "de") ||
        a.order.firstName.localeCompare(b.order.firstName, "de") ||
        a.row.employeeId.localeCompare(b.row.employeeId),
    )
    .map((x) => x.row);
}

type MonthReportFigures = Awaited<ReturnType<typeof computeMonthReportFigures>>;

/**
 * P-13: the drill-down split of the closing saldo into the confirmed part (a closed month's stored
 * carry-over) and the open forecast on top of it — sent only where it is exact, otherwise all three
 * values are `null` and the page shows the single value as a forecast:
 *   - the last listed month is closed: everything is confirmed (open 0, 0 unconfirmed months);
 *   - the last listed month is open directly after a closed month (inside the month before `from`
 *     and `to`): confirmed = that month's stored carry-over, open = closing − confirmed, 1 month.
 * Anything else (several unclosed months, a gap, an unlabelled month) has no exact split.
 */
function closingSplit(
  months: readonly PeriodMonthEntry[],
  beforeFigures: MonthReportFigures | null,
  before: YearMonth,
): {
  closingConfirmedMinutes: number | null;
  closingOpenMinutes: number | null;
  unconfirmedMonths: number | null;
} {
  const none = { closingConfirmedMinutes: null, closingOpenMinutes: null, unconfirmedMonths: null };
  const last = months[months.length - 1];
  if (last.closingBalanceMinutes === null) return none;
  if (last.confirmed) {
    return {
      closingConfirmedMinutes: last.closingBalanceMinutes,
      closingOpenMinutes: 0,
      unconfirmedMonths: 0,
    };
  }
  const wanted = monthBefore(last);
  let predecessor: { confirmed: boolean; closingBalanceMinutes: number | null } | null = null;
  if (months.length > 1) {
    const prev = months[months.length - 2];
    if (prev.year === wanted.year && prev.month === wanted.month) predecessor = prev;
  } else if (before.year === wanted.year && before.month === wanted.month) {
    predecessor = beforeFigures;
  }
  if (!predecessor || !predecessor.confirmed || predecessor.closingBalanceMinutes === null) {
    return none;
  }
  return {
    closingConfirmedMinutes: predecessor.closingBalanceMinutes,
    closingOpenMinutes: last.closingBalanceMinutes - predecessor.closingBalanceMinutes,
    unconfirmedMonths: 1,
  };
}

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
  options: PeriodOptions = {},
) {
  const sections = options.sections ?? "all";
  const tenantId = req.user.tenantId;
  const tz = await getTenantTimezone(app.prisma, tenantId);
  const today = todayInTz(tz);
  const currentMonth: YearMonth = { year: today.getUTCFullYear(), month: today.getUTCMonth() + 1 };
  const months = validateRange(query, currentMonth);

  const access = accessContextFromRequest(req);
  const reach = await resolveAccessReach(app.prisma, access, permission);
  // Issue #542 (T-612-07): the chosen salon is validated against the reach of THIS route's own
  // permission BEFORE any person, entry, account or vacation read (and before the overtime reach);
  // every rejection is the one 404 body. The filter is presentation: it only intersects the reach.
  const salonFilter = await resolveSalonInReach(app.prisma, tenantId, reach, query.salonId);
  if (!salonFilter.ok) throw new PeriodSalonNotFoundError();
  const filterSalonId = salonFilter.salonId;
  // P-04: Soll and saldo follow overtime:read; the reach of that permission is judged per month.
  const canSeeSaldo = await hasPermission(req, "overtime:read:ZUGEWIESEN");
  const overtimeReach = canSeeSaldo
    ? await resolveAccessReach(app.prisma, access, "overtime:read:ZUGEWIESEN")
    : null;

  const persons = new Map<string, PersonAccumulator>();
  // P-07: Σ over months of the per-kind counts of the /monthly assembly, with the persons that have > 0.
  const absenceTotals = new Map<AbsenceKindCode, AbsenceTotal>();
  const sickTotal: AbsenceTotal = { totalDays: 0, persons: new Set() };
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

    const populationEmployees = (await app.prisma.employee.findMany({
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

    // Issue #542 (P-01, P-02): under a filter the population above (period population, Stammsalon
    // scope at month end, optional employeeId) is intersected with the ONE membership rule - an
    // entry in the salon this month OR the Stammsalon on at least one calendar day of it. The filter
    // can only narrow. `homeByPerson` doubles as the per-day attribution of the sick days (#84).
    let employees = populationEmployees;
    let homeByPerson: Map<string, Map<string, string | null>> | null = null;
    if (filterSalonId !== null) {
      const monthDays = calendarDaysBetween(firstDay, lastDay);
      homeByPerson = await homeSalonsForDays(
        app.prisma,
        tenantId,
        populationEmployees.map((e) => e.id),
        monthDays[0],
        monthDays[monthDays.length - 1],
      );
      const members = salonViewMemberIds({
        salonId: filterSalonId,
        candidateIds: populationEmployees.map((e) => e.id),
        entries: populationEmployees.flatMap((e) =>
          e.timeEntries.map((t) => ({ employeeId: e.id, salonId: t.salonId })),
        ),
        homeByPerson,
        days: monthDays,
      });
      employees = populationEmployees.filter((e) => members.has(e.id));
    }
    // Issue #542: tenant-local yesterday as a calendar day - today never counts (#438).
    const yesterdayDate = new Date(todayInTz(tz).getTime() - 86_400_000);

    const section9ByEmp = await fetchConfirmedSection9CreditsByEmp(
      app,
      tenantId,
      firstDay,
      lastDay,
    );
    // Issue #542 (D-542-1): the priced leave counts follow a chronological prefix rule per period and
    // are not fetched under a filter (a per-day variant would be a second counting rule, #451).
    const leaveDaysByEmp =
      filterSalonId === null
        ? await fetchLeaveDaysByCodeForMonthlyReport(app, tenantId, employees, ym.year, ym.month)
        : new Map<string, Map<LeaveTypeCode, LeaveDaysForCode>>();

    for (const emp of employees) {
      const summary = computeEmployeeSummary(
        emp,
        firstDay,
        lastDay,
        tz,
        leaveDaysByEmp.get(emp.id) ?? new Map(),
        section9ByEmp.get(emp.id) ?? [],
        filterSalonId === null
          ? undefined
          : (day) => homeByPerson?.get(emp.id)?.get(day) === filterSalonId,
      );
      // Under a filter Ist = the closed, valid WORK entries recorded in the salon through yesterday
      // (a travel row counts for its departure salon, #92); Soll, saldo and the account are
      // contract figures of the person and are not read (#84, #542).
      const filteredMinutes =
        filterSalonId === null
          ? 0
          : emp.timeEntries
              .filter((t) => t.salonId === filterSalonId && t.date <= yesterdayDate)
              .reduce((sum, t) => addWorkingMinutes(sum, t), 0);
      const figures =
        filterSalonId === null
          ? await computeMonthReportFigures(app, emp.id, ym.year, ym.month)
          : null;
      if (sections === "all") {
        for (const code of ABSENCE_KIND_ORDER) {
          const days = absenceKindDays(summary)[code];
          if (days <= 0) continue;
          const total = absenceTotals.get(code) ?? { totalDays: 0, persons: new Set<string>() };
          total.totalDays += days;
          total.persons.add(emp.id);
          absenceTotals.set(code, total);
        }
        if (summary.sickDays > 0) {
          sickTotal.totalDays += summary.sickDays;
          sickTotal.persons.add(emp.id);
        }
      }
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
      person.months.push(
        figures === null
          ? {
              year: ym.year,
              month: ym.month,
              workedMinutes: filteredMinutes,
              expectedMinutes: null,
              balanceMinutes: null,
              closingBalanceMinutes: null,
              confirmed: false,
              labelled: false,
              sickDays: summary.sickDays,
            }
          : {
              year: ym.year,
              month: ym.month,
              workedMinutes: figures.workedMinutes,
              expectedMinutes: figures.expectedMinutes,
              balanceMinutes: figures.balanceMinutes,
              closingBalanceMinutes: figures.closingBalanceMinutes,
              confirmed: figures.confirmed,
              labelled: figures.labelled,
              sickDays: summary.sickDays,
            },
      );
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

  // P-12: ONE bulk read of who has recorded time since the tenant-local hire day (#588's facade, the
  // same call the overtime overview makes).
  const withRecordedTime = await employeesWithValidWorkSince(
    app.prisma,
    tenantId,
    ordered.map((p) => ({
      employeeId: p.employeeId,
      fromDay: new Date(`${dateStrInTz(p.hireDate, tz)}T00:00:00Z`),
    })),
  );
  const periodEnd = monthRangeUtc(
    months[months.length - 1].year,
    months[months.length - 1].month,
    tz,
  ).end;

  const rows = [];
  for (const person of ordered) {
    // Soll and saldo are shown only where overtime:read covers the person AND no salon filter is
    // active (contract figures are never split by salon, #84/#542). NO_PERMISSION wins as the reason.
    const covered = person.covered && filterSalonId === null;
    const sollReason: SollUnavailableReason | undefined = !person.covered
      ? "NO_PERMISSION"
      : filterSalonId !== null
        ? "SALON_FILTER"
        : undefined;
    let opening: number | null = null;
    let beforeFigures: MonthReportFigures | null = null;
    if (covered && isEmployedInPeriod(person, beforeRange.start, beforeRange.end)) {
      beforeFigures = await computeMonthReportFigures(
        app,
        person.employeeId,
        before.year,
        before.month,
      );
      opening = beforeFigures.closingBalanceMinutes;
    }
    const last = person.months[person.months.length - 1];
    const split = covered
      ? closingSplit(person.months, beforeFigures, before)
      : { closingConfirmedMinutes: null, closingOpenMinutes: null, unconfirmedMonths: null };
    const sum = (pick: (m: PeriodMonthEntry) => number | null): number =>
      person.months.reduce((s, m) => s + (pick(m) ?? 0), 0);
    rows.push({
      employeeId: person.employeeId,
      employeeName: person.employeeName,
      employeeNumber: person.employeeNumber,
      hasRecordedTime: withRecordedTime.has(person.employeeId),
      // P-21: the tenant-local exit day when the employment ended on or before the period's last day.
      exitDay:
        person.exitDate !== null && person.exitDate.getTime() <= periodEnd.getTime()
          ? dateStrInTz(person.exitDate, tz)
          : null,
      workedMinutes: sum((m) => m.workedMinutes),
      expectedMinutes: covered ? sum((m) => m.expectedMinutes) : null,
      balanceMinutes: covered ? sum((m) => m.balanceMinutes) : null,
      openingBalanceMinutes: opening,
      closingBalanceMinutes: covered ? last.closingBalanceMinutes : null,
      ...split,
      monthCount: person.months.length,
      confirmedMonthCount: person.months.filter((m) => m.confirmed).length,
      labelled: person.months.some((m) => m.labelled),
      sickDays: round2(sum((m) => m.sickDays)),
      ...(sollReason === undefined ? {} : { sollUnavailableReason: sollReason }),
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

  // P-05/P-06: one Urlaub table per calendar year the period touches, each at its own Stichtag.
  const vacationYears: PeriodVacationYear[] = [];
  if (sections === "all") {
    // Under a filter: the persons whose Stammsalon is the salon at the period end (the Monatsexport
    // rule), each with whole personal values that are never split by salon (P-06).
    const lastMonthOfPeriod = months[months.length - 1];
    const homedAtEnd =
      filterSalonId === null
        ? undefined
        : new Set(
            await salonPersonsAtStichtag(
              app,
              tenantId,
              filterSalonId,
              lastMonthOfPeriod.year,
              lastMonthOfPeriod.month,
            ),
          );
    const yesterday = dayBeforeStr(dateStrInTz(new Date(), tz));
    for (const year of [...new Set(months.map((m) => m.year))]) {
      const stichtag = vacationStichtag(year, months, tz, yesterday);
      vacationYears.push({
        year,
        asOf: stichtag,
        rows: await vacationYearRows(app, {
          tenantId,
          tz,
          reach,
          year,
          stichtag,
          employeeId: query.employeeId,
          ...(homedAtEnd ? { onlyEmployeeIds: homedAtEnd } : {}),
        }),
      });
    }
  }
  const endYear = vacationYears[vacationYears.length - 1];
  const sumVacation = (pick: (r: PeriodVacationRow) => number | null): number =>
    round2(endYear.rows.reduce((s, r) => s + (r.missingEntitlement ? 0 : (pick(r) ?? 0)), 0));
  const absences: PeriodAbsence[] = [];
  for (const code of ABSENCE_KIND_ORDER) {
    const total = absenceTotals.get(code);
    if (!total) continue;
    absences.push({
      code,
      unit: "WORKDAYS",
      personCount: total.persons.size,
      totalDays: round2(total.totalDays),
    });
  }
  if (sickTotal.persons.size > 0) {
    absences.push({
      code: "SICK",
      unit: "CALENDAR_DAYS",
      personCount: sickTotal.persons.size,
      totalDays: round2(sickTotal.totalDays),
    });
  }

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
      ...(sections === "all"
        ? {
            vacationYear: endYear.year,
            vacationAsOf: endYear.asOf,
            vacationTakenDays: sumVacation((r) => r.takenDays),
            vacationApprovedDays: sumVacation((r) => r.approvedUpcomingDays),
            vacationEntitlementDays: sumVacation((r) => r.entitlementDays),
          }
        : {}),
    },
    rows,
    // Issue #542 (P-03): additive keys, ONLY under a filter - the unfiltered shape stays as it was.
    ...(filterSalonId !== null
      ? {
          salonId: filterSalonId,
          workedBasis: "SALON_ENTRIES" as const,
          sollUnavailableReason: "SALON_FILTER" as const,
          leaveDaysUnavailableReason: "SALON_FILTER" as const,
        }
      : {}),
    ...(sections === "all"
      ? {
          vacation: { year: endYear.year, asOf: endYear.asOf, years: vacationYears },
          absences,
        }
      : {}),
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
        if (err instanceof PeriodSalonNotFoundError) {
          return reply.code(404).send(SALON_VIEW_NOT_FOUND);
        }
        throw err;
      }
    },
  });

  // GET /api/v1/reports/period/csv?from=YYYY-MM&to=YYYY-MM&salonId=&employeeId=
  // The "Zeiten & Konten" table of the same assembly as the JSON, as a spreadsheet file (P-11). It is
  // an export of personal data: the reach is the one of `report:export`, and every successful
  // download is audited BEFORE the bytes leave. A refusal (400/404) throws out of the assembly and
  // writes nothing.
  app.get("/period/csv", {
    schema: {
      tags: ["Reporting"],
      security: [{ bearerAuth: [] }],
      description:
        "CSV export of the period table (Zeiten & Konten): one line per person with Soll, Ist, saldo at the start, over the period and at the end in hours with a decimal comma, UTF-8 with BOM, semicolon separated. Same assembly and rules as GET /reports/period, with the reach of report:export. Audited as EXPORT.",
    },
    preHandler: requirePermission("report:export:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const query = periodQuerySchema.parse(req.query);
      let report: Awaited<ReturnType<typeof assemblePeriodReport>>;
      try {
        report = await assemblePeriodReport(app, req, query, "report:export:ZUGEWIESEN", {
          sections: "times",
        });
      } catch (err) {
        if (err instanceof PeriodRangeError) return reply.code(400).send({ error: err.message });
        if (err instanceof PeriodSalonNotFoundError) {
          return reply.code(404).send(SALON_VIEW_NOT_FOUND);
        }
        throw err;
      }
      const file = periodTableCsv(report.rows);
      await app.audit({
        userId: req.user.sub,
        action: "EXPORT",
        entity: "Report",
        newValue: {
          type: "PERIOD_CSV",
          from: report.from,
          to: report.to,
          // The validated salon id (never a name) - only present under a filter.
          salonId: "salonId" in report ? report.salonId : null,
          personCount: report.rows.length,
        },
      });
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header(
        "Content-Disposition",
        `attachment; filename="${periodCsvFilename(report.from, report.to)}"`,
      );
      return reply.send(file);
    },
  });
}
