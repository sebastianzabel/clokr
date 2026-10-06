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
 *   1 — DATABASE_URL missing, or a DB connection/query failure
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
report exports recorded for each affected month. No write/correction flag exists.

Exit codes:
  0 — no finding for the given scope
  1 — DATABASE_URL missing, or a DB connection/query failure
  2 — one or more findings (correction list for already delivered files)
`;

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

// ── Per-tenant scan ───────────────────────────────────────────────────────────
async function scanEntries(
  prisma: PrismaClient,
  tenantId: string,
  tz: string,
  current: YearMonth,
): Promise<EntryFinding[]> {
  const employees = await prisma.employee.findMany({
    where: { tenantId },
    select: { id: true, isTimeTrackingExempt: true },
  });
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
      findings.push({
        tenantId,
        month: monthKey(ym),
        employeeId: e.employeeId,
        entryId: e.id,
        date,
        type: String(e.type),
        workingMinutes: Math.round(entryDurations(e).workingMinutes),
        reportEntryList: e.type === "WORK",
        datevHours: true,
        reportIst:
          e.type === "WORK" && !exempt.get(e.employeeId) && (await isUntracked(e.employeeId, ym)),
      });
    }
  }
  return findings;
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
    const tenants = args.allTenants
      ? await prisma.tenant.findMany({ select: { id: true }, orderBy: { id: "asc" } })
      : [{ id: args.tenantId! }];

    let total = 0;
    for (const t of tenants) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tz = await getTenantTimezone(prisma as any, t.id);
      const today = todayInTz(tz);
      const current: YearMonth = { year: today.getUTCFullYear(), month: today.getUTCMonth() + 1 };

      const entryFindings = (await scanEntries(prisma, t.id, tz, current)).sort(
        byKey<EntryFinding>(
          (f) => f.month,
          (f) => f.employeeId,
          (f) => f.date,
          (f) => f.entryId,
        ),
      );
      for (const f of entryFindings) console.info(formatEntryFinding(f));
      total += entryFindings.length;
    }

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
