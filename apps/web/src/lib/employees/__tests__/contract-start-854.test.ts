// Issue #854 (D-854-07, AC-5) - the pure start-day helpers of a contract change.
import { describe, expect, it } from "vitest";
import {
  isMonthFirst,
  monthFirstLabel,
  monthFirstOptions,
  nextMonthFirst,
} from "$lib/employees/contract-start";

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

describe("monthFirstLabel", () => {
  it("names a month-first by month and year", () => {
    expect(monthFirstLabel("2026-12-01")).toBe("Dezember 2026");
    expect(monthFirstLabel("2027-03-01")).toBe("März 2027");
  });

  it("is null for any other day", () => {
    expect(monthFirstLabel("2026-12-02")).toBeNull();
    expect(monthFirstLabel("")).toBeNull();
    expect(monthFirstLabel(null)).toBeNull();
  });
});

describe("monthFirstOptions - the „Gültig ab“ choice (owner review #854)", () => {
  it("offers month-firsts only, oldest first, from the first month-first after the hire day", () => {
    const options = monthFirstOptions({
      today: "2026-11-12",
      earliest: "2026-10-19T00:00:00.000Z",
      monthsAhead: 2,
    });
    expect(options).toEqual([
      { value: "2026-11-01", label: "November 2026" },
      { value: "2026-12-01", label: "Dezember 2026" },
      { value: "2027-01-01", label: "Januar 2027" },
    ]);
    expect(options.every((o) => isMonthFirst(o.value))).toBe(true);
  });

  it("starts in the hire month itself when the hire day is a 1st (a retroactive correction stays possible)", () => {
    const options = monthFirstOptions({
      today: "2026-11-12",
      earliest: "2025-01-01",
      monthsAhead: 0,
    });
    expect(options[0].value).toBe("2025-01-01");
    expect(options.at(-1)?.value).toBe("2026-11-01");
    expect(options).toHaveLength(23);
  });

  it("without a hire day it reaches the given months back", () => {
    const options = monthFirstOptions({ today: "2026-11-12", monthsBack: 2, monthsAhead: 1 });
    expect(options.map((o) => o.value)).toEqual([
      "2026-09-01",
      "2026-10-01",
      "2026-11-01",
      "2026-12-01",
    ]);
  });

  it("always offers the current value, and never a day that is not a month-first", () => {
    const base = { today: "2026-11-12", monthsBack: 0, monthsAhead: 1 };
    expect(monthFirstOptions({ ...base, include: "2030-05-01" }).map((o) => o.value)).toEqual([
      "2026-11-01",
      "2026-12-01",
      "2030-05-01",
    ]);
    expect(monthFirstOptions({ ...base, include: "2030-05-15" })).toHaveLength(2);
  });

  it("is empty for a malformed today", () => {
    expect(monthFirstOptions({ today: "12.11.2026" })).toEqual([]);
  });
});
