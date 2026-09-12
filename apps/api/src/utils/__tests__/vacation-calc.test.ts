import { describe, it, expect } from "vitest";
import {
  countWorkDaysPerWeek,
  calculatePartTimeVacation,
  calculateStatutoryMinimum,
  splitDaysAcrossYears,
  calculateProRataVacation,
  countShiftBasedLeaveDays,
  mondayOfWeekUtc,
} from "../vacation-calc";
// Phase 107 — single shared tenant-TZ date helper (issue #34); avoids hardcoded calendar
// dates that expire (see project history in CLAUDE.md / docs/testing.md).
import { mondayOfWeekStr, utcMidnight, dowOf } from "../../__tests__/test-dates";

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

describe("countShiftBasedLeaveDays (Phase 107, D-05..D-09)", () => {
  it("fixture week's Monday is genuinely a Monday (pins the week-cutting primitive)", () => {
    // Two independent implementations must agree: test-dates.ts's dowOf() (tenant-TZ string
    // arithmetic) and vacation-calc.ts's own exported mondayOfWeekUtc() (pure UTC). If either
    // week-cutting primitive ever drifts, this fails here instead of every day-count silently
    // shifting by one.
    expect(dowOf(MONDAY)).toBe(1);
    expect(mondayOfWeekUtc(mon(2)).getTime()).toBe(utcMidnight(MONDAY).getTime()); // Wed -> Mon
  });

  it("AC-UV-01: two whole ISO weeks, count 5 -> 10 days, not provisional (empty AND full roster)", () => {
    const start = mon(0); // Monday, week A
    const end = mon(13); // Sunday, week B (the second Sunday)

    const resultEmptyRoster = countShiftBasedLeaveDays(
      start,
      end,
      false,
      5,
      new Set(),
      NO_HOLIDAYS,
      new Set(),
    );
    expect(resultEmptyRoster).toEqual({ days: 10, provisional: false });

    // A FULL roster (every day rostered, both weeks marked as "has a roster") must not change
    // the result AT ALL — D-06: whole weeks ignore the roster entirely by construction. This is
    // the unit-level proof that later roster planning cannot retroactively alter a whole week
    // (AC-RC-06).
    const fullRoster = new Set<string>();
    for (let i = 0; i <= 13; i++) fullRoster.add(ds(mon(i)));
    const fullWeeks = new Set([ds(mon(0)), ds(mon(7))]);
    const resultFullRoster = countShiftBasedLeaveDays(
      start,
      end,
      false,
      5,
      fullRoster,
      NO_HOLIDAYS,
      fullWeeks,
    );
    expect(resultFullRoster).toEqual({ days: 10, provisional: false });
  });

  it("AC-UV-02: Mon-Tue leave, roster Tue-Sat -> 1 day", () => {
    const start = mon(0); // Mon
    const end = mon(1); // Tue
    const roster = new Set([ds(mon(1)), ds(mon(2)), ds(mon(3)), ds(mon(4)), ds(mon(5))]); // Tue..Sat
    const weeksWithRoster = new Set([ds(mon(0))]);
    const result = countShiftBasedLeaveDays(
      start,
      end,
      false,
      5,
      roster,
      NO_HOLIDAYS,
      weeksWithRoster,
    );
    expect(result).toEqual({ days: 1, provisional: false });
  });

  it("AC-UV-03: Mon-Tue leave, roster Mon-Fri -> 2 days", () => {
    const start = mon(0); // Mon
    const end = mon(1); // Tue
    const roster = new Set([ds(mon(0)), ds(mon(1)), ds(mon(2)), ds(mon(3)), ds(mon(4))]); // Mon..Fri
    const weeksWithRoster = new Set([ds(mon(0))]);
    const result = countShiftBasedLeaveDays(
      start,
      end,
      false,
      5,
      roster,
      NO_HOLIDAYS,
      weeksWithRoster,
    );
    expect(result).toEqual({ days: 2, provisional: false });
  });

  it("AC-UV-04: Mon-Tue leave, no roster in that week, count 5 -> 2 days, provisional true", () => {
    const start = mon(0); // Mon
    const end = mon(1); // Tue
    const result = countShiftBasedLeaveDays(
      start,
      end,
      false,
      5,
      new Set(),
      NO_HOLIDAYS,
      new Set(),
    );
    expect(result).toEqual({ days: 2, provisional: true });
  });

  it("D-07 upper bound: Wed-Sun fragment (5 calendar days), count 4, no roster -> 4 days, provisional true", () => {
    const start = mon(2); // Wed
    const end = mon(6); // Sun
    const result = countShiftBasedLeaveDays(
      start,
      end,
      false,
      4,
      new Set(),
      NO_HOLIDAYS,
      new Set(),
    );
    // min(5 calendar days, count 4) = 4 — the count caps the calendar-day count, not vice versa.
    expect(result).toEqual({ days: 4, provisional: true });
  });

  it("D-08 exact: a holiday on a rostered day inside a fragment is not counted", () => {
    const start = mon(0); // Mon
    const end = mon(1); // Tue
    const roster = new Set([ds(mon(0)), ds(mon(1))]); // both rostered
    const weeksWithRoster = new Set([ds(mon(0))]);
    const holidays = new Set([ds(mon(1))]); // Tuesday is a public holiday
    const result = countShiftBasedLeaveDays(
      start,
      end,
      false,
      5,
      roster,
      holidays,
      weeksWithRoster,
    );
    expect(result).toEqual({ days: 1, provisional: false }); // only Monday counts
  });

  it("D-08 flat: no roster, 1 holiday in the fragment -> value reduced by 1", () => {
    const start = mon(0); // Mon
    const end = mon(1); // Tue
    const holidays = new Set([ds(mon(1))]); // Tuesday
    const result = countShiftBasedLeaveDays(start, end, false, 5, new Set(), holidays, new Set());
    // min(2 calendar days, count 5) = 2, minus 1 holiday in the fragment = 1
    expect(result).toEqual({ days: 1, provisional: true });
  });

  it("D-08 flat floor: count 1, 2 holidays in the fragment -> 0, never negative", () => {
    const start = mon(0); // Mon
    const end = mon(1); // Tue
    const holidays = new Set([ds(mon(0)), ds(mon(1))]); // both days are holidays
    const result = countShiftBasedLeaveDays(start, end, false, 1, new Set(), holidays, new Set());
    // min(2, 1) = 1, minus 2 holidays = -1 -> floored at 0, never negative
    expect(result).toEqual({ days: 0, provisional: true });
  });

  it("halfDay short-circuits to 0.5, never provisional, regardless of roster", () => {
    const start = mon(0);
    const end = mon(0);
    const result = countShiftBasedLeaveDays(start, end, true, 5, new Set(), NO_HOLIDAYS, new Set());
    expect(result).toEqual({ days: 0.5, provisional: false });
  });

  it("mixed period (fragment + 2 whole weeks + fragment): provisional true when only ONE fragment lacks a roster", () => {
    const start = mon(2); // Wed, week A
    const end = mon(24); // Thu, week D (3 weeks + 3 days later)
    const count = 5;

    // Week A's fragment (Wed..Sun) HAS a roster: Wed/Thu/Fri rostered, Sat/Sun not.
    const roster = new Set([ds(mon(2)), ds(mon(3)), ds(mon(4))]);
    // Only week A's Monday-key is marked "has a roster" — week D's fragment (the period's other
    // end) deliberately has NO entry in weeksWithRoster.
    const weeksWithRoster = new Set([ds(mon(0))]);

    const result = countShiftBasedLeaveDays(
      start,
      end,
      false,
      count,
      roster,
      NO_HOLIDAYS,
      weeksWithRoster,
    );
    // Week A fragment (roster-exact): Wed+Thu+Fri rostered -> 3
    // Week B + Week C: WHOLE, roster-independent -> 5 + 5 = 10
    // Week D fragment (Mon..Thu, no roster, flat): min(4 calendar days, 5) - 0 holidays -> 4
    // Total: 3 + 10 + 4 = 17; provisional true because week D's fragment lacked a roster, even
    // though week A's fragment had one (D-11: at-least-one-day / at-least-one-fragment).
    expect(result).toEqual({ days: 17, provisional: true });
  });

  it("is DB-free and callable without Fastify or a Prisma client", () => {
    // No import of Fastify/@clokr/db appears anywhere in this file or in vacation-calc.ts
    // (enforced by Task 1's own acceptance criteria) — this call is the behavioral proof: it
    // runs to completion with nothing but plain JS values.
    expect(() =>
      countShiftBasedLeaveDays(mon(0), mon(1), false, 5, new Set(), new Set(), new Set()),
    ).not.toThrow();
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
