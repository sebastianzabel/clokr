import { describe, it, expect } from "vitest";
import {
  HALF_DAY_LEAVE_CODE,
  halfDayLeaveHint,
  leaveBlocksShift,
  splitLeaveForShift,
} from "../shift-leave-rule";

/** Issue #744 - the one rule: a half-day leave row never blocks a shift, a full-day row does. */
describe("shift-leave-rule (Issue #744)", () => {
  const half = { id: "h", halfDay: true };
  const full = { id: "f", halfDay: false };

  it("a full-day row blocks, a half-day row does not", () => {
    expect(leaveBlocksShift(full)).toBe(true);
    expect(leaveBlocksShift(half)).toBe(false);
  });

  it("half-day only: no blocking row, the half-day row is reported", () => {
    expect(splitLeaveForShift([half])).toEqual({ blocking: null, halfDay: half });
  });

  it("half-day plus full-day on the same date: the full day wins, no hint", () => {
    expect(splitLeaveForShift([half, full])).toEqual({ blocking: full, halfDay: null });
    expect(splitLeaveForShift([full, half])).toEqual({ blocking: full, halfDay: null });
  });

  it("no rows: nothing", () => {
    expect(splitLeaveForShift([])).toEqual({ blocking: null, halfDay: null });
  });

  it("the hint carries the stable code and the leave id", () => {
    const hint = halfDayLeaveHint("abc", "01.12.2026");
    expect(hint.code).toBe(HALF_DAY_LEAVE_CODE);
    expect(hint.leaveRequestId).toBe("abc");
    expect(hint.message).toContain("01.12.2026");
  });
});
