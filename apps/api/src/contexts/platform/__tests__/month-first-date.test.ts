/**
 * Issue #450 (D-04) — pure unit suite for `snapToMonthFirstUtc`'s new optional `direction`
 * parameter. "down" (the default, pre-existing behaviour) is pinned alongside the new "up"
 * direction so a regression in either direction is caught here, not downstream in the loader.
 *
 * No DB. Every date is built via `new Date(Date.UTC(...))` or an explicit ISO instant string.
 */
import { describe, it, expect } from "vitest";
import { snapToMonthFirstUtc } from "../month-first-date";

describe("snapToMonthFirstUtc (Issue #450, D-04)", () => {
  it("no direction argument (default 'down'): 2026-07-18T13:00Z -> 2026-07-01T00:00Z (existing behavior)", () => {
    const result = snapToMonthFirstUtc(new Date("2026-07-18T13:00:00.000Z"));
    expect(result.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("'down' direction explicitly produces the same result as the default", () => {
    const result = snapToMonthFirstUtc(new Date("2026-07-18T13:00:00.000Z"), "down");
    expect(result.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("'up': already month-1st midnight stays unchanged", () => {
    const result = snapToMonthFirstUtc(new Date("2026-07-01T00:00:00.000Z"), "up");
    expect(result.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("'up': month-1st with a non-midnight time-of-day stays in the same month", () => {
    const result = snapToMonthFirstUtc(new Date("2026-07-01T05:00:00.000Z"), "up");
    expect(result.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("'up': a non-1st date moves to the 1st of the FOLLOWING UTC month", () => {
    const result = snapToMonthFirstUtc(new Date("2026-05-18T00:00:00.000Z"), "up");
    expect(result.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  it("'up': a Berlin-local-midnight write of 01.07. (2026-06-30T22:00Z in UTC) snaps to 2026-07-01", () => {
    const result = snapToMonthFirstUtc(new Date("2026-06-30T22:00:00.000Z"), "up");
    expect(result.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("'up': year rollover — 2026-12-31 moves to 2027-01-01", () => {
    const result = snapToMonthFirstUtc(new Date("2026-12-31T00:00:00.000Z"), "up");
    expect(result.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("'up' is idempotent: up(up(d)) === up(d) for every case above", () => {
    const inputs = [
      "2026-07-01T00:00:00.000Z",
      "2026-07-01T05:00:00.000Z",
      "2026-05-18T00:00:00.000Z",
      "2026-06-30T22:00:00.000Z",
      "2026-12-31T00:00:00.000Z",
    ];
    for (const iso of inputs) {
      const once = snapToMonthFirstUtc(new Date(iso), "up");
      const twice = snapToMonthFirstUtc(once, "up");
      expect(twice.toISOString()).toBe(once.toISOString());
    }
  });
});
