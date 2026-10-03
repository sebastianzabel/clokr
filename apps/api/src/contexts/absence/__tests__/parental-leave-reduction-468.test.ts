/**
 * Issue #468, finding 4 (D-08) — pure kernel suite for `fullCalendarMonthsByYear`,
 * `remainingAfterParentalMonths` and `parentalLeaveReducedDays`.
 *
 * No DB. Every date is built via `new Date("YYYY-MM-DD")` — parsed as UTC midnight, so the UTC
 * accessors inside the function under test cannot be moved by a host timezone.
 */
import { describe, it, expect } from "vitest";
import {
  fullCalendarMonthsByYear,
  remainingAfterParentalMonths,
  parentalLeaveReducedDays,
} from "../parental-leave-reduction";

describe("fullCalendarMonthsByYear (Issue #468, D-08 — volle Kalendermonate je Jahr)", () => {
  it("splits a span crossing one year boundary into full months per year", () => {
    expect(fullCalendarMonthsByYear(new Date("2026-09-15"), new Date("2027-04-10"))).toEqual([
      { year: 2026, months: 3 },
      { year: 2027, months: 3 },
    ]);
  });

  it("a full calendar year is 12 full months", () => {
    expect(fullCalendarMonthsByYear(new Date("2027-01-01"), new Date("2027-12-31"))).toEqual([
      { year: 2027, months: 12 },
    ]);
  });

  it("a span starting after the 1st of its only month has zero full months", () => {
    expect(fullCalendarMonthsByYear(new Date("2027-03-02"), new Date("2027-03-31"))).toEqual([
      { year: 2027, months: 0 },
    ]);
  });

  it("a span crossing two year boundaries produces three year entries", () => {
    expect(fullCalendarMonthsByYear(new Date("2026-12-01"), new Date("2028-01-31"))).toEqual([
      { year: 2026, months: 1 },
      { year: 2027, months: 12 },
      { year: 2028, months: 1 },
    ]);
  });

  it("February in a leap year counts as one full month", () => {
    expect(fullCalendarMonthsByYear(new Date("2028-02-01"), new Date("2028-02-29"))).toEqual([
      { year: 2028, months: 1 },
    ]);
  });
});

describe("remainingAfterParentalMonths / parentalLeaveReducedDays (Issue #468, D-08 — § 421 rounding)", () => {
  it("parentalLeaveReducedDays(30, 3) = 7 (remaining 22.5 -> 23)", () => {
    expect(parentalLeaveReducedDays(30, 3)).toBe(7);
  });

  it("parentalLeaveReducedDays(30, 6) = 15 (remaining exactly 15)", () => {
    expect(parentalLeaveReducedDays(30, 6)).toBe(15);
  });

  it("parentalLeaveReducedDays(30, 5) = 12 (remaining 17.5 -> 18)", () => {
    expect(parentalLeaveReducedDays(30, 5)).toBe(12);
  });

  it("parentalLeaveReducedDays(30, 12) = 30 (whole entitlement)", () => {
    expect(parentalLeaveReducedDays(30, 12)).toBe(30);
  });

  it("parentalLeaveReducedDays(30, 0) = 0 (no months, nothing reduced)", () => {
    expect(parentalLeaveReducedDays(30, 0)).toBe(0);
  });

  it("parentalLeaveReducedDays(20, 1) = 1.67 (remaining 18.33 kept, not rounded up)", () => {
    expect(parentalLeaveReducedDays(20, 1)).toBe(1.67);
  });

  it("parentalLeaveReducedDays(36, 1) = 3", () => {
    expect(parentalLeaveReducedDays(36, 1)).toBe(3);
  });

  it("remainingAfterParentalMonths(17.5, 0) = 17.5 (0 months never re-rounds)", () => {
    expect(remainingAfterParentalMonths(17.5, 0)).toBe(17.5);
  });
});
