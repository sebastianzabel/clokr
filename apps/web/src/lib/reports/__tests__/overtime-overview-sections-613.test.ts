// Issue #613 (AC-613-5) - the pure helpers behind the exited-persons section of /reports.
import { describe, it, expect } from "vitest";
import {
  partitionOvertimeOverview,
  exitedMoreCount,
  exitDateLabel,
} from "../overtime-overview-sections";

describe("partitionOvertimeOverview", () => {
  it("puts flagged rows into exitedOpen and every other row (false or missing) into active, keeping the order", () => {
    const rows = [
      { id: "a", exitedWithOpenFinalSaldo: false },
      { id: "x1", exitedWithOpenFinalSaldo: true },
      { id: "b" },
      { id: "x2", exitedWithOpenFinalSaldo: true },
      { id: "c", exitedWithOpenFinalSaldo: false },
    ];
    const { active, exitedOpen } = partitionOvertimeOverview(rows);
    expect(active.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(exitedOpen.map((r) => r.id)).toEqual(["x1", "x2"]);
  });

  it("returns two empty lists for no rows", () => {
    expect(partitionOvertimeOverview([])).toEqual({ active: [], exitedOpen: [] });
  });
});

describe("exitedMoreCount", () => {
  it("is the number of persons counted but not listed, never negative", () => {
    expect(exitedMoreCount(52, 50)).toBe(2);
    expect(exitedMoreCount(2, 2)).toBe(0);
    expect(exitedMoreCount(1, 3)).toBe(0);
  });
});

describe("exitDateLabel", () => {
  it("formats a tenant-local day as DD.MM.YYYY", () => {
    expect(exitDateLabel("2026-10-15")).toBe("15.10.2026");
  });

  it("answers an en dash for null, undefined and a malformed value", () => {
    expect(exitDateLabel(null)).toBe("–");
    expect(exitDateLabel(undefined)).toBe("–");
    expect(exitDateLabel("15.10.2026")).toBe("–");
    expect(exitDateLabel("2026-10-15T00:00:00Z")).toBe("–");
  });
});
