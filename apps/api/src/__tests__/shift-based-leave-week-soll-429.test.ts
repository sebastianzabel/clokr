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
import { monthRangeUtc, monthDayBounds } from "../contexts/working-time-account/timezone";
import { shiftBasedLeaveCreditByDate } from "../contexts/working-time-account/shift-based-leave-credit";

const TZ = "Europe/Berlin";
const { start: JUNE_START, end: JUNE_END } = monthRangeUtc(2026, 6, TZ);
const { firstDay: JUNE_FIRST, lastDay: JUNE_LAST } = monthDayBounds(JUNE_START, JUNE_END, TZ);

const D = (s: string) => new Date(s + "T00:00:00Z");

function daysOfJune(): string[] {
  const out: string[] = [];
  for (let d = 1; d <= 30; d++) out.push(`2026-06-${String(d).padStart(2, "0")}`);
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
