import { describe, it, expect } from "vitest";
import { workDaysPrimarySchedule } from "../work-days-primary-schedule";
import { getDayHoursFromSchedule } from "../timezone";

// ── workDaysPrimarySchedule ──────────────────────────────────────────────────
// Phase 111 (GitHub issue #114). Projects a WorkSchedule row into the {day}Hours
// shape findMissingWorkdays() reads, zeroing every weekday that isObligatedWorkday()
// reports as non-obligated. It introduces NO new obligation semantics — it only
// re-expresses the existing predicate in the {day}Hours channel so the FIXED branch
// of findMissingWorkdays() becomes workDays-primary WITHOUT touching that function.

const ALL_KEYS = [
  "sundayHours",
  "mondayHours",
  "tuesdayHours",
  "wednesdayHours",
  "thursdayHours",
  "fridayHours",
  "saturdayHours",
] as const;

function allHours(value: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ALL_KEYS) out[k] = value;
  return out;
}

describe("workDaysPrimarySchedule", () => {
  it("FIXED_SCHEDULE with workDays [2,3,4] zeroes Mon/Fri despite {day}Hours = 8", () => {
    const input = {
      type: "FIXED_SCHEDULE",
      workDays: [2, 3, 4],
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
    };

    const result = workDaysPrimarySchedule(input);

    expect(Number(result.mondayHours)).toBe(0);
    expect(Number(result.tuesdayHours)).toBe(8);
    expect(Number(result.wednesdayHours)).toBe(8);
    expect(Number(result.thursdayHours)).toBe(8);
    expect(Number(result.fridayHours)).toBe(0);
    expect(Number(result.saturdayHours)).toBe(0);
    expect(Number(result.sundayHours)).toBe(0);
  });

  it("FIXED_SCHEDULE with empty workDays is hours-identical to the input", () => {
    const input = {
      type: "FIXED_SCHEDULE",
      workDays: [] as number[],
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 6,
      saturdayHours: 0,
      sundayHours: 0,
    };

    const result = workDaysPrimarySchedule(input);

    for (let dow = 0; dow < 7; dow++) {
      expect(getDayHoursFromSchedule(result, dow)).toBe(
        getDayHoursFromSchedule(input as Record<string, unknown>, dow),
      );
    }
  });

  it("FIXED_SCHEDULE with the workDays key entirely absent (getEffectiveSchedule fallback shape) does not throw and stays hours-identical", () => {
    // apps/api/src/routes/time-entries.ts getEffectiveSchedule() returns a fallback
    // object with NO workDays key at all when the employee has no WorkSchedule row.
    const input = {
      type: "FIXED_SCHEDULE",
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
    };

    expect(() => workDaysPrimarySchedule(input)).not.toThrow();
    const result = workDaysPrimarySchedule(input);

    for (let dow = 0; dow < 7; dow++) {
      expect(getDayHoursFromSchedule(result, dow)).toBe(
        getDayHoursFromSchedule(input as Record<string, unknown>, dow),
      );
    }
  });

  it("SHIFT_BASED zeroes all seven keys — obligation comes from the roster, never from {day}Hours", () => {
    // The reported prod bug: an inherited thursdayHours = 1 (a legacy 1/0 flag, not
    // hours) made a contractually free Thursday look obligated forever.
    const input = { type: "SHIFT_BASED", workDays: [1, 2, 3, 4, 5], ...allHours(1) };

    const result = workDaysPrimarySchedule(input);

    for (let dow = 0; dow < 7; dow++) {
      expect(getDayHoursFromSchedule(result, dow)).toBe(0);
    }
  });

  it("FLEXTIME zeroes all seven keys", () => {
    const input = { type: "FLEXTIME", workDays: [1, 2, 3, 4, 5], ...allHours(1) };

    const result = workDaysPrimarySchedule(input);

    for (let dow = 0; dow < 7; dow++) {
      expect(getDayHoursFromSchedule(result, dow)).toBe(0);
    }
  });

  it("MONTHLY_HOURS zeroes all seven keys", () => {
    const input = {
      type: "MONTHLY_HOURS",
      monthlyHours: 40,
      workDays: [1, 2, 3, 4, 5],
      ...allHours(1),
    };

    const result = workDaysPrimarySchedule(input);

    for (let dow = 0; dow < 7; dow++) {
      expect(getDayHoursFromSchedule(result, dow)).toBe(0);
    }
  });

  it("type null behaves like FIXED — workDays-primary when populated", () => {
    const input = { type: null, workDays: [2, 3, 4], ...allHours(8) };

    const result = workDaysPrimarySchedule(input);

    expect(getDayHoursFromSchedule(result, 1)).toBe(0);
    expect(getDayHoursFromSchedule(result, 2)).toBe(8);
    expect(getDayHoursFromSchedule(result, 3)).toBe(8);
    expect(getDayHoursFromSchedule(result, 4)).toBe(8);
    expect(getDayHoursFromSchedule(result, 5)).toBe(0);
  });

  it("an unknown type behaves like FIXED — workDays-primary when populated", () => {
    const input = { type: "SOMETHING_NEW", workDays: [2, 3, 4], ...allHours(8) };

    const result = workDaysPrimarySchedule(input);

    expect(getDayHoursFromSchedule(result, 1)).toBe(0);
    expect(getDayHoursFromSchedule(result, 2)).toBe(8);
    expect(getDayHoursFromSchedule(result, 5)).toBe(0);
  });

  it("does not mutate the input object", () => {
    const input = {
      type: "FIXED_SCHEDULE",
      workDays: [2, 3, 4],
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
    };

    const result = workDaysPrimarySchedule(input);

    expect(input.mondayHours).toBe(8);
    expect(input.fridayHours).toBe(8);
    expect(result).not.toBe(input);
  });

  it("tolerates Decimal-like {day}Hours values (Prisma Decimal columns)", () => {
    // WorkSchedule.{day}Hours are Prisma Decimal(4,2) — objects with toString(),
    // not JS numbers. getDayHoursFromSchedule() coerces via Number().
    const decimalLike = (v: string) => ({ toString: () => v, valueOf: () => v });
    const input = {
      type: "FIXED_SCHEDULE",
      workDays: [2, 3, 4],
      sundayHours: decimalLike("0"),
      mondayHours: decimalLike("8"),
      tuesdayHours: decimalLike("8"),
      wednesdayHours: decimalLike("8"),
      thursdayHours: decimalLike("8"),
      fridayHours: decimalLike("8"),
      saturdayHours: decimalLike("0"),
    };

    const result = workDaysPrimarySchedule(input);

    expect(getDayHoursFromSchedule(result, 2)).toBe(8);
    expect(getDayHoursFromSchedule(result, 3)).toBe(8);
    expect(getDayHoursFromSchedule(result, 4)).toBe(8);
    expect(getDayHoursFromSchedule(result, 1)).toBe(0);
    expect(getDayHoursFromSchedule(result, 5)).toBe(0);
  });

  it("keeps non-hour keys (type, weeklyHours, workDays) intact on the projection", () => {
    const input = {
      type: "FIXED_SCHEDULE",
      weeklyHours: 24,
      workDays: [2, 3, 4],
      ...allHours(8),
    };

    const result = workDaysPrimarySchedule(input);

    expect(result.type).toBe("FIXED_SCHEDULE");
    expect(result.weeklyHours).toBe(24);
    expect(result.workDays).toEqual([2, 3, 4]);
  });
});
