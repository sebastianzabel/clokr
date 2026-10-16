// Issue #595 (D-04), Plan 595-04 - one label helper for the stored day count of a leave request.
import { describe, it, expect } from "vitest";

import { calendarDaysUnit, leaveDaysLabel } from "../leave-days-label";

describe("leaveDaysLabel", () => {
  it("names the stored day count of a sick request Arbeitstage (it is a workday price)", () => {
    expect(leaveDaysLabel(2, false, "SICK")).toBe("2 Arbeitstage");
    expect(leaveDaysLabel(1, false, "SICK_CHILD")).toBe("1 Arbeitstag");
    expect(leaveDaysLabel(0, false, "SICK")).toBe("0 Arbeitstage");
  });

  it("keeps the former text for every other type", () => {
    expect(leaveDaysLabel(3, false, "VACATION")).toBe("3 Tage");
    expect(leaveDaysLabel(1, false, "VACATION")).toBe("1 Tag");
    expect(leaveDaysLabel(2, false, "SPECIAL")).toBe("2 Tage");
  });

  it("reads a half day as one half Tag, whatever the type", () => {
    expect(leaveDaysLabel(0.5, true, "VACATION")).toBe("½ Tag");
    expect(leaveDaysLabel(0.5, true, "SICK")).toBe("½ Tag");
  });

  it("treats a missing or masked type like any other type", () => {
    expect(leaveDaysLabel(2, false, null)).toBe("2 Tage");
    expect(leaveDaysLabel(1, false, undefined)).toBe("1 Tag");
  });
});

describe("calendarDaysUnit", () => {
  it("is singular only for exactly one", () => {
    expect(calendarDaysUnit(1)).toBe("Kalendertag");
    expect(calendarDaysUnit(0)).toBe("Kalendertage");
    expect(calendarDaysUnit(4)).toBe("Kalendertage");
    expect(calendarDaysUnit(0.5)).toBe("Kalendertage");
  });
});
