// Issue #86 (D-01, AC-86-6) - the employment state is decided from exitDate and a calendar day.
import { describe, expect, it } from "vitest";
import { employmentState, localCalendarDay } from "$lib/employees/employment-state";

describe("employmentState (Issue #86)", () => {
  it("no exit date means employed", () => {
    expect(employmentState(null, "2026-10-16")).toEqual({ kind: "EMPLOYED", label: "" });
    expect(employmentState(undefined, "2026-10-16").kind).toBe("EMPLOYED");
  });

  it("an exit day in the future or today is a planned exit", () => {
    expect(employmentState("2026-12-31T00:00:00.000Z", "2026-10-16")).toEqual({
      kind: "EXIT_PLANNED",
      label: "Austritt am 31.12.2026",
    });
    expect(employmentState("2026-10-16T00:00:00.000Z", "2026-10-16").kind).toBe("EXIT_PLANNED");
  });

  it("an exit day in the past is ended", () => {
    expect(employmentState("2026-10-15T00:00:00.000Z", "2026-10-16")).toEqual({
      kind: "ENDED",
      label: "Ausgeschieden am 15.10.2026",
    });
  });

  it("a plain date string works like an instant", () => {
    expect(employmentState("2026-01-05", "2026-10-16").kind).toBe("ENDED");
  });

  it("localCalendarDay formats the local day with zero padding", () => {
    expect(localCalendarDay(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});
