/**
 * Issue #473 - a Berufsschultag of a MONTHLY_HOURS Azubi is credited to worked time at the
 * Ø-day value (monthlyHours x 60 / contractual workdays of the full month), Soll untouched, so the
 * day reduces Soll exactly once and a capped block week cannot turn into a minus. Pure core, no DB.
 * Fixture: June 2026, monthlyHours 44 -> 2640 min, 22 Mo-Fr workdays -> Ø-day 120.
 * Every figure is hand-derived (BBiG § 15 Abs. 2: durchschnittliche Ausbildungszeit).
 */
import { describe, it, expect } from "vitest";
import {
  closeEmployeeMonth,
  type CloseMonthInput,
  type LeaveCreditBasis,
} from "../close-employee-month";
import { monthRangeUtc, monthDayBounds } from "../timezone";

const TZ = "Europe/Berlin";

// ── Schedule shells ──────────────────────────────────────────────────────────

/** Prod shape: {day}Hours uniformly 0 (placeholder), workDays carries the contract (D-05). */
const MH_44: Record<string, unknown> = {
  type: "MONTHLY_HOURS",
  monthlyHours: 44,
  mondayHours: 0,
  tuesdayHours: 0,
  wednesdayHours: 0,
  thursdayHours: 0,
  fridayHours: 0,
  saturdayHours: 0,
  sundayHours: 0,
  workDays: [1, 2, 3, 4, 5],
};

// ── Date / month helpers ─────────────────────────────────────────────────────

/** June 2026 month bounds (tenant TZ). */
function juneBounds() {
  const { start: monthStart, end: monthEnd } = monthRangeUtc(2026, 6, TZ);
  const { firstDay: monthFirstDay, lastDay: monthLastDay } = monthDayBounds(
    monthStart,
    monthEnd,
    TZ,
  );
  return { monthStart, monthEnd, monthFirstDay, monthLastDay };
}

function mkLeave(
  start: string,
  end: string,
  overrides: Partial<CloseMonthInput["approvedLeave"][number]> = {},
): CloseMonthInput["approvedLeave"][number] {
  return {
    startDate: new Date(start + "T00:00:00Z"),
    endDate: new Date(end + "T00:00:00Z"),
    halfDay: false,
    isOvertimeCompensation: false,
    creditBasis: "CONTRACT" as LeaveCreditBasis,
    ...overrides,
  };
}

function mkAbsence(
  start: string,
  end: string,
  type: string,
  source = "MANUAL",
): CloseMonthInput["absences"][number] {
  return {
    startDate: new Date(start + "T00:00:00Z"),
    endDate: new Date(end + "T00:00:00Z"),
    type,
    source,
  };
}

/** Base CloseMonthInput for the June 2026 / MH_44 fixture; callers override as needed. */
function baseInput(overrides: Partial<CloseMonthInput> = {}): CloseMonthInput {
  const bounds = juneBounds();
  return {
    employeeId: "emp-1",
    ...bounds,
    tz: TZ,
    carryOverIn: 0,
    schedule: MH_44,
    hireDate: new Date("2025-01-01T00:00:00Z"),
    exitDate: null,
    isTimeTrackingExempt: false,
    breakOver6hOverride: 0,
    breakOver9hOverride: 0,
    entries: [],
    shifts: [],
    approvedLeave: [],
    absences: [],
    holidayDateStrings: new Set<string>(),
    tenantConfig: {
      defaultBreakOver6h: 30,
      defaultBreakOver9h: 45,
      defaultWorkDays: [1, 2, 3, 4, 5],
    },
    ...overrides,
  };
}

describe("closeEmployeeMonth - Issue #473 MONTHLY_HOURS Berufsschule credit", () => {
  // One school day (Tue 09.06.): credit 2640/22 = 120 worked, Soll stays 2640, balance -2520 -
  // exactly what a leave day at the Ø-value gives (expected 2520, worked 0 -> -2520).
  it("credits one BS day at the Ø-day value, equal to a leave day's effect", () => {
    const bs = closeEmployeeMonth(
      baseInput({
        absences: [mkAbsence("2026-06-09", "2026-06-09", "VOCATIONAL_SCHOOL", "PATTERN")],
      }),
    );
    const leave = closeEmployeeMonth(
      baseInput({ approvedLeave: [mkLeave("2026-06-09", "2026-06-09")] }),
    );
    expect(bs.workedMinutes).toBe(120);
    expect(bs.expectedMinutes).toBe(2640);
    expect(bs.balanceMinutes).toBe(-2520);
    expect(bs.balanceMinutes).toBe(leave.balanceMinutes);
  });

  // Block week Mo 08.-Fr 12.06. (5 BS days): the default 40 h weekly cap (2400 -> 480/day) must
  // not apply; 5 x 120 = 600 worked, balance -2640 + 600 = -2040, same as 5 leave days.
  it("a block week is credited 5 x Ø-day, not the 40 h cap, and equals five leave days", () => {
    const bs = closeEmployeeMonth(
      baseInput({
        absences: [mkAbsence("2026-06-08", "2026-06-12", "VOCATIONAL_SCHOOL", "PATTERN")],
      }),
    );
    const leave = closeEmployeeMonth(
      baseInput({ approvedLeave: [mkLeave("2026-06-08", "2026-06-12")] }),
    );
    expect(bs.workedMinutes).toBe(600);
    expect(bs.expectedMinutes).toBe(2640);
    expect(bs.balanceMinutes).toBe(-2040);
    expect(bs.balanceMinutes).toBe(leave.balanceMinutes);
  });

  // Two BS days in a week (long + short slot): both are credited the Ø-day (120 each).
  it("every daily slot defaults to the Ø-day value", () => {
    const r = closeEmployeeMonth(
      baseInput({
        absences: [mkAbsence("2026-06-09", "2026-06-10", "VOCATIONAL_SCHOOL", "PATTERN")],
      }),
    );
    expect(r.workedMinutes).toBe(240);
    expect(r.expectedMinutes).toBe(2640);
  });

  // A BS date on a non-workday (Sat 13.06.) credits nothing: no Soll ever carried that day.
  it("a Berufsschule day on a non-workday credits nothing", () => {
    const r = closeEmployeeMonth(
      baseInput({
        absences: [mkAbsence("2026-06-13", "2026-06-13", "VOCATIONAL_SCHOOL", "MANUAL")],
      }),
    );
    expect(r.workedMinutes).toBe(0);
    expect(r.balanceMinutes).toBe(-2640);
  });

  // An explicit block-week figure (employee override) stays the owner's deliberate choice.
  it("an explicit bsSlotBlockWeekMinutes override still wins in a block week", () => {
    const r = closeEmployeeMonth(
      baseInput({
        absences: [mkAbsence("2026-06-08", "2026-06-12", "VOCATIONAL_SCHOOL", "PATTERN")],
        employeeSlots: {
          bsSlotFirstLongDayMinutes: null,
          bsSlotSecondLongDayMinutes: null,
          bsSlotShortDayMinutes: null,
          bsSlotBlockWeekMinutes: 1500,
        },
      }),
    );
    expect(r.workedMinutes).toBe(1500);
  });

  // Pure tracking (monthlyHours null) has no Ø-day: nothing is credited (unchanged).
  it("monthlyHours null credits nothing", () => {
    const r = closeEmployeeMonth(
      baseInput({
        schedule: { ...MH_44, monthlyHours: null },
        absences: [mkAbsence("2026-06-09", "2026-06-09", "VOCATIONAL_SCHOOL", "PATTERN")],
      }),
    );
    expect(r.workedMinutes).toBe(0);
  });
});
