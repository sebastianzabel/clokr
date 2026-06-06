// Phase 76.3 — SALDO-V19-01 frontend calendar workDays + SHIFT_BASED
// semantics regression guard.
//
// The 2026-06-04 incident reproduction (SHIFT_BASED Mo-non-workday) (test 1) is the architectural enforcement
// for SALDO-V19-01. Without it, a future maintainer can reintroduce
// the `*Hours > 0` pattern in a new calendar surface and ship the
// same 2026-06-04 production regression (phantom -1 h Tagessaldo on
// Mondays for SHIFT_BASED employees with legacy mondayHours drift).
//
// Per CLAUDE.md `feedback_no_test_manipulation`: if any assertion
// in this file ever needs to be relaxed, the helper logic is wrong,
// not the test. Investigate root cause — do not silently weaken.

import { describe, it, expect } from "vitest";
import {
  isWorkDay,
  getDayExpectedHours,
  countWorkingDaysInMonth,
  type WorkScheduleLike,
} from "../work-schedule";

// Helper to build a minimal WorkScheduleLike — fills in the *Hours
// / workDays / monthlyHours fields with defaults so each test only
// declares what it cares about.
function build(partial: Partial<WorkScheduleLike>): WorkScheduleLike {
  return {
    type: "FIXED_SCHEDULE",
    workDays: undefined,
    monthlyHours: null,
    sundayHours: 0,
    mondayHours: 0,
    tuesdayHours: 0,
    wednesdayHours: 0,
    thursdayHours: 0,
    fridayHours: 0,
    saturdayHours: 0,
    ...partial,
  };
}

describe("work-schedule helper (Phase 76.3 SALDO-V19-01)", () => {
  it("2026-06-04 incident — SHIFT_BASED Mo non-workday: SHIFT_BASED + workDays=[2,3,4,5] + legacy mondayHours=1 → Monday returns 0 (no phantom Soll)", () => {
    const sched = build({
      type: "SHIFT_BASED",
      workDays: [2, 3, 4, 5],
      mondayHours: 1, // legacy drift
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
    });
    const monday = new Date(2026, 5, 1); // June 1 2026 = Monday
    const tuesday = new Date(2026, 5, 2);
    expect(isWorkDay(sched, monday)).toBe(false);
    expect(getDayExpectedHours(sched, monday)).toBe(0);
    expect(isWorkDay(sched, tuesday)).toBe(true);
    // SHIFT_BASED: per CONTEXT D-03 the helper returns 0 even on a
    // workday — Soll comes from the Shift row that the page loads.
    expect(getDayExpectedHours(sched, tuesday)).toBe(0);
  });

  it("FIXED_WEEKLY happy path: workDays=[1,2,3,4,5] + mondayHours=8 → Monday returns 8", () => {
    const sched = build({
      type: "FIXED_SCHEDULE",
      workDays: [1, 2, 3, 4, 5],
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
    });
    const monday = new Date(2026, 5, 1);
    const saturday = new Date(2026, 5, 6);
    expect(isWorkDay(sched, monday)).toBe(true);
    expect(getDayExpectedHours(sched, monday)).toBe(8);
    expect(getDayExpectedHours(sched, saturday)).toBe(0);
  });

  it("MONTHLY_HOURS with monthlyHours=null → all days return 0 (pure time tracking)", () => {
    const sched = build({
      type: "MONTHLY_HOURS",
      workDays: [1, 2, 3, 4, 5],
      mondayHours: 4,
      tuesdayHours: 4,
      wednesdayHours: 4,
      thursdayHours: 4,
      fridayHours: 4,
      monthlyHours: null,
    });
    const monday = new Date(2026, 5, 1);
    const saturday = new Date(2026, 5, 6);
    expect(getDayExpectedHours(sched, monday)).toBe(0);
    expect(getDayExpectedHours(sched, saturday)).toBe(0);
    expect(isWorkDay(sched, monday)).toBe(true);
  });

  it("MONTHLY_HOURS with monthlyHours=60 → days respect workDays; per-day Soll is the *Hours value when workDays match", () => {
    const sched = build({
      type: "MONTHLY_HOURS",
      workDays: [1, 2, 3, 4, 5],
      mondayHours: 4,
      tuesdayHours: 4,
      wednesdayHours: 4,
      thursdayHours: 4,
      fridayHours: 4,
      monthlyHours: 60,
    });
    const monday = new Date(2026, 5, 1);
    const saturday = new Date(2026, 5, 6);
    expect(isWorkDay(sched, monday)).toBe(true);
    expect(getDayExpectedHours(sched, monday)).toBe(4);
    expect(getDayExpectedHours(sched, saturday)).toBe(0);
  });

  it("Legacy fallback: workDays undefined + *Hours>0 → uses *Hours predicate (no regression for unmigrated pre-Phase-61 rows)", () => {
    const sched = build({
      type: "FIXED_SCHEDULE",
      workDays: undefined,
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
    });
    const monday = new Date(2026, 5, 1);
    const saturday = new Date(2026, 5, 6);
    expect(isWorkDay(sched, monday)).toBe(true);
    expect(isWorkDay(sched, saturday)).toBe(false);
    expect(getDayExpectedHours(sched, monday)).toBe(8);
  });

  it("countWorkingDaysInMonth: workDays=[1,2,3,4,5] in June 2026 → 22 workdays (no holiday exclusion); 21 with one Thursday excluded", () => {
    const sched = build({
      type: "FIXED_SCHEDULE",
      workDays: [1, 2, 3, 4, 5],
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
    });
    const monthStart = new Date(2026, 5, 1); // June 2026
    expect(countWorkingDaysInMonth(sched, monthStart)).toBe(22);
    // June 4 2026 is a Thursday
    expect(countWorkingDaysInMonth(sched, monthStart, ["2026-06-04"])).toBe(21);
  });
});
