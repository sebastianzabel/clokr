/**
 * Audit tool — committed 2026-10-03 for Issue #433 (D-12).
 *
 * Plan 433-01..06 give `WorkSchedule.type = MONTHLY_HOURS` with `monthlyHours > 0` an OWED
 * monthly Soll (not a budget): approved/effective leave (every type that already reduces Soll
 * for other schedule types, incl. SICK), imposed absences, and statutory/manual public holidays
 * falling on a contractual workday now each reduce that Soll by a per-day average value (the
 * Ø-Methode, `monthlyHours × 60 ÷ contractual workdays in the full calendar month`,
 * `calcMonthlyHoursHolidayMinutesTz`/`calcLeaveAbsenceMinutesTz`'s MONTHLY_HOURS branch). The
 * retired per-tenant holiday-deduction switch (Issue #433, D-04, plans 433-03/04): no code path
 * reads or writes it any more. That fix only changes saldo COMPUTED FROM NOW ON. Every
 * MONTHLY_HOURS month a tenant already had CLOSED under the old, pre-#433 formula (no leave/
 * absence/holiday deduction at all) keeps its stored `SaldoSnapshot.expectedMinutes`/
 * `balanceMinutes` untouched — CLAUDE.md's Revisionssicherheit rules forbid silently rewriting a
 * closed snapshot, and a locked month is immutable even to admins.
 *
 * This script lists, for every MONTHLY_HOURS employee-month (`monthlyHours > 0`, not § 18-exempt)
 * that has a stored non-superseded MONTHLY `SaldoSnapshot`, that month's STORED
 * `expectedMinutes`/`balanceMinutes` next to what `closeEmployeeMonth()` (the Issue #433 rule, as
 * it stands on this branch) RECOMPUTES for the same month, and the delta between them. Whoever
 * owns payroll gets a concrete, per-tenant/per-employee list of which MONTHLY_HOURS months would
 * now compute differently, so THEY can decide whether and how to correct any of them via the
 * existing correction-booking flow — never as a side effect of running this script.
 *
 * READ-ONLY. ZERO mutations. There is no opt-in write/repair flag anywhere in this file, and none
 * may ever be added (mirroring `audit-exit-month-saldo.ts`'s own D-15-cited reasoning here): a
 * detector that can also repair will eventually be run in repair mode by accident on payroll data.
 *
 * Open months (no stored snapshot yet) are not in scope at all — they have nothing stored to
 * differ from, and they pick up the Issue #433 rule automatically the next time they are closed.
 * A FIXED_SCHEDULE/FLEXTIME/SHIFT_BASED month, or a MONTHLY_HOURS month whose schedule has
 * `monthlyHours` null/0/negative (pure tracking, D-01), is never considered either — the Issue
 * #433 rule only ever changes a MONTHLY_HOURS owed-Soll month.
 *
 * Simplification (mirrors `audit-exit-month-saldo.ts`'s own simplification):
 * `closeEmployeeMonth()`'s `expectedMinutes`/`balanceMinutes` do not depend on `carryOverIn`
 * (only `carryOverOut`/`effectiveCarryOverOut` do), so this script always recomputes with
 * `carryOverIn: 0` — it does NOT walk each employee's whole snapshot chain the way
 * `recalculate-snapshots.ts` does.
 *
 * The prefetch for each candidate month mirrors the manual-close path exactly
 * (`api/overtime.ts`'s close-month handler, same as `audit-exit-month-saldo.ts`): the employee's
 * own work-location entries (facade T2) feed `holidaysAtWorkLocation` over
 * `[effectiveStart, monthEnd]` — no second holiday formula — and `tenantConfig.defaultWorkDays`
 * is threaded through (Issue #433, D-05: `workDays → defaultWorkDays → Mo–Fr`) — no switch is
 * read.
 *
 * Output contains ids only — no employee name, no employee number (DSGVO). Follows
 * `audit-saldo-chain-integrity.ts`'s and `audit-exit-month-saldo.ts`'s convention, deliberately
 * NOT `audit-workdays-vs-day-hours.ts`'s (which prints names) — see scripts/README.md's own
 * classification table.
 *
 * Delta sign convention (stated once, applied consistently): delta = recomputed − stored.
 * A positive delta means the Issue #433 rule now computes a HIGHER value than what is stored; a
 * negative delta means it computes LOWER.
 *
 * Run (never against prod/int without the operator's own DATABASE_URL — never set by this
 * script, never executed by this commit):
 *   DATABASE_URL=... pnpm --filter @clokr/api exec tsx \
 *     scripts/dry-run-433-monthly-hours-soll.ts ( --tenant-id <uuid> | --all-tenants )
 *
 * Exit codes:
 *   0 — no MONTHLY_HOURS month has a stored snapshot whose expected/balance minutes differ from
 *       the Issue #433 recompute
 *   1 — usage error (neither, or both, of --tenant-id/--all-tenants given), DATABASE_URL missing,
 *       or a DB connection/query failure
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
  dateStrInTz,
  getTenantTimezone,
  isSnapshotLocked,
  monthDayBounds,
  monthRangeUtc,
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

export type MonthlyHoursFinding = {
  tenantId: string;
  employeeId: string;
  monthLabel: string; // YYYY-MM
  snapshotId: string;
  locked: boolean;
  storedExpectedMinutes: number;
  storedBalanceMinutes: number;
  recomputedExpectedMinutes: number;
  recomputedBalanceMinutes: number;
  expectedDelta: number;
  balanceDelta: number;
};

function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

export function formatMonthlyHoursLine(f: MonthlyHoursFinding): string {
  const expectedPart =
    `expected(stored=${f.storedExpectedMinutes},recomputed=${f.recomputedExpectedMinutes},` +
    `delta=${signed(f.expectedDelta)})`;
  const balancePart =
    `balance(stored=${f.storedBalanceMinutes},recomputed=${f.recomputedBalanceMinutes},` +
    `delta=${signed(f.balanceDelta)})`;
  return (
    `tenant=${truncId(f.tenantId)} emp=${truncId(f.employeeId)} month=${f.monthLabel} ` +
    `snapshot=${truncId(f.snapshotId)} locked=${String(f.locked)} ${expectedPart} ${balancePart}`
  );
}

// ── CLI parsing ──────────────────────────────────────────────────────────────

export type CliArgs = { tenantId: string | null; allTenants: boolean };

export function parseCliArgs(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      "tenant-id": { type: "string" },
      "all-tenants": { type: "boolean", default: false },
    },
    strict: true, // rejects any unknown flag — no opt-in mutation flag is ever accepted here
  });
  return {
    tenantId: values["tenant-id"] ?? null,
    allTenants: Boolean(values["all-tenants"]),
  };
}

const USAGE = `
Usage:
  DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx \\
    scripts/dry-run-433-monthly-hours-soll.ts \\
    ( --tenant-id <uuid> | --all-tenants )

READ-ONLY (Issue #433, D-12) — lists every MONTHLY_HOURS employee-month (monthlyHours > 0) with a
stored non-superseded MONTHLY SaldoSnapshot, the stored vs. Issue #433-rule-recomputed expected/
balance minutes, the delta and the locked flag. No write/repair flag exists.

Exit codes:
  0 - no finding for the given scope
  1 - usage error, or DATABASE_URL missing / a DB connection/query failure
  2 - one or more findings
`;

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Exported for unit-testability — pass a PrismaClient to inject a test connection (run against
 * the worker test DB only); without one the function bootstraps its own connection from
 * DATABASE_URL.
 */
export async function main(argv: string[], injectedPrisma?: PrismaClient): Promise<number> {
  const args = parseCliArgs(argv);

  const exactlyOne =
    (args.tenantId !== null && !args.allTenants) || (args.tenantId === null && args.allTenants);
  if (!exactlyOne) {
    console.error(
      "Usage-Fehler: bitte genau einen der beiden Parameter angeben: --tenant-id <uuid> ODER --all-tenants.",
    );
    console.error(USAGE);
    return EXIT_ERROR;
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
    // Scope: every non-superseded MONTHLY SaldoSnapshot of an employee in scope (optionally
    // filtered by --tenant-id), not § 18-exempt. The MONTHLY_HOURS / monthlyHours > 0 narrowing
    // happens per-row below (the schedule valid for the snapshot's own month) — ids only, no
    // first/last name, no employee number ever selected (DSGVO).
    const snapshots = await prisma.saldoSnapshot.findMany({
      where: {
        periodType: "MONTHLY",
        superseded: false,
        employee: {
          ...(args.tenantId ? { tenantId: args.tenantId } : {}),
          isTimeTrackingExempt: false,
        },
      },
      select: {
        id: true,
        employeeId: true,
        periodStart: true,
        periodEnd: true,
        expectedMinutes: true,
        balanceMinutes: true,
        employee: {
          select: {
            id: true,
            tenantId: true,
            hireDate: true,
            exitDate: true,
            breakOver6hOverride: true,
            breakOver9hOverride: true,
          },
        },
      },
      orderBy: [{ employeeId: "asc" }, { periodStart: "asc" }],
    });

    const findings: MonthlyHoursFinding[] = [];
    let checkedCount = 0;
    let deltaCount = 0;
    let lockedDeltaCount = 0;
    const tenantIds = new Set<string>();

    const tzByTenant = new Map<string, string>();
    const tenantConfigByTenant = new Map<
      string,
      Awaited<ReturnType<typeof prisma.tenantConfig.findUnique>>
    >();

    for (const snap of snapshots) {
      const emp = snap.employee;
      tenantIds.add(emp.tenantId);

      if (!tzByTenant.has(emp.tenantId)) {
        tzByTenant.set(emp.tenantId, await getTenantTimezone(prisma, emp.tenantId));
      }
      const tz = tzByTenant.get(emp.tenantId)!;

      // snap.periodStart/periodEnd are @db.Date columns — Postgres stores the UTC-calendar-date
      // part of the original timestamp, which for a tenant EAST of UTC (e.g. Europe/Berlin) is
      // one day BEFORE the tenant-local 1st of the month (periodStart's intended "2026-06-01
      // 00:00 Berlin" becomes UTC "2026-05-31T22:00", whose date part is "2026-05-31"). Reading
      // {year, month} off periodStart directly would therefore misname the month for roughly
      // half of all tenants. The MIDPOINT between periodStart and periodEnd is always safely
      // inside the real calendar month regardless of that one-day edge shift — same derivation
      // as dry-run-429-leave-contract-days.ts's own `midMonth`/`year`/`month` pattern. Full-
      // precision monthStart/monthEnd for closeEmployeeMonth and the holiday resolver are then
      // RE-DERIVED from that {year, month} via monthRangeUtc, never trusted from the
      // DB-truncated columns directly.
      const periodMidpoint = new Date((snap.periodStart.getTime() + snap.periodEnd.getTime()) / 2);
      const year = periodMidpoint.getUTCFullYear();
      const month = periodMidpoint.getUTCMonth() + 1; // 1-based
      const monthLabel = `${year}-${String(month).padStart(2, "0")}`;
      const { start: monthStart, end: monthEnd } = monthRangeUtc(year, month, tz);

      const { firstDay: monthFirstDay, lastDay: monthLastDay } = monthDayBounds(
        monthStart,
        monthEnd,
        tz,
      );

      // Resolve the schedule as-of the middle of the month — mirrors the manual-close path and
      // audit-exit-month-saldo.ts's own convention (an employee may have changed schedule type
      // mid-history).
      const midMonth = new Date((monthStart.getTime() + monthEnd.getTime()) / 2);
      const schedule = await prisma.workSchedule.findFirst({
        where: { employeeId: emp.id, validFrom: { lte: midMonth } },
        orderBy: { validFrom: "desc" },
      });
      if (!schedule || schedule.type !== "MONTHLY_HOURS") continue; // D-01: not this rule's scope
      const monthlyHours = Number(schedule.monthlyHours ?? 0);
      if (!(monthlyHours > 0)) continue; // D-01: pure tracking, never considered

      checkedCount++;

      if (!tenantConfigByTenant.has(emp.tenantId)) {
        tenantConfigByTenant.set(
          emp.tenantId,
          await prisma.tenantConfig.findUnique({ where: { tenantId: emp.tenantId } }),
        );
      }
      const tenantConfigRow = tenantConfigByTenant.get(emp.tenantId) ?? null;

      const hireDateNorm = emp.hireDate
        ? new Date(dateStrInTz(emp.hireDate, tz) + "T00:00:00Z")
        : null;
      const effectiveStart =
        hireDateNorm && hireDateNorm > monthFirstDay ? hireDateNorm : monthFirstDay;

      // Phase 71b (issue #71) — holiday set by WORK LOCATION, fed with this employee's own
      // closed work entries (facade T2), exactly like the manual-close handler
      // (api/overtime.ts) and audit-exit-month-saldo.ts.
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
        carryOverIn: 0, // simplification mirrored from audit-exit-month-saldo.ts
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
              // Issue #433 (D-05) — the MONTHLY_HOURS workday tier; no switch is read.
              defaultWorkDays: tenantConfigRow.defaultWorkDays ?? undefined,
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

      const locked = await isSnapshotLocked(prisma, emp.id, emp.tenantId, monthStart, monthEnd);
      const delta = computeDelta(
        { expectedMinutes: snap.expectedMinutes, balanceMinutes: snap.balanceMinutes },
        { expectedMinutes: result.expectedMinutes, balanceMinutes: result.balanceMinutes },
      );

      if (delta.expectedDelta !== 0 || delta.balanceDelta !== 0) {
        deltaCount++;
        if (locked) lockedDeltaCount++;
        findings.push({
          tenantId: emp.tenantId,
          employeeId: emp.id,
          monthLabel,
          snapshotId: snap.id,
          locked,
          storedExpectedMinutes: snap.expectedMinutes,
          storedBalanceMinutes: snap.balanceMinutes,
          recomputedExpectedMinutes: result.expectedMinutes,
          recomputedBalanceMinutes: result.balanceMinutes,
          expectedDelta: delta.expectedDelta,
          balanceDelta: delta.balanceDelta,
        });
      }
    }

    // ── Output (grouped by tenant, mirrors audit-exit-month-saldo.ts) ───────────────────────
    if (findings.length === 0) {
      console.log("No differing MONTHLY_HOURS months found.");
    } else {
      let currentTenant = "";
      for (const f of findings) {
        if (f.tenantId !== currentTenant) {
          console.log(`\n== Tenant: ${truncId(f.tenantId)} ==`);
          currentTenant = f.tenantId;
        }
        console.log(`  ${formatMonthlyHoursLine(f)}`);
      }
    }

    console.log(
      `\nSummary: ${checkedCount} MONTHLY_HOURS month(s) checked across ${tenantIds.size} ` +
        `tenant(s); ${deltaCount} finding(s) with a non-zero delta ` +
        `(${lockedDeltaCount} already locked).`,
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
