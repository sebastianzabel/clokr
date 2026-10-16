/**
 * Issue #595 (D-03), Plan 595-02 - the one place a stored MONTHLY snapshot is given a calendar
 * month. `snapshotMonthOf` is the exact inverse of `periodStartWindow`, so the month a reader
 * FINDS a row under and the month a page NAMES it are the same by construction.
 *
 * Pure: no database. Rows are built with `monthRangeUtc` (the TZ-converted convention) and
 * `Date.UTC` (the legacy UTC-naive convention); the month/zone loops are generated, never a
 * literal list.
 */
import { describe, it, expect } from "vitest";
import {
  snapshotMonthOf,
  selectMonthlySnapshotPerMonth,
  yearlySnapshotYearOf,
  monthlySnapshotOrder,
} from "../snapshot-period";
import { monthRangeUtc } from "../timezone";
import { computeFirstOpenMonth } from "../month-close-window";

const ZONES = ["Europe/Berlin", "UTC", "America/New_York", "Asia/Kolkata"] as const;

/** The stored @db.Date value of an instant: UTC midnight of its UTC date part. */
function storedDateOf(instant: Date): Date {
  return new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()));
}

/** Every month 2024-01 .. 2027-12 as { year, month }. */
function allMonths(): Array<{ year: number; month: number }> {
  const months: Array<{ year: number; month: number }> = [];
  for (let year = 2024; year <= 2027; year += 1) {
    for (let month = 1; month <= 12; month += 1) months.push({ year, month });
  }
  return months;
}

describe("snapshotMonthOf names the month of a stored MONTHLY snapshot (Issue #595, D-03)", () => {
  let cases = 0;

  for (const tz of ZONES) {
    it(`${tz}: the TZ-converted row and the legacy 1st-of-month row name the same month for 2024-01..2027-12`, () => {
      for (const { year, month } of allMonths()) {
        const converted = storedDateOf(monthRangeUtc(year, month, tz).start);
        const legacy = new Date(Date.UTC(year, month - 1, 1));
        expect(snapshotMonthOf(converted, tz), `${tz} converted ${year}-${month}`).toEqual({
          year,
          month,
        });
        expect(snapshotMonthOf(legacy, tz), `${tz} legacy ${year}-${month}`).toEqual({
          year,
          month,
        });
        cases += 2;
      }
    });
  }

  it("the matrix covers 48 months x 4 zones x 2 conventions", () => {
    expect(cases).toBe(48 * ZONES.length * 2);
  });

  it("names the Europe/Berlin examples of the issue: stored 2026-07-31 is August, stored 2026-09-01 is September", () => {
    expect(snapshotMonthOf(new Date("2026-07-31T00:00:00Z"), "Europe/Berlin")).toEqual({
      year: 2026,
      month: 8,
    });
    expect(snapshotMonthOf(new Date("2026-09-01T00:00:00Z"), "Europe/Berlin")).toEqual({
      year: 2026,
      month: 9,
    });
    // CET: January 2026 starts 2025-12-31T23:00Z.
    expect(snapshotMonthOf(new Date("2025-12-31T00:00:00Z"), "Europe/Berlin")).toEqual({
      year: 2026,
      month: 1,
    });
  });

  it("a date that lies in no month's window yields null, never a guess", () => {
    for (const tz of ZONES) {
      for (const { year, month } of allMonths()) {
        expect(snapshotMonthOf(new Date(Date.UTC(year, month - 1, 15)), tz)).toBeNull();
      }
    }
  });

  it("is pinned equal to the write path's own derivation: computeFirstOpenMonth names the month after", () => {
    const earlyHire = new Date("2000-01-01T00:00:00Z");
    for (const tz of ZONES) {
      for (const { year, month } of allMonths()) {
        const rows = [
          storedDateOf(monthRangeUtc(year, month, tz).start),
          new Date(Date.UTC(year, month - 1, 1)),
        ];
        for (const periodStart of rows) {
          const named = snapshotMonthOf(periodStart, tz);
          expect(named).not.toBeNull();
          if (!named) continue;
          const next =
            named.month === 12
              ? { year: named.year + 1, month: 1 }
              : { year: named.year, month: named.month + 1 };
          expect(computeFirstOpenMonth(earlyHire, { periodStart }, tz)).toEqual(next);
        }
      }
    }
  });
});

describe("yearlySnapshotYearOf (Issue #595)", () => {
  it("is the UTC year of a YEARLY row's plain UTC year boundary", () => {
    expect(yearlySnapshotYearOf(new Date("2025-01-01T00:00:00Z"))).toBe(2025);
    expect(yearlySnapshotYearOf(new Date("2026-01-01T00:00:00Z"))).toBe(2026);
  });
});

describe("selectMonthlySnapshotPerMonth keeps the record the account reads (Issue #595, P-01)", () => {
  type Row = { id: string; periodStart: Date; closedAt: Date };
  const tz = "Europe/Berlin";
  const row = (id: string, periodStart: string, closedAt: string): Row => ({
    id,
    periodStart: new Date(`${periodStart}T00:00:00Z`),
    closedAt: new Date(closedAt),
  });

  it("keeps per month the row first in the account's order (smallest periodStart) and drops the other", () => {
    const legacy = row("b", "2026-09-01", "2026-10-01T00:00:00Z");
    const converted = row("a", "2026-08-31", "2026-10-02T00:00:00Z");
    expect(selectMonthlySnapshotPerMonth([legacy, converted], tz)).toEqual([converted]);
    expect(selectMonthlySnapshotPerMonth([converted, legacy], tz)).toEqual([converted]);
  });

  it("breaks an equal periodStart by closedAt, then by id", () => {
    const early = row("z", "2026-09-01", "2026-10-01T00:00:00Z");
    const late = row("a", "2026-09-01", "2026-10-02T00:00:00Z");
    expect(selectMonthlySnapshotPerMonth([late, early], tz)).toEqual([early]);
    const sameA = row("a", "2026-09-01", "2026-10-01T00:00:00Z");
    const sameB = row("b", "2026-09-01", "2026-10-01T00:00:00Z");
    expect(selectMonthlySnapshotPerMonth([sameB, sameA], tz)).toEqual([sameA]);
  });

  it("keeps rows of different months and preserves the input order of the kept rows", () => {
    const aug = row("1", "2026-07-31", "2026-09-01T00:00:00Z");
    const sepDup = row("2", "2026-09-01", "2026-10-01T00:00:00Z");
    const sep = row("3", "2026-08-31", "2026-10-02T00:00:00Z");
    const jan = row("4", "2026-01-01", "2026-02-01T00:00:00Z");
    // periodStart-desc input like the route's findMany
    const input = [sepDup, sep, aug, jan];
    expect(selectMonthlySnapshotPerMonth(input, tz)).toEqual([sep, aug, jan]);
  });

  it("keeps a row whose month cannot be named untouched", () => {
    const odd = row("o", "2026-09-15", "2026-10-01T00:00:00Z");
    const sep = row("s", "2026-08-31", "2026-10-02T00:00:00Z");
    expect(selectMonthlySnapshotPerMonth([odd, sep], tz)).toEqual([odd, sep]);
  });

  it("mirrors monthlySnapshotOrder(): periodStart, then closedAt, then id", () => {
    expect(monthlySnapshotOrder()).toEqual([
      { periodStart: "asc" },
      { closedAt: "asc" },
      { id: "asc" },
    ]);
  });
});
