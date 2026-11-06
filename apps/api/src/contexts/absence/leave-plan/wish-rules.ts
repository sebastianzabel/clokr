/**
 * Issue #835 (D-835-06) — the pure date rules of a leave plan wish. No I/O, no runtime import.
 *
 * A wish is a closed range of calendar days (`@db.Date`, inclusive on both ends). Days travel as
 * `YYYY-MM-DD` strings; the helpers convert a `@db.Date` value through its UTC date part, exactly
 * as Prisma casts it (CLAUDE.md #493: a calendar column never meets a tenant-local instant).
 *
 * Deliberately NOT re-exported from `contexts/absence/index.ts` (import-cycle cap 22).
 */

/** The UTC date part (`YYYY-MM-DD`) of a `@db.Date` value. */
export function dayOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The `@db.Date` value of a `YYYY-MM-DD` day (UTC midnight). */
export function dayToDate(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

/** True iff both days lie in the calendar year `year`. */
export function wishInsideYear(startDay: string, endDay: string, year: number): boolean {
  const first = `${year}-01-01`;
  const last = `${year}-12-31`;
  return startDay >= first && startDay <= last && endDay >= first && endDay <= last;
}

/** A half day is only valid for a single day, exactly as for a request. */
export function halfDayShapeValid(startDay: string, endDay: string, halfDay: boolean): boolean {
  return !halfDay || startDay === endDay;
}

/** True iff the inclusive ranges share at least one day. */
export function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}
