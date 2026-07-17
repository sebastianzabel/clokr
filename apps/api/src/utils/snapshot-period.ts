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

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

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
