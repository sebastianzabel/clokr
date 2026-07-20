/**
 * backfill-month-snapshots.ts — Phase 76.30 operator script.
 *
 * Supervised prod backfill: closes stuck-open months for the live prod cohort.
 *
 * DRY-RUN BY DEFAULT. Writes ONLY with an explicit --apply flag.
 *
 * Default run: emits a per-employee diff (old-live OvertimeAccount.balanceHours vs
 * projected post-close carryOver in hours) for operator sign-off before any write.
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @clokr/api exec tsx \
 *     scripts/backfill-month-snapshots.ts \
 *     [--apply] \
 *     [--tenant <uuid>] \
 *     [--employee <id[,id,...]>] (repeatable) \
 *     [--until <YYYY-MM>]
 *
 * Flags:
 *   (none)           Dry-run: print diff table, write ZERO rows.
 *   --apply          Opt-in write: close each open month oldest→newest via the shared
 *                    close-employee-month core. Writes AuditLog origin=BACKFILL per close.
 *   --tenant <id>    Restrict to a single tenant UUID (default: all tenants).
 *   --employee <id>  Restrict to one or more employee IDs (comma-separated, repeatable).
 *   --until YYYY-MM  Month ceiling (inclusive). Default: previous calendar month.
 *
 * Related phase: 76.30
 * No PII — synthetic ids and initials only in tests.
 */
import type { FastifyInstance } from "fastify";
import { monthRangeUtc, monthDayBounds, dateStrInTz } from "../src/utils/timezone";
import { getEffectiveSchedule } from "../src/routes/time-entries";
import { getHolidays, STATE_MAP } from "../src/utils/holidays";
import { periodStartWindow } from "../src/utils/snapshot-period";
import { closeEmployeeMonth } from "../src/utils/close-employee-month";

// ── Exported pure helpers ────────────────────────────────────────────────────
// These mirror the function-scoped helpers inside auto-close-month.ts but are
// exported here for direct unit-testability. Semantics are byte-identical.

/**
 * Build an ordered list of {year, month} keys from firstOpen to ceiling (inclusive),
 * oldest-first. Returns [] if firstOpen > ceiling.
 * Mirrors buildMonthRange in auto-close-month.ts (including the 60-month guard).
 */
export function buildBackfillMonthRange(
  firstOpen: { year: number; month: number },
  ceiling: { year: number; month: number },
): Array<{ year: number; month: number }> {
  const result: Array<{ year: number; month: number }> = [];
  let cur = { ...firstOpen };
  let guard = 0;
  while (guard++ < 60) {
    if (cur.year > ceiling.year || (cur.year === ceiling.year && cur.month > ceiling.month)) {
      break;
    }
    result.push({ ...cur });
    if (cur.month === 12) {
      cur = { year: cur.year + 1, month: 1 };
    } else {
      cur = { year: cur.year, month: cur.month + 1 };
    }
  }
  return result;
}

/**
 * Project the carryOver chain for dry-run reporting (pure, no DB).
 *
 * Given a seed carryOver (minutes from the last active snapshot) and an ordered
 * list of per-month balanceMinutes (oldest→newest from closeEmployeeMonth projections),
 * returns the running carryOver after each month and the final value.
 *
 * This is the math that --apply will commit; the dry-run shows it before any write.
 */
export function projectCarryOverChain(
  seedCarryOverMinutes: number,
  perMonthBalances: number[],
): { finalCarryOverMinutes: number; perMonthCarryOver: number[] } {
  const perMonthCarryOver: number[] = [];
  let running = seedCarryOverMinutes;
  for (const balance of perMonthBalances) {
    running = running + balance;
    perMonthCarryOver.push(running);
  }
  return { finalCarryOverMinutes: running, perMonthCarryOver };
}

// ── Exported types ───────────────────────────────────────────────────────────

export type BackfillOptions = {
  /** If false (default), dry-run: compute and report, write ZERO rows. */
  apply: boolean;
  /** Restrict to a single tenant UUID. If undefined, all tenants are scanned. */
  tenantId?: string;
  /** Restrict to these employee IDs. If undefined, all active non-exempt are scanned. */
  employeeIds?: string[];
  /** Month ceiling (inclusive). If undefined, defaults to the previous calendar month. */
  until?: { year: number; month: number };
};

export type BackfillEmployeeSummary = {
  employeeId: string;
  tenantId: string;
  /** OvertimeAccount.balanceHours before the backfill run. */
  oldLiveBalanceHours: number;
  /** Projected OvertimeAccount.balanceHours after closing all open months. */
  projectedCarryOverHours: number;
  /** Months that will be / were closed (oldest→newest). */
  monthsToClose: Array<{ year: number; month: number }>;
  /** Running carryOver (minutes) after each closed month. */
  projectedCarryOverChain: number[];
};

export type BackfillSummary = {
  dryRun: boolean;
  tenantsScanned: number;
  employeesScanned: number;
  employeesWithOpenMonths: number;
  totalMonthsClosed: number;
  employees: BackfillEmployeeSummary[];
  errors: Array<{ employeeId: string; tenantId: string; error: string }>;
};

// ── Internal helper: computeFirstOpenMonth ───────────────────────────────────
// Mirrors computeFirstOpenMonth in auto-close-month.ts (private there, re-impl here).

function computeFirstOpenMonth(
  hireDate: Date,
  lastSnap: { periodStart: Date } | null,
  tz: string,
): { year: number; month: number } | null {
  const hireDateStr = dateStrInTz(hireDate, tz);
  const [hireYearStr, hireMonthStr] = hireDateStr.split("-");
  const hireYear = parseInt(hireYearStr!, 10);
  const hireMonth = parseInt(hireMonthStr!, 10);

  if (lastSnap === null) {
    return { year: hireYear, month: hireMonth };
  }

  const psDate = lastSnap.periodStart;
  const psMidMonthDate = new Date(psDate.getTime() + 15 * 24 * 60 * 60 * 1000);
  const psMidMonthStr = dateStrInTz(psMidMonthDate, tz);
  const [snapYearStr, snapMonthStr] = psMidMonthStr.split("-");
  const snapYear = parseInt(snapYearStr!, 10);
  const snapMonth = parseInt(snapMonthStr!, 10);

  let nextYear = snapYear;
  let nextMonth = snapMonth + 1;
  if (nextMonth === 13) {
    nextMonth = 1;
    nextYear += 1;
  }

  if (nextYear > hireYear || (nextYear === hireYear && nextMonth >= hireMonth)) {
    return { year: nextYear, month: nextMonth };
  }
  return { year: hireYear, month: hireMonth };
}

// ── Internal helper: computePrevMonthInLoop ──────────────────────────────────
// Mirrors computePrevMonthInLoop in auto-close-month.ts.

function computePrevMonthInLoop(month: number, year: number): { month: number; year: number } {
  if (month === 1) return { month: 12, year: year - 1 };
  return { month: month - 1, year };
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Main backfill entry point. Exported for testability — tests inject a FastifyInstance
 * from getTestApp(). The CLI bootstrap calls this directly.
 *
 * When opts.apply=false (default): computes dry-run diff, writes ZERO rows.
 * When opts.apply=true: closes each open month oldest→newest via the shared
 * closeEmployeeMonth core, writes snapshots + AuditLog (origin=BACKFILL, SYSTEM actor).
 */
export async function main(app: FastifyInstance, opts: BackfillOptions): Promise<BackfillSummary> {
  const { apply, until } = opts;

  const summary: BackfillSummary = {
    dryRun: !apply,
    tenantsScanned: 0,
    employeesScanned: 0,
    employeesWithOpenMonths: 0,
    totalMonthsClosed: 0,
    employees: [],
    errors: [],
  };

  // ── Resolve ceiling month ──────────────────────────────────────────────────
  // Default ceiling: previous calendar month (never close the current month).
  let ceilingYear: number;
  let ceilingMonth: number;

  if (until) {
    ceilingYear = until.year;
    ceilingMonth = until.month;
  } else {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth(); // 0-based; this equals the previous calendar month (1-based)
    if (m === 0) {
      ceilingYear = y - 1;
      ceilingMonth = 12;
    } else {
      ceilingYear = y;
      ceilingMonth = m;
    }
  }

  // ── Resolve tenant list ────────────────────────────────────────────────────
  const tenants = opts.tenantId
    ? await app.prisma.tenant.findMany({
        where: { id: opts.tenantId },
        include: { config: true },
      })
    : await app.prisma.tenant.findMany({ include: { config: true } });

  summary.tenantsScanned = tenants.length;

  for (const tenant of tenants) {
    try {
      const tz = tenant.config?.timezone ?? "Europe/Berlin";
      const stateCode = STATE_MAP[tenant.federalState] ?? "NI";

      // ── Resolve employees ────────────────────────────────────────────────
      const employeeWhere: Parameters<typeof app.prisma.employee.findMany>[0]["where"] = {
        tenantId: tenant.id,
        user: { isActive: true },
        isTimeTrackingExempt: false,
      };
      if (opts.employeeIds && opts.employeeIds.length > 0) {
        employeeWhere.id = { in: opts.employeeIds };
      }

      const employees = await app.prisma.employee.findMany({
        where: employeeWhere,
        include: { user: true, workSchedules: { orderBy: { validFrom: "desc" } } },
      });

      summary.employeesScanned += employees.length;

      // ── Per-employee backfill loop ──────────────────────────────────────
      for (const emp of employees) {
        try {
          // Find the newest active snapshot (to determine where backfill starts)
          const lastSnap = await app.prisma.saldoSnapshot.findFirst({
            where: {
              employeeId: emp.id,
              periodType: "MONTHLY",
              superseded: false,
            },
            orderBy: { periodStart: "desc" },
          });

          // Skip employees hired after the ceiling month
          const { end: ceilingMonthEnd } = monthRangeUtc(ceilingYear, ceilingMonth, tz);
          if (emp.hireDate > ceilingMonthEnd) continue;

          // Compute first open month
          const firstOpen = computeFirstOpenMonth(emp.hireDate, lastSnap, tz);
          if (firstOpen === null) continue;

          // Build the ordered range [firstOpen .. ceiling]
          const monthsToClose = buildBackfillMonthRange(firstOpen, {
            year: ceilingYear,
            month: ceilingMonth,
          });
          if (monthsToClose.length === 0) continue;

          // Get current OvertimeAccount.balanceHours for the dry-run diff
          const overtimeAccount = await app.prisma.overtimeAccount.findUnique({
            where: { employeeId: emp.id },
          });
          const oldLiveBalanceHours = Number(overtimeAccount?.balanceHours ?? 0);

          // Seed carryOver from the last active snapshot
          let carryOverIn = lastSnap?.carryOver ?? 0;

          // Track per-month projections for dry-run and summary
          const projectedBalances: number[] = [];
          const closableMonths: Array<{ year: number; month: number }> = [];

          // ── Iterate months: check idempotency + compute closeEmployeeMonth ──
          let projectedCarryOverIn = carryOverIn;

          for (const monthKey of monthsToClose) {
            const { start: monthStart, end: monthEnd } = monthRangeUtc(
              monthKey.year,
              monthKey.month,
              tz,
            );
            const { firstDay: monthFirstDay, lastDay: monthLastDay } = monthDayBounds(
              monthStart,
              monthEnd,
              tz,
            );

            // ── Idempotency check ────────────────────────────────────────────
            // If this month already has an active snapshot → skip + thread carryOver.
            // This preserves bridge/zero opening snapshots (Pitfall B3).
            const existingSnap = await app.prisma.saldoSnapshot.findFirst({
              where: {
                employeeId: emp.id,
                periodType: "MONTHLY",
                periodStart: periodStartWindow(monthStart),
                superseded: false,
              },
            });
            if (existingSnap) {
              // Thread carryOver forward (both actual and projected)
              carryOverIn = existingSnap.carryOver;
              projectedCarryOverIn = existingSnap.carryOver;
              continue; // already closed — skip
            }

            // Skip months that started after hire date (safety guard)
            if (emp.hireDate > monthEnd) {
              continue;
            }

            // ── Prepare data for closeEmployeeMonth ───────────────────────────
            // Schedule valid for this month
            const midMonth = new Date((monthStart.getTime() + monthEnd.getTime()) / 2);
            const schedule = await getEffectiveSchedule(app, emp.id, midMonth);

            // Effective start for this employee in this month
            const hireDateNorm = new Date(dateStrInTz(emp.hireDate, tz) + "T00:00:00Z");
            const empEffectiveStart = hireDateNorm > monthFirstDay ? hireDateNorm : monthFirstDay;

            // Build holiday set for this month
            const computedHolidays = getHolidays(monthKey.year, stateCode).filter(
              (h) =>
                h.date >= dateStrInTz(empEffectiveStart, tz) && h.date <= dateStrInTz(monthEnd, tz),
            );
            const dbHolidays = await app.prisma.publicHoliday.findMany({
              where: {
                tenant: { employees: { some: { id: emp.id } } },
                date: { gte: empEffectiveStart, lte: monthLastDay },
              },
            });
            const holidaySet = new Set<string>(computedHolidays.map((h) => h.date));
            for (const h of dbHolidays) {
              holidaySet.add(dateStrInTz(h.date, tz));
            }

            // Pre-fetch collections (mirroring auto-close-month.ts lines 497-540)
            const [entries, shifts, approvedLeave, absences] = await Promise.all([
              app.prisma.timeEntry.findMany({
                where: {
                  employeeId: emp.id,
                  deletedAt: null,
                  date: { gte: empEffectiveStart, lte: monthLastDay },
                  endTime: { not: null },
                  type: "WORK",
                  isInvalid: false,
                },
                select: { date: true, startTime: true, endTime: true, breakMinutes: true },
              }),
              app.prisma.shift.findMany({
                where: {
                  employeeId: emp.id,
                  date: { gte: empEffectiveStart, lte: monthLastDay },
                  deletedAt: null,
                },
                select: { date: true, startTime: true, endTime: true },
              }),
              app.prisma.leaveRequest.findMany({
                where: {
                  employeeId: emp.id,
                  deletedAt: null,
                  status: "APPROVED",
                  startDate: { lte: monthEnd },
                  endDate: { gte: monthStart },
                },
                select: { startDate: true, endDate: true, halfDay: true },
              }),
              app.prisma.absence.findMany({
                where: {
                  employeeId: emp.id,
                  deletedAt: null,
                  startDate: { lte: monthEnd },
                  endDate: { gte: empEffectiveStart },
                },
                select: { startDate: true, endDate: true, type: true, source: true },
              }),
            ]);

            // ── Call the shared pure saldo core (never re-implement saldo math) ─
            const r = closeEmployeeMonth({
              employeeId: emp.id,
              monthStart,
              monthEnd,
              monthFirstDay,
              monthLastDay,
              tz,
              carryOverIn: projectedCarryOverIn,
              schedule: schedule as Record<string, unknown>,
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
              approvedLeave: approvedLeave.map((lr) => ({
                startDate: lr.startDate,
                endDate: lr.endDate,
                halfDay: Boolean(lr.halfDay),
              })),
              absences: absences.map((ab) => ({
                startDate: ab.startDate,
                endDate: ab.endDate,
                type: ab.type,
                source: ab.source,
              })),
              holidayDateStrings: holidaySet,
              tenantConfig: tenant.config
                ? {
                    defaultBreakOver6h: tenant.config.defaultBreakOver6h,
                    defaultBreakOver9h: tenant.config.defaultBreakOver9h,
                    monthlyHoursHolidayDeduction:
                      tenant.config.monthlyHoursHolidayDeduction ?? undefined,
                    vocationalSchoolMinutesPerDay:
                      tenant.config.vocationalSchoolMinutesPerDay ?? undefined,
                    vocationalSchoolBlockMinutesPerWeek:
                      tenant.config.vocationalSchoolBlockMinutesPerWeek ?? undefined,
                  }
                : null,
            });

            // Track the projected balance for this month
            projectedBalances.push(r.balanceMinutes);
            closableMonths.push(monthKey);
            projectedCarryOverIn = r.effectiveCarryOverOut;

            // ── APPLY: write the snapshot + lock entries + upsert OvertimeAccount ─
            if (apply) {
              const {
                workedMinutes,
                balanceMinutes,
                carryOverOut,
                effectiveCarryOverOut,
                snapshotExpectedMinutes,
                gaps,
              } = r;

              // Use actual carryOverIn (from lastSnap or previously closed month in this loop)
              // Note: For the --apply path, re-run closeEmployeeMonth with the actual carryOverIn
              // if it differs from projectedCarryOverIn (they may differ if a previous iteration
              // wrote a snapshot that we then re-fetch below). Since we idempotency-check above
              // and thread projectedCarryOverIn=carryOverIn at start, they are always equal here.
              const { start: prevMonthStartInLoop } = monthRangeUtc(
                computePrevMonthInLoop(monthKey.month, monthKey.year).month === 12
                  ? computePrevMonthInLoop(monthKey.month, monthKey.year).year
                  : computePrevMonthInLoop(monthKey.month, monthKey.year).year,
                computePrevMonthInLoop(monthKey.month, monthKey.year).month,
                tz,
              );
              const prevSnapForCarryOver = await app.prisma.saldoSnapshot.findFirst({
                where: {
                  employeeId: emp.id,
                  periodType: "MONTHLY",
                  periodStart: periodStartWindow(prevMonthStartInLoop),
                  superseded: false,
                },
              });
              if (prevSnapForCarryOver) {
                carryOverIn = prevSnapForCarryOver.carryOver;
              }

              // Re-compute with actual carryOverIn (for the write path)
              const rApply = closeEmployeeMonth({
                employeeId: emp.id,
                monthStart,
                monthEnd,
                monthFirstDay,
                monthLastDay,
                tz,
                carryOverIn,
                schedule: schedule as Record<string, unknown>,
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
                approvedLeave: approvedLeave.map((lr) => ({
                  startDate: lr.startDate,
                  endDate: lr.endDate,
                  halfDay: Boolean(lr.halfDay),
                })),
                absences: absences.map((ab) => ({
                  startDate: ab.startDate,
                  endDate: ab.endDate,
                  type: ab.type,
                  source: ab.source,
                })),
                holidayDateStrings: holidaySet,
                tenantConfig: tenant.config
                  ? {
                      defaultBreakOver6h: tenant.config.defaultBreakOver6h,
                      defaultBreakOver9h: tenant.config.defaultBreakOver9h,
                      monthlyHoursHolidayDeduction:
                        tenant.config.monthlyHoursHolidayDeduction ?? undefined,
                      vocationalSchoolMinutesPerDay:
                        tenant.config.vocationalSchoolMinutesPerDay ?? undefined,
                      vocationalSchoolBlockMinutesPerWeek:
                        tenant.config.vocationalSchoolBlockMinutesPerWeek ?? undefined,
                    }
                  : null,
              });

              const closeCarryOver = rApply.carryOverOut;
              const closeEffectiveCarryOver = rApply.effectiveCarryOverOut;

              await app.prisma.$transaction(async (tx) => {
                await tx.saldoSnapshot.create({
                  data: {
                    employeeId: emp.id,
                    periodType: "MONTHLY",
                    periodStart: monthStart,
                    periodEnd: monthEnd,
                    workedMinutes: rApply.workedMinutes,
                    expectedMinutes: rApply.snapshotExpectedMinutes,
                    balanceMinutes: rApply.balanceMinutes,
                    carryOver: closeEffectiveCarryOver,
                    closedAt: new Date(),
                    closedBy: null, // SYSTEM actor
                    note:
                      rApply.gaps.length > 0
                        ? `Backfill Monatsabschluss — ${rApply.gaps.length} Lücke(n) als 0h geschlossen: ${rApply.gaps.map((g) => g.date).join(", ")}`
                        : "Backfill Monatsabschluss",
                  },
                });

                // Lock all time entries in this month
                await tx.timeEntry.updateMany({
                  where: {
                    employeeId: emp.id,
                    deletedAt: null,
                    date: { gte: monthFirstDay, lte: monthLastDay },
                  },
                  data: { isLocked: true, lockedAt: new Date() },
                });

                // Upsert OvertimeAccount with the new carryOver balance
                await tx.overtimeAccount.upsert({
                  where: { employeeId: emp.id },
                  create: { employeeId: emp.id, balanceHours: closeEffectiveCarryOver / 60 },
                  update: { balanceHours: closeEffectiveCarryOver / 60 },
                });
              });

              // Write BACKFILL AuditLog (SYSTEM actor, origin=BACKFILL)
              // Mirrors auto-close-month.ts audit shape but with origin=BACKFILL (not SYSTEM)
              await app.audit({
                userId: undefined,
                action: "CREATE",
                entity: "SaldoSnapshot",
                entityId: emp.id,
                newValue: {
                  origin: "BACKFILL",
                  employeeId: emp.id,
                  periodType: "MONTHLY",
                  year: monthKey.year,
                  month: monthKey.month,
                  workedMinutes: rApply.workedMinutes,
                  expectedMinutes: rApply.snapshotExpectedMinutes,
                  balanceMinutes: rApply.balanceMinutes,
                  carryOver: closeCarryOver,
                  backfill: true,
                },
              });

              // Thread actual effectiveCarryOverOut to next month in the loop
              carryOverIn = closeEffectiveCarryOver;
              summary.totalMonthsClosed++;
            }
          } // end monthsToClose loop

          if (closableMonths.length === 0) continue;

          // ── Build per-employee summary entry ──────────────────────────────
          const chainResult = projectCarryOverChain(lastSnap?.carryOver ?? 0, projectedBalances);
          const projectedCarryOverHours = chainResult.finalCarryOverMinutes / 60;

          const empSummary: BackfillEmployeeSummary = {
            employeeId: emp.id,
            tenantId: tenant.id,
            oldLiveBalanceHours,
            projectedCarryOverHours,
            monthsToClose: closableMonths,
            projectedCarryOverChain: chainResult.perMonthCarryOver,
          };
          summary.employees.push(empSummary);
          summary.employeesWithOpenMonths++;

          // Console output for the operator (dry-run diff or apply summary)
          if (apply) {
            console.info(
              `[APPLIED] employeeId=${emp.id} — closed ${closableMonths.length} month(s): ` +
                `${closableMonths.map((m) => `${m.year}-${String(m.month).padStart(2, "0")}`).join(", ")} ` +
                `oldBalance=${oldLiveBalanceHours.toFixed(2)}h → projectedCarryOver=${projectedCarryOverHours.toFixed(2)}h`,
            );
          } else {
            console.info(
              `[DRY-RUN] employeeId=${emp.id} — ${closableMonths.length} open month(s): ` +
                `${closableMonths.map((m) => `${m.year}-${String(m.month).padStart(2, "0")}`).join(", ")} | ` +
                `oldBalance=${oldLiveBalanceHours.toFixed(2)}h → projectedCarryOver=${projectedCarryOverHours.toFixed(2)}h`,
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          summary.errors.push({ employeeId: emp.id, tenantId: tenant.id, error: message });
          console.error(`[ERROR] employeeId=${emp.id}: ${message}`);
        }
      } // end employee loop
    } catch (err) {
      // Per-tenant failure must not abort other tenants
      console.error(
        `[ERROR] tenantId=${tenant.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } // end tenant loop

  // Print summary table (hours)
  console.log("\n── Backfill Summary ──────────────────────────────────────────");
  console.log(
    `Mode:              ${summary.dryRun ? "DRY-RUN (no writes)" : "APPLY (writes committed)"}`,
  );
  console.log(`Tenants scanned:   ${summary.tenantsScanned}`);
  console.log(`Employees scanned: ${summary.employeesScanned}`);
  console.log(
    `Open months found: ${summary.employees.reduce((n, e) => n + e.monthsToClose.length, 0)}`,
  );
  if (apply) {
    console.log(`Months closed:     ${summary.totalMonthsClosed}`);
  }
  if (summary.errors.length > 0) {
    console.log(`Errors:            ${summary.errors.length}`);
  }
  console.log("─────────────────────────────────────────────────────────────\n");

  return summary;
}

// ── CLI entrypoint ───────────────────────────────────────────────────────────
// Guard: only execute when invoked directly as a script, NOT when imported in tests.
const isMain =
  typeof process !== "undefined" &&
  typeof process.argv !== "undefined" &&
  // ESM: import.meta.url check
  (typeof require === "undefined"
    ? // In ESM context: rely on the import.meta.url check below
      false
    : // CJS context: check require.main
      typeof module !== "undefined" && require.main === module);

// ESM guard for tsx invocation
const esmIsMain =
  typeof import.meta !== "undefined" &&
  typeof import.meta.url !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1] === new URL(import.meta.url).pathname ||
    process.argv[1].endsWith("backfill-month-snapshots.ts") ||
    process.argv[1].endsWith("backfill-month-snapshots.js"));

if (isMain || esmIsMain) {
  (async () => {
    if (!process.env.DATABASE_URL) {
      console.error("DATABASE_URL is required");
      process.exit(1);
    }

    // Lazy import to avoid loading Prisma in test contexts
    const { parseArgs } = await import("node:util");
    const pg = (await import("pg")).default;
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const { PrismaClient } = await import("@clokr/db");
    const { buildApp } = await import("../src/app");

    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        apply: { type: "boolean", default: false },
        tenant: { type: "string" },
        employee: { type: "string", multiple: true },
        until: { type: "string" },
        help: { type: "boolean", default: false },
      },
      strict: true,
    });

    if (values.help) {
      console.info(`
Usage: tsx scripts/backfill-month-snapshots.ts [options]

  (none)              Dry-run: print diff table, write ZERO rows.
  --apply             Opt-in write: close each open month oldest→newest.
  --tenant <uuid>     Restrict to a single tenant UUID.
  --employee <id>     Restrict to employee ID(s). Repeatable or comma-separated.
  --until YYYY-MM     Month ceiling (inclusive, default: previous calendar month).
  --help              Print this message and exit.

Safety:
  - DRY-RUN is the default. --apply is required to write anything.
  - Idempotent: months with an active snapshot are skipped.
  - Every write emits an AuditLog row with origin=BACKFILL (SYSTEM actor).
      `);
      process.exit(0);
    }

    // Parse --employee (supports --employee a,b,c or --employee a --employee b)
    const employeeIds =
      values.employee && values.employee.length > 0
        ? values.employee.flatMap((e) =>
            e
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          )
        : undefined;

    // Parse --until YYYY-MM
    let until: { year: number; month: number } | undefined;
    if (values.until) {
      const parts = values.until.split("-");
      const yr = parseInt(parts[0] ?? "", 10);
      const mo = parseInt(parts[1] ?? "", 10);
      if (isNaN(yr) || isNaN(mo) || mo < 1 || mo > 12) {
        console.error(`Invalid --until value: ${values.until}. Expected YYYY-MM.`);
        process.exit(1);
      }
      until = { year: yr, month: mo };
    }

    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new PrismaPg(pool as any);
    const prisma = new PrismaClient({ adapter });

    // Build the Fastify app so we have access to app.audit() and other plugins
    const app = await buildApp();
    await app.ready();

    try {
      await main(app, {
        apply: Boolean(values.apply),
        tenantId: values.tenant,
        employeeIds,
        until,
      });
    } catch (err) {
      console.error((err as Error).message ?? err);
      process.exit(1);
    } finally {
      await app.close();
      await prisma.$disconnect();
      await pool.end();
    }
  })();
}
