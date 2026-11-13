// Issue #835 (D-835-21) — the pure date ↔ column math of the planner timeline.
import { describe, it, expect } from "vitest";
import {
  assignLanes,
  clampRangeToYear,
  dayFromIndex,
  dayIndex,
  daysInYear,
  monthSegments,
  moveRange,
  pointerDeltaToDays,
  rangeToColumns,
  resizeRange,
} from "../timeline";

describe("dayIndex / dayFromIndex / daysInYear", () => {
  it("counts from the first of January and knows leap years", () => {
    expect(dayIndex(2027, "2027-01-01")).toBe(0);
    expect(dayIndex(2028, "2028-12-31")).toBe(365);
    expect(dayIndex(2027, "2027-12-31")).toBe(364);
    expect(daysInYear(2027)).toBe(365);
    expect(daysInYear(2028)).toBe(366);
    expect(daysInYear(2100)).toBe(365);
  });

  it("dayFromIndex inverts dayIndex for every day of a leap and a common year", () => {
    for (const year of [2027, 2028]) {
      for (let i = 0; i < daysInYear(year); i++) {
        expect(dayIndex(year, dayFromIndex(year, i))).toBe(i);
      }
    }
  });

  it("is not moved by a DST change (UTC arithmetic)", () => {
    expect(dayIndex(2027, "2027-03-28")).toBe(dayIndex(2027, "2027-03-27") + 1);
    expect(dayIndex(2027, "2027-10-31")).toBe(dayIndex(2027, "2027-10-30") + 1);
  });
});

describe("monthSegments", () => {
  it("has 12 entries whose lengths sum to the year, February 28 or 29", () => {
    const segments = monthSegments(2027);
    expect(segments).toHaveLength(12);
    expect(segments.reduce((sum, s) => sum + s.length, 0)).toBe(365);
    expect(segments[1].length).toBe(28);
    expect(segments[1].startIndex).toBe(31);
    expect(monthSegments(2028)[1].length).toBe(29);
    expect(segments[0].label).toBe("Januar");
  });
});

describe("moveRange", () => {
  it("shifts both bounds and keeps the length", () => {
    expect(moveRange({ startDate: "2027-03-08", endDate: "2027-03-12" }, 3, 2027)).toEqual({
      startDate: "2027-03-11",
      endDate: "2027-03-15",
    });
  });

  it("clamps the whole range inside the year with the length kept", () => {
    expect(moveRange({ startDate: "2027-12-20", endDate: "2027-12-24" }, 30, 2027)).toEqual({
      startDate: "2027-12-27",
      endDate: "2027-12-31",
    });
    expect(moveRange({ startDate: "2027-01-05", endDate: "2027-01-09" }, -30, 2027)).toEqual({
      startDate: "2027-01-01",
      endDate: "2027-01-05",
    });
  });
});

describe("resizeRange", () => {
  const range = { startDate: "2027-03-08", endDate: "2027-03-12" };

  it("never produces start > end: the end by -10 leaves a one-day range on the start day", () => {
    expect(resizeRange(range, "end", -10, 2027)).toEqual({
      startDate: "2027-03-08",
      endDate: "2027-03-08",
    });
  });

  it("the start by +2 yields start+2..end; by +99 collapses onto the end day", () => {
    expect(resizeRange(range, "start", 2, 2027)).toEqual({
      startDate: "2027-03-10",
      endDate: "2027-03-12",
    });
    expect(resizeRange(range, "start", 99, 2027)).toEqual({
      startDate: "2027-03-12",
      endDate: "2027-03-12",
    });
  });

  it("stays inside the year", () => {
    expect(resizeRange(range, "end", 999, 2027).endDate).toBe("2027-12-31");
    expect(resizeRange(range, "start", -999, 2027).startDate).toBe("2027-01-01");
  });
});

describe("clampRangeToYear", () => {
  it("forces both bounds inside the year", () => {
    expect(clampRangeToYear({ startDate: "2026-12-20", endDate: "2028-01-10" }, 2027)).toEqual({
      startDate: "2027-01-01",
      endDate: "2027-12-31",
    });
  });
});

describe("pointerDeltaToDays", () => {
  it("rounds to whole columns", () => {
    expect(pointerDeltaToDays(29, 20)).toBe(1);
    expect(pointerDeltaToDays(-31, 20)).toBe(-2);
    expect(pointerDeltaToDays(9, 20)).toBe(0);
    expect(Object.is(pointerDeltaToDays(-3, 20), 0)).toBe(true);
    expect(pointerDeltaToDays(50, 0)).toBe(0);
  });
});

describe("rangeToColumns", () => {
  it("maps a range to 1-based columns of the year view", () => {
    expect(
      rangeToColumns({ startDate: "2027-01-03", endDate: "2027-01-05" }, 2027, "year"),
    ).toEqual({ startColumn: 3, span: 3, clippedStart: false, clippedEnd: false });
  });

  it("maps into a month view and clips at its edges", () => {
    expect(rangeToColumns({ startDate: "2027-02-25", endDate: "2027-03-03" }, 2027, 2)).toEqual({
      startColumn: 1,
      span: 3,
      clippedStart: true,
      clippedEnd: false,
    });
    expect(rangeToColumns({ startDate: "2027-03-30", endDate: "2027-04-02" }, 2027, 2)).toEqual({
      startColumn: 30,
      span: 2,
      clippedStart: false,
      clippedEnd: true,
    });
  });

  it("is null for a range outside the view", () => {
    expect(rangeToColumns({ startDate: "2027-05-01", endDate: "2027-05-03" }, 2027, 2)).toBeNull();
  });
});

describe("assignLanes", () => {
  it("packs overlapping items into separate lanes and reuses a free lane", () => {
    expect(
      assignLanes([
        { start: 0, end: 5 },
        { start: 3, end: 8 },
        { start: 6, end: 9 },
        { start: 10, end: 12 },
      ]),
    ).toEqual([0, 1, 0, 0]);
  });

  it("is empty for no items", () => {
    expect(assignLanes([])).toEqual([]);
  });
});
