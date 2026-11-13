/**
 * Issue #277 - findings 1 and 2 of the yearly close, pinned as regressions.
 *
 * Finding 1: the hire month was read with `getFullYear()`/`getMonth()` in the zone of the Node
 * process instead of the tenant. Finding 2: the cron took `monthSnapshots[length - 1]` as the
 * "December" snapshot, which is the already closed FOLLOWING January for a Europe/Berlin tenant
 * (stored as `${year}-12-31`) the moment the year block runs outside January.
 * Both are decided in one place now (`expected-close-months.ts`, #753); these tests keep it so.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assignYearMonthSnapshots, expectedCloseMonthsOfYear } from "../expected-close-months";

const TZ = "Europe/Berlin";

describe("hire month is read in the tenant zone, never the process zone (Issue #277, finding 1)", () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  // 2026-06-30T22:00:00Z is 1 July 00:00 in Europe/Berlin (summer time).
  const hireDate = new Date("2026-06-30T22:00:00Z");

  for (const processTz of ["UTC", "America/Los_Angeles", "Pacific/Auckland"]) {
    it(`starts at July whatever the process zone is (${processTz})`, () => {
      process.env.TZ = processTz;
      expect(expectedCloseMonthsOfYear({ year: 2026, tz: TZ, hireDate, exitDate: null })).toEqual([
        7, 8, 9, 10, 11, 12,
      ]);
    });
  }

  it("a hire at 00:30 Berlin on 1 Jan belongs to the new year even in a process zone still in the old one", () => {
    process.env.TZ = "America/Los_Angeles"; // still 31 Dec 2025 there
    const lateNewYearsEve = new Date("2025-12-31T23:30:00Z"); // 1 Jan 2026 00:30 Berlin
    expect(
      expectedCloseMonthsOfYear({ year: 2025, tz: TZ, hireDate: lateNewYearsEve, exitDate: null }),
    ).toEqual([]);
    expect(
      expectedCloseMonthsOfYear({ year: 2026, tz: TZ, hireDate: lateNewYearsEve, exitDate: null }),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("the cron source never reads a date part with a process-zone getter", () => {
    const src = readFileSync(
      join(__dirname, "..", "plugins", "auto-close-month.ts"),
      "utf8",
    ).replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/\.getFullYear\(\)/);
    expect(src).not.toMatch(/\.getMonth\(\)/);
  });
});

describe("the yearly close names its months, never 'the last row' (Issue #277, finding 2)", () => {
  const row = (id: string, periodStart: string) => ({
    id,
    periodStart: new Date(periodStart),
    closedAt: new Date("2026-03-01T00:00:00Z"),
  });
  const dec = row("dec", "2025-11-30T00:00:00Z"); // December 2025, TZ-converted
  const followingJan = row("jan-next", "2025-12-31T00:00:00Z"); // January 2026, TZ-converted

  it("a closed following January does not stand in for a missing December", () => {
    const r = assignYearMonthSnapshots([followingJan], [12], 2025, TZ);
    expect(r.missing).toEqual([12]);
    expect(r.assigned).toEqual([]);
  });

  it("with December present the following January is ignored, December is the last month", () => {
    const r = assignYearMonthSnapshots([dec, followingJan], [12], 2025, TZ);
    expect(r.missing).toEqual([]);
    expect(r.assigned.map((x) => x.id)).toEqual(["dec"]);
  });

  it("the cron aggregates the assigned months, not the last fetched row", () => {
    const src = readFileSync(
      join(__dirname, "..", "plugins", "auto-close-month.ts"),
      "utf8",
    ).replace(/\/\/.*$/gm, "");
    expect(src).toContain("assignYearMonthSnapshots(");
    expect(src).not.toMatch(/monthSnapshots\[\s*monthSnapshots\.length/);
  });
});
