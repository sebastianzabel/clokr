/**
 * Issue #595 (D-05, P-06) — the demo seed's own copy of `monthRangeUtc`.
 *
 * `packages/db` cannot import from `apps/api` (the dependency runs the other way: the API imports
 * `@clokr/db`), so this is a deliberate pinned copy of `monthRangeUtc` in
 * `apps/api/src/contexts/working-time-account/timezone.ts`. The drift test
 * `apps/api/scripts/__tests__/demo-month-bounds-595.test.ts` compares the two for 48 months in
 * four time zones and fails the moment they diverge.
 *
 * Why the seed needs it: every `SaldoSnapshot` the closer writes carries a TZ-converted
 * `periodStart` (tenant-local midnight of day 1, converted to UTC; for Europe/Berlin summer the
 * stored date is the last day of the previous month). A seed that stored the legacy UTC-naive
 * date (the 1st) wrote rows the closed-month readers of that time did not recognise — the root
 * cause of #595. The seed now writes every row in the convention the closer writes.
 *
 * No side effects on import and no dependency beyond the platform `Intl` — safe to pull into any
 * seed script. The zone offset comes from `Intl.DateTimeFormat` parts, resolved in two passes so
 * a DST edge lands on the same instant `fromZonedTime` (date-fns-tz) produces.
 */

/** Offset (zone wall clock minus UTC) in ms at the given instant, whole seconds. */
function zoneOffsetMs(instantMs: number, tz: string): number {
  const whole = Math.floor(instantMs / 1000) * 1000;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(whole));
  const part = (type: string): number => {
    const found = parts.find((p) => p.type === type);
    if (!found) throw new Error(`demoMonthRangeUtc: Intl returned no ${type} part for ${tz}`);
    return Number(found.value);
  };
  const wallAsUtc = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
  return wallAsUtc - whole;
}

/** The UTC instant at which the zone's wall clock shows the given civil time. */
function wallClockToUtc(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
  tz: string,
): Date {
  const guess = Date.UTC(year, monthIndex, day, hour, minute, second, ms);
  const firstPass = guess - zoneOffsetMs(guess, tz);
  return new Date(guess - zoneOffsetMs(firstPass, tz));
}

/**
 * First and last instant of a calendar month in the tenant time zone, as UTC instants.
 *
 * @param year  - calendar year
 * @param month - 1-based month (1 = January)
 * @param tz    - IANA time zone
 */
export function demoMonthRangeUtc(
  year: number,
  month: number,
  tz: string,
): { start: Date; end: Date } {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    start: wallClockToUtc(year, month - 1, 1, 0, 0, 0, 0, tz),
    end: wallClockToUtc(year, month - 1, lastDay, 23, 59, 59, 999, tz),
  };
}
