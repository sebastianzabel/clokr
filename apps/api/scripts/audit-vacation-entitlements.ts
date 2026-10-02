/**
 * Audit tool — Issue #444 (Prüfbericht Urlaubsansprüche).
 *
 * READ-ONLY. ZERO mutations. Lists every stored VACATION `LeaveEntitlement` row (base year and
 * the following year) and classifies it so the owner can decide, case by case, whether a
 * correction is needed — corrections run only through the existing audited correction path
 * ("Antrag korrigieren" / PUT /settings/vacation), never through this script. Mirrors
 * `audit-multi-day-half-day-leave.ts`'s own structure, CLI and DSGVO output convention.
 *
 * Target/minimum are computed with the SAME helpers the write paths use — no formula is
 * reimplemented here:
 *   - target: `resolveRegularVacationDays()` (Issue #435 D-05 person/tenant base + statutory
 *     floor, Issue #447 exit twelfthing). Never reads `classification` — the apprentice tenant
 *     default is a UI pre-fill only (D-05), see the ABWEICHUNG_VERTRAG note below.
 *   - minimum: `statutoryMinimumVacationThreshold()`, fed by `resolveContractWorkDaysPerWeek()`.
 *
 * Categories (fixed output order; a row may carry several; `OK` only when none apply):
 *   - UNTER_MINIMUM: stored is below the statutory minimum (applies to manual rows too).
 *   - ABWEICHUNG_VERTRAG: NOT manual, NOT UNTER_MINIMUM, and stored differs from the target —
 *     OR, for an AZUBI without a person value (`annualVacationDays` null) whose birth date is
 *     known, stored differs from a second comparison target computed the SAME way but seeded
 *     with `TenantConfig.defaultApprenticeVacationDays` instead of the tenant's regular default
 *     (report-only; the production resolver in leave-days.ts stays unchanged, #435 D-05). The
 *     apprentice comparison is skipped while GEBURTSDATUM_FEHLT already applies — the statutory
 *     floor computed with no birth date is unreliable, so a second, independent deviation
 *     finding on top of it would only add noise (documented decision, see issue #444 comment).
 *   - GEBURTSDATUM_FEHLT: classification AZUBI and `birthDate` is null — the statutory minimum
 *     then fails open to § 3 BUrlG, which is why the owner must check this row manually.
 *   - NULL_PLATZHALTER: `totalDays` is 0, not auto-calculated, no human write ever set it (Issue
 *     #445/#447 `isZeroVacationPlaceholder`/`hasHumanVacationWrite`), AND the target is > 0 (a
 *     not-employed year legitimately holds 0). Supersedes UNTER_MINIMUM/ABWEICHUNG_VERTRAG for
 *     that row — the placeholder is the root cause; the #445 read-time heal fixes it.
 *   - JAHRESUEBERGREIFEND_FEHLT: an APPROVED/CANCELLATION_REQUESTED VACATION request spans two
 *     calendar years and the year's stored `usedDays` is below the chronological-prefix split
 *     (`countedLeaveDaysWithin`, Issue #445). When the year has NO entitlement row at all, a
 *     synthetic line is printed instead (`entitlementId=missing`).
 *   - UEBERTRAG_VERFALLEN_WIEDER: the previous year's carry-over partially lapsed per
 *     `carryOverRemainder()` (Issue #445 FIFO/expiry) but this year's stored `carriedOverDays`
 *     still reflects the un-lapsed (larger) amount.
 *   - VERTRAGSWECHSEL_PRUEFEN (flag only — Issue #450 implements the split): the employee has a
 *     WorkSchedule change (not the initial contract) whose `validFrom`, read as a calendar date
 *     in the tenant's timezone, falls inside the year.
 *
 * Output contains ids only — no name, no employee number, no birth/hire date (DSGVO). Full,
 * untruncated UUIDs so the owner can locate each row directly.
 *
 * Usage:
 *   DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx \
 *     scripts/audit-vacation-entitlements.ts \
 *     ( --tenant-id <uuid> | --all-tenants ) \
 *     [--year <YYYY>] \
 *     [--help]
 *
 * Exit codes:
 *   0 — no finding for the given scope (every row OK)
 *   1 — DATABASE_URL missing, or a DB connection/query failure
 *   2 — one or more findings (review manually; correction only via the existing correction path)
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { formatInTimeZone } from "date-fns-tz";
import {
  resolveRegularVacationDays,
  resolveContractWorkDaysPerWeek,
  hasHumanVacationWrite,
  isZeroVacationPlaceholder,
  countedLeaveDaysWithin,
  carryOverRemainder,
  daysDiffer,
} from "../src/contexts/absence/leave-days";
import {
  computeRegularVacationDays,
  statutoryMinimumVacationThreshold,
} from "../src/contexts/absence/vacation-calc";
import { getLeaveTypeByCode } from "../src/contexts/absence/facade/leave-types";
import { EFFECTIVE_LEAVE_STATUSES } from "../src/contexts/absence/effective-leave-statuses";

// ── Exit codes ──────────────────────────────────────────────────────────────
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_FINDINGS = 2;

// ── CLI parsing ───────────────────────────────────────────────────────────────
export type CliArgs = {
  tenantId: string | null;
  allTenants: boolean;
  year: number;
  help: boolean;
};

export function parseCli(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      "tenant-id": { type: "string" },
      "all-tenants": { type: "boolean", default: false },
      year: { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true, // rejects any unknown flag, in particular --confirm / --apply
  });

  let year = new Date().getUTCFullYear();
  if (values.year !== undefined) {
    const parsed = Number(values.year);
    if (!Number.isInteger(parsed) || parsed < 2000 || parsed > 2100) {
      throw new Error(
        `--year muss eine Jahreszahl zwischen 2000 und 2100 sein, erhalten: ${values.year}`,
      );
    }
    year = parsed;
  }

  return {
    tenantId: values["tenant-id"] ?? null,
    allTenants: Boolean(values["all-tenants"]),
    year,
    help: Boolean(values.help),
  };
}

const USAGE = `
Usage:
  DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx \\
    scripts/audit-vacation-entitlements.ts \\
    ( --tenant-id <uuid> | --all-tenants ) \\
    [--year <YYYY>] \\
    [--help]

READ-ONLY — lists every stored VACATION LeaveEntitlement row (base year + following year) with
its target, statutory minimum, deviation and classification (Issue #444). No write/correction
flag exists.

Exit codes:
  0 — every row OK for the given scope
  1 — DATABASE_URL missing, or a DB connection/query failure
  2 — one or more findings (review manually; correction only via the existing correction path)
`;

// ── Report row shape ─────────────────────────────────────────────────────────
export type ReportRow = {
  tenantId: string;
  employeeId: string;
  entitlementId: string; // "missing" for a synthetic JAHRESUEBERGREIFEND_FEHLT line
  year: number;
  stored: number | null;
  used: number | null;
  carriedOver: number | null;
  target: number;
  minimum: number;
  deviation: number | null; // null (printed "n/a") for a synthetic row
  manual: boolean;
  categories: string[];
};

type EmployeeInfo = {
  id: string;
  hireDate: Date;
  exitDate: Date | null;
  birthDate: Date | null;
  classification: string;
  annualVacationDays: unknown;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function belowThreshold(stored: number, threshold: number): boolean {
  return Math.round(stored * 100) < Math.round(threshold * 100);
}

function employedInYear(hireDate: Date, exitDate: Date | null, year: number): boolean {
  return (
    hireDate.getUTCFullYear() <= year && (exitDate === null || exitDate.getUTCFullYear() >= year)
  );
}

function fmtNullable(n: number | null): string {
  return n === null ? "none" : round2(n).toFixed(2);
}

/** Full UUIDs — DSGVO-safe (no name, no employeeNumber, no birth/hire date). */
export function formatLine(row: ReportRow): string {
  const categories = row.categories.length > 0 ? row.categories.join(",") : "OK";
  const deviation = row.deviation === null ? "n/a" : round2(row.deviation).toFixed(2);
  return (
    `tenantId=${row.tenantId} employeeId=${row.employeeId} entitlementId=${row.entitlementId} ` +
    `year=${row.year} stored=${fmtNullable(row.stored)} used=${fmtNullable(row.used)} ` +
    `carriedOver=${fmtNullable(row.carriedOver)} target=${round2(row.target).toFixed(2)} ` +
    `minimum=${round2(row.minimum).toFixed(2)} deviation=${deviation} manual=${row.manual ? "yes" : "no"} ` +
    `categories=${categories}`
  );
}

// ── Per-row classification (Kernkategorien) ──────────────────────────────────
type RawEntitlement = {
  id: string;
  totalDays: unknown;
  usedDays: unknown;
  carriedOverDays: unknown;
  isAutoCalculated: boolean;
};

async function classifyRow(
  prisma: PrismaClient,
  tenantId: string,
  employee: EmployeeInfo,
  entitlement: RawEntitlement,
  year: number,
  apprenticeDefault: number,
): Promise<ReportRow> {
  const stored = Number(entitlement.totalDays);
  const used = Number(entitlement.usedDays);
  const carriedOver = Number(entitlement.carriedOverDays);

  const workDaysPerWeek = await resolveContractWorkDaysPerWeek(prisma, employee.id, tenantId);
  const target = await resolveRegularVacationDays(prisma, employee.id, tenantId, year);
  const minimum = statutoryMinimumVacationThreshold({
    birthDate: employee.birthDate,
    year,
    workDaysPerWeek,
    hireDate: employee.hireDate,
    exitDate: employee.exitDate,
  });
  const manual = await hasHumanVacationWrite(prisma, entitlement.id);
  const nullPlaceholder =
    target > 0 &&
    (await isZeroVacationPlaceholder(prisma, {
      id: entitlement.id,
      totalDays: entitlement.totalDays,
      isAutoCalculated: entitlement.isAutoCalculated,
    }));
  const underMinimum = !nullPlaceholder && belowThreshold(stored, minimum);
  const birthDateMissing = employee.classification === "AZUBI" && employee.birthDate === null;

  // ABWEICHUNG_VERTRAG, second comparison target — see the ABWEICHUNG_VERTRAG docblock note above
  // for the GEBURTSDATUM_FEHLT exclusion.
  let apprenticeTarget: number | null = null;
  if (
    employee.classification === "AZUBI" &&
    employee.annualVacationDays === null &&
    !birthDateMissing
  ) {
    const employed = employedInYear(employee.hireDate, employee.exitDate, year);
    apprenticeTarget = computeRegularVacationDays({
      year,
      hireDate: employee.hireDate,
      birthDate: employee.birthDate,
      exitDate: employee.exitDate,
      workDaysPerWeek,
      baseDays: employed ? apprenticeDefault : 0,
    });
  }

  const deviatesFromTarget =
    daysDiffer(stored, target) ||
    (apprenticeTarget !== null && daysDiffer(stored, apprenticeTarget));
  const contractDeviation = !manual && !underMinimum && !nullPlaceholder && deviatesFromTarget;

  const categories: string[] = [];
  if (underMinimum) categories.push("UNTER_MINIMUM");
  if (contractDeviation) categories.push("ABWEICHUNG_VERTRAG");
  if (birthDateMissing) categories.push("GEBURTSDATUM_FEHLT");
  if (nullPlaceholder) categories.push("NULL_PLATZHALTER");

  return {
    tenantId,
    employeeId: employee.id,
    entitlementId: entitlement.id,
    year,
    stored,
    used,
    carriedOver,
    target,
    minimum,
    deviation: round2(stored - target),
    manual,
    categories,
  };
}

// ── Ergänzung (c): carry-over that lapsed but still shows up the next year ──
async function applyCarryOverCheck(
  prisma: PrismaClient,
  tenantId: string,
  employee: EmployeeInfo,
  vacationTypeId: string,
  row: ReportRow,
): Promise<void> {
  if (row.carriedOver === null) return;
  const prev = await prisma.leaveEntitlement.findUnique({
    where: {
      employeeId_leaveTypeId_year: {
        employeeId: employee.id,
        leaveTypeId: vacationTypeId,
        year: row.year - 1,
      },
    },
    select: {
      id: true,
      employeeId: true,
      leaveTypeId: true,
      year: true,
      totalDays: true,
      usedDays: true,
      carriedOverDays: true,
      carryOverDeadline: true,
    },
  });
  if (!prev) return;

  const remainder = await carryOverRemainder(prisma, prev, tenantId);
  const raw = Math.max(
    0,
    round2(Number(prev.totalDays) + Number(prev.carriedOverDays) - Number(prev.usedDays)),
  );
  const carryLapsed = daysDiffer(raw, remainder);
  const storedExceedsRemainder = Math.round(row.carriedOver * 100) > Math.round(remainder * 100);
  if (carryLapsed && storedExceedsRemainder) {
    row.categories.push("UEBERTRAG_VERFALLEN_WIEDER");
  }
}

// ── Ergänzung (d): mid-year contract change not yet reviewed (flag only, #450 splits) ──
async function applyContractChangeCheck(
  prisma: PrismaClient,
  employee: EmployeeInfo,
  row: ReportRow,
  timezone: string,
): Promise<void> {
  const schedules = await prisma.workSchedule.findMany({
    where: { employeeId: employee.id },
    select: { validFrom: true },
    orderBy: { validFrom: "asc" },
  });
  if (schedules.length < 2) return; // single (initial) contract — never flagged

  const yearStart = formatInTimeZone(new Date(Date.UTC(row.year, 0, 1)), timezone, "yyyy-MM-dd");
  const yearEnd = formatInTimeZone(
    new Date(Date.UTC(row.year, 11, 31, 23, 59, 59)),
    timezone,
    "yyyy-MM-dd",
  );
  // The FIRST schedule is the initial contract (exempt) — only a LATER schedule counts as a
  // mid-year change.
  const changed = schedules.slice(1).some((s) => {
    const d = formatInTimeZone(s.validFrom, timezone, "yyyy-MM-dd");
    return d > yearStart && d <= yearEnd;
  });
  if (changed) row.categories.push("VERTRAGSWECHSEL_PRUEFEN");
}

// ── Ergänzung (b): a cross-year request whose days are missing from the account ──
async function applyCrossYearCheck(
  prisma: PrismaClient,
  tenantId: string,
  employee: EmployeeInfo,
  vacationTypeId: string,
  baseYear: number,
  rowsByEmployeeYear: Map<string, ReportRow>,
  apprenticeDefault: number,
): Promise<ReportRow[]> {
  const requests = await prisma.leaveRequest.findMany({
    where: {
      employeeId: employee.id,
      leaveTypeId: vacationTypeId,
      deletedAt: null,
      status: { in: [...EFFECTIVE_LEAVE_STATUSES] },
    },
    select: { startDate: true, endDate: true },
  });

  const yearsTouched = new Set<number>();
  for (const r of requests) {
    const sy = r.startDate.getUTCFullYear();
    const ey = r.endDate.getUTCFullYear();
    if (sy === ey) continue;
    if (sy === baseYear || sy === baseYear + 1) yearsTouched.add(sy);
    if (ey === baseYear || ey === baseYear + 1) yearsTouched.add(ey);
  }

  const extraRows: ReportRow[] = [];
  for (const y of yearsTouched) {
    const { requestDays, section9CreditDays } = await countedLeaveDaysWithin(prisma, {
      employeeId: employee.id,
      tenantId,
      leaveTypeIds: [vacationTypeId],
      from: new Date(Date.UTC(y, 0, 1)),
      to: new Date(Date.UTC(y, 11, 31)),
    });
    const expectedUsed = Math.max(0, round2(requestDays - section9CreditDays));
    const existing = rowsByEmployeeYear.get(`${employee.id}:${y}`);
    if (existing) {
      if (existing.used !== null && belowThreshold(existing.used, expectedUsed)) {
        existing.categories.push("JAHRESUEBERGREIFEND_FEHLT");
      }
      continue;
    }

    // No entitlement row at all for this year — synthetic line, target/minimum still computed.
    void apprenticeDefault; // target/minimum below never need the apprentice comparison
    const workDaysPerWeek = await resolveContractWorkDaysPerWeek(prisma, employee.id, tenantId);
    const target = await resolveRegularVacationDays(prisma, employee.id, tenantId, y);
    const minimum = statutoryMinimumVacationThreshold({
      birthDate: employee.birthDate,
      year: y,
      workDaysPerWeek,
      hireDate: employee.hireDate,
      exitDate: employee.exitDate,
    });
    extraRows.push({
      tenantId,
      employeeId: employee.id,
      entitlementId: "missing",
      year: y,
      stored: null,
      used: null,
      carriedOver: null,
      target,
      minimum,
      deviation: null,
      manual: false,
      categories: ["JAHRESUEBERGREIFEND_FEHLT"],
    });
  }
  return extraRows;
}

async function auditTenant(
  prisma: PrismaClient,
  tenantId: string,
  baseYear: number,
): Promise<ReportRow[]> {
  const vacationType = await getLeaveTypeByCode(prisma, tenantId, "VACATION");
  if (!vacationType) return [];

  const tenantConfig = await prisma.tenantConfig.findUnique({
    where: { tenantId },
    select: { defaultApprenticeVacationDays: true, timezone: true },
  });
  const apprenticeDefault = Number(tenantConfig?.defaultApprenticeVacationDays ?? 20);
  const timezone = tenantConfig?.timezone ?? "Europe/Berlin";

  const entitlements = await prisma.leaveEntitlement.findMany({
    where: {
      leaveTypeId: vacationType.id,
      year: { in: [baseYear, baseYear + 1] },
      employee: { tenantId },
    },
    select: {
      id: true,
      employeeId: true,
      year: true,
      totalDays: true,
      usedDays: true,
      carriedOverDays: true,
      isAutoCalculated: true,
      employee: {
        select: {
          id: true,
          hireDate: true,
          exitDate: true,
          birthDate: true,
          classification: true,
          annualVacationDays: true,
        },
      },
    },
    orderBy: [{ employeeId: "asc" }, { year: "asc" }],
  });

  const rowsByEmployeeYear = new Map<string, ReportRow>();
  const employeesSeen = new Map<string, EmployeeInfo>();

  for (const e of entitlements) {
    employeesSeen.set(e.employee.id, e.employee);
    const row = await classifyRow(prisma, tenantId, e.employee, e, e.year, apprenticeDefault);
    rowsByEmployeeYear.set(`${e.employee.id}:${e.year}`, row);
  }

  for (const row of rowsByEmployeeYear.values()) {
    const employee = employeesSeen.get(row.employeeId)!;
    await applyCarryOverCheck(prisma, tenantId, employee, vacationType.id, row);
    await applyContractChangeCheck(prisma, employee, row, timezone);
  }

  const extraRows: ReportRow[] = [];
  for (const employee of employeesSeen.values()) {
    extraRows.push(
      ...(await applyCrossYearCheck(
        prisma,
        tenantId,
        employee,
        vacationType.id,
        baseYear,
        rowsByEmployeeYear,
        apprenticeDefault,
      )),
    );
  }

  return [...rowsByEmployeeYear.values(), ...extraRows];
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
      ? await prisma.tenant.findMany({ select: { id: true } })
      : [{ id: args.tenantId! }];

    const allRows: ReportRow[] = [];
    for (const t of tenants) {
      allRows.push(...(await auditTenant(prisma, t.id, args.year)));
    }

    allRows.sort((a, b) => {
      if (a.tenantId !== b.tenantId) return a.tenantId.localeCompare(b.tenantId);
      if (a.employeeId !== b.employeeId) return a.employeeId.localeCompare(b.employeeId);
      return a.year - b.year;
    });

    const counts = new Map<string, number>();
    let findingsCount = 0;
    for (const row of allRows) {
      console.info(formatLine(row));
      if (row.categories.length === 0) {
        counts.set("OK", (counts.get("OK") ?? 0) + 1);
      } else {
        findingsCount++;
        for (const c of row.categories) counts.set(c, (counts.get(c) ?? 0) + 1);
      }
    }

    const byCategory = Array.from(counts.entries())
      .map(([c, n]) => `${c}=${n}`)
      .join(", ");
    console.info(
      `\nSummary: ${allRows.length} row(s) across ${tenants.length} tenant(s) (${byCategory}). ` +
        `Read-only — this script writes nothing; corrections run only via the existing audited correction path.`,
    );

    return findingsCount > 0 ? EXIT_FINDINGS : EXIT_OK;
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
