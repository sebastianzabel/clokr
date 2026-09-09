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
import { getHolidays, type FederalStateCode } from "../utils/holidays";

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

/**
 * UTC midnight of the FIRST day of the month `monthsAgo` calendar months before
 * the current month (resolved in the tenant timezone).
 *
 * Builds the date from (year, month, 1) via `Date.UTC` instead of mutating a
 * live `new Date()`. That is the whole point: `new Date()` still carries its
 * day-of-month, so `setUTCMonth(getUTCMonth() - n)` BEFORE `setUTCDate(1)`
 * overflows on a 31st ("31 June" rolls forward into July) and two different `n`
 * values collapse onto the SAME month start — which then violates the
 * SaldoSnapshot unique constraint (employeeId, periodType, periodStart).
 * Because the day component here is always 1, no overflow is possible; a
 * negative or out-of-range month index is normalised across the year by
 * `Date.UTC` itself.
 */
export function monthStartUtc(monthsAgo: number, tz: string = TEST_TZ): Date {
  const [y, m] = todayStr(tz).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 - monthsAgo, 1));
}

/**
 * UTC midnight of the LAST day of the same month `monthStartUtc(monthsAgo)`
 * returns. Day 0 of the FOLLOWING month is the last day of the target month,
 * and — like `monthStartUtc` — carries no day component that could overflow.
 */
export function monthEndUtc(monthsAgo: number, tz: string = TEST_TZ): Date {
  const [y, m] = todayStr(tz).split("-").map(Number);
  return new Date(Date.UTC(y, m - monthsAgo, 0));
}

/** `dateStr` shifted by `n` whole calendar days (may be negative). */
export function addDaysStr(dateStr: string, n: number): string {
  return dbDateStr(new Date(utcMidnight(dateStr).getTime() + n * DAY_MS));
}

/**
 * First Monday, searching forward one week at a time from `weeksAhead` weeks
 * after the CURRENT week's Monday (tenant TZ), whose whole Mon-Sun span
 * contains zero public holidays for `state` — plus, optionally, an extra
 * caller-supplied constraint (`accept`).
 *
 * Issue #136 (batch C): `shifts-under-coverage.test.ts`,
 * `shifts-week-workdays-primary.test.ts`, `shift-week-leave-absence-minutes
 * .test.ts` and `soll-korrelation-display.test.ts` each derived a "future
 * Monday, N weeks ahead" fixture week to avoid COLLIDING with other suites'
 * fixture data, but never checked it against the calendar. Roughly one week
 * in nine contains a German Feiertag, and the pinned Soll-minute assertions
 * in those files are whole-week 5-workday figures — landing on Christi
 * Himmelfahrt (always a Thursday) or any other weekday Feiertag silently
 * drops 480 minutes and the test goes red on a date nobody chose on purpose.
 * This promotes `routes/__tests__/shifts.test.ts`'s private `findCleanMonday`
 * (Phase 104, D-15 Tier 2) into the one shared implementation this file's own
 * header already requires ("no test file may keep a private copy").
 *
 * Why it reads `getHolidays`, the endpoint's own holiday source, rather than
 * a second hand-written Feiertag table: a second table would (a) need
 * maintaining, (b) drift from the product, and (c) be a fresh set of
 * absolute date literals — the exact bomb #136 exists to remove. The
 * necessary, bounded honesty about that choice: if `getHolidays` itself were
 * wrong (say it forgot a Feiertag), this helper would happily pick that week,
 * the endpoint under test would ALSO fail to deduct it, and the caller would
 * stay green on a genuinely broken product. That risk is real and is
 * deliberately delegated to `utils/__tests__/holidays.test.ts`, which tests
 * `getHolidays` as a pure function against its own expectations — the
 * callers of this helper assert week Soll ARITHMETIC, never the holiday
 * table itself, so `getHolidays` here only selects the FIXTURE week; it never
 * computes an expected value.
 *
 * Why the whole Mon-Sun week, not just the Monday: the endpoint's week range
 * is Mon-Sun and it deducts every holiday that falls anywhere in it,
 * including Sat/Sun-only Feiertage that would be invisible to a
 * Monday-only check.
 *
 * Why the holiday years are derived PER CANDIDATE (the union of the
 * candidate Monday's and Sunday's calendar year) instead of a fixed list: a
 * week straddling 31 December must see both years' holiday tables, and a
 * fixed `[2027, 2028, 2029]`-style list is itself exactly the kind of
 * expiring literal #136 exists to remove.
 *
 * Known blind spot, by design: this helper only sees COMPUTED holidays
 * (`getHolidays`). Tenant-specific `PublicHoliday` DB rows (e.g.
 * `soll-korrelation-display.test.ts`'s WR-01 block) are invisible to it —
 * callers that seed one must do so into a week this helper already reports
 * clean, never rely on this helper to route around a DB-seeded holiday.
 */
export function holidayFreeMondayStr(
  weeksAhead: number,
  state: FederalStateCode = "NI",
  accept: (mondayStr: string) => boolean = () => true,
  tz: string = TEST_TZ,
): string {
  const startMonday = addDaysStr(mondayOfWeekStr(tz), weeksAhead * 7);
  const MAX_WEEKS = 104;
  for (let w = 0; w < MAX_WEEKS; w++) {
    const mondayStr = addDaysStr(startMonday, w * 7);
    const sundayStr = addDaysStr(mondayStr, 6);
    const mondayYear = Number(mondayStr.slice(0, 4));
    const sundayYear = Number(sundayStr.slice(0, 4));
    const years = new Set([mondayYear, sundayYear]);
    const holidayDates = new Set<string>();
    for (const y of years) {
      for (const h of getHolidays(y, state)) holidayDates.add(h.date);
    }
    let clean = true;
    for (const hd of holidayDates) {
      if (hd >= mondayStr && hd <= sundayStr) {
        clean = false;
        break;
      }
    }
    if (clean && accept(mondayStr)) return mondayStr;
  }
  throw new Error(
    `holidayFreeMondayStr: no holiday-free Monday found within ${MAX_WEEKS} weeks of ` +
      `weeksAhead=${weeksAhead}, state=${state}`,
  );
}
