import { describe, it, expect } from "vitest";
import {
  countWorkDaysPerWeek,
  calculatePartTimeVacation,
  calculateStatutoryMinimum,
  splitDaysAcrossYears,
  calculateProRataVacation,
} from "../vacation-calc";

const fullSchedule = {
  mondayHours: 8,
  tuesdayHours: 8,
  wednesdayHours: 8,
  thursdayHours: 8,
  fridayHours: 8,
  saturdayHours: 0,
  sundayHours: 0,
};
const partTime3Days = {
  mondayHours: 8,
  tuesdayHours: 8,
  wednesdayHours: 8,
  thursdayHours: 0,
  fridayHours: 0,
  saturdayHours: 0,
  sundayHours: 0,
};
const partTime4Days = {
  mondayHours: 8,
  tuesdayHours: 8,
  wednesdayHours: 8,
  thursdayHours: 8,
  fridayHours: 0,
  saturdayHours: 0,
  sundayHours: 0,
};

describe("countWorkDaysPerWeek", () => {
  it("returns 5 for full-time Mon-Fri", () => {
    expect(countWorkDaysPerWeek(fullSchedule)).toBe(5);
  });
  it("returns 3 for 3-day week", () => {
    expect(countWorkDaysPerWeek(partTime3Days)).toBe(3);
  });
  it("returns 0 for all-zero schedule", () => {
    expect(
      countWorkDaysPerWeek({
        mondayHours: 0,
        tuesdayHours: 0,
        wednesdayHours: 0,
        thursdayHours: 0,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
      }),
    ).toBe(0);
  });
});

describe("calculatePartTimeVacation", () => {
  it("returns full days for full-time", () => {
    expect(calculatePartTimeVacation(fullSchedule, 5, 30)).toBe(30);
  });
  it("calculates pro-rata for 3-day week (3/5 * 30 = 18)", () => {
    expect(calculatePartTimeVacation(partTime3Days, 5, 30)).toBe(18);
  });
  it("calculates pro-rata for 4-day week (4/5 * 30 = 24)", () => {
    expect(calculatePartTimeVacation(partTime4Days, 5, 30)).toBe(24);
  });
  it("rounds up to nearest 0.5", () => {
    // 3/5 * 28 = 16.8 → ceil to 17.0
    expect(calculatePartTimeVacation(partTime3Days, 5, 28)).toBe(17);
  });
  it("returns 0 for zero schedule", () => {
    expect(
      calculatePartTimeVacation(
        {
          mondayHours: 0,
          tuesdayHours: 0,
          wednesdayHours: 0,
          thursdayHours: 0,
          fridayHours: 0,
          saturdayHours: 0,
          sundayHours: 0,
        },
        5,
        30,
      ),
    ).toBe(0);
  });
});

describe("calculateStatutoryMinimum", () => {
  it("returns 20 for 5-day week", () => {
    expect(calculateStatutoryMinimum(5)).toBe(20);
  });
  it("returns 24 for 6-day week", () => {
    expect(calculateStatutoryMinimum(6)).toBe(24);
  });
  it("returns 12 for 3-day week", () => {
    expect(calculateStatutoryMinimum(3)).toBe(12);
  });
  it("returns 16 for 4-day week", () => {
    expect(calculateStatutoryMinimum(4)).toBe(16);
  });
});

describe("calculateProRataVacation", () => {
  const YEAR = 2026;

  it("returns baseDays unchanged when exitDate is in a future year", () => {
    // Employee leaves in 2027 → full 2026 entitlement
    expect(calculateProRataVacation(30, YEAR, new Date(2027, 0, 15))).toBe(30);
  });

  it("returns 0 when exitDate is before the year starts", () => {
    // Employee already left in 2025
    expect(calculateProRataVacation(30, YEAR, new Date(2025, 11, 31))).toBe(0);
  });

  it("returns baseDays when exitDate is Dec 31 of the year (12/12)", () => {
    // Last day of year → 12 volle Monate → full entitlement
    expect(calculateProRataVacation(30, YEAR, new Date(YEAR, 11, 31))).toBe(30);
  });

  it("returns 15 when exitDate is Jun 30 and base is 30 (6/12)", () => {
    // Jun 30 is the last day of June → 6 volle Monate → 30 × 6/12 = 15
    expect(calculateProRataVacation(30, YEAR, new Date(YEAR, 5, 30))).toBe(15);
  });

  it("returns baseDays when exitDate is Jul 1 (H2 — § 5 Abs. 2 BUrlG)", () => {
    // July = month index 6 → H2 → full entitlement, no pro-rata
    expect(calculateProRataVacation(30, YEAR, new Date(YEAR, 6, 1))).toBe(30);
  });

  it("returns baseDays when exitDate is Aug 15 (H2)", () => {
    expect(calculateProRataVacation(30, YEAR, new Date(YEAR, 7, 15))).toBe(30);
  });

  it("returns baseDays for non-30 base on H2 exit (base=25, Jul 1)", () => {
    expect(calculateProRataVacation(25, YEAR, new Date(YEAR, 6, 1))).toBe(25);
  });

  it("returns 12.5 when exitDate is Jun 15 and base is 30 (5/12, rounded up)", () => {
    // Jun 15 is NOT the last day of June → 5 volle Monate (Jan-May)
    // 30 × 5/12 = 12.5 → already a half-day, no rounding needed
    expect(calculateProRataVacation(30, YEAR, new Date(YEAR, 5, 15))).toBe(12.5);
  });

  it("rounds UP to nearest 0.5 (base 20, exitDate Mar 20 = 2 volle Monate → 3.5)", () => {
    // Mar 20 is NOT the last day of March → 2 volle Monate (Jan-Feb)
    // 20 × 2/12 = 3.333 → ceil to 3.5
    expect(calculateProRataVacation(20, YEAR, new Date(YEAR, 2, 20))).toBe(3.5);
  });

  it("returns 0 when baseDays is 0", () => {
    expect(calculateProRataVacation(0, YEAR, new Date(YEAR, 5, 30))).toBe(0);
  });

  it("returns 0 for negative baseDays (defensive)", () => {
    expect(calculateProRataVacation(-5, YEAR, new Date(YEAR, 5, 30))).toBe(0);
  });

  it("returns 0 for NaN baseDays (defensive)", () => {
    expect(calculateProRataVacation(NaN, YEAR, new Date(YEAR, 5, 30))).toBe(0);
  });

  it("correctly counts volle Monate: Mar 31 counts March (3/12 for Jan-Mar)", () => {
    // Mar 31 is the last day of March → 3 volle Monate
    // 30 × 3/12 = 7.5 → exactly 7.5
    expect(calculateProRataVacation(30, YEAR, new Date(YEAR, 2, 31))).toBe(7.5);
  });
});

describe("splitDaysAcrossYears", () => {
  const noHolidays = new Set<string>();

  it("returns all days in year1 when same year", () => {
    const start = new Date("2026-03-02");
    const end = new Date("2026-03-06");
    const result = splitDaysAcrossYears(start, end, false, noHolidays);
    expect(result.year1Days).toBe(5);
    expect(result.year2Days).toBe(0);
    expect(result.year1).toBe(2026);
  });

  it("splits across year boundary correctly", () => {
    // 2026: Dec 29 (Tue), 30 (Wed), 31 (Thu) = 3 work days
    // 2027: Jan 1 (Fri) = 1 work day, Jan 2 (Sat) = weekend
    const start = new Date("2026-12-29");
    const end = new Date("2027-01-02");
    const result = splitDaysAcrossYears(start, end, false, noHolidays);
    expect(result.year1).toBe(2026);
    expect(result.year2).toBe(2027);
    expect(result.year1Days).toBe(3);
    expect(result.year2Days).toBe(1); // Jan 1 (Fri), Jan 2 is Sat
  });

  it("excludes holidays from count", () => {
    const holidays = new Set(["2027-01-01"]); // Neujahr
    const start = new Date("2026-12-29");
    const end = new Date("2027-01-02");
    const result = splitDaysAcrossYears(start, end, false, holidays);
    expect(result.year2Days).toBe(1); // Only Jan 2
  });

  it("handles half-day correctly", () => {
    const start = new Date("2026-06-01");
    const end = new Date("2026-06-03");
    const result = splitDaysAcrossYears(start, end, true, noHolidays);
    expect(result.year1Days).toBe(2.5); // 3 days - 0.5
  });
});
