// Issue #835 (IN-01) - the reason run of the takeover dialog is merged into the first run's result.
import { describe, it, expect } from "vitest";
import { mergeTakeoverResults } from "../takeover-result";
import type { TakeoverResult } from "../types";

const first: TakeoverResult = {
  created: [{ wishId: "w1", employeeId: "e1", leaveRequestId: "r1" }],
  pending: [{ wishId: "w2", employeeId: "e2", leaveRequestId: "r2", reason: "OWN_WISH" }],
  refused: [
    { wishId: "w3", employeeId: "e3", code: "LEAVE_LIMIT_EXCEPTION_REQUIRED", error: "Grenze" },
    { wishId: "w4", employeeId: "e4", code: "OVERLAP", error: "Überschneidung" },
  ],
  planStatus: "OPEN",
};

describe("mergeTakeoverResults", () => {
  it("keeps the first run's entries, lets a later entry win and takes the later plan status", () => {
    const second: TakeoverResult = {
      created: [{ wishId: "w3", employeeId: "e3", leaveRequestId: "r3" }],
      pending: [],
      refused: [{ wishId: "w4", employeeId: "e4", code: "OVERLAP", error: "Überschneidung" }],
      planStatus: "OPEN",
    };
    expect(mergeTakeoverResults(first, second)).toEqual({
      created: [
        { wishId: "w1", employeeId: "e1", leaveRequestId: "r1" },
        { wishId: "w3", employeeId: "e3", leaveRequestId: "r3" },
      ],
      pending: [{ wishId: "w2", employeeId: "e2", leaveRequestId: "r2", reason: "OWN_WISH" }],
      refused: [{ wishId: "w4", employeeId: "e4", code: "OVERLAP", error: "Überschneidung" }],
      planStatus: "OPEN",
    });
  });

  it("adds a wish only the later run reports and reports the later plan status", () => {
    const merged = mergeTakeoverResults(first, {
      created: [{ wishId: "w5", employeeId: "e5", leaveRequestId: "r5" }],
      pending: [],
      refused: [],
      planStatus: "TAKEN_OVER",
    });
    expect(merged.created.map((c) => c.wishId)).toEqual(["w1", "w5"]);
    expect(merged.refused.map((r) => r.wishId)).toEqual(["w3", "w4"]);
    expect(merged.planStatus).toBe("TAKEN_OVER");
  });
});
