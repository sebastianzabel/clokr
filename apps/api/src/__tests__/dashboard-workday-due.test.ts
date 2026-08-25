import { describe, it, expect } from "vitest";
import { isObligatedWorkday, isDayDue } from "../utils/presence";

// ── isObligatedWorkday ───────────────────────────────────────────────────────
// Schedule-type-aware per-day obligation. Only an obligated workday can ever
// surface as "Fehlt" (missing).
describe("isObligatedWorkday", () => {
  const base = { workDays: [1, 2, 3, 4, 5], dow: 1, expectedHours: 8, hasShift: false };

  it("FLEXTIME → never obligated (weekly budget, free daily distribution)", () => {
    expect(isObligatedWorkday({ ...base, scheduleType: "FLEXTIME" })).toBe(false);
    // even with a shift and matching workDay, still false
    expect(isObligatedWorkday({ ...base, scheduleType: "FLEXTIME", hasShift: true })).toBe(false);
  });

  it("MONTHLY_HOURS → never obligated (monthly budget, free daily distribution)", () => {
    expect(isObligatedWorkday({ ...base, scheduleType: "MONTHLY_HOURS" })).toBe(false);
    expect(isObligatedWorkday({ ...base, scheduleType: "MONTHLY_HOURS", hasShift: true })).toBe(
      false,
    );
  });

  it("SHIFT_BASED → obligated ONLY when a shift is planned", () => {
    expect(isObligatedWorkday({ ...base, scheduleType: "SHIFT_BASED", hasShift: true })).toBe(true);
    expect(isObligatedWorkday({ ...base, scheduleType: "SHIFT_BASED", hasShift: false })).toBe(
      false,
    );
    // per-day hours / workDays are irrelevant for SHIFT_BASED
    expect(
      isObligatedWorkday({
        scheduleType: "SHIFT_BASED",
        workDays: [],
        dow: 1,
        expectedHours: 0,
        hasShift: true,
      }),
    ).toBe(true);
  });

  it("FIXED_SCHEDULE → workDays array is source of truth when populated", () => {
    // Monday (dow 1) included
    expect(isObligatedWorkday({ ...base, scheduleType: "FIXED_SCHEDULE", dow: 1 })).toBe(true);
    // Sunday (dow 0) excluded
    expect(isObligatedWorkday({ ...base, scheduleType: "FIXED_SCHEDULE", dow: 0 })).toBe(false);
  });

  it("FIXED_SCHEDULE with empty workDays → fall back to expectedHours > 0", () => {
    expect(
      isObligatedWorkday({
        scheduleType: "FIXED_SCHEDULE",
        workDays: [],
        dow: 3,
        expectedHours: 8,
        hasShift: false,
      }),
    ).toBe(true);
    expect(
      isObligatedWorkday({
        scheduleType: "FIXED_SCHEDULE",
        workDays: [],
        dow: 3,
        expectedHours: 0,
        hasShift: false,
      }),
    ).toBe(false);
  });

  it("null / unknown scheduleType → treated like FIXED (workDays | expectedHours)", () => {
    expect(isObligatedWorkday({ ...base, scheduleType: null, dow: 2 })).toBe(true);
    expect(isObligatedWorkday({ ...base, scheduleType: "SOMETHING_NEW", dow: 0 })).toBe(false);
    expect(
      isObligatedWorkday({
        scheduleType: null,
        workDays: [],
        dow: 0,
        expectedHours: 4,
        hasShift: false,
      }),
    ).toBe(true);
  });
});

// ── isDayDue ─────────────────────────────────────────────────────────────────
// Timing gate: a day is only eligible for "Fehlt" once it is due.
describe("isDayDue", () => {
  const today = "2026-08-05";

  it("past day → due", () => {
    expect(
      isDayDue({ dayStr: "2026-08-04", todayStr: today, nowHHMM: "09:00", shiftStartTime: null }),
    ).toBe(true);
  });

  it("future day → not due", () => {
    expect(
      isDayDue({ dayStr: "2026-08-06", todayStr: today, nowHHMM: "23:59", shiftStartTime: null }),
    ).toBe(false);
  });

  it("today + shift, before shift start → not due", () => {
    expect(
      isDayDue({ dayStr: today, todayStr: today, nowHHMM: "07:59", shiftStartTime: "08:00" }),
    ).toBe(false);
  });

  it("today + shift, at/after shift start → due", () => {
    expect(
      isDayDue({ dayStr: today, todayStr: today, nowHHMM: "08:00", shiftStartTime: "08:00" }),
    ).toBe(true);
    expect(
      isDayDue({ dayStr: today, todayStr: today, nowHHMM: "10:30", shiftStartTime: "08:00" }),
    ).toBe(true);
  });

  it("today, no shift → never due (fixed schedule has no known start time)", () => {
    expect(
      isDayDue({ dayStr: today, todayStr: today, nowHHMM: "23:00", shiftStartTime: null }),
    ).toBe(false);
  });
});
