/**
 * Audit tool — committed 2026-10-02 for Issue #447 (D-04).
 *
 * Plans 447-01/02 fixed the exit-month Soll computation: `closeEmployeeMonth()` now clips Soll,
 * holiday deduction, leave/absence credit and (for SHIFT_BASED) the roster period at the
 * employee's `exitDate`, instead of running to the full calendar month. That fix only changes
 * saldo computed FROM NOW ON. Every exit month a tenant already had CLOSED under the old,
 * pre-#447 formula keeps its stored `SaldoSnapshot.expectedMinutes`/`balanceMinutes` untouched —
 * CLAUDE.md's Revisionssicherheit rules forbid silently rewriting a closed snapshot, and a locked
 * month is immutable even to admins.
 *
 * This script lists, for EVERY employee with a non-null `exitDate` (any schedule type, not only
 * SHIFT_BASED — unlike `dry-run-429-leave-contract-days.ts`, which this file's structure mirrors),
 * the exit month's STORED `expectedMinutes`/`balanceMinutes` (or `none` when no snapshot exists
 * yet) next to what `closeEmployeeMonth()` (the Issue #447 exit-clip formula, as it stands on this
 * branch) RECOMPUTES for the same month, and the delta between them. Whoever owns payroll gets a
 * concrete, per-tenant/per-employee list of which exit months would now compute differently, so
 * THEY can decide whether and how to correct any of them via the existing correction-booking
 * flow — never as a side effect of running this script.
 *
 * READ-ONLY. ZERO mutations. There is no opt-in write/repair flag anywhere in this file, and none
 * may ever be added (mirroring `dry-run-429-leave-contract-days.ts`'s own D-15-cited reasoning
 * here): a detector that can also repair will eventually be run in repair mode by accident on
 * payroll data.
 *
 * Simplification (mirrors dry-run-429's own D-15 simplification): `closeEmployeeMonth()`'s
 * `expectedMinutes`/`balanceMinutes` do not depend on `carryOverIn` (only `carryOverOut`/
 * `effectiveCarryOverOut` do), so this script always recomputes with `carryOverIn: 0` — it does
 * NOT walk each employee's whole snapshot chain the way `recalculate-snapshots.ts` does.
 *
 * Holiday resolution mirrors the manual-close path exactly (`api/overtime.ts`'s close-month
 * handler): the employee's own work-location entries (facade T2) feed `holidaysAtWorkLocation`
 * over `[effectiveStart, monthEnd]` — no second holiday formula.
 *
 * Output contains ids only — no employee name, no employee number (DSGVO). Follows
 * `audit-saldo-chain-integrity.ts`'s and `dry-run-429-leave-contract-days.ts`'s convention,
 * deliberately NOT `audit-workdays-vs-day-hours.ts`'s (which prints names) — see
 * scripts/README.md's own classification table.
 *
 * Delta sign convention (stated once, applied consistently): delta = recomputed − stored.
 * A positive delta means the Issue #447 exit-clip formula now computes a HIGHER value than what
 * is stored; a negative delta means it computes LOWER. An exit month with no stored snapshot yet
 * prints `stored=none` and carries no delta — it is not a correction candidate, just a month the
 * owner has not closed yet.
 *
 * Run (never against prod/int without the operator's own DATABASE_URL — never set by this
 * script, never executed by this commit):
 *   DATABASE_URL=... pnpm --filter @clokr/api exec tsx \
 *     scripts/audit-exit-month-saldo.ts [--tenant-id <uuid>]
 *
 * Exit codes:
 *   0 — no exit month has a stored snapshot whose expected/balance minutes differ from the
 *       Issue #447 recompute
 *   1 — DATABASE_URL missing, or a DB connection/query failure
 *   2 — one or more stored snapshots differ from the recompute (review, do not auto-correct)
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  closeEmployeeMonth,
  toCloseMonthApprovedLeave,
} from "../src/contexts/working-time-account/close-employee-month";
import {
  getTenantTimezone,
  dateStrInTz,
  monthRangeUtc,
  monthDayBounds,
  isSnapshotLocked,
} from "../src/contexts/working-time-account";
import { holidaysAtWorkLocation } from "../src/contexts/platform";
import {
  getValidWorkedEntriesInRange,
  getWorkedEntriesInRange,
} from "../src/contexts/time-tracking";
import { getShiftsInRange } from "../src/contexts/scheduling";
import {
  getActiveLeaveOverlapping,
  getAbsencesOverlapping,
  loadBsSlotOverrides,
} from "../src/contexts/absence";

// ── Exit codes ──────────────────────────────────────────────────────────────
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_FINDINGS = 2;

/** Truncated, non-identifying id for output. NEVER print names or employee numbers. */
export function truncId(id: string): string {
  return id.slice(0, 8);
}

// ── Pure, exported helpers (DB-free, unit-testable) ─────────────────────────

export type MinutePair = { expectedMinutes: number; balanceMinutes: number };

export type DeltaResult = { expectedDelta: number; balanceDelta: number };

/** delta = recomputed − stored, for both the expected and balance fields. */
export function computeDelta(stored: MinutePair, recomputed: MinutePair): DeltaResult {
  return {
    expectedDelta: recomputed.expectedMinutes - stored.expectedMinutes,
    balanceDelta: recomputed.balanceMinutes - stored.balanceMinutes,
  };
}

/** The employee's exit month, as { year, month } (1-based), from the exit day's tenant-TZ string. */
export function exitMonthOf(exitDate: Date, tz: string): { year: number; month: number } {
  const dayStr = dateStrInTz(exitDate, tz);
  const [y, m] = dayStr.split("-").map(Number);
  return { year: y!, month: m! };
}

export type ExitMonthFinding = {
  tenantId: string;
  employeeId: string;
  monthLabel: string; // YYYY-MM
  /** null → no non-superseded MONTHLY snapshot exists yet for this exit month. */
  snapshotId: string | null;
  /** null → not meaningful (no snapshot to check lock state against). */
  locked: boolean | null;
  storedExpectedMinutes: number | null;
  storedBalanceMinutes: number | null;
  recomputedExpectedMinutes: number;
  recomputedBalanceMinutes: number;
  expectedDelta: number | null;
  balanceDelta: number | null;
};

function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

export function formatExitMonthLine(f: ExitMonthFinding): string {
  const snapshotLabel = f.snapshotId ? truncId(f.snapshotId) : "none";
  const lockedLabel = f.locked === null ? "-" : String(f.locked);
  const expectedPart =
    f.storedExpectedMinutes === null
      ? `expected(stored=none,recomputed=${f.recomputedExpectedMinutes})`
      : `expected(stored=${f.storedExpectedMinutes},recomputed=${f.recomputedExpectedMinutes},` +
        `delta=${signed(f.expectedDelta!)})`;
  const balancePart =
    f.storedBalanceMinutes === null
      ? `balance(stored=none,recomputed=${f.recomputedBalanceMinutes})`
      : `balance(stored=${f.storedBalanceMinutes},recomputed=${f.recomputedBalanceMinutes},` +
        `delta=${signed(f.balanceDelta!)})`;
  return (
    `tenant=${truncId(f.tenantId)} emp=${truncId(f.employeeId)} month=${f.monthLabel} ` +
    `snapshot=${snapshotLabel} locked=${lockedLabel} ${expectedPart} ${balancePart}`
  );
}

// ── CLI parsing ──────────────────────────────────────────────────────────────

export type CliArgs = { tenantId: string | null };

export function parseCliArgs(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      "tenant-id": { type: "string" },
    },
    strict: true,
  });
  return { tenantId: values["tenant-id"] ?? null };
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Exported for unit-testability — pass a PrismaClient to inject a test connection (run against
 * the worker test DB only); without one the function bootstraps its own connection from
 * DATABASE_URL.
 */
export async function main(argv: string[], injectedPrisma?: PrismaClient): Promise<number> {
  const args = parseCliArgs(argv);

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
    // Scope: every employee with a non-null exitDate (optionally filtered by --tenant-id), any
    // schedule type, excluding § 18-exempt employees (they never accrue saldo). ids only — no
    // first/last name, no employee number ever selected (DSGVO).
    const employees = await prisma.employee.findMany({
      where: {
        ...(args.tenantId ? { tenantId: args.tenantId } : {}),
        exitDate: { not: null },
        isTimeTrackingExempt: false,
      },
      select: {
        id: true,
        tenantId: true,
        hireDate: true,
        exitDate: true,
        breakOver6hOverride: true,
        breakOver9hOverride: true,
      },
      orderBy: [{ tenantId: "asc" }, { id: "asc" }],
    });

    const findings: ExitMonthFinding[] = [];
    let deltaCount = 0;
    let noScheduleCount = 0;
    const tenantIds = new Set<string>();

    const tzByTenant = new Map<string, string>();
    const tenantConfigByTenant = new Map<
      string,
      Awaited<ReturnType<typeof prisma.tenantConfig.findUnique>>
    >();

    for (const emp of employees) {
      if (!emp.exitDate) continue; // narrows the type; already filtered by the query above
      tenantIds.add(emp.tenantId);

      if (!tzByTenant.has(emp.tenantId)) {
        tzByTenant.set(emp.tenantId, await getTenantTimezone(prisma, emp.tenantId));
      }
      const tz = tzByTenant.get(emp.tenantId)!;

      if (!tenantConfigByTenant.has(emp.tenantId)) {
        tenantConfigByTenant.set(
          emp.tenantId,
          await prisma.tenantConfig.findUnique({ where: { tenantId: emp.tenantId } }),
        );
      }
      const tenantConfigRow = tenantConfigByTenant.get(emp.tenantId) ?? null;

      const { year, month } = exitMonthOf(emp.exitDate, tz);
      const { start: monthStart, end: monthEnd } = monthRangeUtc(year, month, tz);
      const { firstDay: monthFirstDay, lastDay: monthLastDay } = monthDayBounds(
        monthStart,
        monthEnd,
        tz,
      );

      const hireDateNorm = emp.hireDate
        ? new Date(dateStrInTz(emp.hireDate, tz) + "T00:00:00Z")
        : null;
      const effectiveStart =
        hireDateNorm && hireDateNorm > monthFirstDay ? hireDateNorm : monthFirstDay;

      // Resolve the schedule as-of the middle of the exit month — mirrors the manual-close path
      // and dry-run-429's own convention (an employee may have changed schedule type mid-history).
      const midMonth = new Date((monthStart.getTime() + monthEnd.getTime()) / 2);
      const schedule = await prisma.workSchedule.findFirst({
        where: { employeeId: emp.id, validFrom: { lte: midMonth } },
        orderBy: { validFrom: "desc" },
      });
      if (!schedule) {
        noScheduleCount++;
        continue;
      }

      // Phase 71b (issue #71) — holiday set by WORK LOCATION, fed with this employee's own
      // closed work entries (facade T2), exactly like the manual-close handler
      // (api/overtime.ts:1322-1340).
      const workLocationEntries = await getWorkedEntriesInRange(
        prisma,
        { kind: "employee", employeeId: emp.id, tenantId: emp.tenantId },
        effectiveStart,
        monthLastDay,
      );
      const holidaysByEmployee = await holidaysAtWorkLocation(
        prisma,
        emp.tenantId,
        [emp.id],
        dateStrInTz(effectiveStart, tz),
        dateStrInTz(monthEnd, tz),
        workLocationEntries,
      );
      const holidayDateStrings = new Set<string>(holidaysByEmployee.get(emp.id)?.keys() ?? []);

      const [entries, shifts, approvedLeaveRows, absenceRows, bsSlots] = await Promise.all([
        getValidWorkedEntriesInRange(
          prisma,
          { kind: "employee", employeeId: emp.id, tenantId: emp.tenantId },
          effectiveStart,
          monthLastDay,
        ),
        getShiftsInRange(
          prisma,
          { kind: "employee", employeeId: emp.id, tenantId: emp.tenantId },
          effectiveStart,
          monthLastDay,
        ),
        getActiveLeaveOverlapping(
          prisma,
          { kind: "employee", employeeId: emp.id, tenantId: emp.tenantId },
          monthStart,
          monthEnd,
        ),
        getAbsencesOverlapping(
          prisma,
          { kind: "employee", employeeId: emp.id, tenantId: emp.tenantId },
          effectiveStart,
          monthEnd,
        ),
        loadBsSlotOverrides(prisma, emp.id, monthFirstDay),
      ]);

      const result = closeEmployeeMonth({
        employeeId: emp.id,
        monthStart,
        monthEnd,
        monthFirstDay,
        monthLastDay,
        tz,
        carryOverIn: 0, // simplification mirrored from dry-run-429 — expected/balance don't depend on it
        schedule: schedule as unknown as Record<string, unknown>,
        hireDate: emp.hireDate,
        exitDate: emp.exitDate,
        isTimeTrackingExempt: false,
        breakOver6hOverride: emp.breakOver6hOverride ?? null,
        breakOver9hOverride: emp.breakOver9hOverride ?? null,
        entries: entries.map((e) => ({
          date: e.date,
          startTime: e.startTime,
          endTime: e.endTime!,
          breakMinutes: e.breakMinutes,
        })),
        shifts: shifts.map((sh) => ({
          date: sh.date,
          startTime: sh.startTime,
          endTime: sh.endTime,
        })),
        approvedLeave: toCloseMonthApprovedLeave(approvedLeaveRows),
        absences: absenceRows.map((ab) => ({
          startDate: ab.startDate,
          endDate: ab.endDate,
          type: ab.type,
          source: ab.source,
          halfDay: ab.halfDay,
          unterrichtsMinutes: ab.unterrichtsMinutes ?? null,
        })),
        holidayDateStrings,
        tenantConfig: tenantConfigRow
          ? {
              defaultBreakOver6h: tenantConfigRow.defaultBreakOver6h,
              defaultBreakOver9h: tenantConfigRow.defaultBreakOver9h,
              defaultWorkDays: tenantConfigRow.defaultWorkDays ?? undefined,
              monthlyHoursHolidayDeduction:
                tenantConfigRow.monthlyHoursHolidayDeduction ?? undefined,
              vocationalSchoolMinutesPerDay:
                tenantConfigRow.vocationalSchoolMinutesPerDay ?? undefined,
              vocationalSchoolBlockMinutesPerWeek:
                tenantConfigRow.vocationalSchoolBlockMinutesPerWeek ?? undefined,
              bsSlotFirstLongDayMinutes: tenantConfigRow.bsSlotFirstLongDayMinutes ?? undefined,
              bsSlotSecondLongDayMinutes: tenantConfigRow.bsSlotSecondLongDayMinutes ?? undefined,
              bsSlotShortDayMinutes: tenantConfigRow.bsSlotShortDayMinutes ?? undefined,
              bsSlotBlockWeekMinutes: tenantConfigRow.bsSlotBlockWeekMinutes ?? undefined,
            }
          : null,
        employeeSlots: bsSlots.employeeSlots,
        patternSlots: bsSlots.patternSlots,
        patternUnterrichtsMinutenByDow: bsSlots.patternUnterrichtsMinutenByDow,
      });

      // Stored snapshot = the non-superseded MONTHLY row whose periodStart equals
      // monthRangeUtc(...).start — never a hand-built boundary (lint:saldo-lock-derivation).
      const snapshot = await prisma.saldoSnapshot.findFirst({
        where: {
          employeeId: emp.id,
          periodType: "MONTHLY",
          periodStart: monthStart,
          superseded: false,
        },
        select: { id: true, expectedMinutes: true, balanceMinutes: true, periodEnd: true },
      });

      let snapshotId: string | null = null;
      let locked: boolean | null = null;
      let storedExpectedMinutes: number | null = null;
      let storedBalanceMinutes: number | null = null;
      let expectedDelta: number | null = null;
      let balanceDelta: number | null = null;

      if (snapshot) {
        snapshotId = snapshot.id;
        storedExpectedMinutes = snapshot.expectedMinutes;
        storedBalanceMinutes = snapshot.balanceMinutes;
        locked = await isSnapshotLocked(
          prisma,
          emp.id,
          emp.tenantId,
          monthStart,
          snapshot.periodEnd,
        );
        const delta = computeDelta(
          { expectedMinutes: snapshot.expectedMinutes, balanceMinutes: snapshot.balanceMinutes },
          { expectedMinutes: result.expectedMinutes, balanceMinutes: result.balanceMinutes },
        );
        expectedDelta = delta.expectedDelta;
        balanceDelta = delta.balanceDelta;
        if (delta.expectedDelta !== 0 || delta.balanceDelta !== 0) deltaCount++;
      }

      findings.push({
        tenantId: emp.tenantId,
        employeeId: emp.id,
        monthLabel: `${year}-${String(month).padStart(2, "0")}`,
        snapshotId,
        locked,
        storedExpectedMinutes,
        storedBalanceMinutes,
        recomputedExpectedMinutes: result.expectedMinutes,
        recomputedBalanceMinutes: result.balanceMinutes,
        expectedDelta,
        balanceDelta,
      });
    }

    // ── Output (grouped by tenant, mirrors dry-run-429-leave-contract-days.ts) ──────────────
    if (findings.length === 0) {
      console.log("No exit months found.");
    } else {
      let currentTenant = "";
      for (const f of findings) {
        if (f.tenantId !== currentTenant) {
          console.log(`\n== Tenant: ${truncId(f.tenantId)} ==`);
          currentTenant = f.tenantId;
        }
        console.log(`  ${formatExitMonthLine(f)}`);
      }
    }

    console.log(
      `\nSummary: ${employees.length} employee(s) with an exitDate scanned across ` +
        `${tenantIds.size} tenant(s); ${findings.length} exit month(s) listed ` +
        `(${noScheduleCount} skipped — no schedule valid at the exit month); ` +
        `${findings.filter((f) => f.snapshotId !== null).length} had a stored snapshot; ` +
        `${deltaCount} finding(s) with a non-zero delta.`,
    );
    console.log(`\nExit code: ${deltaCount > 0 ? EXIT_FINDINGS : EXIT_OK}`);

    return deltaCount > 0 ? EXIT_FINDINGS : EXIT_OK;
  } catch (err) {
    console.error(err);
    return EXIT_ERROR;
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
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
