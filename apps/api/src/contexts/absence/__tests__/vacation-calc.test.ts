import { describe, it, expect } from "vitest";
import {
  countWorkDaysPerWeek,
  calculatePartTimeVacation,
  calculateStatutoryMinimum,
  splitDaysAcrossYears,
  calculateProRataVacation,
  calculateProRataVacationForHire,
  countShiftBasedLeaveDays,
  mondayOfWeekUtc,
  leaveDaysPerWeek,
  statutoryMinimumVacationDays,
  statutoryMinimumVacationThreshold,
  statutoryMinimumViolationMessage,
  wartezeitEndDate,
  fullEmploymentMonthsInYear,
  employmentYearVacationDays,
} from "../vacation-calc";
// Phase 107 — single shared tenant-TZ date helper (issue #34); avoids hardcoded calendar
// dates that expire (see project history in CLAUDE.md / docs/testing.md).
import { mondayOfWeekStr, utcMidnight, dowOf } from "../../../__tests__/test-dates";

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

describe("statutoryMinimumVacationDays (Issue #435, D-07/D-08)", () => {
  const YEAR = 2027;

  it.each([
    // [label, birthDate, days, expected]
    ["age 14 (< 16, 30 Werktage), 4-day", new Date(Date.UTC(2012, 5, 15)), 4, 20],
    ["age 14 (< 16, 30 Werktage), 5-day", new Date(Date.UTC(2012, 5, 15)), 5, 25],
    ["age 14 (< 16, 30 Werktage), 6-day", new Date(Date.UTC(2012, 5, 15)), 6, 30],
    ["age 16 (< 17, 27 Werktage), 4-day", new Date(Date.UTC(2010, 5, 15)), 4, 18],
    ["age 16 (< 17, 27 Werktage), 5-day", new Date(Date.UTC(2010, 5, 15)), 5, 22.5],
    ["age 16 (< 17, 27 Werktage), 6-day", new Date(Date.UTC(2010, 5, 15)), 6, 27],
    ["age 17 (< 18, 25 Werktage), 4-day", new Date(Date.UTC(2009, 5, 15)), 4, 16.67],
    ["age 17 (< 18, 25 Werktage), 5-day", new Date(Date.UTC(2009, 5, 15)), 5, 20.83],
    ["age 17 (< 18, 25 Werktage), 6-day", new Date(Date.UTC(2009, 5, 15)), 6, 25],
    ["age 26 (adult, § 3 BUrlG 24 Werktage), 4-day", new Date(Date.UTC(2000, 5, 15)), 4, 16],
    ["age 26 (adult, § 3 BUrlG 24 Werktage), 5-day", new Date(Date.UTC(2000, 5, 15)), 5, 20],
    ["age 26 (adult, § 3 BUrlG 24 Werktage), 6-day", new Date(Date.UTC(2000, 5, 15)), 6, 24],
    ["birthDate null (fail-open adult), 4-day", null, 4, 16],
    ["birthDate null (fail-open adult), 5-day", null, 5, 20],
    ["birthDate null (fail-open adult), 6-day", null, 6, 24],
  ])("%s -> %d", (_label, birthDate, days, expected) => {
    expect(statutoryMinimumVacationDays(birthDate, YEAR, days)).toBe(expected);
  });

  it("§ 187 Abs. 2 S. 2 BGB boundary: born 01.01. is already the new age on 1 January", () => {
    // Born 2011-01-01 -> already 16 on 1.1.2027 -> age<17 band (27 Werktage), 5-day = 22.5
    expect(statutoryMinimumVacationDays(new Date(Date.UTC(2011, 0, 1)), YEAR, 5)).toBe(22.5);
  });

  it("§ 187 Abs. 2 S. 2 BGB boundary: born 02.01. is still the old age on 1 January", () => {
    // Born 2011-01-02 -> still 15 on 1.1.2027 -> age<16 band (30 Werktage), 5-day = 25
    expect(statutoryMinimumVacationDays(new Date(Date.UTC(2011, 0, 2)), YEAR, 5)).toBe(25);
  });

  it("turning 18 during the year drops to the BUrlG band only in the FOLLOWING year", () => {
    // Born 2009-03-10: age 17 at 1.1.2027 (< 18 -> 25 Werktage), age 18 at 1.1.2028 (-> 24 Werktage)
    const birthDate = new Date(Date.UTC(2009, 2, 10));
    expect(statutoryMinimumVacationDays(birthDate, 2027, 5)).toBe(20.83);
    expect(statutoryMinimumVacationDays(birthDate, 2028, 5)).toBe(20);
  });

  it("agrees with calculateStatutoryMinimum for the adult/§3 BUrlG case", () => {
    for (const d of [4, 5, 6]) {
      expect(statutoryMinimumVacationDays(null, YEAR, d)).toBe(calculateStatutoryMinimum(d));
    }
  });

  it("0 / NaN / negative days -> 0", () => {
    expect(statutoryMinimumVacationDays(null, YEAR, 0)).toBe(0);
    expect(statutoryMinimumVacationDays(null, YEAR, NaN)).toBe(0);
    expect(statutoryMinimumVacationDays(null, YEAR, -1)).toBe(0);
  });
});

describe("statutoryMinimumVacationThreshold (Issue #435, D-10)", () => {
  const adult = null;
  it("adult, 5 days, hired 2024 -> 2027: 20 (unchanged across the hire-adjacent years)", () => {
    expect(
      statutoryMinimumVacationThreshold({
        birthDate: adult,
        year: 2027,
        workDaysPerWeek: 5,
        hireDate: new Date(Date.UTC(2024, 0, 1)),
        exitDate: null,
      }),
    ).toBe(20);
  });

  it("hired 2027-06-01 (on/before 1 July -> Wartezeit fulfilled, no pro-rata): 20", () => {
    expect(
      statutoryMinimumVacationThreshold({
        birthDate: adult,
        year: 2027,
        workDaysPerWeek: 5,
        hireDate: new Date(Date.UTC(2027, 5, 1)),
        exitDate: null,
      }),
    ).toBe(20);
  });

  it("hired 2027-10-01 (after 1 July -> hire-year pro-rata, 3/12): 5", () => {
    expect(
      statutoryMinimumVacationThreshold({
        birthDate: adult,
        year: 2027,
        workDaysPerWeek: 5,
        hireDate: new Date(Date.UTC(2027, 9, 1)),
        exitDate: null,
      }),
    ).toBe(5);
  });

  it("hired 2028-03-01, queried for 2027 (not yet employed): 0", () => {
    expect(
      statutoryMinimumVacationThreshold({
        birthDate: adult,
        year: 2027,
        workDaysPerWeek: 5,
        hireDate: new Date(Date.UTC(2028, 2, 1)),
        exitDate: null,
      }),
    ).toBe(0);
  });

  it("exited 2026-06-30, queried for 2027 (not employed that year): 0", () => {
    expect(
      statutoryMinimumVacationThreshold({
        birthDate: adult,
        year: 2027,
        workDaysPerWeek: 5,
        hireDate: new Date(Date.UTC(2020, 0, 1)),
        exitDate: new Date(Date.UTC(2026, 5, 30)),
      }),
    ).toBe(0);
  });

  it("exit 30.06. inside the queried year: the threshold is twelfthed like the regular entitlement — § 5 Abs. 1 c BUrlG, Issue #447 D-11", () => {
    expect(
      statutoryMinimumVacationThreshold({
        birthDate: adult,
        year: 2027,
        workDaysPerWeek: 5,
        hireDate: new Date(Date.UTC(2020, 0, 1)),
        exitDate: new Date(Date.UTC(2027, 5, 30)),
      }),
    ).toBe(10);
  });

  it("exit 01.07. inside the queried year: second half-year after a fulfilled Wartezeit -> full threshold (Issue #447 D-11)", () => {
    expect(
      statutoryMinimumVacationThreshold({
        birthDate: adult,
        year: 2027,
        workDaysPerWeek: 5,
        hireDate: new Date(Date.UTC(2020, 0, 1)),
        exitDate: new Date(Date.UTC(2027, 6, 1)),
      }),
    ).toBe(20);
  });

  it("minor born 2012-06-15, 5 days, hired 2024, year 2027: 25", () => {
    expect(
      statutoryMinimumVacationThreshold({
        birthDate: new Date(Date.UTC(2012, 5, 15)),
        year: 2027,
        workDaysPerWeek: 5,
        hireDate: new Date(Date.UTC(2024, 0, 1)),
        exitDate: null,
      }),
    ).toBe(25);
  });
});

describe("statutoryMinimumViolationMessage (Issue #435, D-10/D-11)", () => {
  it("minor (age < 18 on 1 Jan of year) -> § 19 JArbSchG, German-formatted number", () => {
    const msg = statutoryMinimumViolationMessage(20.83, new Date(Date.UTC(2009, 5, 15)), 2027);
    expect(msg).toContain("20,83 Tagen");
    expect(msg).toContain("§ 19 JArbSchG");
    expect(msg).not.toContain("2009"); // never the birth year (T-435-16)
  });

  it("birthDate null (adult) -> § 3 BUrlG, whole number has no trailing comma", () => {
    const msg = statutoryMinimumViolationMessage(20, null, 2027);
    expect(msg).toContain("20 Tagen");
    expect(msg).toContain("§ 3 BUrlG");
  });

  it("half-day fraction formats with a single decimal (22,5, not 22,50)", () => {
    const msg = statutoryMinimumViolationMessage(22.5, new Date(Date.UTC(2010, 5, 15)), 2027);
    expect(msg).toContain("22,5 Tagen");
  });

  it("an adult birthDate (age >= 18 on 1 Jan of year) -> § 3 BUrlG, not § 19 JArbSchG", () => {
    const msg = statutoryMinimumViolationMessage(20, new Date(Date.UTC(2000, 5, 15)), 2027);
    expect(msg).toContain("§ 3 BUrlG");
    expect(msg).not.toContain("§ 19 JArbSchG");
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

  it("rounds a >= half-day fraction UP to a FULL day (base 30, exitDate Jun 15 = 5/12 = 12.5 -> 13, Issue #421)", () => {
    // Jun 15 is NOT the last day of June → 5 volle Monate (Jan-May)
    // 30 × 5/12 = 12.5 → § 5 Abs. 2 BUrlG: fraction >= 0.5 rounds UP to a full day, not to the
    // nearest half day. This is the issue's own example (Issue #421).
    expect(calculateProRataVacation(30, YEAR, new Date(YEAR, 5, 15))).toBe(13);
  });

  it("keeps a < half-day fraction EXACT, never rounded to nearest 0.5 (base 20, exitDate Mar 20 = 2 volle Monate = 3.33.., Issue #421)", () => {
    // Mar 20 is NOT the last day of March → 2 volle Monate (Jan-Feb)
    // 20 × 2/12 = 3.333.. → fraction < 0.5, stays exact to 2 decimals (never rounded to 3.5)
    expect(calculateProRataVacation(20, YEAR, new Date(YEAR, 2, 20))).toBe(3.33);
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

  it("correctly counts volle Monate: Mar 31 counts March (3/12 for Jan-Mar), rounds exact half day UP (Issue #421)", () => {
    // Mar 31 is the last day of March → 3 volle Monate
    // 30 × 3/12 = 7.5 → exactly a half-day fraction → § 5 Abs. 2 BUrlG rounds it UP to 8
    expect(calculateProRataVacation(30, YEAR, new Date(YEAR, 2, 31))).toBe(8);
  });

  it("§ 5 Abs. 2 BUrlG (Issue #421): 7.5 -> 8 (half-day fraction rounds up to a full day)", () => {
    // Mirrors calculateProRataVacationForHire(30, YEAR, new Date(YEAR, 2, 31)) semantics —
    // same rounding rule, same raw value, EXIT function instead of HIRE function.
    expect(calculateProRataVacation(30, YEAR, new Date(YEAR, 2, 31))).toBe(8);
  });

  it("§ 5 Abs. 2 BUrlG (Issue #421): 12.5 -> 13, identical to calculateProRataVacationForHire's proven scenario", () => {
    // calculateProRataVacationForHire(30, YEAR, new Date(YEAR, 7, 1)) === 13 for the same raw
    // value (30 * 5/12 = 12.5). The EXIT function must now produce the identical rounded result
    // for an equivalent raw value.
    expect(calculateProRataVacation(30, YEAR, new Date(YEAR, 5, 15))).toBe(13);
  });

  it("§ 5 Abs. 2 BUrlG (Issue #421): 8.33 stays 8.33 (fraction below half a day is never rounded)", () => {
    // base 25, 4 volle Monate (Jan-Apr, exitDate = Apr 30) → 25 × 4/12 = 8.333.. → stays exact,
    // mirrors calculateProRataVacationForHire(25, YEAR, new Date(YEAR, 8, 1)) === 8.33.
    expect(calculateProRataVacation(25, YEAR, new Date(YEAR, 3, 30))).toBe(8.33);
  });
});

describe("calculateProRataVacationForHire (Issue #416)", () => {
  const YEAR = 2026;

  it("returns baseDays unchanged when hire is Jan 1 (full year)", () => {
    expect(calculateProRataVacationForHire(30, YEAR, new Date(YEAR, 0, 1))).toBe(30);
  });

  it("returns 15 when hire is Jul 1 and base is 30 (6/12)", () => {
    expect(calculateProRataVacationForHire(30, YEAR, new Date(YEAR, 6, 1))).toBe(15);
  });

  it("§ 5 Abs. 2 BUrlG (BAG): a fraction >= 0.5 day rounds UP to a full day — Dec 31 hire, 1/12 of 30 = 2.5 -> 3", () => {
    expect(calculateProRataVacationForHire(30, YEAR, new Date(YEAR, 11, 31))).toBe(3);
  });

  it("§ 5 Abs. 2 BUrlG (BAG): a fraction >= 0.5 day rounds UP — 30 * 3/12 = 7.5 -> 8 (owner worked example, #416)", () => {
    // Oct 1 hire -> Oct/Nov/Dec = 3 full months remaining.
    expect(calculateProRataVacationForHire(30, YEAR, new Date(YEAR, 9, 1))).toBe(8);
  });

  it("§ 5 Abs. 2 BUrlG (BAG): a fraction >= 0.5 day rounds UP — 30 * 5/12 = 12.5 -> 13 (owner worked example, #416)", () => {
    // Aug 1 hire -> Aug/Sep/Oct/Nov/Dec = 5 full months remaining.
    expect(calculateProRataVacationForHire(30, YEAR, new Date(YEAR, 7, 1))).toBe(13);
  });

  it("§ 5 Abs. 2 BUrlG (BAG): a fraction < 0.5 day is NOT rounded to 0.5 — it is kept as the exact fraction (2 decimals) — 25 * 4/12 = 8.33...", () => {
    // Sep 1 hire -> Sep/Oct/Nov/Dec = 4 full months remaining. 25 * 4/12 = 8.3333... -> 8.33,
    // not the old round-to-nearest-0.5 result (8.5) that calculatePartTimeVacation uses elsewhere.
    expect(calculateProRataVacationForHire(25, YEAR, new Date(YEAR, 8, 1))).toBe(8.33);
  });

  it("returns 0 when hireDate is in a future year", () => {
    expect(calculateProRataVacationForHire(30, YEAR, new Date(YEAR + 1, 0, 15))).toBe(0);
  });

  it("returns baseDays unchanged when hireDate is in a prior year", () => {
    expect(calculateProRataVacationForHire(30, YEAR, new Date(YEAR - 1, 5, 1))).toBe(30);
  });

  it("a hire on the 3rd of a month still counts that month as full (no day-level proration)", () => {
    // Hired Jul 3 → same 6/12 result as Jul 1 above — the hire month always counts in full.
    expect(calculateProRataVacationForHire(30, YEAR, new Date(YEAR, 6, 3))).toBe(15);
  });

  it("hire on the last day of a month vs. the first day of the next month differ by exactly one month's worth", () => {
    // Jan 31 → whole year still counts (Jan itself counts in full) = 12/12.
    const lastDayOfJan = calculateProRataVacationForHire(24, YEAR, new Date(YEAR, 0, 31));
    // Feb 1 → January no longer counts = 11/12.
    const firstDayOfFeb = calculateProRataVacationForHire(24, YEAR, new Date(YEAR, 1, 1));
    expect(lastDayOfJan).toBe(24); // 24 * 12/12 = 24
    expect(firstDayOfFeb).toBe(22); // 24 * 11/12 = 22
  });

  it("returns 0 for baseDays 0", () => {
    expect(calculateProRataVacationForHire(0, YEAR, new Date(YEAR, 5, 1))).toBe(0);
  });

  it("returns 0 for negative baseDays (defensive)", () => {
    expect(calculateProRataVacationForHire(-5, YEAR, new Date(YEAR, 5, 1))).toBe(0);
  });

  it("returns 0 for NaN baseDays (defensive)", () => {
    expect(calculateProRataVacationForHire(NaN, YEAR, new Date(YEAR, 5, 1))).toBe(0);
  });
});

describe("wartezeitEndDate (§ 4 BUrlG; §§ 187 Abs. 2, 188 Abs. 2/3 BGB — Issue #447 D-05)", () => {
  it("01.01.2027 -> 30.06.2027", () => {
    expect(wartezeitEndDate(new Date(2027, 0, 1))).toEqual(new Date(2027, 5, 30));
  });
  it("01.07.2027 -> 31.12.2027", () => {
    expect(wartezeitEndDate(new Date(2027, 6, 1))).toEqual(new Date(2027, 11, 31));
  });
  it("15.02.2027 -> 14.08.2027", () => {
    expect(wartezeitEndDate(new Date(2027, 1, 15))).toEqual(new Date(2027, 7, 14));
  });
  it("31.08.2027 -> 29.02.2028 (no numerically matching day six months later, leap year)", () => {
    expect(wartezeitEndDate(new Date(2027, 7, 31))).toEqual(new Date(2028, 1, 29));
  });
  it("31.08.2026 -> 28.02.2027 (no numerically matching day six months later, non-leap year)", () => {
    expect(wartezeitEndDate(new Date(2026, 7, 31))).toEqual(new Date(2027, 1, 28));
  });
});

describe("fullEmploymentMonthsInYear (Issue #447 D-05) — one span twelfthing, hire + exit combined", () => {
  it("(2027, 01.02.2027, 30.06.2027) -> 5", () => {
    expect(fullEmploymentMonthsInYear(2027, new Date(2027, 1, 1), new Date(2027, 5, 30))).toBe(5);
  });
  it("(2027, 2024-01-01, 31.03.2027) -> 3", () => {
    expect(fullEmploymentMonthsInYear(2027, new Date(2024, 0, 1), new Date(2027, 2, 31))).toBe(3);
  });
  it("(2027, 2024-01-01, 15.06.2027) -> 5", () => {
    expect(fullEmploymentMonthsInYear(2027, new Date(2024, 0, 1), new Date(2027, 5, 15))).toBe(5);
  });
  it("(2027, 01.07.2027, 30.11.2027) -> 5", () => {
    expect(fullEmploymentMonthsInYear(2027, new Date(2027, 6, 1), new Date(2027, 10, 30))).toBe(5);
  });
  it("(2027, 02.07.2027, null) -> 6", () => {
    expect(fullEmploymentMonthsInYear(2027, new Date(2027, 6, 2), null)).toBe(6);
  });
  it("(2027, 2024-01-01, null) -> 12", () => {
    expect(fullEmploymentMonthsInYear(2027, new Date(2024, 0, 1), null)).toBe(12);
  });
  it("(2027, 2024-01-01, exit in 2028) -> 12", () => {
    expect(fullEmploymentMonthsInYear(2027, new Date(2024, 0, 1), new Date(2028, 2, 31))).toBe(12);
  });
  it("(2027, hire 2028, null) -> 0", () => {
    expect(fullEmploymentMonthsInYear(2027, new Date(2028, 0, 15), null)).toBe(0);
  });
});

describe("employmentYearVacationDays — exit year (Issue #447, D-05)", () => {
  it("base 24, hire 01.02.2027, exit 30.06.2027 -> 10 (D-09 '10 not 12': Wartezeit not fulfilled)", () => {
    expect(employmentYearVacationDays(24, 2027, new Date(2027, 1, 1), new Date(2027, 5, 30))).toBe(
      10,
    );
  });
  it("base 23, hire 01.07.2027, exit 30.11.2027 -> 10 (D-09 '10 not 23': Wartezeit not fulfilled)", () => {
    expect(employmentYearVacationDays(23, 2027, new Date(2027, 6, 1), new Date(2027, 10, 30))).toBe(
      10,
    );
  });
  it("base 30, hire 2024-01-01, exit 31.03.2027 -> 8 (H1 after Wartezeit, 3/12 = 7.5 -> 8)", () => {
    expect(employmentYearVacationDays(30, 2027, new Date(2024, 0, 1), new Date(2027, 2, 31))).toBe(
      8,
    );
  });
  it("base 30, hire 2024-01-01, exit 30.06.2027 -> 15", () => {
    expect(employmentYearVacationDays(30, 2027, new Date(2024, 0, 1), new Date(2027, 5, 30))).toBe(
      15,
    );
  });
  it("base 30, hire 2024-01-01, exit 15.06.2027 -> 13 (12.5 -> 13)", () => {
    expect(employmentYearVacationDays(30, 2027, new Date(2024, 0, 1), new Date(2027, 5, 15))).toBe(
      13,
    );
  });
  it("base 30, hire 2024-01-01, exit 01.07.2027 -> 30 (H2, full)", () => {
    expect(employmentYearVacationDays(30, 2027, new Date(2024, 0, 1), new Date(2027, 6, 1))).toBe(
      30,
    );
  });
  it("base 30, hire 01.03.2027, exit 31.10.2027 -> 30 (Wartezeit ended 31.08., H2 -> full; supersedes RESEARCH row 467)", () => {
    expect(employmentYearVacationDays(30, 2027, new Date(2027, 2, 1), new Date(2027, 9, 31))).toBe(
      30,
    );
  });
  it("base 30, hire 01.10.2026, exit 15.03.2027 -> 5 (Wartezeit ends 31.03.2027 -> not fulfilled -> Jan, Feb = 2/12)", () => {
    expect(employmentYearVacationDays(30, 2027, new Date(2026, 9, 1), new Date(2027, 2, 15))).toBe(
      5,
    );
  });
  it("base 30, hire 01.10.2026, exit 30.09.2027 -> 30 (Wartezeit fulfilled 31.03.2027, H2 -> full)", () => {
    expect(employmentYearVacationDays(30, 2027, new Date(2026, 9, 1), new Date(2027, 8, 30))).toBe(
      30,
    );
  });
  it("base 30, year 2027, hire 02.07.2027, exit 31.03.2028 (later year) -> 15 (identical to hireYearVacationDays)", () => {
    expect(employmentYearVacationDays(30, 2027, new Date(2027, 6, 2), new Date(2028, 2, 31))).toBe(
      15,
    );
  });
  it("base 30, year 2027, exit 31.12.2026 (earlier year) -> 0", () => {
    expect(employmentYearVacationDays(30, 2027, new Date(2024, 0, 1), new Date(2026, 11, 31))).toBe(
      0,
    );
  });

  it.each([
    [new Date(2027, 0, 1), 20],
    [new Date(2027, 5, 1), 20],
    [new Date(2027, 6, 1), 20],
    [new Date(2027, 6, 2), 10],
    [new Date(2027, 9, 1), 5],
  ])(
    "exitDate null, base 20, hire %s -> %i (identical to hireYearVacationDays — the #435 table)",
    (hireDate, expected) => {
      expect(employmentYearVacationDays(20, 2027, hireDate, null)).toBe(expected);
    },
  );
});

describe("splitDaysAcrossYears", () => {
  const noHolidays = new Set<string>();
  const MO_FR = [1, 2, 3, 4, 5];
  const DI_SA = [2, 3, 4, 5, 6]; // Frisör: Di-Sa

  it("returns all days in year1 when same year", () => {
    const start = new Date("2026-03-02");
    const end = new Date("2026-03-06");
    const result = splitDaysAcrossYears(start, end, false, MO_FR, noHolidays);
    expect(result.year1Days).toBe(5);
    expect(result.year2Days).toBe(0);
    expect(result.year1).toBe(2026);
  });

  it("splits across year boundary correctly", () => {
    // 2026: Dec 29 (Tue), 30 (Wed), 31 (Thu) = 3 work days
    // 2027: Jan 1 (Fri) = 1 work day, Jan 2 (Sat) = weekend
    const start = new Date("2026-12-29");
    const end = new Date("2027-01-02");
    const result = splitDaysAcrossYears(start, end, false, MO_FR, noHolidays);
    expect(result.year1).toBe(2026);
    expect(result.year2).toBe(2027);
    expect(result.year1Days).toBe(3);
    expect(result.year2Days).toBe(1); // Jan 1 (Fri), Jan 2 is Sat
  });

  it("excludes holidays from count", () => {
    // 2027: Jan 1 (Fri) is Neujahr (holiday → excluded),
    //       Jan 2 (Sat), Jan 3 (Sun) are weekend (not in MO_FR),
    //       Jan 4 (Mon) is the only workday → year2Days = 1
    const holidays = new Set(["2027-01-01"]); // Neujahr
    const start = new Date("2026-12-29");
    const end = new Date("2027-01-04");
    const result = splitDaysAcrossYears(start, end, false, MO_FR, holidays);
    expect(result.year2Days).toBe(1); // Only Jan 4
  });

  it("handles half-day correctly", () => {
    // Phase 49.5: halfDay → year1Days = 0.5, year2Days = 0 (single-year halfDay request)
    const start = new Date("2026-06-01");
    const end = new Date("2026-06-03");
    const result = splitDaysAcrossYears(start, end, true, MO_FR, noHolidays);
    expect(result.year1Days).toBe(0.5);
  });

  // Phase 49.5 — workDays-aware counting
  it("Frisör (Di-Sa) Urlaub Mo-Sa zählt 5 Arbeitstage", () => {
    // 2026-05-25 Mon → not in workDays
    // 26 Tue, 27 Wed, 28 Thu, 29 Fri, 30 Sat → 5 days
    const start = new Date("2026-05-25");
    const end = new Date("2026-05-30");
    const result = splitDaysAcrossYears(start, end, false, DI_SA, noHolidays);
    expect(result.year1Days).toBe(5);
  });

  it("4-Tage-Woche (Mo-Do) Urlaub Mo-Fr zählt 4 Arbeitstage", () => {
    const MO_DO = [1, 2, 3, 4];
    const start = new Date("2026-05-04"); // Mon
    const end = new Date("2026-05-08"); // Fri
    const result = splitDaysAcrossYears(start, end, false, MO_DO, noHolidays);
    expect(result.year1Days).toBe(4);
  });

  it("Sa-Schicht-MA: Urlaub nur Sa wird gezählt", () => {
    const SAT_ONLY = [6];
    const start = new Date("2026-05-04"); // Mon
    const end = new Date("2026-05-09"); // Sat
    const result = splitDaysAcrossYears(start, end, false, SAT_ONLY, noHolidays);
    expect(result.year1Days).toBe(1); // Only Sat
  });
});

// ── Phase 107 (D-05..D-09, D-28/D-29) ──────────────────────────────────────────────────────
//
// Every fixture date below is derived from mondayOfWeekStr() (apps/api/src/__tests__/
// test-dates.ts) rather than a hardcoded calendar date, so this block cannot become a time
// bomb (project history: hardcoded-date tests expiring; see CLAUDE.md / docs/testing.md).

const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC "YYYY-MM-DD" of a Date — matches the format countShiftBasedLeaveDays() itself uses. */
function ds(d: Date): string {
  return d.toISOString().split("T")[0];
}

/** `n` whole days after the fixture Monday (UTC midnight). n=0 -> Monday, n=6 -> Sunday, … */
function mon(n: number): Date {
  return new Date(utcMidnight(MONDAY).getTime() + n * DAY_MS);
}

// Anchor: the Monday of the ISO week containing "today" (tenant TZ) — never a fixed calendar
// date, always a genuine Monday.
const MONDAY = mondayOfWeekStr();
const NO_HOLIDAYS = new Set<string>();

describe("countShiftBasedLeaveDays — by contract, roster-independent (Issue #417, supersedes Phase 107 D-05..D-09)", () => {
  it("fixture week's Monday is genuinely a Monday (pins the week-cutting primitive)", () => {
    // Two independent implementations must agree: test-dates.ts's dowOf() (tenant-TZ string
    // arithmetic) and vacation-calc.ts's own exported mondayOfWeekUtc() (pure UTC). If either
    // week-cutting primitive ever drifts, this fails here instead of every day-count silently
    // shifting by one.
    expect(dowOf(MONDAY)).toBe(1);
    expect(mondayOfWeekUtc(mon(2)).getTime()).toBe(utcMidnight(MONDAY).getTime()); // Wed -> Mon
  });

  it("AC-417-c: a whole vacation week on a 5-day contract costs 5 days", () => {
    // Also the issue #425 4th fixture (Test D: 5-day contract, full Mo–So week -> 5) — reused
    // as-is, not duplicated.
    const start = mon(0); // Monday
    const end = mon(6); // Sunday
    const result = countShiftBasedLeaveDays(start, end, false, 5, NO_HOLIDAYS);
    expect(result).toEqual({ days: 5, provisional: false });
  });

  // ── Issue #425: a partial ISO-week fragment must not count Sunday as a vacation-consuming
  // day (§ 3 Abs. 2 BUrlG: Sunday is not a Werktag). These five fixtures use literal calendar
  // dates (real 2026 dates, including real NI public holidays) rather than the mon()/ds()
  // relative helpers, because they pin the exact historical regression from Issue #425.
  it("#425 Test A: 4-day contract, Fri 2026-09-11 – Mon 2026-09-14 costs 3 days (not 4)", () => {
    const start = new Date("2026-09-11"); // Fri
    const end = new Date("2026-09-14"); // Mon
    const result = countShiftBasedLeaveDays(start, end, false, 4, NO_HOLIDAYS);
    // Week 1 fragment Fri-Sat = 2 (Sunday 09-13 excluded), week 2 fragment Mon-only = 1, total 3.
    expect(result).toEqual({ days: 3, provisional: false });
  });

  it("#425 Test B: 4-day contract, 2026-07-23 – 2026-07-29 costs 6 days", () => {
    const start = new Date("2026-07-23");
    const end = new Date("2026-07-29");
    const result = countShiftBasedLeaveDays(start, end, false, 4, NO_HOLIDAYS);
    expect(result).toEqual({ days: 6, provisional: false });
  });

  it("#425 Test C: 4-day contract, 2026-04-01 – 2026-04-07 with Karfreitag + Ostermontag costs 4 days", () => {
    const start = new Date("2026-04-01");
    const end = new Date("2026-04-07");
    const holidays = new Set(["2026-04-03", "2026-04-06"]); // Karfreitag, Ostermontag
    const result = countShiftBasedLeaveDays(start, end, false, 4, holidays);
    expect(result).toEqual({ days: 4, provisional: false });
  });

  it("#425 Test E: a single Sunday costs 0 leave days", () => {
    const start = new Date("2026-09-13"); // Sun
    const end = new Date("2026-09-13");
    const result = countShiftBasedLeaveDays(start, end, false, 5, NO_HOLIDAYS);
    expect(result).toEqual({ days: 0, provisional: false });
  });

  it("#425 D-07: a Mo–Sa request costs the same as the identical Mo–So request (whole-week redefinition)", () => {
    // 4-day contract, one Mo–Sat week with one Mo–Sat holiday. Without D-07's redefinition of
    // "whole", the Mo–Sa request would be treated as a FRAGMENT (min(5,4)=4) while the
    // Mo–So request is a WHOLE week (4-1=3) — a non-working Sunday must never lower the cost.
    const holidays = new Set(["2026-09-16"]); // Wed
    const moSa = countShiftBasedLeaveDays(
      new Date("2026-09-14"), // Mon
      new Date("2026-09-19"), // Sat
      false,
      4,
      holidays,
    );
    const moSo = countShiftBasedLeaveDays(
      new Date("2026-09-14"), // Mon
      new Date("2026-09-20"), // Sun
      false,
      4,
      holidays,
    );
    expect(moSa).toEqual({ days: 3, provisional: false });
    expect(moSo).toEqual({ days: 3, provisional: false });
  });

  it("#425 monotonicity: with a Mo–Sat holiday, a Mo–Fr fragment never costs more than the whole Mo–Sa week", () => {
    // 4-day contract, Wednesday holiday. Fragment Mo–Fr: min(5 Mo-Sat days, 4) - 1 holiday = 3.
    // Counting non-holiday days first and capping afterwards would give min(4, 4) = 4 — more
    // than the whole week (4 - 1 = 3), i.e. adding Saturday would make the request cheaper.
    const holidays = new Set(["2026-09-16"]); // Wed
    const moFr = countShiftBasedLeaveDays(
      new Date("2026-09-14"), // Mon
      new Date("2026-09-18"), // Fri
      false,
      4,
      holidays,
    );
    expect(moFr).toEqual({ days: 3, provisional: false });
  });

  it("#425: a holiday on a Sunday never reduces the count — whole week or fragment", () => {
    const sundayHoliday = new Set(["2026-09-20"]); // Sun
    const wholeWeek = countShiftBasedLeaveDays(
      new Date("2026-09-14"), // Mon
      new Date("2026-09-20"), // Sun
      false,
      5,
      sundayHoliday,
    );
    expect(wholeWeek).toEqual({ days: 5, provisional: false });
    const fragment = countShiftBasedLeaveDays(
      new Date("2026-09-17"), // Thu
      new Date("2026-09-20"), // Sun
      false,
      5,
      sundayHoliday,
    );
    // Thu, Fri, Sat = 3 Mo-Sat days, capped at 5 -> 3; the Sunday holiday is not deducted.
    expect(fragment).toEqual({ days: 3, provisional: false });
  });

  it("two whole ISO weeks, count 5 -> 10 days, never provisional", () => {
    const start = mon(0); // Monday, week A
    const end = mon(13); // Sunday, week B (the second Sunday)
    const result = countShiftBasedLeaveDays(start, end, false, 5, NO_HOLIDAYS);
    expect(result).toEqual({ days: 10, provisional: false });
  });

  it("a single requested day (fragment of 1 calendar day) costs 1 day on a 5-day contract", () => {
    // AC-417-a's unit-level counterpart: a single Tuesday, regardless of any roster —
    // this function no longer takes a roster parameter at all.
    const start = mon(1); // Tue
    const end = mon(1); // Tue
    const result = countShiftBasedLeaveDays(start, end, false, 5, NO_HOLIDAYS);
    expect(result).toEqual({ days: 1, provisional: false });
  });

  it("Mon-Tue fragment costs 2 days on a 5-day contract, independent of any roster shape", () => {
    const start = mon(0); // Mon
    const end = mon(1); // Tue
    const result = countShiftBasedLeaveDays(start, end, false, 5, NO_HOLIDAYS);
    expect(result).toEqual({ days: 2, provisional: false });
  });

  it("upper bound: Wed-Sun fragment (5 calendar days), count 4 -> 4 days, never provisional", () => {
    const start = mon(2); // Wed
    const end = mon(6); // Sun
    const result = countShiftBasedLeaveDays(start, end, false, 4, NO_HOLIDAYS);
    // Issue #425: 4 Mo-Sat days (Wed..Sat; Sunday never counts), min(4, count 4) = 4 — the count
    // caps the Mo-Sat day count, not vice versa. (Before #425 this read min(5 calendar days, 4).)
    expect(result).toEqual({ days: 4, provisional: false });
  });

  it("a holiday inside a fragment reduces the count by 1", () => {
    const start = mon(0); // Mon
    const end = mon(1); // Tue
    const holidays = new Set([ds(mon(1))]); // Tuesday is a public holiday
    const result = countShiftBasedLeaveDays(start, end, false, 5, holidays);
    // min(2 Mo-Sat days, count 5) = 2, minus 1 Mo-Sat holiday in the fragment = 1
    expect(result).toEqual({ days: 1, provisional: false });
  });

  it("a holiday inside a WHOLE week also reduces the count by 1 (uniform holiday exclusion, Issue #417 AC)", () => {
    const start = mon(0); // Mon
    const end = mon(6); // Sun — a whole week
    const holidays = new Set([ds(mon(2))]); // Wednesday is a public holiday
    const result = countShiftBasedLeaveDays(start, end, false, 5, holidays);
    expect(result).toEqual({ days: 4, provisional: false });
  });

  it("floor: count 1, 2 holidays in the fragment -> 0, never negative", () => {
    const start = mon(0); // Mon
    const end = mon(1); // Tue
    const holidays = new Set([ds(mon(0)), ds(mon(1))]); // both days are holidays
    const result = countShiftBasedLeaveDays(start, end, false, 1, holidays);
    // min(2 Mo-Sat days, 1) = 1, minus 2 Mo-Sat holidays = -1 -> floored at 0, never negative
    expect(result).toEqual({ days: 0, provisional: false });
  });

  it("halfDay short-circuits to 0.5, never provisional", () => {
    const start = mon(0);
    const end = mon(0);
    const result = countShiftBasedLeaveDays(start, end, true, 5, NO_HOLIDAYS);
    expect(result).toEqual({ days: 0.5, provisional: false });
  });

  it("mixed period (fragment + 2 whole weeks + fragment): sums every week's contract-capped contribution, never provisional", () => {
    const start = mon(2); // Wed, week A
    const end = mon(24); // Thu, week D (3 weeks + 3 days later)
    const count = 5;

    const result = countShiftBasedLeaveDays(start, end, false, count, NO_HOLIDAYS);
    // Corrected for Issue #425 (Sunday is never a Werktag, § 3 Abs. 2 BUrlG) — this is the
    // literal Sunday-counting bug #425 fixes, caught inside the #417 suite itself; not a
    // relaxed assertion (CLAUDE.md "No test manipulation for green CI").
    // Week A fragment (Wed..Sun): OLD counted all 5 calendar days (incl. Sunday) -> min(5,5)=5.
    //   NEW counts only the 4 Mo-Sat days (Wed,Thu,Fri,Sat) -> min(4,5) = 4.
    // Week B + Week C: WHOLE, no holidays -> unchanged, 5 + 5 = 10.
    // Week D fragment (Mon..Thu, no Sunday in range): unchanged, min(4,5) = 4.
    // Total: OLD 5+5+5+4=19 -> NEW 4+5+5+4=18.
    expect(result).toEqual({ days: 18, provisional: false });
  });

  it("is DB-free and callable without Fastify or a Prisma client", () => {
    // No import of Fastify/@clokr/db appears anywhere in this file or in vacation-calc.ts
    // (enforced by Task 1's own acceptance criteria) — this call is the behavioral proof: it
    // runs to completion with nothing but plain JS values.
    expect(() => countShiftBasedLeaveDays(mon(0), mon(1), false, 5, new Set())).not.toThrow();
  });
});

describe("leaveDaysPerWeek — same kernel as countShiftBasedLeaveDays (Issue #429, D-01/D-02)", () => {
  it("matches countShiftBasedLeaveDays for a single full-day row (contract c=4, Mon-Thu)", () => {
    const c = 4;
    const start = mon(0); // Mon
    const end = mon(3); // Thu
    const weeks = leaveDaysPerWeek([{ startDate: start, endDate: end }], c, NO_HOLIDAYS);
    expect(weeks).toHaveLength(1);
    const entry = weeks[0];
    const expected = countShiftBasedLeaveDays(start, end, false, c, NO_HOLIDAYS);
    expect(entry.days).toBe(expected.days);
    const sumShares = Array.from(entry.dayShares.values()).reduce((a, b) => a + b, 0);
    expect(sumShares).toBeCloseTo(entry.days);
  });
});

describe("leaveDaysPerWeek — properties (D-02)", () => {
  it("parity fuzz: total days matches countShiftBasedLeaveDays for every generated (offset, length, c) combination", () => {
    // 14 offsets x 21 lengths x 6 contract values = 1764 combinations, one full-day row per
    // combination, no dependency added (plain nested loops, per this plan's own decision).
    const mismatches: string[] = [];
    for (let startOffsetDays = 0; startOffsetDays <= 13; startOffsetDays++) {
      for (let lengthDays = 1; lengthDays <= 21; lengthDays++) {
        for (let c = 1; c <= 6; c++) {
          const start = mon(startOffsetDays);
          const end = mon(startOffsetDays + lengthDays - 1);
          const weeks = leaveDaysPerWeek([{ startDate: start, endDate: end }], c, NO_HOLIDAYS);
          const totalFromWeeks = weeks.reduce((sum, w) => sum + w.days, 0);
          const expected = countShiftBasedLeaveDays(start, end, false, c, NO_HOLIDAYS).days;
          if (totalFromWeeks !== expected) {
            mismatches.push(
              `offset=${startOffsetDays} length=${lengthDays} c=${c}: got ${totalFromWeeks}, expected ${expected}`,
            );
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("half-day row: one LeaveWeek entry with days 0.5 and a single dayShares entry of 0.5", () => {
    const start = mon(1); // Tue
    const weeks = leaveDaysPerWeek(
      [{ startDate: start, endDate: start, halfDay: true }],
      5,
      NO_HOLIDAYS,
    );
    expect(weeks).toHaveLength(1);
    expect(weeks[0].days).toBe(0.5);
    expect(weeks[0].dayShares.size).toBe(1);
    expect(weeks[0].dayShares.get(ds(start))).toBe(0.5);
  });

  it("union of two overlapping full-day rows equals a single row covering their union", () => {
    const c = 4;
    const overlapping = leaveDaysPerWeek(
      [
        { startDate: mon(0), endDate: mon(2) }, // Mon-Wed
        { startDate: mon(1), endDate: mon(3) }, // Tue-Thu
      ],
      c,
      NO_HOLIDAYS,
    );
    const union = leaveDaysPerWeek([{ startDate: mon(0), endDate: mon(3) }], c, NO_HOLIDAYS); // Mon-Thu
    const overlappingTotal = overlapping.reduce((s, w) => s + w.days, 0);
    const unionTotal = union.reduce((s, w) => s + w.days, 0);
    expect(overlappingTotal).toBe(unionTotal);
  });

  it("week cap: a half-day row on a different date than an already-full week does not push days past the contract", () => {
    const c = 4;
    // Mon-Thu full days already contribute min(4, c) = 4 == c.
    const weeks = leaveDaysPerWeek(
      [
        { startDate: mon(0), endDate: mon(3) }, // Mon-Thu
        { startDate: mon(4), endDate: mon(4), halfDay: true }, // Fri, half-day, different date
      ],
      c,
      NO_HOLIDAYS,
    );
    expect(weeks).toHaveLength(1);
    expect(weeks[0].days).toBe(c);
  });

  it("Σ dayShares === days for whole-week, fragment and half-day fixtures", () => {
    const fixtures: Array<{
      rows: Array<{ startDate: Date; endDate: Date; halfDay?: boolean }>;
      c: number;
    }> = [
      { rows: [{ startDate: mon(0), endDate: mon(6) }], c: 5 }, // whole week
      { rows: [{ startDate: mon(0), endDate: mon(2) }], c: 5 }, // fragment Mon-Wed
      { rows: [{ startDate: mon(1), endDate: mon(1), halfDay: true }], c: 5 }, // half-day
    ];
    for (const { rows, c } of fixtures) {
      for (const week of leaveDaysPerWeek(rows, c, NO_HOLIDAYS)) {
        const sum = Array.from(week.dayShares.values()).reduce((a, b) => a + b, 0);
        expect(sum).toBeCloseTo(week.days);
      }
    }
  });

  it("every dayShares value stays within [0,1] for whole-week, fragment and half-day fixtures", () => {
    const fixtures: Array<{
      rows: Array<{ startDate: Date; endDate: Date; halfDay?: boolean }>;
      c: number;
    }> = [
      { rows: [{ startDate: mon(0), endDate: mon(6) }], c: 5 }, // whole week
      { rows: [{ startDate: mon(0), endDate: mon(2) }], c: 5 }, // fragment Mon-Wed
      { rows: [{ startDate: mon(1), endDate: mon(1), halfDay: true }], c: 5 }, // half-day
    ];
    for (const { rows, c } of fixtures) {
      for (const week of leaveDaysPerWeek(rows, c, NO_HOLIDAYS)) {
        for (const share of week.dayShares.values()) {
          expect(share).toBeGreaterThanOrEqual(0);
          expect(share).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("a Sunday date is never a key in dayShares, even for a full Mo-Su week fixture", () => {
    const weeks = leaveDaysPerWeek([{ startDate: mon(0), endDate: mon(6) }], 5, NO_HOLIDAYS);
    for (const week of weeks) {
      for (const dateStr of week.dayShares.keys()) {
        expect(dowOf(dateStr)).not.toBe(0);
      }
    }
  });
});

describe("countWorkDaysPerWeek count-first precedence (Phase 107, D-28/D-29)", () => {
  const baseHours = {
    mondayHours: 8,
    tuesdayHours: 8,
    wednesdayHours: 8,
    thursdayHours: 8,
    fridayHours: 8,
    saturdayHours: 8,
    sundayHours: 8,
  };

  // workDays sets of increasing cardinality 1..7 (0=Sun..6=Sat) — .length is all that matters.
  const WORKDAYS_BY_N: Record<number, number[]> = {
    1: [1],
    2: [1, 2],
    3: [1, 2, 3],
    4: [1, 2, 3, 4],
    5: [1, 2, 3, 4, 5],
    6: [1, 2, 3, 4, 5, 6],
    7: [0, 1, 2, 3, 4, 5, 6],
  };

  it.each([1, 2, 3, 4, 5, 6, 7])(
    "AC-DM-03/D-29: n=%i — contractWorkDaysPerWeek present vs. omitted yield the identical result (D-03 backfill is value-neutral)",
    (n) => {
      const workDays = WORKDAYS_BY_N[n];
      const withCount = { ...baseHours, workDays, contractWorkDaysPerWeek: n };
      const withoutCount = { ...baseHours, workDays };
      expect(countWorkDaysPerWeek(withCount)).toBe(countWorkDaysPerWeek(withoutCount));
      expect(countWorkDaysPerWeek(withCount)).toBe(n);
    },
  );

  it("AC-REG-02 guard: a FIXED_SCHEDULE-shaped schedule with contractWorkDaysPerWeek: null still resolves via the unchanged workDays.length tier", () => {
    const schedule = {
      ...baseHours,
      workDays: [1, 2, 3, 4, 5],
      contractWorkDaysPerWeek: null,
    };
    expect(countWorkDaysPerWeek(schedule)).toBe(5);
  });

  it("contractWorkDaysPerWeek wins even when it disagrees with workDays.length (count-first, not a merge)", () => {
    // Not a real-world shape (Plan 01's backfill guarantees agreement for existing rows) but
    // pins down that the precedence is a strict FIRST-match, not "whichever is bigger" or an
    // average of the two tiers.
    const schedule = { ...baseHours, workDays: [1, 2, 3, 4, 5], contractWorkDaysPerWeek: 3 };
    expect(countWorkDaysPerWeek(schedule)).toBe(3);
  });
});
