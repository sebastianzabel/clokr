import fp from "fastify-plugin";
import cron, { type ScheduledTask } from "node-cron";
import { monthRangeUtc, monthDayBounds, dateStrInTz } from "../utils/timezone";
import { getEffectiveSchedule } from "../routes/time-entries";
import { getHolidays, STATE_MAP } from "../utils/holidays";
import { periodStartWindow } from "../utils/snapshot-period";
import { withAdvisoryLock, ADVISORY_LOCK_KEYS } from "../utils/with-advisory-lock";
import { closeEmployeeMonth } from "../utils/close-employee-month"; // Phase 76.26 — shared pure saldo core
import { findMissingWorkdays } from "../utils/find-missing-workdays"; // Phase 76.26 — schedule-model-aware gap detector
import { loadBsSlotOverrides } from "../utils/load-bs-slot-overrides"; // Phase 76.31 — D-06 slot overrides

declare module "fastify" {
  interface FastifyInstance {
    tryAutoCloseMonth: () => Promise<void>;
  }
}

/**
 * Auto-Monatsabschluss: runs daily at 06:00.
 *
 * For each tenant, closes ALL unclosed prior months for each active employee via a
 * bounded backward backfill loop (SNAP-02 / Phase 76.27):
 *   1. Find the employee's last active snapshot → compute first open month.
 *   2. Iterate oldest→newest [firstOpen .. prevMonth]:
 *      a. If month has an active (superseded=false) snapshot → skip + thread carryOver.
 *         This idempotency check also preserves bridge/zero opening snapshots (Pitfall B3).
 *      b. If month is gap-FREE → close immediately (no day-N wait).
 *      c. If month has gaps:
 *         - Within window (today < day N of M+1, N=retroEntryWindowDays) → DEFER (F-02 BREAK + notify).
 *           Do NOT continue past a gap — closing later months on stale carryOver corrupts the chain.
 *         - At/after day N AND closeMonthWithGapsAllowed=true → force-close (gaps=0h).
 *         - At/after day N AND closeMonthWithGapsAllowed=false → DEFER forever (manual-only).
 *      d. Otherwise → close via closeEmployeeMonth(), write snapshot + audit.
 *   3. Sends notifications about remaining gaps.
 *
 * Cross-year (Dec→Jan): handled via computePrevMonthInLoop (month=1 → month=12, year-1).
 * carryOver base: always the IMMEDIATELY preceding month's active snapshot (periodStartWindow
 * + superseded=false — never orderBy:desc which could pick a stale far-earlier row; Pitfall B2).
 *
 * Phase 76.29 Plan 04 (Variante A — Tag-N-Fenster):
 *   Supersedes the hardcoded DEFAULT_CLOSE_AFTER_DAY=15 outer grace guard.
 *   Gap-free months close whenever processed (no day-N wait).
 *   Gap months defer while employees can self-service; force-close on/after day N of M+1.
 */
export const autoCloseMonthPlugin = fp(async (app) => {
  const tasks: ScheduledTask[] = [];

  // ── Month-step helpers ────────────────────────────────────────────────────────

  /**
   * Compute the previous month (with year wrap: Jan → Dec of prior year).
   * Used inside the backward loop to step between months.
   */
  function computePrevMonthInLoop(month: number, year: number): { month: number; year: number } {
    if (month === 1) return { month: 12, year: year - 1 };
    return { month: month - 1, year };
  }

  /**
   * Build an ordered list of { year, month } keys from firstOpen to ceiling (both inclusive),
   * oldest-first. Returns empty if firstOpen > ceiling.
   *
   * The loop iterates by stepping month+1 and wrapping Dec→Jan. This handles cross-year
   * ranges without any special-casing at the call site.
   */
  function buildMonthRange(
    firstOpen: { year: number; month: number },
    ceiling: { year: number; month: number },
  ): Array<{ year: number; month: number }> {
    const result: Array<{ year: number; month: number }> = [];
    let cur = { ...firstOpen };
    // Safety: max 60 months to prevent runaway loops
    let guard = 0;
    while (guard++ < 60) {
      // Stop if cur > ceiling
      if (cur.year > ceiling.year || (cur.year === ceiling.year && cur.month > ceiling.month)) {
        break;
      }
      result.push({ ...cur });
      // Advance to next month
      if (cur.month === 12) {
        cur = { year: cur.year + 1, month: 1 };
      } else {
        cur = { year: cur.year, month: cur.month + 1 };
      }
    }
    return result;
  }

  /**
   * Compute the first open month for an employee: max(hireMonth, lastSnapshotMonth+1).
   * Returns null if the employee has no hire date (shouldn't happen in practice).
   */
  function computeFirstOpenMonth(
    hireDate: Date,
    lastSnap: { periodStart: Date } | null,
    tz: string,
  ): { year: number; month: number } | null {
    // TZ-normalize hireDate to get the calendar month in tenant timezone
    const hireDateStr = dateStrInTz(hireDate, tz);
    const [hireYearStr, hireMonthStr] = hireDateStr.split("-");
    const hireYear = parseInt(hireYearStr, 10);
    const hireMonth = parseInt(hireMonthStr, 10); // 1-based

    if (lastSnap === null) {
      // No prior snapshot → start from hire month
      return { year: hireYear, month: hireMonth };
    }

    // lastSnap.periodStart is a @db.Date — extract year and month from it.
    // The periodStart may be TZ-converted (e.g. 2026-05-31 for June/Berlin) or
    // UTC-naive (2026-06-01). Use the UTC date part and add 2 days then extract month
    // to handle the TZ-shifted case — but more robustly, use the actual monthRangeUtc
    // window convention (the periodStart's UTC date is ≤ the nominal month start).
    // Since lastSnap is the newest active snapshot (found by orderBy:desc), its periodStart
    // tells us which calendar month was last closed. The next open month = that month + 1.
    const psDate = lastSnap.periodStart;
    const psMidMonthDate = new Date(psDate.getTime() + 15 * 24 * 60 * 60 * 1000); // +15d → definitely in the correct month
    const psMidMonthStr = dateStrInTz(psMidMonthDate, tz);
    const [snapYearStr, snapMonthStr] = psMidMonthStr.split("-");
    const snapYear = parseInt(snapYearStr, 10);
    const snapMonth = parseInt(snapMonthStr, 10); // 1-based

    // Next open month = snapMonth + 1 (with year wrap)
    let nextYear = snapYear;
    let nextMonth = snapMonth + 1;
    if (nextMonth === 13) {
      nextMonth = 1;
      nextYear += 1;
    }

    // Return max(hireMonth, nextMonth) in chronological order
    if (nextYear > hireYear || (nextYear === hireYear && nextMonth >= hireMonth)) {
      return { year: nextYear, month: nextMonth };
    }
    return { year: hireYear, month: hireMonth };
  }

  /**
   * Returns true when today (in the given tenant timezone) is AT or AFTER day N of month M+1
   * (the "window close" date for month M). Returns false while employees can still self-service.
   *
   * Decision matrix:
   *   - today is still in month M or earlier → false (window not yet open)
   *   - today is in month M+1 and todayDay < retroWindowDays → false (within window)
   *   - today is in month M+1 and todayDay >= retroWindowDays → true (at/after day N)
   *   - today is after month M+1 → true (long past window; old backfill)
   *
   * Handles Dec→Jan year rollover for M+1. Uses tenant-TZ dateStrInTz — never UTC math.
   */
  function isMonthPastItsWindow(
    monthYear: number,
    monthNum: number,
    tz: string,
    retroWindowDays: number,
  ): boolean {
    const todayStr = dateStrInTz(new Date(), tz); // YYYY-MM-DD in tenant TZ
    const ty = parseInt(todayStr.slice(0, 4), 10);
    const tm = parseInt(todayStr.slice(5, 7), 10);
    const td = parseInt(todayStr.slice(8, 10), 10);
    const wm = monthNum === 12 ? 1 : monthNum + 1; // window-close month (M+1)
    const wy = monthNum === 12 ? monthYear + 1 : monthYear;
    if (ty < wy) return false; // today is before M+1 → still within window
    if (ty === wy && tm < wm) return false; // today is still in M or earlier → within window
    if (ty === wy && tm === wm) return td >= retroWindowDays; // in M+1: check day N
    return true; // today is after M+1 → long past window
  }

  async function tryAutoCloseMonth() {
    const now = new Date();

    app.log.info("Auto-Monatsabschluss: Prüfe Vormonat");

    const tenants = await app.prisma.tenant.findMany({
      include: { config: true },
    });

    for (const tenant of tenants) {
      try {
        const tz = tenant.config?.timezone ?? "Europe/Berlin";

        // Calculate previous month (the CEILING of the backfill range — never close the current month)
        const zonedNow = new Date(dateStrInTz(now, tz) + "T12:00:00Z");
        let prevYear = zonedNow.getUTCFullYear();
        let prevMonth = zonedNow.getUTCMonth(); // 0-based, so this IS previous month (1-based)
        if (prevMonth === 0) {
          prevMonth = 12;
          prevYear -= 1;
        }

        const { start: prevMonthStart, end: prevMonthEnd } = monthRangeUtc(prevYear, prevMonth, tz);

        // Pre-compute holiday date strings for the current cron-target month
        const acmStateCode = STATE_MAP[tenant.federalState] ?? "NI";

        // Get all active employees
        const employees = await app.prisma.employee.findMany({
          where: {
            tenantId: tenant.id,
            user: { isActive: true },
            isTimeTrackingExempt: false, // D-02: §18 ArbZG-exempt employees are not snapshotted (parity with manual close)
          },
          include: {
            user: true,
            workSchedules: { orderBy: { validFrom: "desc" } },
          },
        });

        // Get managers for notifications
        const managers = employees.filter(
          (e) => e.user.role === "ADMIN" || e.user.role === "MANAGER",
        );

        const missing: {
          employee: (typeof employees)[0];
          missingDates: string[];
          month: number;
          year: number;
        }[] = [];

        // ── SNAP-02 / Phase 76.27: Bounded backward backfill loop ─────────────────
        // Replaces the single-month sequential guard (which was :138-170).
        // For each employee, close ALL unclosed prior months oldest→newest.
        // The loop bounds are: [max(hireMonth, lastSnapshot+1) .. prevMonth].
        // carryOver base for each month = immediately-preceding month's active snapshot
        // (periodStartWindow + superseded:false, NOT orderBy:desc — Pitfall B2).
        // Bridge/zero opening snapshots are preserved: idempotency skip (Pitfall B3).
        // Gap-blocked month → BREAK (F-02): never close later months on stale carryOver.

        for (const emp of employees) {
          try {
            // Find the newest active snapshot to determine where backfill starts.
            // orderBy:desc IS correct here (finding the most recent closed month, not the carryOver base).
            const lastSnap = await app.prisma.saldoSnapshot.findFirst({
              where: {
                employeeId: emp.id,
                periodType: "MONTHLY",
                superseded: false, // Pitfall B5: always filter superseded=false
              },
              orderBy: { periodStart: "desc" },
            });

            // Skip employees hired after the ceiling month
            if (emp.hireDate > prevMonthEnd) continue;

            // Compute the first open month = max(hireMonth, lastSnapshot+1)
            const firstOpen = computeFirstOpenMonth(emp.hireDate, lastSnap, tz);
            if (firstOpen === null) continue;

            // Build the ordered range [firstOpen .. prevMonth]
            const monthsToClose = buildMonthRange(firstOpen, { year: prevYear, month: prevMonth });

            // Thread carryOver through the loop: seeded from the lastSnap before the loop starts.
            // Will be updated as each month is closed or idempotency-skipped.
            let carryOverIn = lastSnap?.carryOver ?? 0;

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

              // ── Idempotency check ──────────────────────────────────────────────
              // If this month already has an active (superseded=false) snapshot, skip it
              // and thread its carryOver to the next month. This preserves bridge/zero
              // opening balance snapshots (Pitfall B3) — they ARE active snapshots and
              // this check naturally skips them without any balanceMinutes==0 heuristic.
              // SNAP-04: bridge snapshots MUST NOT be superseded; the sole guard is this check.
              const existingSnap = await app.prisma.saldoSnapshot.findFirst({
                where: {
                  employeeId: emp.id,
                  periodType: "MONTHLY",
                  periodStart: periodStartWindow(monthStart), // convention-robust (B5)
                  superseded: false, // Pitfall B5: always filter superseded=false
                },
              });
              if (existingSnap) {
                // Skip — thread existing snapshot's carryOver as the next month's base.
                carryOverIn = existingSnap.carryOver;
                continue;
              }

              // Skip months that started after the employee's hire date check
              if (emp.hireDate > monthEnd) continue;

              // ── Per-month gap readiness check ──────────────────────────────────
              // Re-uses the same findMissingWorkdays logic as before, scoped to THIS month.
              // D-01: MONTHLY_HOURS and FLEXTIME have no daily gap rule.
              const scheduleForMonth = emp.workSchedules.find((ws) => ws.validFrom <= monthEnd);

              if (scheduleForMonth) {
                const acmScheduleTypeSt = String(scheduleForMonth.type);
                const isFlexible =
                  acmScheduleTypeSt === "MONTHLY_HOURS" || acmScheduleTypeSt === "FLEXTIME";

                if (!isFlexible) {
                  // Fetch entries and leave/absences for this month
                  const rdEntries = await app.prisma.timeEntry.findMany({
                    where: {
                      employeeId: emp.id,
                      deletedAt: null,
                      date: { gte: monthStart, lte: monthEnd },
                      endTime: { not: null },
                      type: "WORK",
                    },
                    select: { date: true },
                  });
                  const rdEntryDates = new Set(rdEntries.map((e) => dateStrInTz(e.date, tz)));

                  const rdApprovedLeave = await app.prisma.leaveRequest.findMany({
                    where: {
                      employeeId: emp.id,
                      deletedAt: null,
                      status: "APPROVED",
                      startDate: { lte: monthEnd },
                      endDate: { gte: monthStart },
                    },
                    select: { startDate: true, endDate: true, halfDay: true },
                  });
                  const rdAbsences = await app.prisma.absence.findMany({
                    where: {
                      employeeId: emp.id,
                      deletedAt: null,
                      startDate: { lte: monthEnd },
                      endDate: { gte: monthStart },
                    },
                    select: { startDate: true, endDate: true, halfDay: true },
                  });

                  // Pre-compute holiday date strings for this specific month
                  const monthHolidayDateStrings = new Set<string>(
                    getHolidays(monthKey.year, acmStateCode).map((h) => h.date),
                  );
                  const monthDbHolidays = await app.prisma.publicHoliday.findMany({
                    where: { tenantId: tenant.id, date: { gte: monthStart, lte: monthEnd } },
                  });
                  for (const h of monthDbHolidays) {
                    monthHolidayDateStrings.add(dateStrInTz(h.date, tz));
                  }

                  // For SHIFT_BASED: fetch rosterDates (Shift.date set) — pitfall A4 fix.
                  let rdRosterDates: Set<string> | undefined;
                  if (acmScheduleTypeSt === "SHIFT_BASED") {
                    const empShifts = await app.prisma.shift.findMany({
                      where: {
                        employeeId: emp.id,
                        date: { gte: monthFirstDay, lte: monthLastDay },
                        deletedAt: null,
                      },
                      select: { date: true },
                    });
                    rdRosterDates = new Set(empShifts.map((sh) => dateStrInTz(sh.date, tz)));
                  }

                  // effectiveStart = max(hireDate, monthFirstDay) — TZ-normalised (CLOSE-04).
                  const rdHireDateNorm = new Date(dateStrInTz(emp.hireDate, tz) + "T00:00:00Z");
                  const rdEffectiveStart =
                    rdHireDateNorm > monthFirstDay ? rdHireDateNorm : monthFirstDay;

                  const rdGapResult = findMissingWorkdays({
                    schedule: scheduleForMonth as Record<string, unknown>,
                    effectiveStart: rdEffectiveStart,
                    effectiveEnd: monthLastDay,
                    tz,
                    entryDates: rdEntryDates,
                    approvedLeave: rdApprovedLeave.map((lr) => ({
                      startDate: lr.startDate,
                      endDate: lr.endDate,
                      halfDay: Boolean(lr.halfDay),
                    })),
                    absences: rdAbsences.map((ab) => ({
                      startDate: ab.startDate,
                      endDate: ab.endDate,
                      halfDay: ab.halfDay,
                    })),
                    holidayDateStrings: monthHolidayDateStrings,
                    rosterDates: rdRosterDates,
                  });

                  const missingDates = rdGapResult.gaps.map((g) => g.date);

                  if (missingDates.length > 0) {
                    // Phase 76.29 Plan 04 — Variante A (Tag-N-Fenster):
                    // Read real typed TenantConfig fields (column added by Plan 01).
                    const retroWindowDays = tenant.config?.retroEntryWindowDays ?? 10;
                    const closeAllowed = tenant.config?.closeMonthWithGapsAllowed ?? true;
                    const pastWindow = isMonthPastItsWindow(
                      monthKey.year,
                      monthKey.month,
                      tz,
                      retroWindowDays,
                    );

                    if (!pastWindow) {
                      // Within the retro self-service window (today < day N of M+1).
                      // Defer: BREAK + notify. Do NOT close later months on stale carryOver.
                      app.log.warn(
                        { employeeId: emp.id, month: monthKey.month, year: monthKey.year },
                        `Auto-Monatsabschluss: Lücken in ${monthKey.month}/${monthKey.year} — innerhalb Selbstbearbeitungsfenster (Tag ${retroWindowDays}), verschoben`,
                      );
                      missing.push({
                        employee: emp,
                        missingDates,
                        month: monthKey.month,
                        year: monthKey.year,
                      });
                      break; // F-02: defer while in-window
                    }

                    if (!closeAllowed) {
                      // Past window but flag=false → defer forever (manual-only, never auto-finalize).
                      app.log.warn(
                        { employeeId: emp.id, month: monthKey.month, year: monthKey.year },
                        `Auto-Monatsabschluss: Lücken nach Fenster-Ende — closeMonthWithGapsAllowed=false, verschoben (manuell)`,
                      );
                      missing.push({
                        employee: emp,
                        missingDates,
                        month: monthKey.month,
                        year: monthKey.year,
                      });
                      break; // defer forever
                    }
                    // pastWindow && closeAllowed → fall through to force-close (gaps=0h)
                  }
                }
              }

              // ── Close this month ───────────────────────────────────────────────
              // Pre-fetch the carryOver base from the IMMEDIATELY preceding month
              // (Pitfall B2 — NOT orderBy:desc which could pick a far-earlier snapshot).
              const prevMonthKeyInLoop = computePrevMonthInLoop(monthKey.month, monthKey.year);
              const { start: prevMonthStartInLoop } = monthRangeUtc(
                prevMonthKeyInLoop.year,
                prevMonthKeyInLoop.month,
                tz,
              );
              const prevSnapForCarryOver = await app.prisma.saldoSnapshot.findFirst({
                where: {
                  employeeId: emp.id,
                  periodType: "MONTHLY",
                  periodStart: periodStartWindow(prevMonthStartInLoop), // immediately-preceding month
                  superseded: false, // Pitfall B5: always filter superseded=false
                },
                // NO orderBy here — periodStartWindow narrows to exactly one month
              });
              // Use the immediately-preceding snapshot's carryOver if available,
              // otherwise fall back to the threaded carryOverIn (which may differ if
              // the prev snapshot was just created in this same loop iteration).
              // The threaded carryOverIn is equally correct since it was set to
              // effectiveCarryOverOut of the previously closed month.
              if (prevSnapForCarryOver) {
                carryOverIn = prevSnapForCarryOver.carryOver;
              }
              // (else: carryOverIn remains the threaded value from the prior iteration)

              // ── Schedule valid FOR this month (historical schedule awareness) ──
              const midMonth = new Date((monthStart.getTime() + monthEnd.getTime()) / 2);
              const schedule = await getEffectiveSchedule(app, emp.id, midMonth);

              // Build holiday set for this month
              const empHireDateNorm = emp.hireDate
                ? new Date(dateStrInTz(emp.hireDate, tz) + "T00:00:00Z")
                : null;
              const empEffectiveStart =
                empHireDateNorm && empHireDateNorm > monthFirstDay
                  ? empHireDateNorm
                  : monthFirstDay;

              const closeMonthComputedHolidays = getHolidays(monthKey.year, acmStateCode).filter(
                (h) =>
                  h.date >= dateStrInTz(empEffectiveStart, tz) &&
                  h.date <= dateStrInTz(monthEnd, tz),
              );
              const closeMonthDbHolidays = await app.prisma.publicHoliday.findMany({
                where: {
                  tenant: { employees: { some: { id: emp.id } } },
                  date: { gte: empEffectiveStart, lte: monthLastDay },
                },
              });
              const closeMonthHolidayDateSet = new Set<string>(
                closeMonthComputedHolidays.map((h) => h.date),
              );
              const closeHolidayDateStrings = new Set<string>([
                ...closeMonthComputedHolidays.map((h) => h.date),
                ...closeMonthDbHolidays
                  .filter((h) => !closeMonthHolidayDateSet.has(dateStrInTz(h.date, tz)))
                  .map((h) => dateStrInTz(h.date, tz)),
              ]);

              // Pre-fetch all collections needed by closeEmployeeMonth
              const [closeEntries, closeShifts, closeApprovedLeave, closeAbsences] =
                await Promise.all([
                  // WORK entries (effectiveStart..monthLastDay, soft-delete + isInvalid filter)
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
                  // Shifts (SHIFT_BASED only — also fetch for non-SHIFT; core ignores them)
                  app.prisma.shift.findMany({
                    where: {
                      employeeId: emp.id,
                      date: { gte: empEffectiveStart, lte: monthLastDay },
                      deletedAt: null,
                    },
                    select: { date: true, startTime: true, endTime: true },
                  }),
                  // Approved leave
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
                  // All absences (including VOCATIONAL_SCHOOL — BS-doubling handled in core)
                  app.prisma.absence.findMany({
                    where: {
                      employeeId: emp.id,
                      deletedAt: null,
                      startDate: { lte: monthEnd },
                      endDate: { gte: empEffectiveStart },
                    },
                    select: {
                      startDate: true,
                      endDate: true,
                      type: true,
                      source: true,
                      halfDay: true,
                      // Phase 76.38 (D-11) — per-day Unterrichtszeit for duration-based BS slot.
                      unterrichtsMinutes: true,
                    },
                  }),
                ]);

              // Phase 76.31 (D-06): load Employee + active-Pattern bsSlot* overrides.
              const { employeeSlots, patternSlots, patternUnterrichtsMinutenByDow } =
                await loadBsSlotOverrides(app.prisma, emp.id, monthFirstDay);

              // ── Phase 76.26: call the shared pure saldo core ──────────────────
              const r = closeEmployeeMonth({
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
                isTimeTrackingExempt: false, // already short-circuited above
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
                holidayDateStrings: closeHolidayDateStrings,
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
                      // Phase 76.31 (D-06) — TenantConfig slot layer.
                      bsSlotFirstLongDayMinutes:
                        tenant.config.bsSlotFirstLongDayMinutes ?? undefined,
                      bsSlotSecondLongDayMinutes:
                        tenant.config.bsSlotSecondLongDayMinutes ?? undefined,
                      bsSlotShortDayMinutes: tenant.config.bsSlotShortDayMinutes ?? undefined,
                      bsSlotBlockWeekMinutes: tenant.config.bsSlotBlockWeekMinutes ?? undefined,
                    }
                  : null,
                // Phase 76.31 (D-06) — Employee/Pattern slot layers (null → fallback).
                employeeSlots,
                patternSlots,
                // Phase 76.38 (D-11) — Pattern per-DOW Unterrichtszeit fallback.
                patternUnterrichtsMinutenByDow,
              });

              const {
                workedMinutes: closeWorkedMinutes,
                balanceMinutes,
                carryOverOut,
                effectiveCarryOverOut,
                snapshotExpectedMinutes,
                gaps,
              } = r;

              // Alias for the $transaction and audit log below (mirrors P1 manual-close variable names)
              const effectiveCarryOver = effectiveCarryOverOut;
              const carryOver = carryOverOut;

              await app.prisma.$transaction(async (tx) => {
                await tx.saldoSnapshot.create({
                  data: {
                    employeeId: emp.id,
                    periodType: "MONTHLY",
                    periodStart: monthStart,
                    periodEnd: monthEnd,
                    workedMinutes: closeWorkedMinutes,
                    expectedMinutes: snapshotExpectedMinutes,
                    balanceMinutes,
                    carryOver: effectiveCarryOver,
                    closedAt: new Date(),
                    closedBy: null, // SYSTEM
                    note:
                      gaps.length > 0
                        ? `Automatischer Monatsabschluss — ${gaps.length} Lücke(n) als 0h geschlossen: ${gaps.map((g) => g.date).join(", ")}`
                        : "Automatischer Monatsabschluss",
                  },
                });

                await tx.timeEntry.updateMany({
                  where: {
                    employeeId: emp.id,
                    deletedAt: null,
                    // Day bounds (not the monthStart/monthEnd timestamps): the timestamp
                    // lower bound casts to the previous month's last day for UTC+ tenants.
                    date: { gte: monthFirstDay, lte: monthLastDay },
                  },
                  data: { isLocked: true, lockedAt: new Date() },
                });

                // PERF-V1814-02: overtimeAccount.upsert inside the same tx as snapshot + entry-lock.
                // A crash between snapshot commit and upsert can no longer leave a stale live balance.
                // effectiveCarryOver=0 for TRACK_ONLY employees.
                await tx.overtimeAccount.upsert({
                  where: { employeeId: emp.id },
                  create: { employeeId: emp.id, balanceHours: effectiveCarryOver / 60 },
                  update: { balanceHours: effectiveCarryOver / 60 },
                });
              });

              await app.audit({
                userId: undefined,
                action: "CREATE",
                entity: "SaldoSnapshot",
                entityId: emp.id,
                newValue: {
                  origin: "SYSTEM",
                  employeeId: emp.id,
                  periodType: "MONTHLY",
                  year: monthKey.year,
                  month: monthKey.month,
                  workedMinutes: closeWorkedMinutes,
                  expectedMinutes: snapshotExpectedMinutes,
                  balanceMinutes,
                  carryOver,
                  auto: true,
                },
              });

              app.log.info(
                `Auto-Monatsabschluss: ${emp.firstName} ${emp.lastName} — ${monthKey.month}/${monthKey.year} abgeschlossen (${Math.round(closeWorkedMinutes / 60)}h Ist, ${Math.round(snapshotExpectedMinutes / 60)}h Soll)`,
              );

              // Thread the effectiveCarryOverOut to the next month in the loop
              carryOverIn = effectiveCarryOverOut;
            }
          } catch (err) {
            app.log.error(
              { err, employeeId: emp.id },
              "Auto-Monatsabschluss: Fehler beim Abschluss",
            );
          }
        }

        // Auto-Jahresabschluss: if all 12 months of the previous year are closed, create yearly snapshot
        if (prevMonth === 12) {
          for (const emp of employees) {
            try {
              // Check if yearly snapshot already exists
              const yearlyExists = await app.prisma.saldoSnapshot.findFirst({
                where: {
                  employeeId: emp.id,
                  periodType: "YEARLY",
                  periodStart: {
                    gte: new Date(`${prevYear}-01-01`),
                    lte: new Date(`${prevYear}-01-02`),
                  },
                  superseded: false,
                },
              });
              if (yearlyExists) continue;

              // Check all 12 months are closed
              const yearStart = new Date(`${prevYear}-01-01T00:00:00Z`);
              const yearEnd = new Date(`${prevYear}-12-31T23:59:59Z`);
              const monthSnapshots = await app.prisma.saldoSnapshot.findMany({
                where: {
                  employeeId: emp.id,
                  periodType: "MONTHLY",
                  periodStart: { gte: yearStart, lte: yearEnd },
                  superseded: false,
                },
                orderBy: { periodStart: "asc" },
              });

              // COMP-V1814-08: mid-year hires only need their share of months.
              // A July hire has 6 months in the year (Jul-Dec); requiring 12 would
              // prevent their yearly carry-over from ever running.
              const hireYear = emp.hireDate ? new Date(emp.hireDate).getFullYear() : null;
              const hireMonth = emp.hireDate ? new Date(emp.hireDate).getMonth() + 1 : 1; // 1-12
              const firstMonth = hireYear === prevYear ? hireMonth : 1;
              const expectedMonths = 12 - firstMonth + 1;
              if (monthSnapshots.length < expectedMonths) continue; // Not all expected months closed yet

              const yearWorked = monthSnapshots.reduce((s, m) => s + m.workedMinutes, 0);
              const yearExpected = monthSnapshots.reduce((s, m) => s + m.expectedMinutes, 0);
              const yearBalance = monthSnapshots.reduce((s, m) => s + m.balanceMinutes, 0);
              const decSnapshot = monthSnapshots[monthSnapshots.length - 1];
              const finalCarryOver = decSnapshot.carryOver;

              // Apply carry-over rules
              const mode = tenant.config?.overtimeCarryOverMode ?? "FULL";
              const cap = tenant.config?.overtimeCarryOverCap;
              let appliedCarryOver = finalCarryOver;
              if (mode === "RESET") {
                appliedCarryOver = 0;
              } else if (mode === "CAPPED" && cap != null && finalCarryOver > cap) {
                appliedCarryOver = cap;
              }

              // PERF-V1814-02: saldoSnapshot.create + overtimeAccount.upsert in ONE $transaction.
              // A crash between snapshot commit and balance upsert can no longer leave stale data
              // (previously there was NO transaction at all around these two writes).
              await app.prisma.$transaction(async (tx) => {
                await tx.saldoSnapshot.create({
                  data: {
                    employeeId: emp.id,
                    periodType: "YEARLY",
                    periodStart: yearStart,
                    periodEnd: yearEnd,
                    workedMinutes: yearWorked,
                    expectedMinutes: yearExpected,
                    balanceMinutes: yearBalance,
                    carryOver: appliedCarryOver,
                    closedAt: new Date(),
                    closedBy: null,
                    note:
                      mode === "RESET"
                        ? "Automatischer Jahresübertrag: Reset auf 0"
                        : mode === "CAPPED" && cap != null && finalCarryOver > cap
                          ? `Automatischer Jahresübertrag: gedeckelt auf ${Math.round(cap / 60)}h`
                          : `Automatischer Jahresübertrag: ${Math.round(appliedCarryOver / 60)}h`,
                  },
                });

                await tx.overtimeAccount.upsert({
                  where: { employeeId: emp.id },
                  create: { employeeId: emp.id, balanceHours: appliedCarryOver / 60 },
                  update: { balanceHours: appliedCarryOver / 60 },
                });
              });

              await app.audit({
                userId: undefined,
                action: "CREATE",
                entity: "SaldoSnapshot",
                entityId: emp.id,
                newValue: {
                  origin: "SYSTEM",
                  employeeId: emp.id,
                  periodType: "YEARLY",
                  year: prevYear,
                  mode,
                  originalCarryOver: finalCarryOver,
                  appliedCarryOver,
                  auto: true,
                },
              });

              app.log.info(
                `Auto-Jahresabschluss: ${emp.firstName} ${emp.lastName} — ${prevYear} abgeschlossen (Übertrag: ${Math.round(appliedCarryOver / 60)}h)`,
              );
            } catch (err) {
              app.log.error({ err, employeeId: emp.id }, "Auto-Jahresabschluss: Fehler");
            }
          }
        }

        // Notify managers about missing entries (from gap-blocked months in the backfill loop)
        if (missing.length > 0) {
          const lines = missing.map((m) => {
            const name = `${m.employee.firstName} ${m.employee.lastName}`;
            const dates = m.missingDates
              .map((d) =>
                new Date(d).toLocaleDateString("de-DE", {
                  day: "2-digit",
                  month: "2-digit",
                }),
              )
              .join(", ");
            return `${name} (${m.month}/${m.year}): ${dates}`;
          });

          const monthName = new Date(
            `${prevYear}-${String(prevMonth).padStart(2, "0")}-15`,
          ).toLocaleDateString("de-DE", { month: "long", year: "numeric" });

          for (const mgr of managers) {
            await app.notify({
              userId: mgr.user.id,
              type: "MONTH_CLOSE_BLOCKED",
              title: `Monatsabschluss ${monthName} nicht möglich`,
              message: `Fehlende Zeiteinträge:\n${lines.join("\n")}`,
              link: "/admin/month-close",
            });
          }

          app.log.info(
            `Auto-Monatsabschluss: Tenant ${tenant.name} — ${missing.length} MA mit fehlenden Einträgen`,
          );
        } else {
          app.log.info(
            `Auto-Monatsabschluss: Tenant ${tenant.name} — Backfill-Durchlauf abgeschlossen`,
          );
        }
      } catch (err) {
        // D-04: one tenant's failure logs (audit-traceable) and continues — it must
        // not abort the Monatsabschluss run for every subsequent tenant.
        app.log.error(
          { err, tenant: tenant.id },
          "Auto-Monatsabschluss: Tenant fehlgeschlagen, fahre fort",
        );
        continue;
      }
    }
  }

  // Phase 66 (DEBT-01): expose tryAutoCloseMonth as a Fastify decorator so the
  // D-11 grace-period guard test can invoke it directly. Previously the test
  // intercepted `cron.schedule("0 6 * * *", ...)`, but `carryoverWarningPlugin`
  // registers the SAME cron expression (in its `onReady` hook, which runs after
  // plugin registration) and overwrote the captured callback — the test then
  // exercised the carryover-warning path instead of the auto-close path.
  // The cron registration below is unchanged: production behavior is identical.
  app.decorate("tryAutoCloseMonth", tryAutoCloseMonth);

  // Run daily at 06:00 Berlin time. Leader-locked so only one replica runs the
  // Monatsabschluss per window; noOverlap skips a tick if the previous run is still active.
  const task = cron.schedule(
    "0 6 * * *",
    () => {
      withAdvisoryLock(
        app.prisma,
        ADVISORY_LOCK_KEYS.AUTO_CLOSE_MONTH,
        () => tryAutoCloseMonth(),
        app.log,
      ).catch((err) => app.log.error({ err }, "Auto-Monatsabschluss fehlgeschlagen"));
    },
    { timezone: "Europe/Berlin", noOverlap: true },
  );
  tasks.push(task);
  app.log.info("Auto-Monatsabschluss: Tägliche Prüfung geplant (06:00)");

  app.addHook("onClose", () => {
    tasks.forEach((t) => void t.stop());
  });
});
