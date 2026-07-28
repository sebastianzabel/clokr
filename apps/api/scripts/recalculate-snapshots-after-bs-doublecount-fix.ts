/**
 * Operator script — v1.8.27 Azubi Berufsschultag (BS) Monats-Soll double-count retro-recalc.
 *
 * v1.8.27 fixes a double-count in the SHIFT_BASED saldo core (close-employee-month.ts):
 * before the fix, a VOCATIONAL_SCHOOL (Berufsschule) day was counted TWICE in the monthly
 * expected/Soll — once inside `contractSoll` (calcExpectedMinutesTz counts the BS day as a
 * normal contracted workday) and again via `bsExpectedMinutes` (the §15 BS credit added on
 * top), because the BS day was EXCLUDED from the absence-credit subtraction loop. The fix
 * makes the SHIFT_BASED branch symmetric with the non-SHIFT branch (subtract-then-recredit),
 * so each BS day's Soll is counted exactly ONCE.
 *
 * Effect: displayed Monats-Soll and -Ist were inflated by Σ(BS-day Soll) for every Azubi with
 * BS days; the inflated effective contract Soll could also suppress legitimate overtime. The
 * *balance* was usually still neutral (BS day nets 0), so most snapshots' balanceMinutes are
 * unchanged — but expectedMinutes/workedMinutes (and, where overtime was suppressed,
 * balanceMinutes/carryOver) need recomputing.
 *
 * Already-stored SaldoSnapshots created before the v1.8.27 deploy still hold the doubled
 * expectedMinutes. This script re-runs the SHARED, FIXED `closeEmployeeMonth()` core (identical
 * to the live/close/cron/retro paths — Phase 76.39) over affected snapshots and rewrites the
 * ones that differ. Each rewrite gets exactly 1 AuditLog row (action below) with full oldValue.
 *
 * IMPORTANT: this script deliberately recomputes via `closeEmployeeMonth()` — it does NOT reuse
 * the inline Model-B math of `recalculate-snapshots-after-shift-soll-fix.ts` (that script still
 * carries the pre-fix double-count and would re-introduce the bug).
 *
 * Invariants:
 *   - NEVER hard-deletes (Revisionssicherheit per CLAUDE.md). Supersede-then-create only.
 *   - NEVER writes to locked-month snapshots on --apply. They appear in summary.skippedLocked
 *     for operator review (unlock+re-close is an owner decision, out of scope here).
 *   - Idempotent: re-running --apply on already-corrected snapshots writes zero new AuditLog rows
 *     (noop detection compares all 4 numeric fields).
 *   - Opening-balance bridge snapshots (human-set carryOver, zero activity) are preserved and used
 *     as the chain start for downstream snapshots.
 *   - Soft-delete: queries the `superseded: false` SaldoSnapshot pool only.
 *   - Scope: SHIFT_BASED employees that have at least one VOCATIONAL_SCHOOL absence (= Azubis with
 *     Berufsschule). Others are unaffected and not scanned.
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @clokr/api exec tsx \
 *     scripts/recalculate-snapshots-after-bs-doublecount-fix.ts \
 *     ( --tenant-id <uuid> | --all-tenants ) \
 *     [--year YYYY] \
 *     [--apply] \
 *     [--help]
 *
 * Without --apply: dry-run (prints proposed changes + JSON summary, ZERO writes).
 * With    --apply: one $transaction per rewrite (supersede old row + create corrected row +
 *                  AuditLog) for atomicity.
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import {
  getTenantTimezone,
  dateStrInTz,
  monthRangeUtc,
  monthDayBounds,
} from "../src/utils/timezone";
import { getHolidays, STATE_MAP } from "../src/utils/holidays";
import { closeEmployeeMonth } from "../src/utils/close-employee-month";
import { loadBsSlotOverrides } from "../src/utils/load-bs-slot-overrides";

// ── Audit constants ─────────────────────────────────────────────────────────
const RECALC_REASON = "v1.8.27 Azubi Berufsschultag Monats-Soll double-count fix (single-count)";
const RECALC_ACTION = "SALDO_RECALC_AFTER_BS_DOUBLECOUNT_FIX";
const RECALC_USER_AGENT = "script:recalculate-snapshots-after-bs-doublecount-fix";

// ── Types ─────────────────────────────────────────────────────────────────────
export type CliArgs = {
  tenantId: string | null;
  allTenants: boolean;
  year: number | null;
  apply: boolean;
  help: boolean;
};

export type RecalcSummary = {
  dryRun: boolean;
  tenantsScanned: number;
  employeesScanned: number;
  snapshotsScanned: number;
  recalculated: number;
  unchanged: number;
  skippedLocked: Array<{
    snapshotId: string;
    employeeId: string;
    tenantId: string;
    periodStart: Date;
    deltaExpectedMinutes: number;
    deltaBalanceMinutes: number;
  }>;
  errors: Array<{ snapshotId: string; employeeId: string; tenantId: string; error: string }>;
};

// ── Usage ─────────────────────────────────────────────────────────────────────
const USAGE = `Usage: tsx scripts/recalculate-snapshots-after-bs-doublecount-fix.ts \\
  ( --tenant-id <uuid> | --all-tenants ) \\
  [--year YYYY] \\
  [--apply] \\
  [--help]

  --tenant-id    Scope to a single tenant (UUID).
  --all-tenants  Scope to every tenant (one of --tenant-id OR --all-tenants is REQUIRED).
  --year         Optional. Only recalc snapshots whose periodStart year matches.
  --apply        Opt-in. Without it the script runs dry-run (prints summary, writes nothing).
  --help         Print this usage block and exit 0.

Safety:
  - Scope: SHIFT_BASED employees WITH >=1 VOCATIONAL_SCHOOL absence (Azubis with Berufsschule).
  - Recompute is via the SHARED, FIXED closeEmployeeMonth() core (v1.8.27) — not inline math.
  - Locked-month snapshots are listed in the summary but SKIPPED on --apply (Revisionssicherheit).
  - Idempotent: already-corrected snapshots write zero new AuditLog rows.
  - Every rewrite produces exactly one AuditLog row (action ${RECALC_ACTION}).
`;

// ── CLI parsing ─────────────────────────────────────────────────────────────
export function parseArgs2(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      "tenant-id": { type: "string" },
      "all-tenants": { type: "boolean", default: false },
      year: { type: "string" },
      apply: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  const yearStr = values["year"];
  let year: number | null = null;
  if (yearStr !== undefined) {
    const n = Number(yearStr);
    if (!Number.isInteger(n) || n < 1970 || n > 9999) {
      throw new Error(`--year muss eine vierstellige Jahreszahl sein (erhalten: ${yearStr}).`);
    }
    year = n;
  }

  return {
    tenantId: values["tenant-id"] ?? null,
    allTenants: Boolean(values["all-tenants"]),
    year,
    apply: Boolean(values["apply"]),
    help: Boolean(values["help"]),
  };
}

// ── Locked-month detection ──────────────────────────────────────────────────
// SaldoSnapshot has no isLocked column; the canonical signal is >=1 TimeEntry in the
// period with isLocked: true (CLAUDE.md "Immutability after lock").
async function isSnapshotLocked(
  prisma: PrismaClient,
  employeeId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<boolean> {
  const lockedCount = await prisma.timeEntry.count({
    where: {
      employeeId,
      deletedAt: null,
      date: { gte: periodStart, lte: periodEnd },
      isLocked: true,
    },
  });
  return lockedCount > 0;
}

// ── Bridge-snapshot detection (preserve human-set opening balances) ─────────
function isBridgeSnapshot(snap: {
  expectedMinutes: number;
  workedMinutes: number;
  balanceMinutes: number;
  carryOver: number;
}): boolean {
  return (
    snap.expectedMinutes === 0 &&
    snap.workedMinutes === 0 &&
    snap.balanceMinutes === 0 &&
    snap.carryOver !== 0
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export async function main(argv: string[], injectedPrisma?: PrismaClient): Promise<RecalcSummary> {
  const args = parseArgs2(argv);

  if (args.help) {
    console.info(USAGE);
    return {
      dryRun: true,
      tenantsScanned: 0,
      employeesScanned: 0,
      snapshotsScanned: 0,
      recalculated: 0,
      unchanged: 0,
      skippedLocked: [],
      errors: [],
    };
  }

  if (!args.tenantId && !args.allTenants) {
    throw new Error(
      "Tenant-Auswahl erforderlich: bitte --tenant-id <uuid> ODER --all-tenants angeben.",
    );
  }

  const prisma = injectedPrisma ?? new PrismaClient();
  const ownsPrisma = !injectedPrisma;

  try {
    const summary: RecalcSummary = {
      dryRun: !args.apply,
      tenantsScanned: 0,
      employeesScanned: 0,
      snapshotsScanned: 0,
      recalculated: 0,
      unchanged: 0,
      skippedLocked: [],
      errors: [],
    };

    const tenants = args.allTenants
      ? await prisma.tenant.findMany({ select: { id: true } })
      : [{ id: args.tenantId! }];
    summary.tenantsScanned = tenants.length;

    for (const t of tenants) {
      const tz = await getTenantTimezone(prisma, t.id);
      const yearStart = args.year ? monthRangeUtc(args.year, 1, tz).start : null;
      const yearEnd = args.year ? monthRangeUtc(args.year, 12, tz).end : null;

      const tenantConfig = await prisma.tenantConfig.findUnique({ where: { tenantId: t.id } });
      if (!tenantConfig) {
        console.warn(`[recalc] tenant ${t.id}: no TenantConfig — skipping.`);
        continue;
      }

      // Scope: SHIFT_BASED employees WITH >=1 VOCATIONAL_SCHOOL absence (= affected Azubis).
      const employees = await prisma.employee.findMany({
        where: {
          tenantId: t.id,
          workSchedules: { some: { type: "SHIFT_BASED" } },
          absences: { some: { type: "VOCATIONAL_SCHOOL", deletedAt: null } },
        },
        select: {
          id: true,
          hireDate: true,
          exitDate: true,
          isTimeTrackingExempt: true,
          breakOver6hOverride: true,
          breakOver9hOverride: true,
          tenant: { select: { federalState: true } },
        },
      });
      summary.employeesScanned += employees.length;

      for (const emp of employees) {
        if (emp.isTimeTrackingExempt) continue; // exempt employees never get snapshot recalcs

        const snapshots = await prisma.saldoSnapshot.findMany({
          where: {
            employeeId: emp.id,
            periodType: "MONTHLY",
            superseded: false,
            ...(yearStart && yearEnd ? { periodStart: { gte: yearStart, lte: yearEnd } } : {}),
          },
          orderBy: [{ periodStart: "asc" }],
        });
        summary.snapshotsScanned += snapshots.length;
        if (snapshots.length === 0) continue;

        // Running carry-over from the snapshot immediately before the first in scope.
        const prev = await prisma.saldoSnapshot.findFirst({
          where: {
            employeeId: emp.id,
            periodType: "MONTHLY",
            periodStart: { lt: snapshots[0].periodStart },
            superseded: false,
          },
          orderBy: { periodStart: "desc" },
        });
        let runningCarryOver = prev?.carryOver ?? 0;

        for (const snap of snapshots) {
          try {
            // Preserve opening-balance bridge rows; chain their carryOver forward.
            if (isBridgeSnapshot(snap)) {
              console.info(
                `[BRIDGE-SNAPSHOT] preserved — employeeId=${emp.id} ` +
                  `periodStart=${snap.periodStart.toISOString().slice(0, 10)} carryOver=${snap.carryOver}`,
              );
              runningCarryOver = snap.carryOver;
              continue;
            }

            const oldValues = {
              workedMinutes: snap.workedMinutes,
              expectedMinutes: snap.expectedMinutes,
              balanceMinutes: snap.balanceMinutes,
              carryOver: snap.carryOver,
            };

            // Canonical month range from the stored period (mid-month is inside the month
            // under both periodStart conventions — TZ-converted vs UTC-naive).
            const midMonth = new Date((snap.periodStart.getTime() + snap.periodEnd.getTime()) / 2);
            const { start: monthStart, end: monthEnd } = monthRangeUtc(
              midMonth.getUTCFullYear(),
              midMonth.getUTCMonth() + 1,
              tz,
            );
            const { firstDay: monthFirstDay, lastDay: monthLastDay } = monthDayBounds(
              monthStart,
              monthEnd,
              tz,
            );

            // Effective schedule = WorkSchedule valid as of mid-month (getEffectiveSchedule inline).
            const schedule = await prisma.workSchedule.findFirst({
              where: { employeeId: emp.id, validFrom: { lte: midMonth } },
              orderBy: { validFrom: "desc" },
            });
            if (!schedule || String(schedule.type ?? "") !== "SHIFT_BASED") {
              runningCarryOver = snap.carryOver; // not SHIFT_BASED this period — leave unchanged
              continue;
            }

            const hireDateNorm = emp.hireDate
              ? new Date(dateStrInTz(emp.hireDate, tz) + "T00:00:00Z")
              : null;
            const effectiveStart =
              hireDateNorm && hireDateNorm > monthFirstDay ? hireDateNorm : monthFirstDay;

            // Holiday set: computed German Feiertage (year from MID-month) + DB manual holidays.
            const snapYear = midMonth.getUTCFullYear();
            const snapStateCode = emp.tenant ? (STATE_MAP[emp.tenant.federalState] ?? "NI") : "NI";
            const computedHolidays = getHolidays(snapYear, snapStateCode).filter(
              (h) =>
                h.date >= dateStrInTz(effectiveStart, tz) && h.date <= dateStrInTz(monthEnd, tz),
            );
            const computedDateSet = new Set(computedHolidays.map((h) => h.date));
            const dbHolidays = await prisma.publicHoliday.findMany({
              where: {
                tenant: { employees: { some: { id: emp.id } } },
                date: { gte: effectiveStart, lte: monthLastDay },
              },
            });
            const holidayDateStrings = new Set<string>([
              ...computedHolidays.map((h) => h.date),
              ...dbHolidays
                .filter((h) => !computedDateSet.has(dateStrInTz(h.date, tz)))
                .map((h) => dateStrInTz(h.date, tz)),
            ]);

            // Pre-fetch all collections needed by closeEmployeeMonth (parallel).
            const [closeEntries, closeShifts, closeApprovedLeave, closeAbsences] =
              await Promise.all([
                prisma.timeEntry.findMany({
                  where: {
                    employeeId: emp.id,
                    deletedAt: null,
                    date: { gte: effectiveStart, lte: monthLastDay },
                    endTime: { not: null },
                    type: "WORK",
                    isInvalid: false,
                  },
                  select: { date: true, startTime: true, endTime: true, breakMinutes: true },
                }),
                prisma.shift.findMany({
                  where: {
                    employeeId: emp.id,
                    date: { gte: effectiveStart, lte: monthLastDay },
                    deletedAt: null,
                  },
                  select: { date: true, startTime: true, endTime: true },
                }),
                prisma.leaveRequest.findMany({
                  where: {
                    employeeId: emp.id,
                    deletedAt: null,
                    status: "APPROVED",
                    startDate: { lte: monthEnd },
                    endDate: { gte: monthStart },
                  },
                  select: { startDate: true, endDate: true, halfDay: true },
                }),
                // ALL absences (incl. VOCATIONAL_SCHOOL — BS single-count handled inside the core).
                prisma.absence.findMany({
                  where: {
                    employeeId: emp.id,
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
                    unterrichtsMinutes: true,
                  },
                }),
              ]);

            const { employeeSlots, patternSlots, patternUnterrichtsMinutenByDow } =
              await loadBsSlotOverrides(prisma, emp.id, monthFirstDay);

            const r = closeEmployeeMonth({
              employeeId: emp.id,
              monthStart,
              monthEnd,
              monthFirstDay,
              monthLastDay,
              tz,
              carryOverIn: runningCarryOver,
              schedule: schedule as Record<string, unknown>,
              hireDate: emp.hireDate,
              exitDate: emp.exitDate ?? null,
              isTimeTrackingExempt: false,
              breakOver6hOverride: emp.breakOver6hOverride ?? null,
              breakOver9hOverride: emp.breakOver9hOverride ?? null,
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
                halfDay: ab.halfDay,
                unterrichtsMinutes: ab.unterrichtsMinutes ?? null,
              })),
              holidayDateStrings,
              tenantConfig: {
                defaultBreakOver6h: tenantConfig.defaultBreakOver6h,
                defaultBreakOver9h: tenantConfig.defaultBreakOver9h,
                monthlyHoursHolidayDeduction:
                  tenantConfig.monthlyHoursHolidayDeduction ?? undefined,
                vocationalSchoolMinutesPerDay:
                  tenantConfig.vocationalSchoolMinutesPerDay ?? undefined,
                vocationalSchoolBlockMinutesPerWeek:
                  tenantConfig.vocationalSchoolBlockMinutesPerWeek ?? undefined,
                bsSlotFirstLongDayMinutes: tenantConfig.bsSlotFirstLongDayMinutes ?? undefined,
                bsSlotSecondLongDayMinutes: tenantConfig.bsSlotSecondLongDayMinutes ?? undefined,
                bsSlotShortDayMinutes: tenantConfig.bsSlotShortDayMinutes ?? undefined,
                bsSlotBlockWeekMinutes: tenantConfig.bsSlotBlockWeekMinutes ?? undefined,
              },
              employeeSlots,
              patternSlots,
              patternUnterrichtsMinutenByDow,
            });

            const newWorked = r.workedMinutes;
            const newExpected = r.snapshotExpectedMinutes;
            const newBalance = r.balanceMinutes;
            const newCarry = r.effectiveCarryOverOut;

            // Idempotency: if the fixed core reproduces the stored values, nothing to do.
            const noop =
              newWorked === oldValues.workedMinutes &&
              newExpected === oldValues.expectedMinutes &&
              newBalance === oldValues.balanceMinutes &&
              newCarry === oldValues.carryOver;
            if (noop) {
              summary.unchanged++;
              runningCarryOver = snap.carryOver;
              continue;
            }

            // Locked-month guard: never mutate a locked month.
            const locked = await isSnapshotLocked(prisma, emp.id, snap.periodStart, snap.periodEnd);
            if (locked) {
              summary.skippedLocked.push({
                snapshotId: snap.id,
                employeeId: emp.id,
                tenantId: t.id,
                periodStart: snap.periodStart,
                deltaExpectedMinutes: newExpected - oldValues.expectedMinutes,
                deltaBalanceMinutes: newBalance - oldValues.balanceMinutes,
              });
              console.warn(
                `[WARN] Locked snapshot SKIPPED — employee ${emp.id} ` +
                  `period=${snap.periodStart.toISOString().slice(0, 10)} ` +
                  `expected ${oldValues.expectedMinutes}→${newExpected} ` +
                  `balance ${oldValues.balanceMinutes}→${newBalance}. ` +
                  `Downstream carry-over stays anchored to the stored (uncorrected) carryOver. ` +
                  `Owner action: unlock+re-close this month to apply the fix.`,
              );
              runningCarryOver = snap.carryOver; // chain from stored value (cannot update)
              continue;
            }

            if (!args.apply) {
              console.info(
                `[DRY-RUN] ${snap.periodStart.toISOString().slice(0, 10)} employeeId=${emp.id} ` +
                  `worked=${oldValues.workedMinutes}→${newWorked} ` +
                  `expected=${oldValues.expectedMinutes}→${newExpected} ` +
                  `balance=${oldValues.balanceMinutes}→${newBalance} ` +
                  `carry=${oldValues.carryOver}→${newCarry}`,
              );
              summary.recalculated++;
              runningCarryOver = newCarry; // project the chain forward in dry-run
              continue;
            }

            // --apply: supersede-then-create + AuditLog, atomically.
            await prisma.$transaction(async (tx) => {
              await tx.saldoSnapshot.update({
                where: { id: snap.id },
                data: { superseded: true, supersededReason: RECALC_REASON },
              });
              const newSnap = await tx.saldoSnapshot.create({
                data: {
                  employeeId: emp.id,
                  periodType: "MONTHLY",
                  periodStart: snap.periodStart,
                  periodEnd: snap.periodEnd,
                  workedMinutes: newWorked,
                  expectedMinutes: newExpected,
                  balanceMinutes: newBalance,
                  carryOver: newCarry,
                  closedAt: snap.closedAt,
                  closedBy: snap.closedBy,
                  note: snap.note,
                },
              });
              await tx.auditLog.create({
                data: {
                  userId: null,
                  action: RECALC_ACTION,
                  entity: "SaldoSnapshot",
                  entityId: newSnap.id,
                  oldValue: { ...oldValues, supersededRowId: snap.id },
                  newValue: {
                    workedMinutes: newWorked,
                    expectedMinutes: newExpected,
                    balanceMinutes: newBalance,
                    carryOver: newCarry,
                    reason: RECALC_REASON,
                  },
                  ipAddress: null,
                  userAgent: RECALC_USER_AGENT,
                },
              });
            });
            summary.recalculated++;
            runningCarryOver = newCarry;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            summary.errors.push({
              snapshotId: snap.id,
              employeeId: emp.id,
              tenantId: t.id,
              error: message,
            });
            console.error(`[recalc] snapshot ${snap.id} failed: ${message}`);
            runningCarryOver = snap.carryOver;
          }
        } // snapshots
      } // employees
    } // tenants

    // eslint-disable-next-line no-console -- intentional structured operator output
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  } finally {
    if (ownsPrisma) await prisma.$disconnect();
  }
}

// ── CLI entrypoint ──────────────────────────────────────────────────────────
const isMain =
  typeof require !== "undefined" && typeof module !== "undefined" && require.main === module;

if (isMain) {
  (async () => {
    if (!process.env.DATABASE_URL) {
      console.error("DATABASE_URL is required");
      process.exit(1);
    }
    if (process.argv.includes("--help")) {
      await main(process.argv.slice(2));
      process.exit(0);
    }
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new PrismaPg(pool as any);
    const prisma = new PrismaClient({ adapter });
    try {
      await main(process.argv.slice(2), prisma);
    } catch (err) {
      console.error((err as Error).message ?? err);
      process.exit(1);
    } finally {
      await prisma.$disconnect();
      await pool.end();
    }
  })();
}
