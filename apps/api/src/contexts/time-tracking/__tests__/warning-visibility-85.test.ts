// Issue #85 (D-12) - the window of the person's entries each ArbZG warning rests on. DB-free:
// `warningWindow` is pure. The windows decide which warnings a scoped caller may keep, so they must
// be at least as wide as what `checkArbZG` reads - a doubt withholds.

import { describe, it, expect } from "vitest";
import { warningWindow } from "../warning-visibility";

const day = new Date("2026-06-13T00:00:00Z"); // a Saturday
const week = {
  firstDay: new Date("2026-06-08T00:00:00Z"),
  lastDay: new Date("2026-06-14T00:00:00Z"),
};
const iso = (w: { from: Date; to: Date }) => [
  w.from.toISOString().slice(0, 10),
  w.to.toISOString().slice(0, 10),
];

describe("Issue #85 D-12 - warningWindow", () => {
  it.each([
    "BREAK_TOO_SHORT",
    "BREAK_SEGMENT_TOO_SHORT",
    "BREAK_TOO_LATE",
    "BREAK_OUTSIDE_WINDOW",
    "BREAK_POSITION_UNKNOWN",
    "MAX_DAILY_EXCEEDED",
  ])("%s rests on the entry's day only", (code) => {
    expect(iso(warningWindow(code, day, week))).toEqual(["2026-06-13", "2026-06-13"]);
  });

  it("MIN_REST_VIOLATED rests on the previous day up to the next day", () => {
    expect(iso(warningWindow("MIN_REST_VIOLATED", day, week))).toEqual([
      "2026-06-12",
      "2026-06-14",
    ]);
  });

  it("MAX_WEEKLY_EXCEEDED rests on the ISO week", () => {
    expect(iso(warningWindow("MAX_WEEKLY_EXCEEDED", day, week))).toEqual([
      "2026-06-08",
      "2026-06-14",
    ]);
  });

  it("MAX_DAILY_AVG_EXCEEDED rests on the 168 days up to the day", () => {
    expect(iso(warningWindow("MAX_DAILY_AVG_EXCEEDED", day, week))).toEqual([
      "2025-12-27",
      "2026-06-13",
    ]);
  });

  it("an unknown code gets the widest window", () => {
    expect(iso(warningWindow("SOME_FUTURE_CODE", day, week))).toEqual(["2025-12-27", "2026-06-14"]);
    // the day after the day reaches past the week when the day is the Sunday
    const sunday = new Date("2026-06-14T00:00:00Z");
    expect(iso(warningWindow("SOME_FUTURE_CODE", sunday, week))[1]).toBe("2026-06-15");
  });

  it("every known window contains the day itself", () => {
    for (const code of [
      "BREAK_TOO_SHORT",
      "MIN_REST_VIOLATED",
      "MAX_WEEKLY_EXCEEDED",
      "MAX_DAILY_AVG_EXCEEDED",
      "SOME_FUTURE_CODE",
    ]) {
      const w = warningWindow(code, day, week);
      expect(w.from.getTime()).toBeLessThanOrEqual(day.getTime());
      expect(w.to.getTime()).toBeGreaterThanOrEqual(day.getTime());
    }
  });
});
