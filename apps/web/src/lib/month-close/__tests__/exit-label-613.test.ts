// Issue #613 (P-03) - the Monatsabschluss names the exit day of a person. The server sends the
// tenant-local calendar day as `YYYY-MM-DD`; the web only formats that string.
import { describe, expect, it } from "vitest";
import { exitLabel } from "$lib/month-close/exit-label";

describe("exitLabel", () => {
  it("formats the exit day in German day-month-year order", () => {
    expect(exitLabel("2026-09-30")).toBe("Austritt am 30.09.2026");
    expect(exitLabel("2027-01-05")).toBe("Austritt am 05.01.2027");
  });

  it("returns null without an exit date", () => {
    expect(exitLabel(null)).toBeNull();
    expect(exitLabel(undefined)).toBeNull();
    expect(exitLabel("")).toBeNull();
  });

  it("returns null for a malformed string and never prints undefined", () => {
    for (const bad of ["30.09.2026", "2026-9-30", "2026-09-30T00:00:00Z", "abc", "2026-13-01x"]) {
      expect(exitLabel(bad)).toBeNull();
    }
  });

  it("does not shift the day across time zones (no Date parsing)", () => {
    const original = process.env.TZ;
    try {
      for (const tz of ["Pacific/Auckland", "America/Los_Angeles", "UTC"]) {
        process.env.TZ = tz;
        expect(exitLabel("2026-10-01")).toBe("Austritt am 01.10.2026");
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});
