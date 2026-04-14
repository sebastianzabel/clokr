/**
 * Timezone utilities for Clokr.
 *
 * Principle: Server stores and calculates in UTC.
 * For day-based logic (which weekday? which month? calendar targets?)
 * we convert to the tenant's configured timezone.
 */
import { toZonedTime, fromZonedTime, formatInTimeZone } from "date-fns-tz";
import { FastifyInstance } from "fastify";

const DEFAULT_TZ = "Europe/Berlin";

// ── Simple cache for tenant timezone (avoids DB lookup on every request) ────
const tzCache = new Map<string, { tz: string; exp: number }>();
const CACHE_TTL_MS = 5 * 60_000; // 5 minutes

/**
 * Resolve the tenant's configured timezone from the database.
 * Cached for 5 minutes to avoid repeated DB queries.
 */
export async function getTenantTimezone(
  prisma: FastifyInstance["prisma"],
  tenantId: string,
): Promise<string> {
  const cached = tzCache.get(tenantId);
  if (cached && cached.exp > Date.now()) return cached.tz;

  const cfg = await prisma.tenantConfig.findUnique({
    where: { tenantId },
    select: { timezone: true },
  });
  const tz = cfg?.timezone ?? DEFAULT_TZ;
  tzCache.set(tenantId, { tz, exp: Date.now() + CACHE_TTL_MS });
  return tz;
}

/**
 * Return "today" as a plain Date (midnight, no time component)
 * in the given timezone. Useful for the TimeEntry `date` field.
 *
 * Example: It's 2026-03-24T23:30:00Z (UTC).
 *   In Europe/Berlin (UTC+1) that's 2026-03-25 00:30 → todayInTz returns 2026-03-25.
 */
export function todayInTz(tz: string): Date {
  const str = formatInTimeZone(new Date(), tz, "yyyy-MM-dd");
  return new Date(str + "T00:00:00Z");
}

/**
 * Format a UTC date as "YYYY-MM-DD" in the given timezone.
 */
export function dateStrInTz(utcDate: Date, tz: string): string {
  return formatInTimeZone(utcDate, tz, "yyyy-MM-dd");
}

/**
 * Get the day-of-week (0=Sunday, 1=Monday, …, 6=Saturday)
 * for a UTC date interpreted in the given timezone.
 */
export function getDayOfWeekInTz(utcDate: Date, tz: string): number {
  const zoned = toZonedTime(utcDate, tz);
  return zoned.getDay();
}

/**
 * Compute the month start/end as UTC dates for a given year+month in the tenant timezone.
 *
 * @param year  - Calendar year (e.g. 2026)
 * @param month - 1-based month (1=January, 12=December)
 * @param tz    - IANA timezone string
 * @returns { start: Date, end: Date } in UTC
 *   start = first moment of month in TZ, converted to UTC
 *   end   = last moment of month in TZ, converted to UTC
 */
export function monthRangeUtc(year: number, month: number, tz: string): { start: Date; end: Date } {
  // First day of month at 00:00 in tenant TZ → UTC
  const start = fromZonedTime(new Date(year, month - 1, 1, 0, 0, 0, 0), tz);
  // Last day of month at 23:59:59.999 in tenant TZ → UTC
  const lastDay = new Date(year, month, 0).getDate(); // day count of month
  const end = fromZonedTime(new Date(year, month - 1, lastDay, 23, 59, 59, 999), tz);
  return { start, end };
}

/**
 * Compute the ISO week (Monday–Sunday) containing `refDate` in the given timezone.
 *
 * @returns { start, end, days[] } where days is an array of "YYYY-MM-DD" strings
 */
export function weekRangeUtc(
  refDate: Date,
  tz: string,
): {
  start: Date;
  end: Date;
  days: string[];
} {
  const zoned = toZonedTime(refDate, tz);
  const dow = zoned.getDay(); // 0=Sun
  const mondayOffset = dow === 0 ? -6 : 1 - dow;

  // Monday at 00:00 in tenant TZ
  const mondayLocal = new Date(zoned);
  mondayLocal.setDate(mondayLocal.getDate() + mondayOffset);
  mondayLocal.setHours(0, 0, 0, 0);

  // Sunday at 23:59:59.999 in tenant TZ
  const sundayLocal = new Date(mondayLocal);
  sundayLocal.setDate(sundayLocal.getDate() + 6);
  sundayLocal.setHours(23, 59, 59, 999);

  const start = fromZonedTime(mondayLocal, tz);
  const end = fromZonedTime(sundayLocal, tz);

  // Generate "YYYY-MM-DD" for each day of the week
  const days: string[] = [];
  const cur = new Date(mondayLocal);
  for (let i = 0; i < 7; i++) {
    days.push(
      `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`,
    );
    cur.setDate(cur.getDate() + 1);
  }

  return { start, end, days };
}

/**
 * Iterate calendar days between two dates (inclusive) in the tenant timezone
 * and return the day-of-week for each.
 *
 * Used for calculating expected working minutes.
 */
export function iterateDaysInTz(
  from: Date,
  to: Date,
  tz: string,
  callback: (dow: number) => void,
): void {
  // Work with zoned copies to iterate by calendar day
  const current = toZonedTime(from, tz);
  const endZoned = toZonedTime(to, tz);
  current.setHours(0, 0, 0, 0);
  endZoned.setHours(23, 59, 59, 999);

  while (current <= endZoned) {
    callback(current.getDay());
    current.setDate(current.getDate() + 1);
  }
}

/**
 * Calculate expected working minutes between two UTC dates in a given timezone,
 * using a schedule object that maps day-of-week to hours.
 * Supports MONTHLY_HOURS schedules (Minijobber): prorates the monthly budget
 * based on working days in [from, to] relative to working days in the full calendar month.
 */
export function calcExpectedMinutesTz(
  schedule: Record<string, unknown>,
  from: Date,
  to: Date,
  tz: string,
): number {
  // Minijobber / flexible monthly hours: prorate monthly budget by working-day fraction
  if (String(schedule.type ?? "") === "MONTHLY_HOURS") {
    const mh = Number(schedule.monthlyHours ?? 0);
    if (mh <= 0) return 0; // pure tracking mode — no Soll target

    const DOW_KEYS_MH = [
      "sundayHours",
      "mondayHours",
      "tuesdayHours",
      "wednesdayHours",
      "thursdayHours",
      "fridayHours",
      "saturdayHours",
    ];

    // Count working days in the range [from, to]
    let rangeWorkdays = 0;
    iterateDaysInTz(from, to, tz, (dow) => {
      if (Number(schedule[DOW_KEYS_MH[dow]] ?? 0) > 0) rangeWorkdays++;
    });

    // Count working days in the full calendar month that contains `from`
    const fromZoned = toZonedTime(from, tz);
    const monthStart = fromZonedTime(
      new Date(fromZoned.getFullYear(), fromZoned.getMonth(), 1, 0, 0, 0, 0),
      tz,
    );
    const lastDay = new Date(fromZoned.getFullYear(), fromZoned.getMonth() + 1, 0).getDate();
    const monthEnd = fromZonedTime(
      new Date(fromZoned.getFullYear(), fromZoned.getMonth(), lastDay, 23, 59, 59, 999),
      tz,
    );
    let monthWorkdays = 0;
    iterateDaysInTz(monthStart, monthEnd, tz, (dow) => {
      if (Number(schedule[DOW_KEYS_MH[dow]] ?? 0) > 0) monthWorkdays++;
    });

    // If no per-day hours configured, fall back to calendar-day proration
    if (monthWorkdays === 0) {
      // Fallback: prorate by calendar days (flexible Minijobber with no fixed workdays).
      // Use Math.floor to get inclusive day count without double-counting boundary days.
      const rangeDays = Math.floor((to.getTime() - from.getTime()) / 86400000) + 1;
      const monthDays = lastDay;
      return Math.round((mh * 60 * rangeDays) / monthDays);
    }

    return Math.round((mh * 60 * rangeWorkdays) / monthWorkdays);
  }

  const DOW_KEYS = [
    "sundayHours",
    "mondayHours",
    "tuesdayHours",
    "wednesdayHours",
    "thursdayHours",
    "fridayHours",
    "saturdayHours",
  ];
  let total = 0;
  iterateDaysInTz(from, to, tz, (dow) => {
    total += Number(schedule[DOW_KEYS[dow]] ?? 0) * 60;
  });
  return total;
}

/**
 * Get scheduled hours for a specific day-of-week from a schedule object.
 */
export function getDayHoursFromSchedule(schedule: Record<string, unknown>, dow: number): number {
  const DOW_KEYS = [
    "sundayHours",
    "mondayHours",
    "tuesdayHours",
    "wednesdayHours",
    "thursdayHours",
    "fridayHours",
    "saturdayHours",
  ];
  return Number(schedule[DOW_KEYS[dow]] ?? 0);
}
