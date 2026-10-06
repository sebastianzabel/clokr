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
import { holidaysAtWorkLocation } from "../platform"; // Phase 71b (issue #71) — central resolver
import { getCarryOverBase } from "./carry-over-base"; // Phase 99 (OB-02) — shared chain-head seed
import { getShiftsInRange } from "../scheduling"; // Phase 100B Plan 05 — S1
import {
  closeEmployeeMonth,
  toCloseMonthApprovedLeave,
  monthlyHoursMonthSollMinutes, // Issue #433 (D-11)
} from "./close-employee-month";
import {
  getValidWorkedEntriesInRange, // Phase 100B Plan 08 — T1; Phase 101B wave 8 merged in
  getWorkedEntriesInRange, // Phase 71b (issue #71) — T2, feeds the holiday resolver below
  getEffectiveBreakDuration,
  addWorkingMinutes, // Phase 79 (Issue #79), D-12 — fold step
} from "../time-tracking";
import {
  getAbsencesOverlapping, // Phase 100B Plan 12 — A4
  getActiveLeaveOverlapping, // Phase 100B Plan 13 — A2; Issue #446 — effective leave
  loadBsSlotOverrides,
} from "../absence"; // Phase 101B (Issue #101, wave 7) — merged from two deep imports

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
   *  "up to yesterday" clamping (issue #438: today never counts) is therefore the core's own
   *  `effectiveEnd`, not a second derivation.
   *
   *  ABSENT — never a fabricated 0 — for a CLOSED month and for the three zeroed early returns.
   *  A SaldoSnapshot stores no day count and D-07 forbids adding a column, so for a closed month
   *  the honest answer is "not known here", exactly as `rosterIncomplete` above is undefined
   *  rather than false where it cannot be known. Consumers must render nothing in that case. */
  workedDays?: number;
  /**
   * Issue #433 (D-11) — MONTHLY_HOURS with `monthlyHours > 0` only: the FULL calendar month's
   * net Soll (holiday/leave/absence already folded in), from the SAME
   * `monthlyHoursMonthSollMinutes` call the dashboard tile and the monthly report use — so the
   * calendar header can never show a different number than they do.
   *
   * Closed month: the stored snapshot's `expectedMinutes`, verbatim (Revisionssicherheit) — a
   * closed month is never recomputed, D-12. Open month: computed once over the full calendar
   * month from the SAME prefetched collections (`sharedInput`) the per-day series below already
   * builds, with `monthLastDay` set to the month's actual last day (not the to-date cursor).
   *
   * ABSENT — never a fabricated 0 — for every other schedule type, for pure tracking
   * (`monthlyHours` null/0), and for the three zeroed early returns (missing employee, exempt,
   * no schedule). Same convention as `rosterIncomplete` / `workedDays` above.
   */
  monthSollMinutes?: number;
  /**
   * Issue #451 (D-03) — OPEN months of a non-SHIFT_BASED schedule only: the FULL calendar
   * month's §615 state (`closeEmployeeMonth` over `monthStart`..`monthLastDay`, the month's OWN
   * end, never the to-date cursor), computed once from the SAME prefetched collections
   * (`sharedInput`) the per-day series above already builds — no second query. `workedMinutes`
   * is still clamped to entries recorded through yesterday (issue #438: today never counts), so
   * it reflects only what has actually happened; `expectedMinutes`/`balanceMinutes` already fold
   * in the WHOLE month's holidays/leave/absence, giving the monthly report's Stundennachweis
   * model its whole-month Soll even while the month is still running (planner decision P-03).
   *
   * ABSENT — never a fabricated value — for SHIFT_BASED (the running month must show the
   * roster-to-date state the header already carries, never the not-yet-worked full roster,
   * issue #438 Bug 3) and for a CLOSED month (the snapshot is the only truth, D-12). Same
   * "absent, never fabricated" convention as `monthSollMinutes` / `workedDays` above.
   */
  fullMonth?: { workedMinutes: number; expectedMinutes: number; balanceMinutes: number };
  days: MonthSaldoDay[];
};

/**
 * Issue #451 (D-03) — ONE Soll/Ist/Überstunden result for the monthly report (JSON + both PDFs),
 * sourced exclusively from the working-time-account's own month result: the SaldoSnapshot for a
 * closed month (verbatim, Revisionssicherheit — never recomputed), `MonthSaldoResult.fullMonth`
 * for an open non-SHIFT_BASED month (the whole month's Stundennachweis Soll, Ist capped to
 * yesterday — planner decision P-03), or the saldo core's to-date header for an open SHIFT_BASED
 * month (never the not-yet-worked roster, issue #438 Bug 3). `reports.ts` reads only this
 * function — see its own module comment for why it computes no Soll of its own any more.
 *
 * `balanceAdjustmentMinutes` is `balanceMinutes - (workedMinutes - expectedMinutes)`: the
 * Überstundenausgleich withdrawal and any other non-additive § 615 adjustment `closeEmployeeMonth`
 * folds into `balanceMinutes` without changing `workedMinutes`/`expectedMinutes` themselves (see
 * `close-employee-month.ts`'s own `overtimeCompensationMinutes` doc block) — 0 for every
 * unlabelled result.
 *
 * `labelled: false` only for: `isTimeTrackingExempt`, no `WorkSchedule` valid at the month's end,
 * or MONTHLY_HOURS with `monthlyHours` null/0 (pure tracking, D-01) — never a fabricated Soll of
 * 0 for a population that genuinely has none. `workedMinutes` is still reported for an unlabelled
 * employee (the sum of their valid worked entries that month, via the T1 facade) so the report's
 * Ist column is never blank just because there is no Soll to compare it against.
 *
 * Read-only: no write, ever (T-451-07 — closed months are legal record).
 */
export type MonthReportFigures = {
  workedMinutes: number;
  expectedMinutes: number;
  balanceMinutes: number;
  balanceAdjustmentMinutes: number;
  /** true only for the CLOSED-month branch (the one figure that is final). */
  confirmed: boolean;
  /** false only for the three unlabelled populations above. */
  labelled: boolean;
  basis: "snapshot" | "fullMonth" | "toDate" | "untracked";
};

export async function computeMonthReportFigures(
  app: FastifyInstance,
  employeeId: string,
  year: number,
  month: number,
): Promise<MonthReportFigures> {
  const unlabelled = (workedMinutes: number): MonthReportFigures => ({
    workedMinutes,
    expectedMinutes: 0,
    balanceMinutes: 0,
    balanceAdjustmentMinutes: 0,
    confirmed: false,
    labelled: false,
    basis: "untracked",
  });

  const employee = await app.prisma.employee.findUnique({
    where: { id: employeeId },
    select: { tenantId: true, isTimeTrackingExempt: true },
  });
  if (!employee || employee.isTimeTrackingExempt) {
    return unlabelled(0);
  }

  const tz = await getTenantTimezone(app.prisma, employee.tenantId);
  const { start: monthStart, end: monthEnd } = monthRangeUtc(year, month, tz);

  // Same eligibility rule as computeMonthSaldo's OPEN path: the schedule valid at the reported
  // month's end — NOT the employee's schedule today, which can differ for a past month.
  const schedule = await app.prisma.workSchedule.findFirst({
    where: { employeeId, validFrom: { lte: monthEnd } },
    orderBy: { validFrom: "desc" },
  });
  const scheduleType = String(schedule?.type ?? "");
  const isUntrackedMonthlyHours =
    scheduleType === "MONTHLY_HOURS" && !(Number(schedule?.monthlyHours ?? 0) > 0);

  if (!schedule || isUntrackedMonthlyHours) {
    // Issue #493: the untracked Ist reads TimeEntry.date, a @db.Date column — the month instants
    // admitted the previous month's last day (prod Ist 5.58 h). Calendar-day bounds instead.
    const { firstDay: monthFirstDay, lastDay: monthLastDay } = monthDayBounds(
      monthStart,
      monthEnd,
      tz,
    );
    const entries = await getValidWorkedEntriesInRange(
      app.prisma,
      { kind: "employee", employeeId, tenantId: employee.tenantId },
      monthFirstDay,
      monthLastDay,
    );
    // T1 returns closed rows only, so the open-row branch (0 here, previously minus the break) is
    // unreachable — a harmonisation, not a behaviour change (Phase 79, D-03).
    const workedMinutes = entries.reduce((sum, e) => addWorkingMinutes(sum, e), 0);
    return unlabelled(Math.round(workedMinutes));
  }

  const ms = await computeMonthSaldo(app, employeeId, year, month);
  const basis: MonthReportFigures["basis"] = ms.closed
    ? "snapshot"
    : ms.fullMonth
      ? "fullMonth"
      : "toDate";
  const source = ms.closed || !ms.fullMonth ? ms : ms.fullMonth;
  const balanceAdjustmentMinutes =
    source.balanceMinutes - (source.workedMinutes - source.expectedMinutes);
  return {
    workedMinutes: source.workedMinutes,
    expectedMinutes: source.expectedMinutes,
    balanceMinutes: source.balanceMinutes,
    balanceAdjustmentMinutes,
    confirmed: ms.closed,
    labelled: true,
    basis,
  };
}

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
    // Issue #433 (D-11/D-12): fetched ONLY to decide whether `monthSollMinutes` is set on a
    // closed month — the snapshot's own stored values above are never recomputed or touched.
    const closedSchedule = await app.prisma.workSchedule.findFirst({
      where: { employeeId, validFrom: { lte: monthEnd } },
      orderBy: { validFrom: "desc" },
    });
    const closedIsMonthlyHours =
      String(closedSchedule?.type ?? "") === "MONTHLY_HOURS" &&
      Number(closedSchedule?.monthlyHours ?? 0) > 0;
    return {
      workedMinutes: snapshot.workedMinutes,
      expectedMinutes: snapshot.expectedMinutes,
      balanceMinutes: snapshot.balanceMinutes,
      closed: true,
      ...(closedIsMonthlyHours ? { monthSollMinutes: snapshot.expectedMinutes } : {}),
      days: [{ date: lastDayStr, cumulativeSaldoMinutes: snapshot.carryOver }],
    };
  }

  // ── Open month: full prefetch (mirrors overtime.ts P1 caller) ────────────

  // Effective employment span for this month
  const hireDateNorm = new Date(dateStrInTz(employee.hireDate, tz) + "T00:00:00Z");
  const effectiveStart = hireDateNorm > monthFirstDay ? hireDateNorm : monthFirstDay;
  // Issue #447 (D-13) — exit day normalized to tenant-TZ UTC midnight, or null. Used below to
  // end the SHIFT_BASED per-day roster proration at the exit date, mirroring the core's own
  // sollRangeEnd clip (closeEmployeeMonth.ts).
  const exitDateNorm = employee.exitDate
    ? new Date(dateStrInTz(employee.exitDate, tz) + "T00:00:00Z")
    : null;
  const exitDayStr = exitDateNorm ? dateStrInTz(exitDateNorm, tz) : null;

  const tenantConfig = await app.prisma.tenantConfig.findUnique({
    where: { tenantId: employee.tenantId },
  });

  // Phase 71b (issue #71) — holidays by work location per day (§ 2 EFZG), from the Unterbau's
  // central resolver instead of a single tenant-wide federal state. The entries passed are the
  // employee's own closed work entries (facade T2) — the Unterbau never reads them itself. The
  // resulting Set still feeds closeEmployeeMonth completely unchanged (D-08).
  const workLocationEntries = await getWorkedEntriesInRange(
    app.prisma,
    { kind: "employee", employeeId, tenantId: employee.tenantId },
    effectiveStart,
    monthLastDay,
  );
  const holidaysByEmployee = await holidaysAtWorkLocation(
    app.prisma,
    employee.tenantId,
    [employeeId],
    dateStrInTz(effectiveStart, tz),
    dateStrInTz(monthEnd, tz),
    workLocationEntries,
  );
  const holidayDateStrings = new Set<string>(holidaysByEmployee.get(employeeId)?.keys() ?? []);

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
    // Phase 100B Plan 08 — T1, contexts/time-tracking facade. THE SALDO INPUT.
    getValidWorkedEntriesInRange(
      app.prisma,
      { kind: "employee", employeeId, tenantId: employee.tenantId },
      effectiveStart,
      monthLastDay,
    ),
    getShiftsInRange(
      app.prisma,
      { kind: "employee", employeeId, tenantId: employee.tenantId },
      effectiveStart,
      monthLastDay,
    ),
    // Issue #446 (D-02) — effective leave (APPROVED + CANCELLATION_REQUESTED), contexts/absence facade. THE SALDO INPUT.
    getActiveLeaveOverlapping(
      app.prisma,
      { kind: "employee", employeeId, tenantId: employee.tenantId },
      monthStart,
      monthEnd,
    ),
    // Phase 100B Plan 12 — A4, contexts/absence facade. THE SALDO INPUT.
    getAbsencesOverlapping(
      app.prisma,
      { kind: "employee", employeeId, tenantId: employee.tenantId },
      effectiveStart,
      monthEnd,
    ),
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
        // Issue #429 (D-11) — contractWorkDaysPerWeekFrom()'s tenant fallback tier;
        // also the MONTHLY_HOURS workday tier (Issue #433, D-05).
        defaultWorkDays: tenantConfig.defaultWorkDays ?? undefined,
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
    // Issue #220: the shared mapper also derives isOvertimeCompensation from
    // LeaveType.code — never inline it, see toCloseMonthApprovedLeave's doc block.
    approvedLeave: toCloseMonthApprovedLeave(closeApprovedLeave),
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

  // Issue #433 (D-11) — the SAME full-month MONTHLY_HOURS Soll the dashboard tile and the
  // monthly report call, computed ONCE over the FULL calendar month (`monthLastDay`, not the
  // to-date cursor the per-day loop below uses) from the collections already prefetched above.
  // `null` (→ `undefined` here) for every other schedule type and for pure tracking
  // (`monthlyHours` null/0) — the wrapper itself tells the two apart, never a fabricated 0.
  const monthSollMinutes =
    monthlyHoursMonthSollMinutes({
      employeeId,
      schedule: schedule as Record<string, unknown>,
      monthStart,
      monthEnd,
      monthFirstDay,
      monthLastDay,
      tz,
      hireDate: employee.hireDate,
      exitDate: employee.exitDate ?? null,
      leave: closeApprovedLeave,
      absences: closeAbsences,
      holidayDateStrings,
      defaultWorkDays: tenantCfg?.defaultWorkDays,
    }) ?? undefined;

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

  // Iterate only days from effectiveStart through yesterday (never today) — the series and
  // header always end yesterday, the SAME window computeOvertimeBalanceBreakdown uses (issue
  // #438). A closed entry for today is not evidence the day is over: the clock resolver's
  // REOPEN branch (services/clock/resolver.ts:232-256, commit 446d4bb6) closes today's entry on
  // a lunch-break clock-out exactly like an end-of-day clock-out would, and a later clock-in
  // reopens it. Promoting the cutoff to today on that signal charged the full day's Soll
  // against only a partial Ist. A SHIFT_BASED employee with a shift today but no entry yet
  // similarly never has today's shift charged as §615 undertime — it is simply outside the
  // window.
  const todayStr = dateStrInTz(new Date(), tz);
  const yesterdayStr = dateStrInTz(new Date(Date.now() - 86400000), tz);
  const cutoffStr = yesterdayStr;
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
    // Issue #447 (D-13) — once this day is on or after the exit day, the month is COMPLETE for
    // the employee: no roster proration (rosterProration stays undefined), identical to the
    // close path (the core's own sollRangeEnd clips Soll to the exit date without any scaling).
    if (scheduleType === "SHIFT_BASED" && (exitDayStr === null || dayStr < exitDayStr)) {
      // Issue #447 (D-13) — the roster-period denominator (R_periodFull / allMonthShifts) ends
      // at the exit day when the exit falls inside this month, so a stray planned shift AFTER
      // the exit never inflates a contract period the employee will never work. shiftsToDate is
      // already bounded by dayEnd < exitDateNorm here (the outer condition above), so applying
      // the same cap to it is a no-op safety net, not a behavior change.
      const rosterPeriodCap =
        exitDateNorm !== null && exitDateNorm < monthLastDay ? exitDateNorm : monthLastDay;
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
      const shiftsToDate = closeShifts.filter(
        (s) =>
          s.date >= monthFirstDay &&
          s.date <= (dayEnd < rosterPeriodCap ? dayEnd : rosterPeriodCap),
      );
      const allMonthShifts = closeShifts.filter(
        (s) => s.date >= monthFirstDay && s.date <= rosterPeriodCap,
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
  // already computed above), NOT `lastDayStr` (the day loop's own cursor, always yesterday since
  // issue #438). This was previously anchored to `lastDayStr` on the reasoning that it's "the
  // same to-date cursor the header/cells already use" — correct in isolation, but it silently
  // disagreed with computeOvertimeBalanceBreakdown's sibling flag (overtime-balance.ts), which
  // has always anchored to `todayStr`, on exactly one window: today is the LAST calendar day of
  // the month (so lastDayStr = yesterday, one day short of month-end, while todayStr already IS
  // month-end). Both flags now anchor to `todayStr` — the flag answers "is there still unplanned
  // roster ahead of *now*", which does not depend on whether today's own entry happens to be
  // logged yet. See overtime-live-vs-monthsaldo-parity.test.ts's "WR-01" describe block for the
  // regression case this anchor choice is pinned against.
  const rosterIncomplete: boolean | undefined =
    scheduleType === "SHIFT_BASED" && lastRosterProration !== undefined && lastDayStr !== undefined
      ? lastRosterProration.rosterPeriodMinutes > 0 &&
        lastRosterProration.rosterToDateMinutes === lastRosterProration.rosterPeriodMinutes &&
        todayStr < monthLastStr
      : undefined;

  // Issue #451 (D-03) — the FULL calendar month's §615 state for non-SHIFT_BASED schedules only;
  // see this field's own doc comment above (MonthSaldoResult.fullMonth) for the rationale. Reuses
  // `sharedInput` (no new query): `monthLastDay` is the month's own end (not the to-date cursor),
  // `holidayDateStrings` is already the FULL unwindowed set (`sharedInput.holidayDateStrings`),
  // and only `entries` is re-filtered to the SAME `windowEnd` cutoff the per-day loop above uses
  // (today never counts, issue #438) — so `workedMinutes` still reflects only what has happened
  // while `expectedMinutes`/`balanceMinutes` fold in the whole month's reductions.
  let fullMonth:
    { workedMinutes: number; expectedMinutes: number; balanceMinutes: number } | undefined;
  if (scheduleType !== "SHIFT_BASED") {
    const fullMonthEntries = closeEntries.filter((e) => dateStrInTz(e.date, tz) <= windowEnd);
    const fullMonthResult = closeEmployeeMonth({
      ...sharedInput,
      monthLastDay,
      entries: fullMonthEntries.map((e) => ({
        date: e.date,
        startTime: e.startTime,
        endTime: e.endTime!,
        breakMinutes: e.breakMinutes,
      })),
    });
    fullMonth = {
      workedMinutes: fullMonthResult.workedMinutes,
      expectedMinutes: fullMonthResult.expectedMinutes,
      balanceMinutes: fullMonthResult.balanceMinutes,
    };
  }

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
    monthSollMinutes,
    fullMonth,
    days,
  };
}
