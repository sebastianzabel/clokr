/**
 * close-employee-month.ts
 *
 * Pure per-employee-per-month saldo core for the Monatsabschluss pipeline.
 *
 * PURITY CONTRACT:
 *   Pure function — no DB, no network, no side effects.
 *   Caller owns $transaction + app.audit(). All inputs are pre-fetched by the
 *   caller. Purity contract matches calcShiftBasedSaldo (shift-based-saldo.ts).
 *
 * SHIFT_BASED bsExpectedMinutes note (live-path gap):
 *   This function includes bsExpectedMinutes for SHIFT_BASED, matching manual
 *   close (P1, overtime.ts:963–989), cron close (P2, auto-close-month.ts:314–348),
 *   and retroactive recalc (P3, recalculate-snapshots.ts:404–437).
 *   The live path (updateOvertimeAccount, time-entries.ts) still lacks bsExpectedMinutes
 *   in its SHIFT_BASED branch — that is an EXISTING gap carried forward to SNAP-03
 *   (phase 76.27); this core does NOT change updateOvertimeAccount.
 *
 * exitDate convention (D-03):
 *   exitDate is INCLUSIVE — last working day, per vocational-school-generator.ts:320
 *   precedent. effectiveEnd = min(exitDate, monthLastDay).
 *   Caller must skip employees whose exitDate < monthFirstDay (they left before
 *   the month started); the core clamps defensively but returns empty results in
 *   that edge case.
 *
 * BS-doubling (pure inline computation):
 *   VOCATIONAL_SCHOOL absence dates are counted per ISO week from the provided
 *   absences array (no DB access). The same block-week cap logic from
 *   vocational-school-saldo.ts is reproduced inline: if ≥5 BS days in the same
 *   ISO week → distribute blockWeekly / N; otherwise use dailyDefault per day.
 *   tenantConfig.vocationalSchoolMinutesPerDay / vocationalSchoolBlockMinutesPerWeek
 *   configure the per-tenant caps (defaults: 480 / 2400 matching the DB @default values).
 *
 * References: RESEARCH.md §5.2, §2 (divergence table), §7 (helpers), §8 (patterns).
 */

import { findMissingWorkdays, type WorkdayGap } from "./find-missing-workdays";
import { calcShiftBasedSaldo } from "./shift-based-saldo";
import { getEffectiveBreakDuration } from "./break-effective";
import {
  calcExpectedMinutesTz,
  calcLeaveAbsenceMinutesTz,
  getDayHoursFromSchedule,
  getDayOfWeekInTz,
  dateStrInTz,
} from "./timezone";
import { BS_DAILY_DEFAULT_MIN, BS_BLOCK_WEEKLY_DEFAULT_MIN } from "./vocational-school-constants";

// ── Public types ──────────────────────────────────────────────────────────────

export type CloseMonthInput = {
  employeeId: string;
  // Month to close
  monthStart: Date; // from monthRangeUtc — UTC timestamp
  monthEnd: Date; // from monthRangeUtc — UTC timestamp
  monthFirstDay: Date; // from monthDayBounds — @db.Date floor
  monthLastDay: Date; // from monthDayBounds — @db.Date ceil
  tz: string;
  carryOverIn: number; // minutes — previous snapshot carryOver (0 if first month)

  // Pre-fetched employee/schedule data
  schedule: Record<string, unknown>;
  hireDate: Date;
  exitDate: Date | null; // CLOSE-04: null = still employed
  isTimeTrackingExempt: boolean; // must be false (caller verifies)
  breakOver6hOverride: number | null;
  breakOver9hOverride: number | null;

  // Pre-fetched collections (PERF: caller batches these)
  entries: Array<{
    // WORK entries, deletedAt=null, endTime!=null, isInvalid=false
    date: Date;
    startTime: Date;
    endTime: Date;
    breakMinutes: bigint | number;
  }>;
  shifts: Array<{
    // SHIFT_BASED: deletedAt=null
    date: Date;
    startTime: string;
    endTime: string;
  }>;
  approvedLeave: Array<{
    startDate: Date;
    endDate: Date;
    halfDay: boolean;
  }>;
  absences: Array<{
    startDate: Date;
    endDate: Date;
    type: string;
    source: string;
  }>;
  holidayDateStrings: Set<string>; // YYYY-MM-DD in tenant TZ

  // Tenant config
  tenantConfig: {
    defaultBreakOver6h: number;
    defaultBreakOver9h: number;
    monthlyHoursHolidayDeduction?: boolean;
    vocationalSchoolMinutesPerDay?: number | null;
    vocationalSchoolBlockMinutesPerWeek?: number | null;
  } | null;
};

export type CloseMonthResult = {
  // SaldoSnapshot field values (caller writes to DB)
  workedMinutes: number;
  expectedMinutes: number; // C_net for SHIFT_BASED; netExpected otherwise
  balanceMinutes: number; // D-01 two-clause for SHIFT_BASED; flat diff otherwise
  carryOverOut: number; // carryOverIn + balanceMinutes (before TRACK_ONLY zeroing)
  effectiveCarryOverOut: number; // 0 if TRACK_ONLY; else = carryOverOut
  snapshotExpectedMinutes: number; // = expectedMinutes for SHIFT_BASED; netExpected otherwise

  // Gap detection results (for warning UX in 76.28)
  gaps: WorkdayGap[];
  coveredDates: Set<string>;
};

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Pure per-employee-per-month saldo core.
 *
 * Produces byte-identical SaldoSnapshot values to today's manual close (P1,
 * overtime.ts), cron close (P2, auto-close-month.ts), and retroactive recalc
 * (P3, recalculate-snapshots.ts). The four-path parity assertion in
 * close-employee-month.test.ts is the primary regression gate.
 *
 * The function reconciles ALL divergences from RESEARCH.md §2:
 *   - SHIFT_BASED bsExpectedMinutes: INCLUDED (matching P1/P2/P3; live-path gap documented above)
 *   - exitDate handling: effectiveEnd = min(exitDate, monthLastDay) — CLOSE-04
 *   - General absence subtraction from netExpected: DONE for non-SHIFT, non-MONTHLY_HOURS
 *   - SHIFT_BASED leave credit excludeHolidays: NOT passed (consistent with all four paths)
 *   - snapshotExpectedMinutes sentinel: SHIFT_BASED → C_net, else → netExpected
 *
 * @see CloseMonthInput for parameter documentation.
 * @see RESEARCH.md §5.2 for the full specification this implements.
 */
export function closeEmployeeMonth(input: CloseMonthInput): CloseMonthResult {
  const {
    monthEnd,
    monthFirstDay,
    monthLastDay,
    tz,
    carryOverIn,
    schedule,
    hireDate,
    exitDate,
    breakOver6hOverride,
    breakOver9hOverride,
    entries,
    shifts,
    approvedLeave,
    absences,
    holidayDateStrings,
    tenantConfig,
  } = input;

  const scheduleType = String(schedule.type ?? "");

  // ── Step 1: Compute effectiveStart and effectiveEnd ───────────────────────
  //
  // effectiveStart = max(hireDate, monthFirstDay) — TZ-normalized.
  // effectiveEnd   = min(exitDate if within month, monthLastDay) — D-03.
  // exitDate is INCLUSIVE (last working day). If exitDate < monthFirstDay, the
  // caller should skip this employee; the core clamps defensively here.

  const hireDateNorm = new Date(dateStrInTz(hireDate, tz) + "T00:00:00Z");
  const effectiveStart = hireDateNorm > monthFirstDay ? hireDateNorm : monthFirstDay;

  let effectiveEnd = monthLastDay;
  if (exitDate !== null) {
    const exitDateNorm = new Date(dateStrInTz(exitDate, tz) + "T00:00:00Z");
    if (exitDateNorm < monthFirstDay) {
      // Employee left before this month — return zeroed result.
      return {
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOverOut: carryOverIn,
        effectiveCarryOverOut: carryOverIn,
        snapshotExpectedMinutes: 0,
        gaps: [],
        coveredDates: new Set<string>(),
      };
    }
    if (exitDateNorm < monthLastDay) {
      effectiveEnd = exitDateNorm;
    }
  }

  // ── Step 2: Compute entry dates set ──────────────────────────────────────
  //
  // Only entries within [effectiveStart, effectiveEnd] are relevant.
  // The entries array is pre-filtered by the caller (deletedAt=null, type=WORK,
  // isInvalid=false, endTime!=null). We apply the employment-span filter here.

  const entryDates = new Set<string>();
  for (const e of entries) {
    const ds = dateStrInTz(e.date, tz);
    if (ds >= dateStrInTz(effectiveStart, tz) && ds <= dateStrInTz(effectiveEnd, tz)) {
      entryDates.add(ds);
    }
  }

  // ── Step 3: Build rosterDates for SHIFT_BASED ────────────────────────────
  //
  // SHIFT_BASED: expected days = Shift.date set (not getDayHoursFromSchedule — pitfall A4 fix).
  // Non-SHIFT: rosterDates not needed (findMissingWorkdays uses getDayHoursFromSchedule).

  const rosterDates =
    scheduleType === "SHIFT_BASED"
      ? new Set(
          shifts
            .map((sh) => dateStrInTz(sh.date, tz))
            .filter(
              (ds) => ds >= dateStrInTz(effectiveStart, tz) && ds <= dateStrInTz(effectiveEnd, tz),
            ),
        )
      : undefined;

  // ── Step 4: Call findMissingWorkdays ONCE ────────────────────────────────
  //
  // Pitfall A1 fix: the returned coveredDates is REUSED by the SHIFT_BASED
  // roster-exclusion loop below — one covered-date computation, no drift.
  //
  // approvedLeave and absences for gap detection are bounded to [effectiveStart, effectiveEnd]
  // by findMissingWorkdays internally (span guard).

  const gapResult = findMissingWorkdays({
    schedule,
    effectiveStart,
    effectiveEnd,
    tz,
    entryDates,
    approvedLeave: approvedLeave.map((lr) => ({
      startDate: lr.startDate,
      endDate: lr.endDate,
      halfDay: lr.halfDay,
    })),
    absences: absences.map((ab) => ({
      startDate: ab.startDate,
      endDate: ab.endDate,
    })),
    holidayDateStrings,
    rosterDates,
  });

  const { gaps, coveredDates } = gapResult;

  // ── Step 5: Compute workedMinutes ─────────────────────────────────────────
  //
  // Sum net durations (endTime - startTime - breakMinutes) for all entries within
  // [effectiveStart, effectiveEnd]. The entry pre-filter at step 2 already ensures
  // all entries in the set are within the employment span.

  const effectiveStartStr = dateStrInTz(effectiveStart, tz);
  const effectiveEndStr = dateStrInTz(effectiveEnd, tz);

  let workedMinutes = 0;
  for (const e of entries) {
    const ds = dateStrInTz(e.date, tz);
    if (ds < effectiveStartStr || ds > effectiveEndStr) continue;
    workedMinutes += (e.endTime.getTime() - e.startTime.getTime()) / 60000 - Number(e.breakMinutes);
  }

  // ── Step 6: Compute BS-doubling (pure inline, no DB) ──────────────────────
  //
  // VOCATIONAL_SCHOOL absence dates are collected from the provided absences array.
  // ISO-week counts are computed from the same array (no DB access needed for the
  // block-week cap). This replicates the semantics of getVocationalSchoolMinutesForDate
  // but operates on the pre-fetched data.
  //
  // D-01: BS minutes add to BOTH workedMinutes AND expectedMinutes for Soll-bearing
  // types (FIXED/FLEXTIME/SHIFT_BASED), keeping the balance neutral.
  // D-04: MONTHLY_HOURS adds to workedMinutes ONLY (no Soll target).
  //
  // VOCATIONAL_SCHOOL / PATTERN absences are EXCLUDED from the leave/absence Soll-
  // credit loop (they are handled by the doubling mechanism — matching all four paths;
  // see time-entries.ts:1861 / overtime.ts:1058).

  const bsDaily = tenantConfig?.vocationalSchoolMinutesPerDay ?? BS_DAILY_DEFAULT_MIN;
  const bsWeekly = tenantConfig?.vocationalSchoolBlockMinutesPerWeek ?? BS_BLOCK_WEEKLY_DEFAULT_MIN;

  // Build set of distinct VOCATIONAL_SCHOOL dates within [effectiveStart, effectiveEnd]
  // from the provided absences array. Group by ISO week (Mon–Sun, UTC-based per
  // vocational-school-saldo.ts:41–52 semantics).
  const bsDatesInMonth = new Set<string>();
  for (const ab of absences) {
    if (ab.type !== "VOCATIONAL_SCHOOL") continue;
    const abStart = ab.startDate < effectiveStart ? effectiveStart : ab.startDate;
    const abEnd = ab.endDate > monthEnd ? monthEnd : ab.endDate;
    if (abStart > abEnd) continue;
    const cur = new Date(abStart.getTime());
    while (true) {
      const ds = dateStrInTz(cur, tz);
      if (ds > dateStrInTz(abEnd, tz)) break;
      if (ds >= effectiveStartStr && ds <= effectiveEndStr) {
        bsDatesInMonth.add(ds);
      }
      cur.setTime(cur.getTime() + 24 * 60 * 60 * 1000);
    }
  }

  // Group BS dates by ISO week key ("YYYY-Www") for block-week cap computation.
  // ISO week: Monday-based. Monday = day 1 (0=Sun → 6=Sat in Date.getUTCDay).
  function isoWeekKey(dateStr: string): string {
    const d = new Date(dateStr + "T00:00:00Z");
    const dow = d.getUTCDay(); // 0=Sun…6=Sat
    const daysSinceMon = (dow + 6) % 7;
    const monday = new Date(d.getTime());
    monday.setUTCDate(d.getUTCDate() - daysSinceMon);
    // Use ISO year-week: year of the Monday + week number
    const year = monday.getUTCFullYear();
    const startOfYear = new Date(Date.UTC(year, 0, 1));
    const weekNum = Math.ceil(
      ((monday.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getUTCDay() + 1) / 7,
    );
    return `${year}-W${String(weekNum).padStart(2, "0")}`;
  }

  // Count distinct BS dates per ISO week (using the full absences array, not just
  // bsDatesInMonth, to match the DB version which counts ALL BS days in the same
  // ISO week — including days outside the effective span that may be in the same week).
  const bsDatesAllByWeek = new Map<string, Set<string>>();
  for (const ab of absences) {
    if (ab.type !== "VOCATIONAL_SCHOOL") continue;
    const cur = new Date(ab.startDate.getTime());
    const endLimit = ab.endDate;
    while (true) {
      const ds = dateStrInTz(cur, tz);
      if (ds > dateStrInTz(endLimit, tz)) break;
      const wk = isoWeekKey(ds);
      if (!bsDatesAllByWeek.has(wk)) bsDatesAllByWeek.set(wk, new Set());
      bsDatesAllByWeek.get(wk)!.add(ds);
      cur.setTime(cur.getTime() + 24 * 60 * 60 * 1000);
    }
  }

  let bsWorkedMinutes = 0;
  let bsExpectedMinutes = 0;
  for (const ds of bsDatesInMonth) {
    const wk = isoWeekKey(ds);
    const daysInWeek = bsDatesAllByWeek.get(wk)?.size ?? 1;
    let bsMin: number;
    if (daysInWeek >= 5) {
      bsMin = Math.round(bsWeekly / daysInWeek);
    } else {
      bsMin = bsDaily;
    }
    bsWorkedMinutes += bsMin;
    if (scheduleType !== "MONTHLY_HOURS") {
      bsExpectedMinutes += bsMin;
    }
  }

  // ── Step 7: Branch on schedule type ──────────────────────────────────────
  //
  // SHIFT_BASED: Model B + §615 via calcShiftBasedSaldo.
  //   R = Σ netto active shifts (deletedAt=null, coveredDates excluded) — reusing
  //       the SAME coveredDates from findMissingWorkdays (pitfall A1 fix).
  //   C_net = calcExpectedMinutesTz − leave credits − absence credits (excl. BS/PATTERN)
  //           + bsExpectedMinutes.
  //   No rosterProration (close = full month, not live open month).
  //   expectedMinutes = C_net (stored in SaldoSnapshot.expectedMinutes — not R, D-07).
  //   shiftBalanceOverride = balanceDelta + bsWorkedMinutes.
  //
  // Non-SHIFT (FIXED/FLEXTIME/MONTHLY_HOURS):
  //   netExpected = calcExpectedMinutesTz − holidayMinutes − leaveMinutes − absenceMinutes.
  //   Add bsExpectedMinutes to expectedMinutes.
  //   balanceMinutes = totalWorked − netExpected.

  let expectedMinutes: number;
  let holidayMinutes = 0;
  let leaveMinutes = 0;
  let absenceMinutes = 0;
  let shiftBalanceOverride: number | null = null;

  if (scheduleType === "SHIFT_BASED") {
    // ── SHIFT_BASED branch ────────────────────────────────────────────────

    // R = Σ netto active shifts (deletedAt=null already pre-filtered; coveredDates excluded).
    // Reuse coveredDates from findMissingWorkdays (pitfall A1 fix — one covered-date set).
    const hmToMin = (hm: string): number => {
      const [h, m] = hm.split(":").map(Number);
      return (h ?? 0) * 60 + (m ?? 0);
    };
    const employeeBreakShape = {
      breakOver6hOverride: breakOver6hOverride ?? null,
      breakOver9hOverride: breakOver9hOverride ?? null,
    };
    const tenantBreakShape = {
      defaultBreakOver6h: tenantConfig?.defaultBreakOver6h ?? 30,
      defaultBreakOver9h: tenantConfig?.defaultBreakOver9h ?? 45,
    };

    let shiftMinutes = 0; // R = Σ netto active shifts
    for (const sh of shifts) {
      const shDs = dateStrInTz(sh.date, tz);
      // Only count shifts within effective span
      if (shDs < effectiveStartStr || shDs > effectiveEndStr) continue;
      // Exclude shifts on covered dates (leave/absence/holiday — Ausfallprinzip)
      if (coveredDates.has(shDs)) continue;
      let brutto = hmToMin(sh.endTime) - hmToMin(sh.startTime);
      if (brutto < 0) brutto += 24 * 60; // cross-midnight (e.g. 22:00–06:00)
      if (brutto <= 0) continue;
      const breakMin = getEffectiveBreakDuration(employeeBreakShape, tenantBreakShape, brutto);
      shiftMinutes += Math.max(0, brutto - breakMin);
    }

    // C_net = contract Ø-Methode Soll (via calcExpectedMinutesTz) minus leave/absence credits
    // (Ausfallprinzip). VOCATIONAL_SCHOOL + source=PATTERN excluded from credit loop — handled
    // via bsExpectedMinutes (D-06, Phase 63). Holiday credit included automatically by
    // calcExpectedMinutesTz. No excludeHolidays passed (consistent with all four paths; see
    // RESEARCH.md §2 "SHIFT_BASED leave credit excludeHolidays" row).
    const contractSoll = calcExpectedMinutesTz(schedule, effectiveStart, monthEnd, tz);
    const sbLeaveCredit = approvedLeave.reduce((sum, lr) => {
      const leaveStart = lr.startDate < effectiveStart ? effectiveStart : lr.startDate;
      const leaveEnd = lr.endDate > monthEnd ? monthEnd : lr.endDate;
      if (leaveStart > leaveEnd) return sum;
      return (
        sum +
        calcLeaveAbsenceMinutesTz(schedule, leaveStart, leaveEnd, tz, {
          halfDay: Boolean(lr.halfDay),
          // NOTE: no excludeHolidays here — consistent with overtime.ts:1050, auto-close-month.ts:447,
          // recalculate-snapshots.ts:248 (all four paths omit it in the SHIFT_BASED branch).
        })
      );
    }, 0);
    const sbAbsenceCredit = absences.reduce((sum, ab) => {
      // VOCATIONAL_SCHOOL + source=PATTERN: handled via bsExpectedMinutes (D-06).
      if (ab.type === "VOCATIONAL_SCHOOL" || ab.source === "PATTERN") return sum;
      const absStart = ab.startDate < effectiveStart ? effectiveStart : ab.startDate;
      const absEnd = ab.endDate > monthEnd ? monthEnd : ab.endDate;
      if (absStart > absEnd) return sum;
      return sum + calcLeaveAbsenceMinutesTz(schedule, absStart, absEnd, tz);
    }, 0);

    // C_net: contract Soll net of leave/absence credits + bsExpectedMinutes (BS day = Arbeitstag,
    // BBiG §15 — VOCATIONAL_SCHOOL credit folded in via bsExpectedMinutes, not the loop above).
    const cNet = Math.max(0, contractSoll - sbLeaveCredit - sbAbsenceCredit) + bsExpectedMinutes;

    // Byte-identical to overtime.ts:1068–1078 and auto-close-month.ts:464–472:
    // Pass W = workedMinutes (entries only, WITHOUT bsWorkedMinutes) into calcShiftBasedSaldo,
    // then add bsWorkedMinutes POST-HOC to balanceDelta.
    // Any BS-doubling correctness change (e.g. balance-neutrality) is out of scope for this
    // extraction (tracked separately in 76.26-BS-DOUBLING-FOLLOWUP.md).
    const sbSaldo = calcShiftBasedSaldo({
      contractSollMinutes: cNet,
      rosterMinutes: shiftMinutes,
      workedMinutes: workedMinutes,
      // NO rosterProration — close = full month, not live open month.
    });

    expectedMinutes = sbSaldo.expectedMinutes; // = C_net (stored in SaldoSnapshot — not R, D-07)
    // shiftBalanceOverride = D-01 two-clause balance + bsWorkedMinutes (worked-side BS credit).
    // bsExpectedMinutes is already folded into C_net above — byte-identical to overtime.ts:1078
    // and auto-close-month.ts:472.
    shiftBalanceOverride = sbSaldo.balanceDelta + bsWorkedMinutes;

    // leaveMinutes / absenceMinutes / holidayMinutes stay 0:
    // Credits are folded into C_net. Leaving them 0 prevents double-deduction at
    // the netExpected site (which SHIFT_BASED bypasses via shiftBalanceOverride anyway).
    leaveMinutes = 0;
    absenceMinutes = 0;
    holidayMinutes = 0;
  } else {
    // ── Non-SHIFT branch (FIXED_SCHEDULE, FIXED_WEEKLY, FLEXTIME, MONTHLY_HOURS) ──

    expectedMinutes = calcExpectedMinutesTz(schedule, effectiveStart, monthEnd, tz);

    // Holiday subtraction: holidayDateStrings is pre-computed by the caller (merged
    // computed Feiertage + DB manual holidays). Convert to Date objects for the
    // getDayHoursFromSchedule lookup.
    const isMonthlyHoursDeduction =
      scheduleType === "MONTHLY_HOURS" &&
      Number(schedule.monthlyHours ?? 0) > 0 &&
      tenantConfig?.monthlyHoursHolidayDeduction === true;

    let workingDaysInRange = 0;
    if (isMonthlyHoursDeduction) {
      const wdCur = new Date(effectiveStart.getTime());
      while (true) {
        if (wdCur > monthEnd) break;
        const dow = getDayOfWeekInTz(wdCur, tz);
        if (getDayHoursFromSchedule(schedule, dow) > 0) workingDaysInRange++;
        wdCur.setTime(wdCur.getTime() + 24 * 60 * 60 * 1000);
      }
    }
    const dailySollMin =
      isMonthlyHoursDeduction && workingDaysInRange > 0
        ? (Number(schedule.monthlyHours!) * 60) / workingDaysInRange
        : 0;

    for (const hDateStr of holidayDateStrings) {
      const hDate = new Date(hDateStr + "T00:00:00Z");
      const dow = getDayOfWeekInTz(hDate, tz);
      if (isMonthlyHoursDeduction) {
        if (getDayHoursFromSchedule(schedule, dow) > 0) holidayMinutes += dailySollMin;
      } else {
        holidayMinutes += getDayHoursFromSchedule(schedule, dow) * 60;
      }
    }

    // D-06: holiday dates as Set<string> for excludeHolidays inside leave/absence Soll-reduction,
    // so a holiday inside an approved leave/absence range is NOT double-deducted.
    // holidayDateStrings is already YYYY-MM-DD in tenant TZ from the caller.
    const holidayExcludeSet = holidayDateStrings;

    // CLAUDE.md "Schedule Types": MONTHLY_HOURS — holiday/absence deductions do NOT apply.
    if (scheduleType !== "MONTHLY_HOURS") {
      leaveMinutes = approvedLeave.reduce((sum, lr) => {
        const leaveStart = lr.startDate < effectiveStart ? effectiveStart : lr.startDate;
        const leaveEnd = lr.endDate > monthEnd ? monthEnd : lr.endDate;
        if (leaveStart > leaveEnd) return sum;
        return (
          sum +
          calcLeaveAbsenceMinutesTz(schedule, leaveStart, leaveEnd, tz, {
            halfDay: Boolean(lr.halfDay),
            excludeHolidays: holidayExcludeSet, // D-06
          })
        );
      }, 0);

      absenceMinutes = absences.reduce((sum, ab) => {
        const absStart = ab.startDate < effectiveStart ? effectiveStart : ab.startDate;
        const absEnd = ab.endDate > monthEnd ? monthEnd : ab.endDate;
        if (absStart > absEnd) return sum;
        return (
          sum +
          calcLeaveAbsenceMinutesTz(schedule, absStart, absEnd, tz, {
            excludeHolidays: holidayExcludeSet, // D-06
          })
        );
      }, 0);
    }

    // Add bsExpectedMinutes to expectedMinutes for non-MONTHLY_HOURS Soll-bearing types.
    // For MONTHLY_HOURS (D-04): bsExpectedMinutes stays 0 (forced above — scheduleType check).
    expectedMinutes += bsExpectedMinutes;
  }

  // ── Step 8: Compute final saldo values ────────────────────────────────────

  // netExpected: valid for non-SHIFT branches.
  // For SHIFT_BASED, expectedMinutes is already C_net (set by calcShiftBasedSaldo);
  // shiftBalanceOverride is the D-01 two-clause balance (bypasses netExpected formula).
  const netExpected = Math.max(
    0,
    scheduleType !== "SHIFT_BASED"
      ? expectedMinutes - holidayMinutes - leaveMinutes - absenceMinutes
      : expectedMinutes, // SHIFT_BASED: expectedMinutes = C_net, not used for balance
  );

  const totalWorked = workedMinutes + bsWorkedMinutes;

  // Phase 76.22: SHIFT_BASED uses D-01 two-clause formula via shiftBalanceOverride.
  // Non-SHIFT branches use the flat totalWorked − netExpected subtraction.
  const balanceMinutes =
    shiftBalanceOverride !== null
      ? Math.round(shiftBalanceOverride)
      : Math.round(totalWorked - netExpected);

  const carryOverOut = carryOverIn + balanceMinutes;

  // TRACK_ONLY zeroing: MONTHLY_HOURS with overtimeMode=TRACK_ONLY → effectiveCarryOverOut = 0.
  // Mirrors overtime.ts:1268–1269, auto-close-month.ts:618–620, recalculate-snapshots.ts:461.
  const isTrackOnly = scheduleType === "MONTHLY_HOURS" && schedule.overtimeMode === "TRACK_ONLY";
  const effectiveCarryOverOut = isTrackOnly ? 0 : carryOverOut;

  // snapshotExpectedMinutes sentinel (RESEARCH §2 last row):
  //   SHIFT_BASED → C_net (= expectedMinutes, already set to calcShiftBasedSaldo.expectedMinutes)
  //   else        → netExpected (the post-deduction Soll stored in the snapshot)
  // Mirrors overtime.ts:1273–1274, auto-close-month.ts:624–625, recalculate-snapshots.ts:470–471.
  const snapshotExpectedMinutes =
    shiftBalanceOverride !== null ? Math.round(expectedMinutes) : Math.round(netExpected);

  return {
    workedMinutes: Math.round(totalWorked),
    expectedMinutes: Math.round(scheduleType === "SHIFT_BASED" ? expectedMinutes : netExpected),
    balanceMinutes,
    carryOverOut,
    effectiveCarryOverOut,
    snapshotExpectedMinutes,
    gaps,
    coveredDates,
  };
}
