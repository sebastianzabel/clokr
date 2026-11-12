// Issue #854 (D-854-07, AC-5) - the pure start-day helpers of a contract change.
import { describe, expect, it } from "vitest";
import { isMonthFirst, nextMonthFirst } from "$lib/employees/contract-start";

describe("nextMonthFirst", () => {
  it("is the first of the following month", () => {
    expect(nextMonthFirst("2026-11-12")).toBe("2026-12-01");
    expect(nextMonthFirst("2026-02-28")).toBe("2026-03-01");
  });

  it("is still the NEXT month on the 1st and on the last day", () => {
    expect(nextMonthFirst("2026-12-01")).toBe("2027-01-01");
    expect(nextMonthFirst("2026-12-31")).toBe("2027-01-01");
    expect(nextMonthFirst("2026-11-01")).toBe("2026-12-01");
  });

  it("rolls the year over in December only", () => {
    expect(nextMonthFirst("2026-11-30")).toBe("2026-12-01");
    expect(nextMonthFirst("2026-12-15")).toBe("2027-01-01");
  });

  it("returns null for a malformed day instead of guessing", () => {
    expect(nextMonthFirst("")).toBeNull();
    expect(nextMonthFirst("12.11.2026")).toBeNull();
    expect(nextMonthFirst("2026-11")).toBeNull();
  });
});

describe("isMonthFirst", () => {
  it("accepts exactly the first of a month", () => {
    expect(isMonthFirst("2026-12-01")).toBe(true);
    expect(isMonthFirst("2026-12-02")).toBe(false);
    expect(isMonthFirst("2026-12-31")).toBe(false);
    expect(isMonthFirst("2026-12-10")).toBe(false);
  });

  it("is false for empty and malformed input", () => {
    expect(isMonthFirst(null)).toBe(false);
    expect(isMonthFirst(undefined)).toBe(false);
    expect(isMonthFirst("")).toBe(false);
    expect(isMonthFirst("01.12.2026")).toBe(false);
  });
});
