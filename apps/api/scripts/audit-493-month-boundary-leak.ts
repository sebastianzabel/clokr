/**
 * Audit tool — Issue #493 (R6, D-06, D-07, D-08).
 *
 * Root cause this script surfaces (fixed in the read paths by the same issue): the Monatsbericht
 * (JSON + PDFs), the DATEV export and a few dashboard/calendar reads compared the month INSTANTS
 * of `monthRangeUtc()` with `@db.Date` columns (`TimeEntry.date`, leave and absence ranges, § 9
 * credits). A date parameter against a `@db.Date` column is evaluated at UTC-calendar-date
 * precision, so for a tenant east of UTC the previous month's LAST local day counted as part of
 * the month (for a tenant west of UTC it was the next month's FIRST day). Fixed code compares
 * calendar-day bounds (`monthDateRange()`) and reproduces correct reports on demand.
 *
 * What this script lists — each category is a correction list for files that were ALREADY
 * delivered; nothing stored is wrong, closed months are not recalculated, and this script
 * recalculates nothing:
 *   A  time entries the old bounds attributed to the wrong month, with the working minutes and
 *      which outputs they reached (report entry list, DATEV hours, report Ist of an untracked
 *      employee).
 *   B  sick leave and § 9 credits whose Monatsbericht day count differs between the old and the
 *      new bounds (old and new value).
 *   C  sick leave whose DATEV Krank workday-key count differs between the old and the new bounds.
 * Plus, per affected tenant and month, which report exports the audit log recorded (D-07).
 *
 * Each row is listed only when the OUTPUT it names would really have contained the employee at
 * the old code (7c6018e9): the Monatsbericht JSON and the company PDF select `exitDate: null` and
 * an active user; the single-employee PDF selects nobody (it is listed only when the audit log
 * names that employee for that month); DATEV selects `datevPayrollPeriodEmployeeFilter` (the real
 * predicate, imported). A row no delivered file contained is not a correction target. Both
 * filters read the CURRENT employee state — an employee who exited or was deactivated AFTER a
 * file was delivered was in that file but is not listed for the Monatsbericht; the stored history
 * cannot reconstruct the state at delivery time.
 *
 * The exports line lists only AUDITED exports (`EXPORT` / `Report` rows: MONTHLY_PDF, DATEV,
 * DATEV_EMPLOYEE, COMPANY_MONTHLY_PDF). `GET /reports/monthly` (the JSON the UI renders) writes no
 * audit row, so `exports(audited)=none` does NOT mean the leaked figures were never shown. An
 * export by a since-anonymized user (AuditLog.userId set to null, DSGVO) cannot be attributed to
 * a tenant and is missing from the list. Per-employee exports appear on that employee's summary
 * line, company-wide ones on the month line.
 *
 * READ-ONLY. ZERO mutations. There is no write/correction flag anywhere in this file, and none
 * may ever be added: a delivered report is corrected by a deliberate new export, never by a
 * script rewriting stored data.
 *
 * Output contains ids only, full untruncated UUIDs, no personal data (DSGVO) — the owner locates
 * each row through an admin lookup or a direct database query.
 *
 * Months after the tenant's current month are skipped (no report can have leaked yet).
 *
 * Usage:
 *   DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx \
 *     scripts/audit-493-month-boundary-leak.ts \
 *     ( --tenant-id <uuid> | --all-tenants ) \
 *     [--help]
 *
 * Exit codes:
 *   0 — nothing was attributed to a wrong month for the given scope
 *   1 — DATABASE_URL missing, an unknown --tenant-id, or a DB connection/query failure
 *   2 — one or more findings (correction list for already delivered files)
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  getTenantTimezone,
  monthDateRange,
  monthRangeUtc,
  todayInTz,
} from "../src/contexts/working-time-account";
import { entryDurations } from "../src/contexts/time-tracking";
import { EFFECTIVE_LEAVE_STATUSES, isSickLeaveTypeCode } from "../src/contexts/absence";
// The real DATEV payroll-period predicate — reused, never copied, so the audit cannot drift from
// the export. `composition/` is not a context, so this import needs no boundary exception.
import { datevPayrollPeriodEmployeeFilter } from "../src/composition/reports";

// ── Exit codes ──────────────────────────────────────────────────────────────
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_FINDINGS = 2;

// ── CLI parsing ───────────────────────────────────────────────────────────────
export type CliArgs = {
  tenantId: string | null;
  allTenants: boolean;
  help: boolean;
};

export function parseCli(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      "tenant-id": { type: "string" },
      "all-tenants": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true, // rejects any unknown flag, in particular --confirm / --apply
  });

  return {
    tenantId: values["tenant-id"] ?? null,
    allTenants: Boolean(values["all-tenants"]),
    help: Boolean(values.help),
  };
}

const USAGE = `
Usage:
  DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx \\
    scripts/audit-493-month-boundary-leak.ts \\
    ( --tenant-id <uuid> | --all-tenants ) \\
    [--help]

READ-ONLY — lists what the pre-#493 month bounds attributed to the wrong month (Issue #493):
time entries (category A), sick/§ 9 report day counts (B), DATEV Krank day keys (C), plus the
AUDITED report exports recorded for each affected month (JSON views of GET /reports/monthly are
not audited; exports by anonymized users are not attributable). No write/correction flag exists.
Rows are listed only for employees the named output really contained.

Exit codes:
  0 — no finding for the given scope
  1 — DATABASE_URL missing, an unknown --tenant-id, or a DB connection/query failure
  2 — one or more findings (correction list for already delivered files)
`;

const EXPORTS_NOTE =
  "note exports(audited) and employeeExports(audited) list only AUDITED exports (PDF and DATEV). " +
  "GET /reports/monthly (the JSON view) is not audited, and exports by since-anonymized users " +
  "cannot be attributed to a tenant — 'none' does not prove that nothing was delivered.";

// ── Month windows ─────────────────────────────────────────────────────────────
function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The UTC calendar dates a `@db.Date` comparison against the OLD month instants covered. */
export function legacyMonthDays(
  year: number,
  month: number,
  tz: string,
): { first: string; last: string } {
  // Deliberately the pre-#493 bounds: this script measures what they got wrong.
  const { start, end } = monthRangeUtc(year, month, tz);
  return { first: dateOnly(start), last: dateOnly(end) };
}

/** The calendar days of the month in the tenant's timezone — the bounds the fixed code uses. */
export function currentMonthDays(
  year: number,
  month: number,
  tz: string,
): { first: string; last: string } {
  const { firstDay, lastDay } = monthDateRange(year, month, tz);
  return { first: dateOnly(firstDay), last: dateOnly(lastDay) };
}

type YearMonth = { year: number; month: number };

function shiftMonth(ym: YearMonth, delta: number): YearMonth {
  const idx = ym.year * 12 + (ym.month - 1) + delta;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

function monthKey(ym: YearMonth): string {
  return `${ym.year}-${String(ym.month).padStart(2, "0")}`;
}

function monthOfDate(s: string): YearMonth {
  return { year: Number(s.slice(0, 4)), month: Number(s.slice(5, 7)) };
}

function isAfter(a: YearMonth, b: YearMonth): boolean {
  return a.year * 12 + a.month > b.year * 12 + b.month;
}

// ── Finding shapes ────────────────────────────────────────────────────────────
export type EntryFinding = {
  tenantId: string;
  month: string; // YYYY-MM — the month the entry was wrongly attributed to
  employeeId: string;
  entryId: string;
  date: string; // YYYY-MM-DD
  type: string;
  workingMinutes: number;
  reportEntryList: boolean; // listed in the Monatsbericht entry list (type WORK only)
  datevHours: boolean; // counted in the DATEV hours (no type filter, D-11)
  reportIst: boolean; // also raised the Ist of an untracked employee in that report
};

/** Full UUIDs — DSGVO-safe (ids only), but locatable by the owner. */
export function formatEntryFinding(f: EntryFinding): string {
  return (
    `category=A tenantId=${f.tenantId} month=${f.month} employeeId=${f.employeeId} ` +
    `entryId=${f.entryId} date=${f.date} type=${f.type} workingMinutes=${f.workingMinutes} ` +
    `reportEntryList=${f.reportEntryList} datevHours=${f.datevHours} reportIst=${f.reportIst}`
  );
}

export type DayCountFinding = {
  tenantId: string;
  month: string;
  employeeId: string;
  source: "leaveRequest" | "section9Credit";
  id: string;
  code: string;
  daysOld: number;
  daysNew: number;
};

export function formatDayCountFinding(f: DayCountFinding): string {
  return (
    `category=B tenantId=${f.tenantId} month=${f.month} employeeId=${f.employeeId} ` +
    `source=${f.source} id=${f.id} code=${f.code} daysOld=${f.daysOld} daysNew=${f.daysNew}`
  );
}

export type KeyShiftFinding = {
  tenantId: string;
  month: string;
  employeeId: string;
  leaveRequestId: string;
  code: string;
  keysOld: number;
  keysNew: number;
};

export function formatKeyShiftFinding(f: KeyShiftFinding): string {
  return (
    `category=C tenantId=${f.tenantId} month=${f.month} employeeId=${f.employeeId} ` +
    `leaveRequestId=${f.leaveRequestId} code=${f.code} keysOld=${f.keysOld} keysNew=${f.keysNew}`
  );
}

// ── Frozen copies of the pre-#493 arithmetic ──────────────────────────────────
// Both bodies below are token-identical copies of code that no longer exists in
// composition/reports.ts; they are evaluated twice per month — once with the old
// monthRangeUtc instants and once with the monthDateRange calendar days — so the difference
// between the two results is exactly what the delivered files got wrong.

/**
 * Source: `git show 7c6018e9:apps/api/src/composition/reports.ts`, `daysInRange` inside
 * `computeEmployeeSummary` (lines 198-202). Monatsbericht day count: the range clipped to
 * [start, end], rounded to whole days.
 */
export function legacyClippedDays(from: Date, to: Date, start: Date, end: Date): number {
  const s = from < start ? start : from;
  const e2 = to > end ? end : to;
  return Math.max(0, Math.round((e2.getTime() - s.getTime()) / 86400000) + 1);
}

/**
 * Source: `git show 7c6018e9:apps/api/src/composition/reports.ts`, `workdayKeysInMonthRange`
 * inside `buildDatevLodas` (lines 463-474). DATEV workday keys: the clipped range walked day by
 * day from the clip start, weekends skipped.
 */
export function legacyWorkdayKeys(from: Date, to: Date, start: Date, end: Date): string[] {
  const s = from < start ? start : from;
  const e2 = to > end ? end : to;
  const keys: string[] = [];
  const cur = new Date(s);
  while (cur <= e2) {
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) keys.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return keys;
}

/** The old and the new value of one counter for one month; 0 when the range misses that window. */
function oldAndNew<T>(
  row: { from: Date; to: Date },
  ym: YearMonth,
  tz: string,
  measure: (from: Date, to: Date, lo: Date, hi: Date) => T,
  zero: T,
): { old: T; now: T } {
  const fromStr = dateOnly(row.from);
  const toStr = dateOnly(row.to);
  const oldDays = legacyMonthDays(ym.year, ym.month, tz);
  const newDays = currentMonthDays(ym.year, ym.month, tz);
  const instants = monthRangeUtc(ym.year, ym.month, tz);
  const days = monthDateRange(ym.year, ym.month, tz);
  const overlaps = (w: { first: string; last: string }) => fromStr <= w.last && toStr >= w.first;
  return {
    old: overlaps(oldDays) ? measure(row.from, row.to, instants.start, instants.end) : zero,
    now: overlaps(newDays) ? measure(row.from, row.to, days.firstDay, days.lastDay) : zero,
  };
}

/** Months to test for a row: one before its first to one after its last, none after `current`. */
function monthsAround(from: Date, to: Date, current: YearMonth): YearMonth[] {
  const first = shiftMonth(monthOfDate(dateOnly(from)), -1);
  const last = shiftMonth(monthOfDate(dateOnly(to)), 1);
  const out: YearMonth[] = [];
  for (let ym = first; !isAfter(ym, last); ym = shiftMonth(ym, 1)) {
    if (!isAfter(ym, current)) out.push(ym);
  }
  return out;
}

// ── Audited exports ───────────────────────────────────────────────────────────
/** One `EXPORT` / `Report` audit row: its month and what the export named. */
export type ExportRecord = {
  month: string; // YYYY-MM
  type: string;
  employeeId: string | null; // MONTHLY_PDF and DATEV_EMPLOYEE name one employee
  role: string | null; // COMPANY_MONTHLY_PDF carries the role filter
};

/**
 * Report exports the audit log recorded for a tenant. AUDITED exports only: `GET /reports/monthly`
 * writes no row, and a row whose user was anonymized (`userId` set null) fails the tenant join.
 * Rows without a numeric year and month (LEAVE_LIST_PDF, VACATION_PDF, ...) are not month exports.
 */
async function recordedExports(prisma: PrismaClient, tenantId: string): Promise<ExportRecord[]> {
  const rows = await prisma.auditLog.findMany({
    where: { action: "EXPORT", entity: "Report", user: { employee: { tenantId } } },
    select: { newValue: true },
  });
  const out: ExportRecord[] = [];
  for (const r of rows) {
    const v = r.newValue as {
      type?: unknown;
      year?: unknown;
      month?: unknown;
      employeeId?: unknown;
      role?: unknown;
    } | null;
    const year = Number(v?.year);
    const month = Number(v?.month);
    if (!v || typeof v.type !== "string" || !Number.isInteger(year) || !Number.isInteger(month)) {
      continue;
    }
    out.push({
      month: monthKey({ year, month }),
      type: v.type,
      employeeId: typeof v.employeeId === "string" ? v.employeeId : null,
      role: typeof v.role === "string" ? v.role : null,
    });
  }
  return out;
}

/** Month-level label of a company-wide export, e.g. `DATEV` or `COMPANY_MONTHLY_PDF(role=all)`. */
function companyExportLabel(r: ExportRecord): string {
  return r.role ? `${r.type}(role=${r.role})` : r.type;
}

// ── Output populations ────────────────────────────────────────────────────────
/** Which employees a delivered output really contained, per month (see the file header). */
export type Populations = {
  /** Monatsbericht JSON / company PDF, or an audited single-employee PDF for that month. */
  inReport(employeeId: string, ym: YearMonth): boolean;
  /** DATEV payroll-period predicate with the month instants of the old code. */
  inDatev(employeeId: string, ym: YearMonth): Promise<boolean>;
};

type EmployeeRow = {
  id: string;
  isTimeTrackingExempt: boolean;
  exitDate: Date | null;
  user: { isActive: boolean } | null;
};

function makePopulations(
  prisma: PrismaClient,
  tenantId: string,
  tz: string,
  employees: EmployeeRow[],
  exports: ExportRecord[],
): Populations {
  // Source: `git show 7c6018e9:apps/api/src/composition/reports.ts`, GET /monthly (lines 912-917)
  // and GET /monthly/pdf/all (lines 1909-1913): `exitDate: null, user: { isActive: true }`.
  const reportBase = new Set(
    employees.filter((e) => e.exitDate === null && e.user?.isActive === true).map((e) => e.id),
  );
  // GET /monthly/pdf (single employee) has no population filter; the audit row is the evidence.
  const singlePdf = new Set(
    exports
      .filter((x) => x.type === "MONTHLY_PDF" && x.employeeId !== null)
      .map((x) => `${x.month}|${x.employeeId}`),
  );
  const datevCache = new Map<string, Promise<Set<string>>>();
  return {
    inReport: (employeeId, ym) =>
      reportBase.has(employeeId) || singlePdf.has(`${monthKey(ym)}|${employeeId}`),
    inDatev: async (employeeId, ym) => {
      const key = monthKey(ym);
      if (!datevCache.has(key)) {
        const { start, end } = monthRangeUtc(ym.year, ym.month, tz);
        datevCache.set(
          key,
          prisma.employee
            .findMany({
              where: { tenantId, ...datevPayrollPeriodEmployeeFilter(start, end) },
              select: { id: true },
            })
            .then((rows) => new Set(rows.map((r) => r.id))),
        );
      }
      return (await datevCache.get(key)!).has(employeeId);
    },
  };
}

// ── Per-tenant scan ───────────────────────────────────────────────────────────
async function scanEntries(
  prisma: PrismaClient,
  tenantId: string,
  tz: string,
  current: YearMonth,
  employees: EmployeeRow[],
  populations: Populations,
): Promise<EntryFinding[]> {
  const exempt = new Map(employees.map((e) => [e.id, e.isTimeTrackingExempt]));

  const entries = await prisma.timeEntry.findMany({
    where: {
      employee: { tenantId },
      deletedAt: null,
      endTime: { not: null },
      isInvalid: false,
    },
    select: {
      id: true,
      employeeId: true,
      date: true,
      startTime: true,
      endTime: true,
      breakMinutes: true,
      type: true,
    },
  });

  // reportIst mirrors computeMonthReportFigures' untracked rule: the schedule valid at the end of
  // the reported month is missing or MONTHLY_HOURS without a positive monthlyHours.
  const untrackedCache = new Map<string, boolean>();
  async function isUntracked(employeeId: string, ym: YearMonth): Promise<boolean> {
    const key = `${employeeId}|${monthKey(ym)}`;
    const hit = untrackedCache.get(key);
    if (hit !== undefined) return hit;
    const { end } = monthRangeUtc(ym.year, ym.month, tz);
    const schedule = await prisma.workSchedule.findFirst({
      where: { employeeId, validFrom: { lte: end } },
      orderBy: { validFrom: "desc" },
      select: { type: true, monthlyHours: true },
    });
    const untracked =
      !schedule ||
      (String(schedule.type) === "MONTHLY_HOURS" && !(Number(schedule.monthlyHours ?? 0) > 0));
    untrackedCache.set(key, untracked);
    return untracked;
  }

  const findings: EntryFinding[] = [];
  for (const e of entries) {
    const date = dateOnly(e.date);
    const own = monthOfDate(date);
    // Only the neighbouring months can have a window that differs on this date.
    for (const ym of [shiftMonth(own, -1), shiftMonth(own, 1)]) {
      if (isAfter(ym, current)) continue;
      const old = legacyMonthDays(ym.year, ym.month, tz);
      const now = currentMonthDays(ym.year, ym.month, tz);
      const inOld = date >= old.first && date <= old.last;
      const inNew = date >= now.first && date <= now.last;
      if (!inOld || inNew) continue;
      // Only the outputs that really contained this employee count (WR-01): the entry list is the
      // report's (type WORK only), the DATEV hours have no type filter (D-11).
      const inReport = populations.inReport(e.employeeId, ym);
      const reportEntryList = e.type === "WORK" && inReport;
      const datevHours = await populations.inDatev(e.employeeId, ym);
      const reportIst =
        reportEntryList && !exempt.get(e.employeeId) && (await isUntracked(e.employeeId, ym));
      if (!reportEntryList && !datevHours) continue;
      findings.push({
        tenantId,
        month: monthKey(ym),
        employeeId: e.employeeId,
        entryId: e.id,
        date,
        type: String(e.type),
        workingMinutes: Math.round(entryDurations(e).workingMinutes),
        reportEntryList,
        datevHours,
        reportIst,
      });
    }
  }
  return findings;
}

async function scanLeave(
  prisma: PrismaClient,
  tenantId: string,
  tz: string,
  current: YearMonth,
  populations: Populations,
): Promise<{ dayCounts: DayCountFinding[]; keyShifts: KeyShiftFinding[] }> {
  const dayCounts: DayCountFinding[] = [];
  const keyShifts: KeyShiftFinding[] = [];

  const requests = await prisma.leaveRequest.findMany({
    where: {
      employee: { tenantId },
      deletedAt: null,
      status: { in: [...EFFECTIVE_LEAVE_STATUSES] },
      leaveType: { code: { in: ["SICK", "SICK_CHILD"] } },
    },
    select: {
      id: true,
      employeeId: true,
      startDate: true,
      endDate: true,
      halfDay: true,
      leaveType: { select: { code: true } },
    },
  });

  for (const r of requests) {
    if (!isSickLeaveTypeCode(r.leaveType.code)) continue;
    const row = { from: r.startDate, to: r.endDate };
    for (const ym of monthsAround(r.startDate, r.endDate, current)) {
      // Report: whole-day clip, halved for a half day.
      const days = oldAndNew(row, ym, tz, legacyClippedDays, 0);
      const factor = r.halfDay ? 0.5 : 1;
      if (days.old * factor !== days.now * factor && populations.inReport(r.employeeId, ym)) {
        dayCounts.push({
          tenantId,
          month: monthKey(ym),
          employeeId: r.employeeId,
          source: "leaveRequest",
          id: r.id,
          code: String(r.leaveType.code),
          daysOld: days.old * factor,
          daysNew: days.now * factor,
        });
      }
      // DATEV: workday keys; a half day counts n / 2.
      const keys = oldAndNew<string[]>(row, ym, tz, legacyWorkdayKeys, []);
      const keysOld = r.halfDay ? keys.old.length / 2 : keys.old.length;
      const keysNew = r.halfDay ? keys.now.length / 2 : keys.now.length;
      if (keysOld !== keysNew && (await populations.inDatev(r.employeeId, ym))) {
        keyShifts.push({
          tenantId,
          month: monthKey(ym),
          employeeId: r.employeeId,
          leaveRequestId: r.id,
          code: String(r.leaveType.code),
          keysOld,
          keysNew,
        });
      }
    }
  }

  const credits = await prisma.section9Credit.findMany({
    where: {
      employee: { tenantId },
      status: "CONFIRMED",
      creditedStart: { not: null },
      creditedEnd: { not: null },
    },
    select: {
      id: true,
      employeeId: true,
      creditedStart: true,
      creditedEnd: true,
      sickRequest: { select: { leaveType: { select: { code: true } } } },
    },
  });

  for (const c of credits) {
    if (!c.creditedStart || !c.creditedEnd) continue;
    const row = { from: c.creditedStart, to: c.creditedEnd };
    for (const ym of monthsAround(c.creditedStart, c.creditedEnd, current)) {
      const days = oldAndNew(row, ym, tz, legacyClippedDays, 0);
      if (days.old !== days.now && populations.inReport(c.employeeId, ym)) {
        dayCounts.push({
          tenantId,
          month: monthKey(ym),
          employeeId: c.employeeId,
          source: "section9Credit",
          id: c.id,
          code: String(c.sickRequest.leaveType.code),
          daysOld: days.old,
          daysNew: days.now,
        });
      }
    }
  }

  return { dayCounts, keyShifts };
}

function byKey<T>(...keys: ((x: T) => string)[]) {
  return (a: T, b: T) => {
    for (const k of keys) {
      const c = k(a).localeCompare(k(b));
      if (c !== 0) return c;
    }
    return 0;
  };
}

// ── Main entry point ─────────────────────────────────────────────────────────
/**
 * Exported for unit-testability — pass a PrismaClient to inject a test connection (run against
 * the worker test DB only); without one the CLI entrypoint below bootstraps its own connection
 * from DATABASE_URL.
 */
export async function main(argv: string[], injectedPrisma?: PrismaClient): Promise<number> {
  const args = parseCli(argv);

  if (args.help) {
    console.info(USAGE);
    return EXIT_OK;
  }

  if (!args.tenantId && !args.allTenants) {
    throw new Error(
      "Tenant-Auswahl erforderlich: bitte --tenant-id <uuid> ODER --all-tenants angeben.",
    );
  }

  if (!injectedPrisma && !process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    return EXIT_ERROR;
  }

  let pool: pg.Pool | undefined;
  let prisma: PrismaClient;
  if (injectedPrisma) {
    prisma = injectedPrisma;
  } else {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new PrismaPg(pool as any);
    prisma = new PrismaClient({ adapter });
  }

  try {
    let tenants: { id: string }[];
    if (args.allTenants) {
      tenants = await prisma.tenant.findMany({ select: { id: true }, orderBy: { id: "asc" } });
    } else {
      // A mistyped id must not read as a clean bill of health (exit 0, "total findings=0").
      const found = await prisma.tenant.findUnique({
        where: { id: args.tenantId! },
        select: { id: true },
      });
      if (!found) {
        console.error(`Tenant nicht gefunden: --tenant-id ${args.tenantId} existiert nicht.`);
        return EXIT_ERROR;
      }
      tenants = [found];
    }

    let total = 0;
    let exportsNoteNeeded = false;
    for (const t of tenants) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tz = await getTenantTimezone(prisma as any, t.id);
      const today = todayInTz(tz);
      const current: YearMonth = { year: today.getUTCFullYear(), month: today.getUTCMonth() + 1 };

      const employees: EmployeeRow[] = await prisma.employee.findMany({
        where: { tenantId: t.id },
        select: {
          id: true,
          isTimeTrackingExempt: true,
          exitDate: true,
          user: { select: { isActive: true } },
        },
      });
      const exports = await recordedExports(prisma, t.id);
      const populations = makePopulations(prisma, t.id, tz, employees, exports);

      const entryFindings = (
        await scanEntries(prisma, t.id, tz, current, employees, populations)
      ).sort(
        byKey<EntryFinding>(
          (f) => f.month,
          (f) => f.employeeId,
          (f) => f.date,
          (f) => f.entryId,
        ),
      );
      const leave = await scanLeave(prisma, t.id, tz, current, populations);
      const dayCounts = leave.dayCounts.sort(
        byKey<DayCountFinding>(
          (f) => f.month,
          (f) => f.employeeId,
          (f) => f.source,
          (f) => f.id,
        ),
      );
      const keyShifts = leave.keyShifts.sort(
        byKey<KeyShiftFinding>(
          (f) => f.month,
          (f) => f.employeeId,
          (f) => f.leaveRequestId,
        ),
      );
      for (const f of entryFindings) console.info(formatEntryFinding(f));
      for (const f of dayCounts) console.info(formatDayCountFinding(f));
      for (const f of keyShifts) console.info(formatKeyShiftFinding(f));
      total += entryFindings.length + dayCounts.length + keyShifts.length;

      // Per affected month: the exports actually recorded (D-07), then one line per employee.
      type Tally = {
        entries: number;
        workingMinutes: number;
        dayCountRows: number;
        keyShiftRows: number;
      };
      const tally = new Map<string, Map<string, Tally>>();
      const bump = (month: string, employeeId: string, apply: (t: Tally) => void) => {
        if (!tally.has(month)) tally.set(month, new Map());
        const perEmployee = tally.get(month)!;
        if (!perEmployee.has(employeeId)) {
          perEmployee.set(employeeId, {
            entries: 0,
            workingMinutes: 0,
            dayCountRows: 0,
            keyShiftRows: 0,
          });
        }
        apply(perEmployee.get(employeeId)!);
      };
      for (const f of entryFindings) {
        bump(f.month, f.employeeId, (x) => {
          x.entries += 1;
          x.workingMinutes += f.workingMinutes;
        });
      }
      for (const f of dayCounts) bump(f.month, f.employeeId, (x) => (x.dayCountRows += 1));
      for (const f of keyShifts) bump(f.month, f.employeeId, (x) => (x.keyShiftRows += 1));

      if (tally.size > 0) {
        for (const month of [...tally.keys()].sort()) {
          const perEmployee = tally.get(month)!;
          const company = [
            ...new Set(
              exports
                .filter((x) => x.month === month && x.employeeId === null)
                .map(companyExportLabel),
            ),
          ].sort();
          console.info(
            `month tenantId=${t.id} month=${month} employees=${perEmployee.size} ` +
              `exports(audited)=${company.length > 0 ? company.join(",") : "none"}`,
          );
          for (const employeeId of [...perEmployee.keys()].sort()) {
            const x = perEmployee.get(employeeId)!;
            const own = [
              ...new Set(
                exports
                  .filter((e) => e.month === month && e.employeeId === employeeId)
                  .map((e) => e.type),
              ),
            ].sort();
            console.info(
              `summary tenantId=${t.id} month=${month} employeeId=${employeeId} entries=${x.entries} ` +
                `workingMinutes=${x.workingMinutes} dayCountRows=${x.dayCountRows} keyShiftRows=${x.keyShiftRows} ` +
                `employeeExports(audited)=${own.length > 0 ? own.join(",") : "none"}`,
            );
          }
        }
        exportsNoteNeeded = true;
      }
    }

    if (exportsNoteNeeded) console.info(EXPORTS_NOTE);
    console.info(`total findings=${total}`);
    return total > 0 ? EXIT_FINDINGS : EXIT_OK;
  } finally {
    if (!injectedPrisma) {
      await prisma.$disconnect();
      await pool?.end();
    }
  }
}

// Run-guard: only bootstrap the DB + execute when invoked as a script, so importing the module
// for unit tests is side-effect-free (no connection, no process.exit).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = EXIT_ERROR;
    });
}
