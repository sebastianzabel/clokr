import { describe, it, expect } from "vitest";
import { applyPrepWrapup } from "../time-arithmetic";

describe("applyPrepWrapup", () => {
  it("pads start earlier and end later by the given minutes", () => {
    expect(applyPrepWrapup("09:00", "17:00", 15, 15)).toEqual({
      startTime: "08:45",
      endTime: "17:15",
    });
  });

  it("is a no-op passthrough when prep and wrapup are both 0", () => {
    expect(applyPrepWrapup("09:00", "17:00", 0, 0)).toEqual({
      startTime: "09:00",
      endTime: "17:00",
    });
  });

  it("clamps the lower bound to 00:00, never rolling to the previous day", () => {
    expect(applyPrepWrapup("00:10", "17:00", 30, 0)).toEqual({
      startTime: "00:00",
      endTime: "17:00",
    });
  });

  it("clamps the upper bound to 23:59, never rolling to the next day", () => {
    expect(applyPrepWrapup("09:00", "23:50", 0, 30)).toEqual({
      startTime: "09:00",
      endTime: "23:59",
    });
  });

  it("does not mutate its string inputs and returns a fresh object each call", () => {
    const rawStart = "09:00";
    const rawEnd = "17:00";
    const result1 = applyPrepWrapup(rawStart, rawEnd, 10, 10);
    const result2 = applyPrepWrapup(rawStart, rawEnd, 10, 10);

    expect(rawStart).toBe("09:00");
    expect(rawEnd).toBe("17:00");
    expect(result1).not.toBe(result2); // fresh object each call
    expect(result1).toEqual(result2); // same value
  });
});
