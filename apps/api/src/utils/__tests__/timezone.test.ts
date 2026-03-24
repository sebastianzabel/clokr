import { describe, it, expect } from "vitest";
import {
  todayInTz,
  dateStrInTz,
  getDayOfWeekInTz,
  monthRangeUtc,
  weekRangeUtc,
  iterateDaysInTz,
  calcExpectedMinutesTz,
  getDayHoursFromSchedule,
} from "../timezone";

describe("dateStrInTz", () => {
  it("formats a UTC date as YYYY-MM-DD in Europe/Berlin", () => {
    // 2026-03-24 23:30 UTC = 2026-03-25 00:30 CET (UTC+1 → actually CEST UTC+2 in March)
    const utc = new Date("2026-03-24T23:30:00Z");
    // March 24 2026: already CEST (clocks spring forward last Sunday of March = Mar 29 2026? Let's check)
    // Actually DST starts last Sunday of March. In 2026, March 29 is last Sunday.
    // So March 24 is still CET (UTC+1). 23:30 UTC = 00:30 CET next day = March 25
    expect(dateStrInTz(utc, "Europe/Berlin")).toBe("2026-03-25");
  });

  it("handles UTC timezone", () => {
    const utc = new Date("2026-06-15T02:00:00Z");
    expect(dateStrInTz(utc, "UTC")).toBe("2026-06-15");
  });

  it("handles US/Eastern timezone", () => {
    // 2026-06-15 03:00 UTC = 2026-06-14 23:00 EDT (UTC-4)
    const utc = new Date("2026-06-15T03:00:00Z");
    expect(dateStrInTz(utc, "America/New_York")).toBe("2026-06-14");
  });
});

describe("getDayOfWeekInTz", () => {
  it("returns correct day of week for Berlin timezone", () => {
    // 2026-03-24 is a Tuesday
    const tue = new Date("2026-03-24T12:00:00Z");
    expect(getDayOfWeekInTz(tue, "Europe/Berlin")).toBe(2); // Tuesday
  });

  it("handles day boundary crossing", () => {
    // 2026-03-24 23:30 UTC = March 25 in Berlin (CET, UTC+1)
    const lateTue = new Date("2026-03-24T23:30:00Z");
    expect(getDayOfWeekInTz(lateTue, "Europe/Berlin")).toBe(3); // Wednesday in Berlin
  });
});

describe("monthRangeUtc", () => {
  it("returns correct UTC range for January in Berlin", () => {
    const { start, end } = monthRangeUtc(2026, 1, "Europe/Berlin");
    // Jan 1 00:00 CET (UTC+1) → Dec 31 23:00 UTC
    expect(start.toISOString()).toBe("2025-12-31T23:00:00.000Z");
    // Jan 31 23:59:59.999 CET → Jan 31 22:59:59.999 UTC
    expect(end.toISOString()).toBe("2026-01-31T22:59:59.999Z");
  });

  it("returns correct UTC range for July (CEST) in Berlin", () => {
    const { start, end } = monthRangeUtc(2026, 7, "Europe/Berlin");
    // Jul 1 00:00 CEST (UTC+2) → Jun 30 22:00 UTC
    expect(start.toISOString()).toBe("2026-06-30T22:00:00.000Z");
    // Jul 31 23:59:59.999 CEST → Jul 31 21:59:59.999 UTC
    expect(end.toISOString()).toBe("2026-07-31T21:59:59.999Z");
  });

  it("handles February (28 days in non-leap year)", () => {
    const { end } = monthRangeUtc(2026, 2, "UTC");
    // Feb 28 23:59:59.999 UTC
    expect(end.toISOString()).toBe("2026-02-28T23:59:59.999Z");
  });

  it("handles February (29 days in leap year)", () => {
    const { end } = monthRangeUtc(2028, 2, "UTC");
    expect(end.toISOString()).toBe("2028-02-29T23:59:59.999Z");
  });
});

describe("weekRangeUtc", () => {
  it("returns Monday through Sunday for a Wednesday", () => {
    // Wednesday 2026-03-25
    const wed = new Date("2026-03-25T12:00:00Z");
    const { days } = weekRangeUtc(wed, "Europe/Berlin");
    expect(days).toHaveLength(7);
    expect(days[0]).toBe("2026-03-23"); // Monday
    expect(days[6]).toBe("2026-03-29"); // Sunday
  });

  it("returns correct week for a Monday", () => {
    const mon = new Date("2026-03-23T12:00:00Z");
    const { days } = weekRangeUtc(mon, "Europe/Berlin");
    expect(days[0]).toBe("2026-03-23");
    expect(days[6]).toBe("2026-03-29");
  });

  it("returns correct week for a Sunday", () => {
    const sun = new Date("2026-03-29T12:00:00Z");
    const { days } = weekRangeUtc(sun, "Europe/Berlin");
    expect(days[0]).toBe("2026-03-23");
    expect(days[6]).toBe("2026-03-29");
  });
});

describe("iterateDaysInTz", () => {
  it("calls callback for each day in range", () => {
    const from = new Date("2026-03-23T00:00:00Z"); // Monday
    const to = new Date("2026-03-25T23:59:59Z");   // Wednesday
    const dows: number[] = [];
    iterateDaysInTz(from, to, "UTC", (dow) => dows.push(dow));
    expect(dows).toEqual([1, 2, 3]); // Mon, Tue, Wed
  });

  it("handles single day range", () => {
    const d = new Date("2026-03-23T12:00:00Z");
    const dows: number[] = [];
    iterateDaysInTz(d, d, "UTC", (dow) => dows.push(dow));
    expect(dows).toEqual([1]); // Monday
  });
});

describe("calcExpectedMinutesTz", () => {
  const schedule = {
    sundayHours: 0,
    mondayHours: 8,
    tuesdayHours: 8,
    wednesdayHours: 8,
    thursdayHours: 8,
    fridayHours: 8,
    saturdayHours: 0,
  };

  it("calculates full work week (Mon–Fri)", () => {
    const from = new Date("2026-03-23T00:00:00Z"); // Monday
    const to = new Date("2026-03-29T23:59:59Z");   // Sunday
    const minutes = calcExpectedMinutesTz(schedule, from, to, "UTC");
    expect(minutes).toBe(5 * 8 * 60); // 5 work days × 8h × 60min
  });

  it("calculates partial week", () => {
    const from = new Date("2026-03-23T00:00:00Z"); // Monday
    const to = new Date("2026-03-25T23:59:59Z");   // Wednesday
    const minutes = calcExpectedMinutesTz(schedule, from, to, "UTC");
    expect(minutes).toBe(3 * 8 * 60); // 3 days
  });

  it("returns 0 for weekend only", () => {
    const from = new Date("2026-03-28T00:00:00Z"); // Saturday
    const to = new Date("2026-03-29T23:59:59Z");   // Sunday
    const minutes = calcExpectedMinutesTz(schedule, from, to, "UTC");
    expect(minutes).toBe(0);
  });
});

describe("getDayHoursFromSchedule", () => {
  const schedule = {
    sundayHours: 0,
    mondayHours: 8,
    tuesdayHours: 7.5,
    wednesdayHours: 8,
    thursdayHours: 8,
    fridayHours: 6,
    saturdayHours: 4,
  };

  it("returns correct hours for each day", () => {
    expect(getDayHoursFromSchedule(schedule, 0)).toBe(0);    // Sunday
    expect(getDayHoursFromSchedule(schedule, 1)).toBe(8);    // Monday
    expect(getDayHoursFromSchedule(schedule, 2)).toBe(7.5);  // Tuesday
    expect(getDayHoursFromSchedule(schedule, 5)).toBe(6);    // Friday
    expect(getDayHoursFromSchedule(schedule, 6)).toBe(4);    // Saturday
  });
});

describe("todayInTz", () => {
  it("returns a Date at midnight UTC", () => {
    const today = todayInTz("UTC");
    expect(today.getUTCHours()).toBe(0);
    expect(today.getUTCMinutes()).toBe(0);
    expect(today.getUTCSeconds()).toBe(0);
  });
});
