/**
 * Unit test scaffold for findMissingWorkdays — RED until Plan 01 creates find-missing-workdays.ts
 *
 * Covers CLOSE-02, CLOSE-03, CLOSE-04 per RESEARCH.md §10.4 item 1 and §3–§4.
 *
 * Tests are PURE (no DB) — all inputs built from Date/Set/Array fixtures in Europe/Berlin TZ.
 * 2026-07-01 is a Wednesday (2026-07-01 UTC → day-of-week 3).
 * 2026-07-02 is a Thursday.
 * 2026-07-03 is a Friday.
 *
 * Locked decisions encoded here:
 *   D-01: FLEXTIME never produces a daily gap (no daily gap rule, like MONTHLY_HOURS)
 *   D-02: half-day leave with no entry → { date, partial: true }; with entry → not a gap
 *   D-03: exitDate is INCLUSIVE last working day; gaps only on/before effectiveEnd
 *
 * References: RESEARCH.md §5.1, §9 (pitfalls A1–A5), §10.4 item 1, REQUIREMENTS CLOSE-02/03/04.
 */

// RED until Plan 01 creates find-missing-workdays.ts
import { describe, it, expect } from "vitest";
import type {
  MissingWorkdaysInput,
  MissingWorkdaysResult,
  WorkdayGap,
} from "../find-missing-workdays";
import { findMissingWorkdays } from "../find-missing-workdays";

const TZ = "Europe/Berlin";

// ── Schedule fixtures ──────────────────────────────────────────────────────

/** FIXED_SCHEDULE Mon–Fri 8h, no weekend */
const FIXED_SCHEDULE_MON_FRI = {
  type: "FIXED_SCHEDULE",
  weeklyHours: 40,
  mondayHours: 8,
  tuesdayHours: 8,
  wednesdayHours: 8,
  thursdayHours: 8,
  fridayHours: 8,
  saturdayHours: 0,
  sundayHours: 0,
  workDays: [1, 2, 3, 4, 5],
};

const SHIFT_BASED_SCHEDULE = {
  type: "SHIFT_BASED",
  weeklyHours: 38,
  mondayHours: 7.6,
  tuesdayHours: 7.6,
  wednesdayHours: 7.6,
  thursdayHours: 7.6,
  fridayHours: 7.6,
  saturdayHours: 0,
  sundayHours: 0,
};

const MONTHLY_HOURS_SCHEDULE = {
  type: "MONTHLY_HOURS",
  monthlyHours: 80,
  weeklyHours: 0,
  mondayHours: 0,
  tuesdayHours: 0,
  wednesdayHours: 0,
  thursdayHours: 0,
  fridayHours: 0,
  saturdayHours: 0,
  sundayHours: 0,
};

const FLEXTIME_SCHEDULE = {
  type: "FLEXTIME",
  weeklyHours: 40,
  mondayHours: 8,
  tuesdayHours: 8,
  wednesdayHours: 8,
  thursdayHours: 8,
  fridayHours: 8,
  saturdayHours: 0,
  sundayHours: 0,
};

// ── Date fixtures (July 2026 in Europe/Berlin) ─────────────────────────────

// 2026-07-01 is a Wednesday; July 2026 runs Mon–Fri with no German holidays
// effectiveStart = month start, effectiveEnd = month end (full month, no hire/exit edge)
const JULY_START = new Date("2026-07-01T00:00:00+02:00"); // Wed Jul 1 in Berlin = Mon Jun 30 UTC
const JULY_END = new Date("2026-07-31T23:59:59+02:00"); // Thu Jul 31 in Berlin

/** Base input for FIXED_SCHEDULE full-month tests */
function baseFixedInput(overrides: Partial<MissingWorkdaysInput> = {}): MissingWorkdaysInput {
  return {
    schedule: FIXED_SCHEDULE_MON_FRI as Record<string, unknown>,
    effectiveStart: JULY_START,
    effectiveEnd: JULY_END,
    tz: TZ,
    entryDates: new Set<string>(),
    approvedLeave: [],
    absences: [],
    holidayDateStrings: new Set<string>(),
    ...overrides,
  };
}

// ── Helper ─────────────────────────────────────────────────────────────────

function gapDates(result: MissingWorkdaysResult): string[] {
  return result.gaps.map((g: WorkdayGap) => g.date);
}

// ──────────────────────────────────────────────────────────────────────────────
// FIXED_SCHEDULE cases (CLOSE-02 + CLOSE-03)
// ──────────────────────────────────────────────────────────────────────────────

describe("findMissingWorkdays — FIXED_SCHEDULE gaps (CLOSE-02/03)", () => {
  it("case 1: FIXED_SCHEDULE Wednesday with no entry and no coverage → gap", () => {
    // 2026-07-01 is a Wednesday (scheduled day, 8h). No entry, no leave/absence/holiday.
    const result = findMissingWorkdays(baseFixedInput());

    expect(gapDates(result)).toContain("2026-07-01");
    const gap = result.gaps.find((g: WorkdayGap) => g.date === "2026-07-01");
    expect(gap).toBeDefined();
    expect(gap!.partial).toBe(false);
  });

  it("case 2: FIXED_SCHEDULE Wednesday IS in entryDates → not a gap", () => {
    const result = findMissingWorkdays(baseFixedInput({ entryDates: new Set(["2026-07-01"]) }));

    expect(gapDates(result)).not.toContain("2026-07-01");
  });

  it("case 3: FIXED_SCHEDULE Wednesday covered by full-day approvedLeave → not a gap, IS in coveredDates", () => {
    const result = findMissingWorkdays(
      baseFixedInput({
        approvedLeave: [
          {
            startDate: new Date("2026-07-01T00:00:00Z"),
            endDate: new Date("2026-07-01T23:59:59Z"),
            halfDay: false,
          },
        ],
      }),
    );

    expect(gapDates(result)).not.toContain("2026-07-01");
    expect(result.coveredDates.has("2026-07-01")).toBe(true);
  });

  it("case 4: FIXED_SCHEDULE Wednesday covered by absence → not a gap, IS in coveredDates", () => {
    const result = findMissingWorkdays(
      baseFixedInput({
        absences: [
          {
            startDate: new Date("2026-07-01T00:00:00Z"),
            endDate: new Date("2026-07-01T23:59:59Z"),
          },
        ],
      }),
    );

    expect(gapDates(result)).not.toContain("2026-07-01");
    expect(result.coveredDates.has("2026-07-01")).toBe(true);
  });

  it("case 5: FIXED_SCHEDULE Wednesday in holidayDateStrings → not a gap, IS in coveredDates", () => {
    const result = findMissingWorkdays(
      baseFixedInput({
        holidayDateStrings: new Set(["2026-07-01"]),
      }),
    );

    expect(gapDates(result)).not.toContain("2026-07-01");
    expect(result.coveredDates.has("2026-07-01")).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// SHIFT_BASED cases (CLOSE-02/03 — roster-based gap detection, PITFALL A4 fix)
// ──────────────────────────────────────────────────────────────────────────────

describe("findMissingWorkdays — SHIFT_BASED gaps (CLOSE-02, Pitfall A4)", () => {
  // Base SHIFT_BASED input: rosterDates drives what's expected (not {day}Hours)
  function baseShiftInput(overrides: Partial<MissingWorkdaysInput> = {}): MissingWorkdaysInput {
    return {
      schedule: SHIFT_BASED_SCHEDULE as Record<string, unknown>,
      effectiveStart: JULY_START,
      effectiveEnd: JULY_END,
      tz: TZ,
      entryDates: new Set<string>(),
      approvedLeave: [],
      absences: [],
      holidayDateStrings: new Set<string>(),
      rosterDates: new Set<string>(),
      ...overrides,
    };
  }

  it("case 6: SHIFT_BASED rostered day with no entry → gap", () => {
    // 2026-07-02 is a Thursday — rostered, no entry → gap
    const result = findMissingWorkdays(baseShiftInput({ rosterDates: new Set(["2026-07-02"]) }));

    expect(gapDates(result)).toContain("2026-07-02");
    const gap = result.gaps.find((g: WorkdayGap) => g.date === "2026-07-02");
    expect(gap!.partial).toBe(false);
  });

  it("case 7: SHIFT_BASED rostered day IS in entryDates → not a gap", () => {
    const result = findMissingWorkdays(
      baseShiftInput({
        rosterDates: new Set(["2026-07-02"]),
        entryDates: new Set(["2026-07-02"]),
      }),
    );

    expect(gapDates(result)).not.toContain("2026-07-02");
  });

  it("case 8: SHIFT_BASED non-rostered weekday is NOT a gap — SHIFT_BASED keys off rosterDates only", () => {
    // 2026-07-03 is a Friday — {day}Hours > 0 for this schedule, but NOT in rosterDates
    // PITFALL A4 fix: getDayHoursFromSchedule must NOT be used for SHIFT_BASED
    const result = findMissingWorkdays(
      baseShiftInput({
        rosterDates: new Set<string>(), // empty roster — no rostered shifts
        entryDates: new Set<string>(), // no entries either
      }),
    );

    // A non-rostered weekday should NEVER appear in gaps for SHIFT_BASED, regardless of {day}Hours
    expect(gapDates(result)).not.toContain("2026-07-03");
    expect(result.gaps).toHaveLength(0);
  });

  it("case 9: SHIFT_BASED rostered day covered by approvedLeave → not a gap (Ausfallprinzip)", () => {
    // rostered on 2026-07-02 but covered by leave → not a gap
    const result = findMissingWorkdays(
      baseShiftInput({
        rosterDates: new Set(["2026-07-02"]),
        approvedLeave: [
          {
            startDate: new Date("2026-07-02T00:00:00Z"),
            endDate: new Date("2026-07-02T23:59:59Z"),
            halfDay: false,
          },
        ],
      }),
    );

    expect(gapDates(result)).not.toContain("2026-07-02");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// MONTHLY_HOURS and FLEXTIME — never produce daily gaps (CLOSE-02, D-01)
// ──────────────────────────────────────────────────────────────────────────────

describe("findMissingWorkdays — MONTHLY_HOURS/FLEXTIME: no daily gap (CLOSE-02, D-01)", () => {
  it("case 10: MONTHLY_HOURS weekday with no entry → gaps is empty", () => {
    const result = findMissingWorkdays({
      schedule: MONTHLY_HOURS_SCHEDULE as Record<string, unknown>,
      effectiveStart: JULY_START,
      effectiveEnd: JULY_END,
      tz: TZ,
      entryDates: new Set<string>(),
      approvedLeave: [],
      absences: [],
      holidayDateStrings: new Set<string>(),
    });

    expect(result.gaps).toHaveLength(0);
  });

  it("case 11: FLEXTIME never produces a daily gap", () => {
    // D-01: FLEXTIME excluded from gap detection (no daily gap rule, like MONTHLY_HOURS)
    const result = findMissingWorkdays({
      schedule: FLEXTIME_SCHEDULE as Record<string, unknown>,
      effectiveStart: JULY_START,
      effectiveEnd: JULY_END,
      tz: TZ,
      entryDates: new Set<string>(),
      approvedLeave: [],
      absences: [],
      holidayDateStrings: new Set<string>(),
    });

    expect(result.gaps).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Half-day leave cases (CLOSE-03, Pitfall A2, D-02)
// ──────────────────────────────────────────────────────────────────────────────

describe("findMissingWorkdays — half-day leave handling (CLOSE-03, Pitfall A2, D-02)", () => {
  it("case 12: half-day leave, no entry → gap with partial: true", () => {
    // D-02: halfDay=true, no time entry → partial gap. Employee owes the other half.
    const result = findMissingWorkdays(
      baseFixedInput({
        approvedLeave: [
          {
            startDate: new Date("2026-07-01T00:00:00Z"),
            endDate: new Date("2026-07-01T23:59:59Z"),
            halfDay: true,
          },
        ],
        entryDates: new Set<string>(),
      }),
    );

    expect(gapDates(result)).toContain("2026-07-01");
    const gap = result.gaps.find((g: WorkdayGap) => g.date === "2026-07-01");
    expect(gap).toBeDefined();
    // D-02: half-day leave with no entry → partial: true
    expect(gap!.partial).toBe(true);
  });

  it("case 13: half-day leave WITH entry → not a gap", () => {
    // D-02: halfDay=true AND employee has an entry on that day → not a gap at all
    const result = findMissingWorkdays(
      baseFixedInput({
        approvedLeave: [
          {
            startDate: new Date("2026-07-01T00:00:00Z"),
            endDate: new Date("2026-07-01T23:59:59Z"),
            halfDay: true,
          },
        ],
        entryDates: new Set(["2026-07-01"]),
      }),
    );

    expect(gapDates(result)).not.toContain("2026-07-01");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Mid-month hire / exit boundary cases (CLOSE-04, Pitfall A5, D-03)
// ──────────────────────────────────────────────────────────────────────────────

describe("findMissingWorkdays — mid-month hire/exit boundaries (CLOSE-04, D-03)", () => {
  it("case 14: mid-month hire — days before effectiveStart NOT in gaps; days after ARE", () => {
    // effectiveStart = 2026-07-15 (Wednesday). Employee hired mid-July.
    // 2026-07-01 (Wed) is before hire → NOT a gap.
    // 2026-07-15 (Wed) is after hire → IS a gap (no entry).
    const effectiveStart = new Date("2026-07-15T00:00:00+02:00");
    const result = findMissingWorkdays(
      baseFixedInput({
        effectiveStart,
        effectiveEnd: JULY_END,
        entryDates: new Set<string>(),
      }),
    );

    // 2026-07-01 is before effectiveStart (hire date) → not a gap
    expect(gapDates(result)).not.toContain("2026-07-01");

    // 2026-07-15 is a Wednesday, after hire date → IS a gap (CLOSE-04)
    expect(gapDates(result)).toContain("2026-07-15");
  });

  it("case 15: mid-month exit — days after effectiveEnd NOT in gaps; days on/before ARE (D-03 exitDate inclusive)", () => {
    // effectiveEnd = 2026-07-10 (Thursday, last working day — INCLUSIVE per D-03).
    // 2026-07-13 (Mon, after exit) → NOT a gap.
    // 2026-07-07 (Tue, before/on exit) → IS a gap (no entry, workday within span).
    // 2026-07-10 (Thu, on exit date, inclusive) → IS a gap (no entry).
    const effectiveEnd = new Date("2026-07-10T23:59:59+02:00");
    const result = findMissingWorkdays(
      baseFixedInput({
        effectiveStart: JULY_START,
        effectiveEnd,
        entryDates: new Set<string>(),
      }),
    );

    // 2026-07-13 (Monday) is after effectiveEnd → NOT a gap (D-03: exitDate inclusive)
    expect(gapDates(result)).not.toContain("2026-07-13");

    // 2026-07-07 (Tuesday) is within span and has no entry → IS a gap
    expect(gapDates(result)).toContain("2026-07-07");

    // 2026-07-10 (Thursday = exitDate) is inclusive → IS a gap (no entry, D-03)
    expect(gapDates(result)).toContain("2026-07-10");
  });
});
