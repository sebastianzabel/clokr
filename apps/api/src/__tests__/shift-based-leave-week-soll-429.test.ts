/**
 * shift-based-leave-week-soll-429.test.ts
 *
 * Issue #429 — regression pin for the issue's own numeric example (RED-then-GREEN, see
 * 429-02-SUMMARY.md for the actual RED numbers this file produced against the unmodified
 * `close-employee-month.ts`), plus the "a day reduces Soll exactly once" invariant suite
 * for the new `shiftBasedLeaveCreditByDate()`-based SHIFT_BASED `approvedLeave` credit
 * loop (429-CONTEXT.md D-07..D-10).
 *
 * PURE unit tests: no DB, no `getTestApp` — `CloseMonthInput` objects are built directly
 * and fed to `closeEmployeeMonth()`, mirroring the orchestrator's own spot-check script
 * (`p429-analysis.tmp.ts`, ported here) that produced the numbers quoted in
 * 429-CONTEXT.md's `<analysis_results>` and the issue's own analysis comment.
 *
 * Fixture shape: a SHIFT_BASED employee, 38h/week, 4-day contract
 * (`contractWorkDaysPerWeek: 4`), tested against three `workDays` variants (Mo-Sa, Mo-Fr,
 * Mo-Th — the roster shape must not change the contract-driven leave credit). Every week
 * OTHER than the test week (2026-06-08..14) works exactly the contract (Mon-Thu 9.5h/day,
 * 570 min = 38h*60/4). June 2026 has no public holidays in the tested range and is used
 * throughout (no DST transition either, matching the tmp script and the CONTEXT.md
 * analysis).
 */
import { describe, it, expect } from "vitest";
import {
  closeEmployeeMonth,
  toCloseMonthApprovedLeave,
  type CloseMonthInput,
} from "../contexts/working-time-account/close-employee-month";
import {
  monthRangeUtc,
  monthDayBounds,
  calcExpectedMinutesTz,
} from "../contexts/working-time-account/timezone";
import { shiftBasedLeaveCreditByDate } from "../contexts/working-time-account/shift-based-leave-credit";

const TZ = "Europe/Berlin";
const { start: JUNE_START, end: JUNE_END } = monthRangeUtc(2026, 6, TZ);
const { firstDay: JUNE_FIRST, lastDay: JUNE_LAST } = monthDayBounds(JUNE_START, JUNE_END, TZ);
const { start: JULY_START, end: JULY_END } = monthRangeUtc(2026, 7, TZ);
const { firstDay: JULY_FIRST, lastDay: JULY_LAST } = monthDayBounds(JULY_START, JULY_END, TZ);

const D = (s: string) => new Date(s + "T00:00:00Z");

function daysOfJune(): string[] {
  const out: string[] = [];
  for (let d = 1; d <= 30; d++) out.push(`2026-06-${String(d).padStart(2, "0")}`);
  return out;
}
function daysOfJuly(): string[] {
  const out: string[] = [];
  for (let d = 1; d <= 31; d++) out.push(`2026-07-${String(d).padStart(2, "0")}`);
  return out;
}
const dow = (s: string) => D(s).getUTCDay();
const WEEK = [
  "2026-06-08",
  "2026-06-09",
  "2026-06-10",
  "2026-06-11",
  "2026-06-12",
  "2026-06-13",
  "2026-06-14",
];
const inWeek = (d: string) => WEEK.includes(d);

function entry(ds: string, netMin: number) {
  return {
    date: D(ds),
    startTime: new Date(ds + "T06:00:00Z"),
    endTime: new Date(D(ds).getTime() + 6 * 3600e3 + netMin * 60e3),
    breakMinutes: 0,
  };
}

function shift(ds: string, netMin: number) {
  const brk = netMin + 45 > 9 * 60 ? 45 : netMin + 30 > 6 * 60 ? 30 : 0;
  const s = 8 * 60;
  const e = s + netMin + brk;
  const hm = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return { date: D(ds), startTime: hm(s), endTime: hm(e) };
}

type Leave = { s: string; e: string; half?: boolean; overtimeComp?: boolean };

function buildInput(
  schedule: Record<string, unknown>,
  perDay: (ds: string) => number,
  leave: Leave[],
  shiftsFn: (ds: string) => number = () => 0,
  overrides: Partial<CloseMonthInput> = {},
): CloseMonthInput {
  const days = daysOfJune();
  return {
    employeeId: "x",
    monthStart: JUNE_START,
    monthEnd: JUNE_END,
    monthFirstDay: JUNE_FIRST,
    monthLastDay: JUNE_LAST,
    tz: TZ,
    carryOverIn: 0,
    schedule,
    hireDate: D("2025-01-01"),
    exitDate: null,
    isTimeTrackingExempt: false,
    breakOver6hOverride: null,
    breakOver9hOverride: null,
    entries: days.filter((d) => perDay(d) > 0).map((d) => entry(d, perDay(d))),
    shifts: days.filter((d) => shiftsFn(d) > 0).map((d) => shift(d, shiftsFn(d))),
    approvedLeave: toCloseMonthApprovedLeave(
      leave.map((l) => ({
        startDate: D(l.s),
        endDate: D(l.e),
        halfDay: Boolean(l.half),
        leaveType: { code: l.overtimeComp ? "OVERTIME_COMP" : "VACATION" },
      })),
    ),
    absences: [],
    holidayDateStrings: new Set(),
    tenantConfig: { defaultBreakOver6h: 30, defaultBreakOver9h: 45 },
    ...overrides,
  };
}

function run(
  schedule: Record<string, unknown>,
  perDay: (ds: string) => number,
  leave: Leave[],
  shiftsFn: (ds: string) => number = () => 0,
  overrides: Partial<CloseMonthInput> = {},
) {
  return closeEmployeeMonth(buildInput(schedule, perDay, leave, shiftsFn, overrides));
}

/** Same shape as buildInput, but for an arbitrary month (used by the month-straddle test). */
function buildInputForMonth(
  days: string[],
  monthBounds: { start: Date; end: Date; firstDay: Date; lastDay: Date },
  schedule: Record<string, unknown>,
  perDay: (ds: string) => number,
  leave: Leave[],
  shiftsFn: (ds: string) => number = () => 0,
): CloseMonthInput {
  return {
    employeeId: "x",
    monthStart: monthBounds.start,
    monthEnd: monthBounds.end,
    monthFirstDay: monthBounds.firstDay,
    monthLastDay: monthBounds.lastDay,
    tz: TZ,
    carryOverIn: 0,
    schedule,
    hireDate: D("2025-01-01"),
    exitDate: null,
    isTimeTrackingExempt: false,
    breakOver6hOverride: null,
    breakOver9hOverride: null,
    entries: days.filter((d) => perDay(d) > 0).map((d) => entry(d, perDay(d))),
    shifts: days.filter((d) => shiftsFn(d) > 0).map((d) => shift(d, shiftsFn(d))),
    approvedLeave: toCloseMonthApprovedLeave(
      leave.map((l) => ({
        startDate: D(l.s),
        endDate: D(l.e),
        halfDay: Boolean(l.half),
        leaveType: { code: l.overtimeComp ? "OVERTIME_COMP" : "VACATION" },
      })),
    ),
    absences: [],
    holidayDateStrings: new Set(),
    tenantConfig: { defaultBreakOver6h: 30, defaultBreakOver9h: 45 },
  };
}

/** 38h/week, 4-day contract, tested against three `workDays` roster shapes. */
function shiftBasedSchedule(workDays: number[]): Record<string, unknown> {
  return {
    type: "SHIFT_BASED",
    weeklyHours: 38,
    contractWorkDaysPerWeek: 4,
    workDays,
    mondayHours: 8,
    tuesdayHours: 8,
    wednesdayHours: 8,
    thursdayHours: 8,
    fridayHours: 8,
    saturdayHours: 8,
    sundayHours: 0,
  };
}

/** Every week other than the test week: Mon-Thu 9.5h (570 min = 38h*60/4), the contract. */
const base = (d: string) => (dow(d) >= 1 && dow(d) <= 4 ? 570 : 0);

const WORKDAYS_VARIANTS: Array<{ label: string; workDays: number[] }> = [
  { label: "Mo-Sa", workDays: [1, 2, 3, 4, 5, 6] },
  { label: "Mo-Fr", workDays: [1, 2, 3, 4, 5] },
  { label: "Mo-Do", workDays: [1, 2, 3, 4] },
];

describe("Issue #429 — SHIFT_BASED leave reduces contract Soll (not workDays Ø-Methode)", () => {
  describe.each(WORKDAYS_VARIANTS)("workDays=$label (38h / 4-day contract)", ({ workDays }) => {
    const schedule = shiftBasedSchedule(workDays);

    it("A — issue's own example: leave Mon unplanned, Tue-Thu 10.5h -> +180 min week effect", () => {
      const baseline = run(schedule, base, [], base);
      const scenA = (d: string) => (inWeek(d) ? (dow(d) >= 2 && dow(d) <= 4 ? 630 : 0) : base(d));
      const scenario = run(schedule, scenA, [{ s: "2026-06-08", e: "2026-06-08" }], scenA);
      expect(scenario.balanceMinutes - baseline.balanceMinutes).toBe(180);
    });

    it("A2 — leave Sat unplanned (outside Mo-Fr/Mo-Do workDays), Mon-Wed 10.5h -> +180 min", () => {
      const baseline = run(schedule, base, [], base);
      const scenA2 = (d: string) => (inWeek(d) ? (dow(d) >= 1 && dow(d) <= 3 ? 630 : 0) : base(d));
      const scenario = run(schedule, scenA2, [{ s: "2026-06-13", e: "2026-06-13" }], scenA2);
      expect(scenario.balanceMinutes - baseline.balanceMinutes).toBe(180);
    });

    it("B — whole Mo-Sa leave week, no plan -> 0 min week effect", () => {
      const baseline = run(schedule, base, [], base);
      const scenB = (d: string) => (inWeek(d) ? 0 : base(d));
      const scenario = run(schedule, scenB, [{ s: "2026-06-08", e: "2026-06-13" }], scenB);
      expect(scenario.balanceMinutes - baseline.balanceMinutes).toBe(0);
    });
  });
});

describe("Issue #429 — invariant suite (D-07..D-10): 'a day reduces Soll exactly once'", () => {
  // Mo-Fr roster, 4-day contract — arbitrary but fixed choice for this suite (the workDays
  // variant itself is already exercised exhaustively by the suite above).
  const schedule = shiftBasedSchedule([1, 2, 3, 4, 5]);

  it("Sigma row credits === total: 3 non-overlapping rows sum to the same total as the direct map", () => {
    const contractSoll = calcExpectedMinutesTz(schedule, JUNE_FIRST, JUNE_END, TZ);
    const leave: Leave[] = [
      { s: "2026-06-01", e: "2026-06-01" }, // week 1, fragment (1 day)
      { s: "2026-06-16", e: "2026-06-18" }, // week 3, fragment (3 days)
      { s: "2026-06-22", e: "2026-06-27" }, // week 4, whole Mo-Sa week (capped at 4)
    ];
    const result = run(schedule, base, leave, base);
    const derivedTotal = contractSoll - result.expectedMinutes; // = sbLeaveCredit (no absences/BS here)

    const map = shiftBasedLeaveCreditByDate(
      leave.map((l) => ({ startDate: D(l.s), endDate: D(l.e) })),
      4,
      schedule,
      JUNE_FIRST,
      JUNE_END,
      TZ,
    );
    const mapTotal = Math.round(Array.from(map.values()).reduce((a, b) => a + b, 0));

    expect(mapTotal).toBeGreaterThan(0);
    expect(derivedTotal).toBe(mapTotal);
  });

  it("§9 overlap: two overlapping rows (Mon-Wed VACATION + Wed-Thu SICK) credit the same total as one union row (Mon-Thu)", () => {
    const noWork = (d: string) => (inWeek(d) ? 0 : base(d));
    const twoRows = run(
      schedule,
      noWork,
      [
        { s: "2026-06-08", e: "2026-06-10" }, // Mon-Wed
        { s: "2026-06-10", e: "2026-06-11" }, // Wed-Thu, overlaps Wed
      ],
      noWork,
    );
    const oneRow = run(schedule, noWork, [{ s: "2026-06-08", e: "2026-06-11" }], noWork);
    expect(twoRows.expectedMinutes).toBe(oneRow.expectedMinutes);
    expect(twoRows.balanceMinutes).toBe(oneRow.balanceMinutes);
  });

  it("OPEN-01: a full-day row beats a half-day row on the same date — the half-day row contributes 0", () => {
    const noWork = (d: string) => (inWeek(d) ? 0 : base(d));
    const fullPlusHalf = run(
      schedule,
      noWork,
      [
        { s: "2026-06-08", e: "2026-06-08" }, // full-day, sorts first (sortForDedup)
        { s: "2026-06-08", e: "2026-06-08", half: true }, // half-day, same date
      ],
      noWork,
    );
    const fullOnly = run(schedule, noWork, [{ s: "2026-06-08", e: "2026-06-08" }], noWork);
    expect(fullPlusHalf.expectedMinutes).toBe(fullOnly.expectedMinutes);
    expect(fullPlusHalf.balanceMinutes).toBe(fullOnly.balanceMinutes);
  });

  it("OVERTIME_COMP withdrawal === credit (D-10): the withdrawal equals what the row would credit standalone", () => {
    const result = run(
      schedule,
      base,
      [{ s: "2026-06-08", e: "2026-06-08", overtimeComp: true }],
      base,
    );
    const standaloneMap = shiftBasedLeaveCreditByDate(
      [{ startDate: D("2026-06-08"), endDate: D("2026-06-08") }],
      4,
      schedule,
      JUNE_FIRST,
      JUNE_END,
      TZ,
    );
    const standaloneCredit = Math.round(
      Array.from(standaloneMap.values()).reduce((a, b) => a + b, 0),
    );
    expect(standaloneCredit).toBeGreaterThan(0);
    expect(result.overtimeCompensationMinutes).toBe(standaloneCredit);
  });

  it("Month-straddle: a whole-week leave row crossing a month boundary credits exactly one week's contract Soll in total, never negative", () => {
    // workDays spans the FULL Mo-Sat week here (unlike this describe block's own Mo-Fr
    // `schedule`) — see the "under-credit" finding test right below for why that choice is
    // load-bearing: the per-week-part cap (D-08) is computed independently per part via
    // calcExpectedMinutesTz's own Ø-Methode divisor (workDays.length), which only lines up
    // exactly with the calendar Mo-Sat dates a leave week's shares are spread over when
    // workDays covers all six of them.
    const moSaSchedule = shiftBasedSchedule([1, 2, 3, 4, 5, 6]);

    // 2026-06-29 (Mon) .. 2026-07-05 (Sun) — a full Mo-Sa leave week straddling June/July.
    // Passed UNCLIPPED to both calls, matching production (D-07).
    const leave: Leave[] = [{ s: "2026-06-29", e: "2026-07-05" }];

    const juneResult = run(moSaSchedule, base, leave, base);
    const juneContractSoll = calcExpectedMinutesTz(moSaSchedule, JUNE_FIRST, JUNE_END, TZ);
    const juneCredit = juneContractSoll - juneResult.expectedMinutes;

    const julyPerDay = (d: string) => (dow(d) >= 1 && dow(d) <= 4 ? 570 : 0);
    const julyResult = closeEmployeeMonth(
      buildInputForMonth(
        daysOfJuly(),
        { start: JULY_START, end: JULY_END, firstDay: JULY_FIRST, lastDay: JULY_LAST },
        moSaSchedule,
        julyPerDay,
        leave,
        julyPerDay,
      ),
    );
    const julyContractSoll = calcExpectedMinutesTz(moSaSchedule, JULY_FIRST, JULY_END, TZ);
    const julyCredit = julyContractSoll - julyResult.expectedMinutes;

    expect(juneCredit).toBeGreaterThanOrEqual(0);
    expect(julyCredit).toBeGreaterThanOrEqual(0);
    expect(juneCredit + julyCredit).toBe(38 * 60); // exactly one week's contract Soll (38h), never doubled
  });

  it("Month-straddle FINDING: workDays narrower than Mo-Sat can under-credit the split total (never negative, never over-credited)", () => {
    // Same fixture as above but with this describe block's Mo-Fr `schedule` (workDays
    // [1,2,3,4,5], contractWorkDaysPerWeek 4). D-08 caps each week-PART independently against
    // its OWN calcExpectedMinutesTz Soll — there is no cross-part reallocation of unused
    // capacity. Per-date share for a whole leave week is weeklyHours*60/6 = 380 regardless of
    // contractWorkDaysPerWeek (the whole-week fullDayTotal, which equals contractWorkDaysPerWeek,
    // is spread uniformly over the 6 Mo-Sat calendar dates and the two terms cancel). The June
    // part (Mon+Tue, both Mo-Fr workdays) caps at 2280*2/5=912 >= its 760 uncapped -> unscaled.
    // The July part (Wed-Sat, only Wed-Fri are Mo-Fr workdays) caps at 2280*3/5=1368 <
    // its 1520 uncapped -> scaled down to 1368. Total 760+1368=2128 < 2280 (the full week's
    // Soll) by 152 minutes — the June part's 152 minutes of unused headroom (912-760) is never
    // carried over. Never negative and never exceeds the full week's Soll either direction, so
    // Revisionssicherheit (no silent double-charge) holds; the "sums to exactly one week" must-have
    // is therefore workDays-shape-dependent, not universal. Reported as a finding (D-08 does not
    // specify cross-part reallocation), not silently patched in this plan.
    const leave: Leave[] = [{ s: "2026-06-29", e: "2026-07-05" }];

    const juneResult = run(schedule, base, leave, base);
    const juneContractSoll = calcExpectedMinutesTz(schedule, JUNE_FIRST, JUNE_END, TZ);
    const juneCredit = juneContractSoll - juneResult.expectedMinutes;

    const julyPerDay = (d: string) => (dow(d) >= 1 && dow(d) <= 4 ? 570 : 0);
    const julyResult = closeEmployeeMonth(
      buildInputForMonth(
        daysOfJuly(),
        { start: JULY_START, end: JULY_END, firstDay: JULY_FIRST, lastDay: JULY_LAST },
        schedule,
        julyPerDay,
        leave,
        julyPerDay,
      ),
    );
    const julyContractSoll = calcExpectedMinutesTz(schedule, JULY_FIRST, JULY_END, TZ);
    const julyCredit = julyContractSoll - julyResult.expectedMinutes;

    expect(juneCredit).toBe(760);
    expect(julyCredit).toBe(1368);
    expect(juneCredit + julyCredit).toBe(2128); // < 38*60=2280 — under-credited, never negative/doubled
    expect(juneCredit + julyCredit).toBeLessThan(38 * 60);
    expect(juneCredit + julyCredit).toBeGreaterThan(0);
  });

  it("Split-request cap (D-08): two duplicate full-week rows for the SAME week never double-credit that week", () => {
    const scenB = (d: string) => (inWeek(d) ? 0 : base(d));
    const duplicated = run(
      schedule,
      scenB,
      [
        { s: "2026-06-08", e: "2026-06-13" },
        { s: "2026-06-08", e: "2026-06-13" }, // duplicate of the exact same whole week
      ],
      scenB,
    );
    const single = run(schedule, scenB, [{ s: "2026-06-08", e: "2026-06-13" }], scenB);
    expect(duplicated.expectedMinutes).toBeGreaterThanOrEqual(0);
    expect(duplicated.expectedMinutes).toBe(single.expectedMinutes);
    expect(duplicated.balanceMinutes).toBe(single.balanceMinutes);
  });

  it("Live-path / rosterProration: scales C_net (already leave-credited) by roster progress, without re-scaling the leave credit itself", () => {
    const closeRun = run(schedule, base, [{ s: "2026-06-08", e: "2026-06-08" }], base);
    // A partial roster: 60% of the period's roster minutes worked so far.
    const rosterPeriodMinutes = 10000;
    const rosterToDateMinutes = 6000;
    const liveRun = run(schedule, base, [{ s: "2026-06-08", e: "2026-06-08" }], base, {
      rosterProration: { rosterToDateMinutes, rosterPeriodMinutes },
    });
    const factor = rosterToDateMinutes / rosterPeriodMinutes;
    expect(liveRun.expectedMinutes).toBe(Math.round(closeRun.expectedMinutes * factor));
  });

  it("Leave+absence same date: the leave credit and the BS absence credit apply independently (finding, not fixed by this plan)", () => {
    const dateStr = "2026-06-08"; // Monday
    const bsAbsence = {
      startDate: D(dateStr),
      endDate: D(dateStr),
      type: "VOCATIONAL_SCHOOL",
      source: "PATTERN",
    };
    const none = run(schedule, base, [], base);
    const leaveOnly = run(schedule, base, [{ s: dateStr, e: dateStr }], base);
    const bsOnly = run(schedule, base, [], base, { absences: [bsAbsence] });
    const both = run(schedule, base, [{ s: dateStr, e: dateStr }], base, { absences: [bsAbsence] });

    const leaveEffect = leaveOnly.expectedMinutes - none.expectedMinutes;
    const bsEffect = bsOnly.expectedMinutes - none.expectedMinutes;
    const bothEffect = both.expectedMinutes - none.expectedMinutes;

    // isBsAbsence()'s carve-out (close-employee-month.ts, above sortForDedup) means a BS
    // absence neither claims a day into sbClaimed nor is blocked by a day the leave loop
    // already claimed. A BS day cannot physically overlap a LeaveRequest today (conflict
    // checks elsewhere prevent it — see that doc block's own "guarantee in principle" note),
    // so this superposition is a purely additive, PRE-EXISTING edge case this plan does not
    // touch (it never modified the absence loop or isBsAbsence) — the two credits stack
    // rather than deduplicating. Documented as a finding, not silently worked around.
    expect(bothEffect).toBe(leaveEffect + bsEffect);
  });
});
