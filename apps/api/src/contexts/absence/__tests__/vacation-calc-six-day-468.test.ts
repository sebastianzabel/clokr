/**
 * Issue #468 (D-06) — pure kernel suite for `calculatePartTimeVacation` after removing the
 * `employeeWorkDays >= fullTimeWorkDays` cap.
 *
 * No DB. Two concerns:
 *   1. The new 6/7-day (and fractional-base) proportional values.
 *   2. A byte-identity equivalence property for every workday count 0..5 against a FROZEN copy
 *      of the pre-#468 function body — proving D-06 changed NOTHING for the equal-or-fewer case.
 *      `preIssue468CalculatePartTimeVacation` below is copied verbatim from commit 9b5cb9f5 and
 *      must never be "updated" to follow production — that would defeat the whole point of the
 *      oracle.
 */
import { describe, it, expect } from "vitest";
import {
  calculatePartTimeVacation,
  countWorkDaysPerWeek,
  type ScheduleForCalc,
} from "../vacation-calc";

function ref(workDaysPerWeek: number): ScheduleForCalc {
  return {
    mondayHours: 0,
    tuesdayHours: 0,
    wednesdayHours: 0,
    thursdayHours: 0,
    fridayHours: 0,
    saturdayHours: 0,
    sundayHours: 0,
    contractWorkDaysPerWeek: workDaysPerWeek,
  };
}

/**
 * Frozen oracle — pre-#468 body of `calculatePartTimeVacation` (commit 9b5cb9f5,
 * apps/api/src/contexts/absence/vacation-calc.ts:68-80), verbatim except for the rename. Uses the
 * SAME (unchanged) `countWorkDaysPerWeek` production helper the real function always has.
 */
function preIssue468CalculatePartTimeVacation(
  schedule: ScheduleForCalc,
  fullTimeWorkDays: number,
  baseVacationDays: number,
): number {
  const employeeWorkDays = countWorkDaysPerWeek(schedule);

  if (employeeWorkDays === 0 || fullTimeWorkDays === 0) return 0;
  if (employeeWorkDays >= fullTimeWorkDays) return baseVacationDays;

  const raw = (employeeWorkDays / fullTimeWorkDays) * baseVacationDays;
  // Round to nearest 0.5 (German standard: always round UP to nearest 0.5)
  return Math.ceil(raw * 2) / 2;
}

describe("calculatePartTimeVacation (Issue #468, D-06) — 6/7-day proportional scaling", () => {
  it("6-day week: 6/5 * 30 = 36", () => {
    expect(calculatePartTimeVacation(ref(6), 5, 30)).toBe(36);
  });

  it("7-day week: 7/5 * 30 = 42", () => {
    expect(calculatePartTimeVacation(ref(7), 5, 30)).toBe(42);
  });

  it("6-day week, base 29: 6/5 * 29 = 34.8 -> ceil to 35.0", () => {
    expect(calculatePartTimeVacation(ref(6), 5, 29)).toBe(35);
  });

  it("6-day week, base 24.5: 6/5 * 24.5 = 29.4 -> ceil to 29.5", () => {
    expect(calculatePartTimeVacation(ref(6), 5, 24.5)).toBe(29.5);
  });
});

describe("calculatePartTimeVacation (Issue #468, D-06) — byte-identity for 0..5 days", () => {
  it("equals the frozen pre-#468 oracle for every workday count 0..5 x every base value, toBe (not toBeCloseTo)", () => {
    const workDayCounts = [0, 1, 2, 3, 4, 5];
    const bases = [0, 1, 12.5, 17, 20, 24.5, 25, 27.75, 29, 29.3, 30, 36];
    let checked = 0;

    for (const workDays of workDayCounts) {
      for (const base of bases) {
        const schedule = ref(workDays);
        const actual = calculatePartTimeVacation(schedule, 5, base);
        const expected = preIssue468CalculatePartTimeVacation(schedule, 5, base);
        expect(actual).toBe(expected);
        checked += 1;
      }
    }

    expect(checked).toBe(72);
  });
});
