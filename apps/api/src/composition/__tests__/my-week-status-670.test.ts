/**
 * Issue #670 - DB-free pins: the documented my-week vocabulary mapping.
 */
import { describe, it, expect } from "vitest";
import { myWeekStatusOf } from "../my-week-status";

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
