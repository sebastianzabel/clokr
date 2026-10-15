// Issue #93 - the month of the support month view: the `monat` query is validated against the
// bounds the API accepts, the default is the current month in the browser zone, and stepping keeps
// the month inside those bounds.
import { describe, expect, it } from "vitest";

import {
  MAX_MONTH,
  MIN_MONTH,
  currentMonth,
  monthFromQuery,
  monthLabel,
  shiftMonth,
} from "../support-month";

describe("monthFromQuery", () => {
  it("accepts YYYY-MM inside the supported years", () => {
    expect(monthFromQuery("2026-09")).toBe("2026-09");
    expect(monthFromQuery(MIN_MONTH)).toBe(MIN_MONTH);
    expect(monthFromQuery(MAX_MONTH)).toBe(MAX_MONTH);
  });

  it.each([
    null,
    "",
    "2026-9",
    "2026-13",
    "2026-00",
    "1999-12",
    "2101-01",
    "2026-09-01",
    "abcd-ef",
  ])("rejects %s", (value) => {
    expect(monthFromQuery(value)).toBeNull();
  });
});

describe("currentMonth", () => {
  it("is the month of the given instant in the browser zone", () => {
    const now = new Date(2026, 8, 15, 12, 0, 0);
    expect(currentMonth(now)).toBe("2026-09");
    expect(currentMonth(new Date(2026, 0, 1, 0, 0, 0))).toBe("2026-01");
    expect(currentMonth(new Date(2026, 11, 31, 23, 59, 59))).toBe("2026-12");
  });
});

describe("shiftMonth", () => {
  it("steps over a year boundary in both directions", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-09", 1)).toBe("2026-10");
    expect(shiftMonth("2026-09", -1)).toBe("2026-08");
  });

  it("stays inside the supported bounds", () => {
    expect(shiftMonth(MIN_MONTH, -1)).toBe(MIN_MONTH);
    expect(shiftMonth(MAX_MONTH, 1)).toBe(MAX_MONTH);
  });
});

describe("monthLabel", () => {
  it("names the month in German", () => {
    expect(monthLabel("2026-09")).toBe("September 2026");
    expect(monthLabel("2026-03")).toBe("März 2026");
  });
});
