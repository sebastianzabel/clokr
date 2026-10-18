/**
 * Issue #670 - DB-free pins: the documented my-week vocabulary mapping, and the proof that the
 * Monatsabschluss gap detector's obligation entry (`obligationOfDay`) answers exactly like the
 * primitive it delegates to, over the whole input grid (full-row comparison).
 */
import { describe, it, expect } from "vitest";
import { myWeekStatusOf } from "../my-week-status";
import { isObligatedWorkday, obligationOfDay } from "../../contexts/time-tracking";

const base = {
  hasLeave: false,
  absenceType: null,
  isWeekend: false,
  workedMinutes: 0,
  expectedMinutes: 480,
};

describe("myWeekStatusOf - the documented mapping", () => {
  it("maps every shared status", () => {
    expect(myWeekStatusOf({ ...base, status: "clocked_in" })).toBe("clocked_in");
    expect(myWeekStatusOf({ ...base, status: "present", workedMinutes: 480 })).toBe("complete");
    expect(myWeekStatusOf({ ...base, status: "present", workedMinutes: 479 })).toBe("partial");
    expect(myWeekStatusOf({ ...base, status: "requested" })).toBe("requested");
    expect(myWeekStatusOf({ ...base, status: "absent", hasLeave: true })).toBe("leave");
    expect(myWeekStatusOf({ ...base, status: "absent", absenceType: "SICK" })).toBe("sick");
    expect(myWeekStatusOf({ ...base, status: "absent", absenceType: "SICK_CHILD" })).toBe("sick");
    expect(myWeekStatusOf({ ...base, status: "absent", absenceType: "MATERNITY" })).toBe("absent");
    expect(myWeekStatusOf({ ...base, status: "holiday" })).toBe("holiday");
    expect(myWeekStatusOf({ ...base, status: "missing" })).toBe("missing");
    expect(myWeekStatusOf({ ...base, status: "scheduled" })).toBe("scheduled");
    expect(myWeekStatusOf({ ...base, status: "none" })).toBe("none");
    expect(myWeekStatusOf({ ...base, status: "none", isWeekend: true })).toBe("weekend");
  });

  it("a weekend day never turns a missing/scheduled status into weekend", () => {
    expect(myWeekStatusOf({ ...base, status: "missing", isWeekend: true })).toBe("missing");
    expect(myWeekStatusOf({ ...base, status: "scheduled", isWeekend: true })).toBe("scheduled");
  });
});

describe("obligationOfDay is the same predicate as isObligatedWorkday (month-close detector unchanged)", () => {
  it("agrees on the whole grid", () => {
    let rows = 0;
    for (const scheduleType of [
      null,
      "FIXED_SCHEDULE",
      "FIXED_WEEKLY",
      "SHIFT_BASED",
      "FLEXTIME",
      "MONTHLY_HOURS",
      "X",
    ]) {
      for (const workDays of [[], [1, 2, 3, 4, 5], [3, 4, 5], [1, 6]]) {
        for (let dow = 0; dow < 7; dow++) {
          for (const expectedHours of [0, 1, 8]) {
            for (const hasShift of [false, true]) {
              const p = { scheduleType, workDays, dow, expectedHours, hasShift };
              expect(obligationOfDay(p)).toBe(isObligatedWorkday(p));
              rows++;
            }
          }
        }
      }
    }
    expect(rows).toBe(7 * 4 * 7 * 3 * 2);
  });
});
