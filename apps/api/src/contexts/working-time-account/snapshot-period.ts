/**
 * Convention-robust matching of MONTHLY SaldoSnapshots to a calendar month.
 *
 * Problem: `SaldoSnapshot.periodStart` is a @db.Date column, but two storage
 * conventions exist on production data:
 *
 *   1. TZ-converted (API paths via monthRangeUtc): for Europe/Berlin summer,
 *      June 2026 starts at 2026-05-31T22:00:00Z → stored as date `2026-05-31`.
 *   2. UTC-naive (legacy import scripts): June 2026 stored as date `2026-06-01`.
 *
 * Equality checks on `periodStart === monthStart` only match convention (1) and
 * MISS convention (2), which has caused duplicate active snapshots for the same
 * month in production (two snapshots per month, both superseded=false).
 *
 * The fix: match any periodStart inside a 2-day window starting at monthStart.
 * The window covers both conventions while excluding the NEXT month's
 * TZ-converted periodStart (which is the last day of THIS month, e.g.
 * `2026-06-30` for July — well outside [monthStart, monthStart + 2d)).
 */

import { monthRangeUtc } from "./timezone";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const TWO_DAYS_MS = 2 * ONE_DAY_MS;

/**
 * Prisma `where` fragment matching a MONTHLY snapshot's periodStart for the
 * month beginning at `monthStart` (as returned by monthRangeUtc), regardless
 * of which date convention the row was stored with.
 *
 * Prisma casts DateTime params to the column type (@db.Date → date), so
 * `gte: monthStart` compares against the UTC date-part of monthStart.
 */
export function periodStartWindow(monthStart: Date): { gte: Date; lt: Date } {
  return {
    gte: monthStart,
    lt: new Date(monthStart.getTime() + TWO_DAYS_MS),
  };
}

/**
 * In-memory variant for already-fetched snapshots: does `periodStart` (a
 * UTC-midnight Date from a @db.Date column) belong to the month beginning at
 * `monthStart` (a monthRangeUtc timestamp)?
 */
export function isPeriodStartInMonth(periodStart: Date, monthStart: Date): boolean {
  // Normalize monthStart to UTC midnight of its UTC date-part — this equals the
  // stored date value for the TZ-converted convention.
  const baseStr = monthStart.toISOString().slice(0, 10);
  const base = new Date(baseStr + "T00:00:00Z").getTime();
  const t = periodStart.getTime();
  return t >= base && t < base + TWO_DAYS_MS;
}

/**
 * The one tie-break for several active MONTHLY rows that match one month's window
 * (Issue #595, P-01): legacy UTC-naive and TZ-converted duplicates of the same month exist on
 * production (see the header). Every account read takes the FIRST row of this order. The
 * smallest `periodStart` is exactly the row the former exact-match lookup returned whenever it
 * returned one, so a month already shown as confirmed keeps its figures; `closedAt` and `id`
 * only make the rare remaining tie deterministic.
 */
export function monthlySnapshotOrder(): Array<
  { periodStart: "asc" } | { closedAt: "asc" } | { id: "asc" }
> {
  return [{ periodStart: "asc" }, { closedAt: "asc" }, { id: "asc" }];
}

/**
 * The calendar month a stored MONTHLY snapshot belongs to (Issue #595, D-03): the month M for
 * which `isPeriodStartInMonth(periodStart, monthRangeUtc(M, tz).start)` holds, or null when the
 * date lies in no month's window (never a guess).
 *
 * This is the ONE place a stored MONTHLY snapshot is given a calendar month. It is the exact
 * inverse of `periodStartWindow`, so the month a reader FINDS a row under and the month a page
 * NAMES it are the same by construction, and it covers both storage conventions of the header
 * (TZ-converted last day of the previous month, legacy UTC-naive 1st of the month). Never derive
 * a month from `periodStart` anywhere else - not with date getters, not with a date-string
 * slice, not in the browser: a getter in the browser's zone names every TZ-converted row one
 * month early. `computeFirstOpenMonth` (month-close-window.ts) keeps its own +15-day derivation
 * on the write path; `snapshot-period-595.test.ts` pins the two equal.
 *
 * Candidates: the UTC calendar month of `periodStart` (legacy rows and zones behind UTC) and
 * the UTC calendar month one day later (TZ-converted rows of zones ahead of UTC, stored on the
 * last day of the previous month). The windows of two months never overlap, so at most one holds.
 */
export function snapshotMonthOf(
  periodStart: Date,
  tz: string,
): { year: number; month: number } | null {
  const candidates = [periodStart, new Date(periodStart.getTime() + ONE_DAY_MS)];
  for (const candidate of candidates) {
    const year = candidate.getUTCFullYear();
    const month = candidate.getUTCMonth() + 1;
    if (isPeriodStartInMonth(periodStart, monthRangeUtc(year, month, tz).start)) {
      return { year, month };
    }
  }
  return null;
}

/**
 * The calendar year of a YEARLY snapshot: the UTC year of its `periodStart`. YEARLY rows are
 * written as a plain UTC year boundary (`${year}-01-01T00:00:00Z`, close-year handler), never
 * through `monthRangeUtc`, so no zone conversion applies.
 */
export function yearlySnapshotYearOf(periodStart: Date): number {
  return periodStart.getUTCFullYear();
}

/**
 * One row per calendar month out of already-fetched MONTHLY snapshots (Issue #595, P-01): per
 * month the row that is FIRST in `monthlySnapshotOrder()` (smallest `periodStart`, then
 * `closedAt`, then `id`) is kept and the others are dropped, so a duplicate legacy + TZ-converted
 * pair never shows a second, different closed figure. This is the in-memory twin of that order;
 * `snapshot-period-595.test.ts` pins the two together. A row whose month cannot be named is kept
 * untouched; the input order of the kept rows is preserved.
 */
export function selectMonthlySnapshotPerMonth<
  T extends { id: string; periodStart: Date; closedAt: Date },
>(rows: T[], tz: string): T[] {
  const first = (a: T, b: T): boolean => {
    if (a.periodStart.getTime() !== b.periodStart.getTime()) {
      return a.periodStart.getTime() < b.periodStart.getTime();
    }
    if (a.closedAt.getTime() !== b.closedAt.getTime()) {
      return a.closedAt.getTime() < b.closedAt.getTime();
    }
    return a.id < b.id;
  };
  const keyOf = (row: T): number | null => {
    const named = snapshotMonthOf(row.periodStart, tz);
    return named === null ? null : named.year * 12 + (named.month - 1);
  };
  const best = new Map<number, T>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null) continue;
    const current = best.get(key);
    if (current === undefined || first(row, current)) best.set(key, row);
  }
  return rows.filter((row) => {
    const key = keyOf(row);
    return key === null || best.get(key) === row;
  });
}
