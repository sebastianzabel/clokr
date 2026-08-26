/**
 * The single shared tenant-TZ date helper for the whole `apps/api` test suite
 * (issue #34).
 *
 * Root cause this file fixes: test date helpers used to do LOCAL arithmetic
 * and then UTC formatting (`d.setDate(d.getDate() - n)` … then slicing the
 * ISO-8601 rendering of `d` down to its date component), while the endpoints
 * under test resolve the same calendar day in the TENANT timezone
 * (Europe/Berlin, seeded in `setup.ts:61`). Between
 * 00:00 and 02:00 Europe/Berlin the UTC date is still "yesterday", so the two
 * derivations silently disagreed by one day.
 *
 * This is THE only place test date math may live — no test file may keep a
 * private copy. Every export here either derives a calendar day from "now"
 * (going through `todayInTz`/`dateStrInTz` from `../utils/timezone`, mirroring
 * the exact DST-safe idiom in `../utils/retro-config.ts`), or reads a value
 * already stored in the database (`dbDateStr`, `@db.Date` columns are UTC
 * midnight — see its own comment for why that must NOT be re-projected into
 * the tenant TZ).
 */
import { todayInTz, dateStrInTz } from "../utils/timezone";

/** Must mirror the tenant timezone seeded in `setup.ts:61`. */
export const TEST_TZ = "Europe/Berlin";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Format a value already STORED in the database (a Prisma `@db.Date` /
 * UTC-midnight column, e.g. `TimeEntry.date`, `Section9Credit.overlapStart`,
 * `RetroEntryRequest.targetDate`, `WorkSchedule.validFrom`) as "YYYY-MM-DD".
 *
 * Deliberately formats in UTC, NOT `TEST_TZ`: Prisma stores `@db.Date` values
 * at UTC midnight, so projecting that instant into a tenant TZ would be a
 * SECOND, wrong conversion — for any tenant with a negative UTC offset (or,
 * more relevantly here, any hour before the tenant's own local midnight) it
 * would yield the previous calendar day. This is what replaces the old
 * ISO-string-then-slice calls that read a stored value rather than deriving
 * "now".
 */
export function dbDateStr(d: Date): string {
  return dateStrInTz(d, "UTC");
}

/** Parse a "YYYY-MM-DD" string back into its UTC-midnight `Date`. */
export function utcMidnight(dateStr: string): Date {
  return new Date(dateStr + "T00:00:00Z");
}

/** "Today", derived in the tenant timezone (default `TEST_TZ`). */
export function todayStr(tz: string = TEST_TZ): string {
  return dbDateStr(todayInTz(tz));
}

/**
 * `daysAgo` calendar days before "today" in the tenant timezone. Mirrors
 * `computeRetroLimitStr` in `../utils/retro-config.ts` exactly: `todayInTz` is
 * already normalised to UTC midnight, so whole-day subtraction is exact and
 * DST-safe.
 */
export function pastDateStr(daysAgo: number, tz: string = TEST_TZ): string {
  return dbDateStr(new Date(todayInTz(tz).getTime() - daysAgo * DAY_MS));
}

/** `daysAhead` calendar days after "today" in the tenant timezone. */
export function futureDateStr(daysAhead: number, tz: string = TEST_TZ): string {
  return dbDateStr(new Date(todayInTz(tz).getTime() + daysAhead * DAY_MS));
}

/**
 * `n` calendar days before an explicit FROZEN instant (`now`), in the tenant
 * timezone. For callers that pin "now" themselves (e.g. `retro-entry-first
 * .test.ts`'s `FROZEN_NOW`) rather than reading the live clock.
 */
export function daysAgoStrInTz(now: Date, n: number, tz: string = TEST_TZ): string {
  return dateStrInTz(new Date(now.getTime() - n * DAY_MS), tz);
}

/**
 * Day-of-week (0=Sunday .. 6=Saturday) of a "YYYY-MM-DD" date string. Reads
 * the weekday off the tenant-TZ date STRING (via its UTC-midnight
 * representation), never via local `getDay()` on an instant — that is what
 * keeps this consistent under the fake-clock harness at any wall-clock time.
 */
export function dowOf(dateStr: string): number {
  return utcMidnight(dateStr).getUTCDay();
}

/** Advance `dateStr` by whole days until it lands on a weekday (Mon-Fri). */
export function nextWeekdayStr(dateStr: string): string {
  let d = dateStr;
  while (dowOf(d) === 0 || dowOf(d) === 6) {
    d = dbDateStr(new Date(utcMidnight(d).getTime() + DAY_MS));
  }
  return d;
}

/** Monday of the ISO week containing "today" in the tenant timezone. */
export function mondayOfWeekStr(tz: string = TEST_TZ): string {
  const today = todayStr(tz);
  const dow = dowOf(today); // 0=Sun..6=Sat
  const mondayOffsetDays = dow === 0 ? -6 : 1 - dow;
  return dbDateStr(new Date(utcMidnight(today).getTime() + mondayOffsetDays * DAY_MS));
}

/**
 * "Today" (tenant TZ) shifted forward by `months` calendar months, via
 * `Date.UTC` month arithmetic. Note: this normalises JS-style month overflow
 * (e.g. Jan 31 + 1 month → Mar 3, not Feb 31) — harmless for the "far enough
 * ahead" assertions that consume it.
 */
export function monthsAheadStr(months: number, tz: string = TEST_TZ): string {
  const today = todayStr(tz);
  const [y, m, d] = today.split("-").map(Number);
  return dbDateStr(new Date(Date.UTC(y, m - 1 + months, d)));
}
