/**
 * Audit tool — committed 2026-09-30 for Issue #429 (D-15).
 *
 * Plans 429-01..03 fixed the SHIFT_BASED approved-leave Soll credit: it now reduces the
 * CONTRACT workdays per week (`contractWorkDaysPerWeek`), not the roster-shape "workDays
 * Ø-Methode" average `avgWorkMinutesCore` used before. That fix only changes saldo computed
 * FROM NOW ON. Every month a SHIFT_BASED employee already had CLOSED under the old formula
 * keeps its stored `expectedMinutes`/`balanceMinutes` untouched — CLAUDE.md's
 * Revisionssicherheit rules forbid silently rewriting a closed snapshot, and a locked month
 * is immutable even to admins.
 *
 * This script lists, for every SHIFT_BASED employee's non-superseded MONTHLY SaldoSnapshot
 * whose period overlaps at least one effective (APPROVED or CANCELLATION_REQUESTED, Issue #446)
 * LeaveRequest, the STORED `expectedMinutes`/
 * `balanceMinutes` next to what `closeEmployeeMonth()` (the Issue #429 formula, as it stands
 * on this branch) RECOMPUTES for the same month, and the delta between them. Whoever owns
 * payroll gets a concrete, per-employee/per-month list of which closed months would now
 * compute differently, so THEY can decide whether and how to correct any of them via the
 * existing correction-booking flow — never as a side effect of running this script.
 *
 * READ-ONLY. ZERO mutations. There is no opt-in write/repair flag anywhere in this file, and
 * none may ever be added (mirroring audit-saldo-chain-integrity.ts's own D-15-cited reasoning
 * here): a detector that can also repair will eventually be run in repair mode by accident on
 * payroll data.
 *
 * Simplification (D-15, documented in 429-04-PLAN.md's own `<context>`): `closeEmployeeMonth()`'s
 * `expectedMinutes`/`balanceMinutes` do not depend on `carryOverIn` (only `carryOverOut`/
 * `effectiveCarryOverOut` do), so this script always recomputes with `carryOverIn: 0` — it does
 * NOT walk each employee's whole snapshot chain the way `recalculate-snapshots.ts` does.
 *
 * `holidayDateStrings` is always passed as an empty Set. This is SHIFT_BASED-only script and
 * the SHIFT_BASED branch of `closeEmployeeMonth()` never reads that field (holiday credit is
 * folded into `calcExpectedMinutesTz` itself for that branch, per close-employee-month.ts's own
 * "No excludeHolidays passed" comment) — an empty set is correct here, not a shortcut.
 *
 * Output contains ids only — no employee name, no employee number (DSGVO). Follows
 * `audit-saldo-chain-integrity.ts`'s convention, deliberately NOT `audit-workdays-vs-day-hours.ts`'s
 * (which prints names) — see scripts/README.md's own classification table.
 *
 * Delta sign convention (stated once, applied consistently): delta = recomputed − stored.
 * A positive delta means the Issue #429 formula now computes a HIGHER value than what is
 * stored; a negative delta means it computes LOWER.
 *
 * Run (never against prod/int without the operator's own DATABASE_URL — never set by this
 * script, never executed by this commit):
 *   DATABASE_URL=... pnpm --filter @clokr/api exec tsx \
 *     scripts/dry-run-429-leave-contract-days.ts [--tenant-id <uuid>]
 *
 * Exit codes:
 *   0 — no SHIFT_BASED closed-month delta found for any approved-leave-overlapping snapshot
 *   1 — DATABASE_URL missing, or a DB connection/query failure
 *   2 — one or more deltas found (review, do not auto-correct)
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
  monthRangeUtc,
  monthDayBounds,
  isSnapshotLocked,
} from "../src/contexts/working-time-account";
import { getValidWorkedEntriesInRange } from "../src/contexts/time-tracking";
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

export type Finding = {
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

export function formatFindingLine(f: Finding): string {
  return (
    `tenant=${truncId(f.tenantId)} emp=${truncId(f.employeeId)} month=${f.monthLabel} ` +
    `snapshot=${truncId(f.snapshotId)} locked=${f.locked} ` +
    `expected(stored=${f.storedExpectedMinutes},recomputed=${f.recomputedExpectedMinutes},` +
    `delta=${signed(f.expectedDelta)}) ` +
    `balance(stored=${f.storedBalanceMinutes},recomputed=${f.recomputedBalanceMinutes},` +
    `delta=${signed(f.balanceDelta)})`
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
    // Scope: every SHIFT_BASED employee (optionally filtered by --tenant-id). ids only —
    // no firstName/lastName/employeeNumber ever selected (DSGVO).
    const employees = await prisma.employee.findMany({
      where: {
        ...(args.tenantId ? { tenantId: args.tenantId } : {}),
        workSchedules: { some: { type: "SHIFT_BASED" } },
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

    const findings: Finding[] = [];
    let snapshotsScanned = 0;
    let overlappingLeaveCount = 0;
    let notShiftBasedAtSnapshotTime = 0;
    const tenantIds = new Set<string>();

    const tzByTenant = new Map<string, string>();
    const tenantConfigByTenant = new Map<
      string,
      Awaited<ReturnType<typeof prisma.tenantConfig.findUnique>>
    >();

    for (const emp of employees) {
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

      const snapshots = await prisma.saldoSnapshot.findMany({
        where: { employeeId: emp.id, periodType: "MONTHLY", superseded: false },
        orderBy: { periodStart: "asc" },
        select: {
          id: true,
          periodStart: true,
          periodEnd: true,
          expectedMinutes: true,
          balanceMinutes: true,
        },
      });
      snapshotsScanned += snapshots.length;

      for (const snap of snapshots) {
        // Cheap existence check first — only snapshots overlapping an approved leave are
        // candidates at all (D-15 scope).
        const overlappingLeave = await prisma.leaveRequest.findFirst({
          where: {
            employeeId: emp.id,
            deletedAt: null,
            status: "APPROVED",
            startDate: { lte: snap.periodEnd },
            endDate: { gte: snap.periodStart },
          },
          select: { id: true },
        });
        if (!overlappingLeave) continue;
        overlappingLeaveCount++;

        const midMonth = new Date((snap.periodStart.getTime() + snap.periodEnd.getTime()) / 2);
        const year = midMonth.getUTCFullYear();
        const month = midMonth.getUTCMonth() + 1;
        const { start: monthStart, end: monthEnd } = monthRangeUtc(year, month, tz);
        const { firstDay: monthFirstDay, lastDay: monthLastDay } = monthDayBounds(
          monthStart,
          monthEnd,
          tz,
        );

        // Resolve the schedule as-of the middle of THIS month — an employee may have been a
        // different schedule type when this particular month was closed.
        const schedule = await prisma.workSchedule.findFirst({
          where: { employeeId: emp.id, validFrom: { lte: midMonth } },
          orderBy: { validFrom: "desc" },
        });
        if (!schedule || schedule.type !== "SHIFT_BASED") {
          notShiftBasedAtSnapshotTime++;
          continue;
        }

        const [entries, shifts, approvedLeaveRows, absenceRows, bsSlots] = await Promise.all([
          getValidWorkedEntriesInRange(
            prisma,
            { kind: "employee", employeeId: emp.id, tenantId: emp.tenantId },
            monthFirstDay,
            monthLastDay,
          ),
          getShiftsInRange(
            prisma,
            { kind: "employee", employeeId: emp.id, tenantId: emp.tenantId },
            monthFirstDay,
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
            monthFirstDay,
            monthLastDay,
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
          carryOverIn: 0, // D-15 simplification — expected/balance do not depend on carryOverIn
          schedule: schedule as unknown as Record<string, unknown>,
          hireDate: emp.hireDate,
          exitDate: emp.exitDate ?? null,
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
          // D-05 — see module docblock: the SHIFT_BASED branch never reads this field.
          holidayDateStrings: new Set<string>(),
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

        const locked = await isSnapshotLocked(
          prisma,
          emp.id,
          emp.tenantId,
          snap.periodStart,
          snap.periodEnd,
        );

        const { expectedDelta, balanceDelta } = computeDelta(
          { expectedMinutes: snap.expectedMinutes, balanceMinutes: snap.balanceMinutes },
          { expectedMinutes: result.expectedMinutes, balanceMinutes: result.balanceMinutes },
        );

        if (expectedDelta === 0 && balanceDelta === 0) continue;

        findings.push({
          tenantId: emp.tenantId,
          employeeId: emp.id,
          monthLabel: `${year}-${String(month).padStart(2, "0")}`,
          snapshotId: snap.id,
          locked,
          storedExpectedMinutes: snap.expectedMinutes,
          storedBalanceMinutes: snap.balanceMinutes,
          recomputedExpectedMinutes: result.expectedMinutes,
          recomputedBalanceMinutes: result.balanceMinutes,
          expectedDelta,
          balanceDelta,
        });
      }
    }

    // ── Output ────────────────────────────────────────────────────────────
    if (findings.length === 0) {
      console.log("No Issue #429 SHIFT_BASED leave/contract-days deltas found.");
    } else {
      let currentTenant = "";
      let currentEmployee = "";
      for (const f of findings) {
        if (f.tenantId !== currentTenant) {
          console.log(`\n== Tenant: ${truncId(f.tenantId)} ==`);
          currentTenant = f.tenantId;
          currentEmployee = "";
        }
        if (f.employeeId !== currentEmployee) {
          console.log(`  -- emp=${truncId(f.employeeId)} --`);
          currentEmployee = f.employeeId;
        }
        console.log(`     ${formatFindingLine(f)}`);
      }
    }

    console.log(
      `\nSummary: ${snapshotsScanned} non-superseded MONTHLY snapshot(s) scanned across ` +
        `${employees.length} SHIFT_BASED employee(s) in ${tenantIds.size} tenant(s); ` +
        `${overlappingLeaveCount} overlapped at least one APPROVED leave request; ` +
        `${notShiftBasedAtSnapshotTime} of those were a different schedule type at that time ` +
        `(skipped); ${findings.length} finding(s) with a non-zero delta.`,
    );
    console.log(`\nExit code: ${findings.length > 0 ? EXIT_FINDINGS : EXIT_OK}`);

    return findings.length > 0 ? EXIT_FINDINGS : EXIT_OK;
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
