// Issue #494 R5 — the client-side lock rule for the "Überstunden-Modus" select.
// Mirrors the monthly-hours clause of the server's isTrackOnlySchedule(); advisory display only.

import { describe, it, expect } from "vitest";
import { overtimeModeLocked, OVERTIME_MODE_LOCKED_HINT } from "../work-schedule";

describe("overtimeModeLocked (Issue #494 R5)", () => {
  it.each([null, undefined, 0, "0", "0.00", "", Number.NaN, -1])(
    "MONTHLY_HOURS with monthlyHours %j is locked",
    (hours) => {
      expect(overtimeModeLocked("MONTHLY_HOURS", hours)).toBe(true);
    },
  );

  it.each([0.5, 15, "15", "15.50"])("MONTHLY_HOURS with monthlyHours %j is not locked", (hours) => {
    expect(overtimeModeLocked("MONTHLY_HOURS", hours)).toBe(false);
  });

  it.each(["FIXED_SCHEDULE", "FLEXTIME", "SHIFT_BASED", undefined, null])(
    "type %j is never locked, even with null or 0 monthly hours",
    (type) => {
      expect(overtimeModeLocked(type, null)).toBe(false);
      expect(overtimeModeLocked(type, 0)).toBe(false);
    },
  );

  it("hint is the R5 sentence verbatim", () => {
    expect(OVERTIME_MODE_LOCKED_HINT).toBe(
      "Ohne Monatsstunden werden Stunden nur erfasst, nicht übertragen.",
    );
  });
});
