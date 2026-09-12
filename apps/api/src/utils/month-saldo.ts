/**
 * month-saldo.ts
 *
 * Compute the §615-consistent monthly saldo for a single employee, plus a
 * per-day cumulative Gesamtsaldo series.  Used by the new
 * GET /api/v1/overtime/month-saldo/:employeeId endpoint and the Team-Zeiten
 * / Meine Zeiteinträge calendar headers.
 *
 * §615 model: balance = worked − contract_expected, where contract_expected
 * for SHIFT_BASED is the roster-prorated Vertrags-Soll (NOT the roster itself).
 * This is exactly what closeEmployeeMonth() computes.  We must NOT replicate
 * the §615 formula here — we just call the core and surface its result.
 *
 * Closed month: a non-superseded MONTHLY SaldoSnapshot for this period exists.
 *   → Return snapshot values verbatim (Revisionssicherheit).
 *   → days[] is a single terminal entry with cumulativeSaldoMinutes = snapshot.carryOver.
 *
 * Open month: compute via closeEmployeeMonth() with the SAME prefetch pattern
 * as the manual-close path in overtime.ts (lines 908–1075).  For the per-day
 * series, call closeEmployeeMonth() once per day D with monthLastDay = D,
 * reusing the pre-fetched collections.
 *
 * Purity: no audit trail here (read-only endpoint, no mutation).
 * Tenant isolation: CALLER enforces (endpoint verifies employee.tenantId).
 */

import type { FastifyInstance } from "fastify";
import { getTenantTimezone, dateStrInTz, monthRangeUtc, monthDayBounds } from "./timezone";
import { getHolidays, STATE_MAP } from "./holidays";
import { getCarryOverBase } from "./carry-over-base"; // Phase 99 (OB-02) — shared chain-head seed
import { closeEmployeeMonth } from "./close-employee-month";
import { loadBsSlotOverrides } from "./load-bs-slot-overrides";
import { getEffectiveBreakDuration } from "./break-effective";

// ── Public types ──────────────────────────────────────────────────────────────

export type MonthSaldoDay = {
  /** YYYY-MM-DD in tenant timezone */
  date: string;
  /** carryOverIn + balanceMinutes for days 1..D (§615, from closeEmployeeMonth) */
  cumulativeSaldoMinutes: number;
};

export type MonthSaldoResult = {
  workedMinutes: number;
  expectedMinutes: number;
  balanceMinutes: number;
  /** true when a non-superseded MONTHLY SaldoSnapshot exists for this period */
  closed: boolean;
  /** Phase 97-05 (SALDO-DISP-07) — SHIFT_BASED open months only: true when every EXISTING
   *  shift for the remainder of the month already lies in the past (the roster itself is
   *  incomplete, not merely open). Undefined — never a fabricated `false` — for every other
   *  schedule type, for closed months, and for the zeroed early returns (missing employee,
   *  exempt, no schedule). */
  rosterIncomplete?: boolean;
  /** Phase 125 (issue #125, D-02/D-03) — distinct days in
   *  [month-start-or-hireDate, to-date cutoff] with credited worked minutes > 0, taken from the
   *  SAME `closeEmployeeMonth` to-date result that produced `workedMinutes` above. The
   *  "up to and including today" clamping is therefore the core's own `effectiveEnd`, not a
   *  second derivation.
   *
   *  ABSENT — never a fabricated 0 — for a CLOSED month and for the three zeroed early returns.
   *  A SaldoSnapshot stores no day count and D-07 forbids adding a column, so for a closed month
   *  the honest answer is "not known here", exactly as `rosterIncomplete` above is undefined
   *  rather than false where it cannot be known. Consumers must render nothing in that case. */
  workedDays?: number;
  days: MonthSaldoDay[];
};

// ── Main function ─────────────────────────────────────────────────────────────

/**
 * Compute the §615-based monthly saldo for one employee.
 *
 * Caller MUST verify tenant isolation before calling this function:
 *   employee.tenantId === req.user.tenantId
 *
 * @param app        - Fastify instance (access to prisma, log)
 * @param employeeId - employee to compute for
 * @param year       - calendar year (e.g. 2026)
 * @param month      - 1-based month (1=January)
 */
export async function computeMonthSaldo(
  app: FastifyInstance,
  employeeId: string,
  year: number,
  month: number,
): Promise<MonthSaldoResult> {
  // ── Resolve timezone + month bounds ──────────────────────────────────────
  const employee = await app.prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      tenantId: true,
      hireDate: true,
      exitDate: true,
      isTimeTrackingExempt: true,
      breakOver6hOverride: true,
      breakOver9hOverride: true,
      tenant: { select: { federalState: true } },
    },
  });
  if (!employee) {
    return { workedMinutes: 0, expectedMinutes: 0, balanceMinutes: 0, closed: false, days: [] };
  }
  if (employee.isTimeTrackingExempt) {
    return { workedMinutes: 0, expectedMinutes: 0, balanceMinutes: 0, closed: false, days: [] };
  }

  const tz = await getTenantTimezone(app.prisma, employee.tenantId);
  const { start: monthStart, end: monthEnd } = monthRangeUtc(year, month, tz);
  const { firstDay: monthFirstDay, lastDay: monthLastDay } = monthDayBounds(
    monthStart,
    monthEnd,
    tz,
  );

  // ── Check for closed month (non-superseded MONTHLY snapshot) ─────────────
  const snapshot = await app.prisma.saldoSnapshot.findFirst({
    where: {
      employeeId,
      periodType: "MONTHLY",
      periodStart: monthStart,
      superseded: false,
    },
  });

  if (snapshot) {
    // Revisionssicherheit: return snapshot verbatim.
    // days[] has a single terminal entry whose cumulativeSaldoMinutes = carryOver
    // (the carry-over into the next month, i.e. snapshotCarryOver + balance).
    const lastDayStr = dateStrInTz(monthLastDay, tz);
    return {
      workedMinutes: snapshot.workedMinutes,
      expectedMinutes: snapshot.expectedMinutes,
      balanceMinutes: snapshot.balanceMinutes,
      closed: true,
      days: [{ date: lastDayStr, cumulativeSaldoMinutes: snapshot.carryOver }],
    };
  }

  // ── Open month: full prefetch (mirrors overtime.ts P1 caller) ────────────

  // Effective employment span for this month
  const hireDateNorm = new Date(dateStrInTz(employee.hireDate, tz) + "T00:00:00Z");
  const effectiveStart = hireDateNorm > monthFirstDay ? hireDateNorm : monthFirstDay;

  const tenantConfig = await app.prisma.tenantConfig.findUnique({
    where: { tenantId: employee.tenantId },
  });

  const stateCode = employee.tenant ? (STATE_MAP[employee.tenant.federalState] ?? "NI") : "NI";

  // Holiday set: computed Feiertage + DB manual holidays for this month
  const computedHolidays = getHolidays(year, stateCode).filter(
    (h) => h.date >= dateStrInTz(effectiveStart, tz) && h.date <= dateStrInTz(monthEnd, tz),
  );
  const dbHolidays = await app.prisma.publicHoliday.findMany({
    where: {
      tenant: { employees: { some: { id: employeeId } } },
      date: { gte: effectiveStart, lte: monthLastDay },
    },
  });
  const computedHolidaySet = new Set<string>(computedHolidays.map((h) => h.date));
  const holidayDateStrings = new Set<string>([
    ...computedHolidays.map((h) => h.date),
    ...dbHolidays
      .filter((h) => !computedHolidaySet.has(dateStrInTz(h.date, tz)))
      .map((h) => dateStrInTz(h.date, tz)),
  ]);

  // Effective schedule
  const schedule = await app.prisma.workSchedule.findFirst({
    where: { employeeId, validFrom: { lte: monthEnd } },
    orderBy: { validFrom: "desc" },
  });
  if (!schedule) {
    return { workedMinutes: 0, expectedMinutes: 0, balanceMinutes: 0, closed: false, days: [] };
  }
  const scheduleType = String(schedule.type ?? "");

  // Pre-fetch all collections (mirroring overtime.ts lines 943–995)
  const [closeEntries, closeShifts, closeApprovedLeave, closeAbsences] = await Promise.all([
    app.prisma.timeEntry.findMany({
      where: {
        employeeId,
        deletedAt: null,
        date: { gte: effectiveStart, lte: monthLastDay },
        endTime: { not: null },
        type: "WORK",
        isInvalid: false,
      },
      select: { date: true, startTime: true, endTime: true, breakMinutes: true },
    }),
    app.prisma.shift.findMany({
      where: {
        employeeId,
        date: { gte: effectiveStart, lte: monthLastDay },
        deletedAt: null,
      },
      select: { date: true, startTime: true, endTime: true },
    }),
    app.prisma.leaveRequest.findMany({
      where: {
        employeeId,
        deletedAt: null,
        status: "APPROVED",
        startDate: { lte: monthEnd },
        endDate: { gte: monthStart },
      },
      select: { startDate: true, endDate: true, halfDay: true },
    }),
    app.prisma.absence.findMany({
      where: {
        employeeId,
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

  // Previous month carry-over (last non-superseded MONTHLY snapshot before monthStart)
  const prevSnapshot = await app.prisma.saldoSnapshot.findFirst({
    where: {
      employeeId,
      periodType: "MONTHLY",
      periodStart: { lt: monthStart },
      superseded: false,
    },
    orderBy: { periodStart: "desc" },
  });
  // Phase 99 (OB-02) — chain-head seeds resolve through the one shared helper;
  // identical to `?? 0` when the employee has no OpeningBalance.
  const carryOverIn = await getCarryOverBase(app.prisma, employeeId, prevSnapshot);

  // BS slot overrides for this month
  const { employeeSlots, patternSlots, patternUnterrichtsMinutenByDow } = await loadBsSlotOverrides(
    app.prisma,
    employeeId,
    monthFirstDay,
  );

  // Shared tenantConfig shape for closeEmployeeMonth
  const tenantCfg = tenantConfig
    ? {
        defaultBreakOver6h: tenantConfig.defaultBreakOver6h,
        defaultBreakOver9h: tenantConfig.defaultBreakOver9h,
        monthlyHoursHolidayDeduction: tenantConfig.monthlyHoursHolidayDeduction ?? undefined,
        vocationalSchoolMinutesPerDay: tenantConfig.vocationalSchoolMinutesPerDay ?? undefined,
        vocationalSchoolBlockMinutesPerWeek:
          tenantConfig.vocationalSchoolBlockMinutesPerWeek ?? undefined,
        bsSlotFirstLongDayMinutes: tenantConfig.bsSlotFirstLongDayMinutes ?? undefined,
        bsSlotSecondLongDayMinutes: tenantConfig.bsSlotSecondLongDayMinutes ?? undefined,
        bsSlotShortDayMinutes: tenantConfig.bsSlotShortDayMinutes ?? undefined,
        bsSlotBlockWeekMinutes: tenantConfig.bsSlotBlockWeekMinutes ?? undefined,
      }
    : null;

  // Shared input base
  const sharedInput = {
    employeeId,
    monthStart,
    monthEnd,
    monthFirstDay,
    tz,
    carryOverIn,
    schedule: schedule as Record<string, unknown>,
    hireDate: employee.hireDate,
    exitDate: employee.exitDate ?? null,
    isTimeTrackingExempt: false as const,
    breakOver6hOverride: employee.breakOver6hOverride ?? null,
    breakOver9hOverride: employee.breakOver9hOverride ?? null,
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
      halfDay: Boolean(ab.halfDay),
      unterrichtsMinutes: ab.unterrichtsMinutes ?? null,
    })),
    holidayDateStrings,
    tenantConfig: tenantCfg,
    employeeSlots,
    patternSlots,
    patternUnterrichtsMinutenByDow,
  };

  // ── Per-day cumulative series ─────────────────────────────────────────────
  // For SHIFT_BASED we need rosterProration per day.  Pre-compute the helper
  // functions here (same as time-entries.ts updateOvertimeAccount partial-month block).
  //
  // Header numbers (workedMinutes / expectedMinutes / balanceMinutes) are derived from the
  // LAST included day's partial (to-date) result — NOT a separate full-month call. This makes
  // the header the SAME §615 to-date state the cells display (single source of truth: header
  // ↔ cells can never diverge). For the open month the last-day result is roster-prorated
  // (SHIFT_BASED) so the header shows the "bisher" (to-date) Soll/Saldo, not the inflated
  // full-month roster charged as undertime (Bug 3).
  const days: MonthSaldoDay[] = [];

  // Iterate only days from effectiveStart to today-or-monthLastDay.
  // Bug 1 fix: only include TODAY when the employee has completed entries for today —
  // mirroring updateOvertimeAccount's hasTodayEntries cutoff (time-entries.ts). Otherwise
  // a SHIFT_BASED employee with a shift today but no entry yet would have today's full shift
  // charged as §615 undertime, showing a spurious "future penalty" on today's cell.
  const todayStr = dateStrInTz(new Date(), tz);
  const yesterdayStr = dateStrInTz(new Date(Date.now() - 86400000), tz);
  const hasTodayEntries = closeEntries.some((e) => dateStrInTz(e.date, tz) === todayStr);
  const cutoffStr = hasTodayEntries ? todayStr : yesterdayStr;
  const windowEnd =
    cutoffStr < dateStrInTz(monthLastDay, tz) ? cutoffStr : dateStrInTz(monthLastDay, tz);

  // Pre-compute SHIFT_BASED netto helpers (reused per day)
  const employeeBreakShape = {
    breakOver6hOverride: employee.breakOver6hOverride ?? null,
    breakOver9hOverride: employee.breakOver9hOverride ?? null,
  };
  const tenantBreakShape = {
    defaultBreakOver6h: tenantConfig?.defaultBreakOver6h ?? 30,
    defaultBreakOver9h: tenantConfig?.defaultBreakOver9h ?? 45,
  };
  const hmToMin = (hm: string): number => {
    const [h, m] = hm.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };

  // Walk each calendar day D from month-start (or hireDate if later) through windowEnd
  const startStr = dateStrInTz(effectiveStart, tz);
  const monthLastStr = dateStrInTz(monthLastDay, tz);

  // Build a list of day strings to iterate
  const dayStrings: string[] = [];
  {
    const cur = new Date(startStr + "T00:00:00Z");
    const endDate = new Date(windowEnd + "T00:00:00Z");
    const lastDate = new Date(monthLastStr + "T00:00:00Z");
    const cap = endDate < lastDate ? endDate : lastDate;
    while (cur <= cap) {
      dayStrings.push(dateStrInTz(cur, tz));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
  }

  // Track the LAST included day's partial result — this is the to-date §615 state the header
  // displays (single source of truth with the cells).
  let lastDayResult: ReturnType<typeof closeEmployeeMonth> | null = null;
  // Phase 97-05 (SALDO-DISP-07): capture the last iteration's rosterProration + day string
  // alongside lastDayResult — both already exist in memory at that point, so the
  // rosterIncomplete computation below adds no query and no third roster summation.
  let lastRosterProration: { rosterToDateMinutes: number; rosterPeriodMinutes: number } | undefined;
  let lastDayStr: string | undefined;

  for (const dayStr of dayStrings) {
    const dayEnd = new Date(dayStr + "T00:00:00Z");

    // For SHIFT_BASED: compute rosterProration up to this day
    let rosterProration: { rosterToDateMinutes: number; rosterPeriodMinutes: number } | undefined;
    if (scheduleType === "SHIFT_BASED") {
      // coveredDates: leave + absence days that are not shift-days (same logic as time-entries.ts)
      const buildCovered = (fromD: Date, toD: Date): Set<string> => {
        const set = new Set<string>();
        const addRange = (s: Date, e: Date) => {
          const start = s < fromD ? fromD : s;
          const end = e > toD ? toD : e;
          const cur = new Date(start);
          while (cur <= end) {
            set.add(dateStrInTz(cur, tz));
            cur.setUTCDate(cur.getUTCDate() + 1);
          }
        };
        for (const lr of closeApprovedLeave) addRange(lr.startDate, lr.endDate);
        for (const ab of closeAbsences) addRange(ab.startDate, ab.endDate);
        return set;
      };
      const coveredToDate = buildCovered(effectiveStart, dayEnd);
      const monthCovered = buildCovered(monthStart, monthEnd);

      const sumShiftNetto = (
        list: { date: Date; startTime: string; endTime: string }[],
        covered: Set<string>,
      ): number => {
        let total = 0;
        for (const sh of list) {
          const ds = dateStrInTz(sh.date, tz);
          if (covered.has(ds)) continue;
          let brutto = hmToMin(sh.endTime) - hmToMin(sh.startTime);
          if (brutto < 0) brutto += 24 * 60;
          if (brutto <= 0) continue;
          const breakMin = getEffectiveBreakDuration(employeeBreakShape, tenantBreakShape, brutto);
          total += Math.max(0, brutto - breakMin);
        }
        return total;
      };
      const shiftsToDate = closeShifts.filter((s) => s.date >= monthFirstDay && s.date <= dayEnd);
      const allMonthShifts = closeShifts.filter(
        (s) => s.date >= monthFirstDay && s.date <= monthLastDay,
      );
      rosterProration = {
        rosterToDateMinutes: sumShiftNetto(shiftsToDate, coveredToDate),
        rosterPeriodMinutes: sumShiftNetto(allMonthShifts, monthCovered),
      };
    }

    // Filter entries/shifts to [effectiveStart, dayEnd]
    const dayEntries = closeEntries.filter((e) => e.date >= effectiveStart && e.date <= dayEnd);
    const dayShifts = closeShifts.filter((s) => s.date >= monthFirstDay && s.date <= dayEnd);

    // Window-filtered holiday set (partial window only)
    const partialHolidaySet = new Set(
      [...holidayDateStrings].filter((d) => d >= startStr && d <= dayStr),
    );

    // For SHIFT_BASED: monthEnd = full-month end (C_net). For non-SHIFT: monthEnd = dayEnd.
    const partialMonthEnd = scheduleType === "SHIFT_BASED" ? monthEnd : dayEnd;

    const dayResult = closeEmployeeMonth({
      ...sharedInput,
      monthEnd: partialMonthEnd,
      monthLastDay: dayEnd,
      entries: dayEntries.map((e) => ({
        date: e.date,
        startTime: e.startTime,
        endTime: e.endTime!,
        breakMinutes: e.breakMinutes,
      })),
      shifts: dayShifts.map((sh) => ({
        date: sh.date,
        startTime: sh.startTime,
        endTime: sh.endTime,
      })),
      holidayDateStrings: partialHolidaySet,
      rosterProration,
    });

    days.push({
      date: dayStr,
      cumulativeSaldoMinutes: carryOverIn + dayResult.balanceMinutes,
    });

    lastDayResult = dayResult;
    lastRosterProration = rosterProration;
    lastDayStr = dayStr;
  }

  // Phase 97-05 (SALDO-DISP-07): the remainder of the month is unrostered when every EXISTING
  // shift already lies in the past (the last iterated day consumed the entire known roster)
  // while the month still has days remaining. The `rosterPeriodMinutes > 0` guard is
  // load-bearing: without it the pre-existing "nothing rostered at all" zero-state (guarded
  // separately in shift-based-saldo.ts, contribution 0) would collide with this state because
  // 0 === 0. Undefined — never a fabricated `false` — for every non-SHIFT_BASED schedule and
  // whenever no day was iterated at all (e.g. employee hired after windowEnd, or an all-future
  // window).
  //
  // WR-01 (code review) — "days remaining" is anchored to `todayStr` (literal calendar today,
  // already computed above), NOT `lastDayStr` (the day loop's own cursor, today-or-yesterday
  // depending on whether today has a completed entry yet). This was previously anchored to
  // `lastDayStr` on the reasoning that it's "the same to-date cursor the header/cells already
  // use" — correct in isolation, but it silently disagreed with computeOvertimeBalanceBreakdown's
  // sibling flag (time-entries.ts), which has always anchored to `todayStr`, on exactly one
  // window: today is the LAST calendar day of the month and has no entry logged yet (so
  // lastDayStr = yesterday, one day short of month-end, while todayStr already IS month-end).
  // Both flags now anchor to `todayStr` — the flag answers "is there still unplanned roster
  // ahead of *now*", which does not depend on whether today's own entry happens to be logged
  // yet. See overtime-live-vs-monthsaldo-parity.test.ts's "WR-01" describe block for the
  // regression case this anchor choice is pinned against.
  const rosterIncomplete: boolean | undefined =
    scheduleType === "SHIFT_BASED" && lastRosterProration !== undefined && lastDayStr !== undefined
      ? lastRosterProration.rosterPeriodMinutes > 0 &&
        lastRosterProration.rosterToDateMinutes === lastRosterProration.rosterPeriodMinutes &&
        todayStr < monthLastStr
      : undefined;

  // Header numbers = last included day's to-date §615 state (single source of truth with cells).
  // If no days were included (e.g. employee hired after windowEnd, or an all-future window),
  // fall back to a zeroed to-date state — the terminal cumulative is just carryOverIn.
  return {
    workedMinutes: lastDayResult?.workedMinutes ?? 0,
    expectedMinutes: lastDayResult?.expectedMinutes ?? 0,
    balanceMinutes: lastDayResult?.balanceMinutes ?? 0,
    closed: false,
    rosterIncomplete,
    workedDays: lastDayResult?.workedDays ?? 0,
    days,
  };
}
