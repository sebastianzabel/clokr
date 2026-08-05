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
 * Format a UTC date as "HH:MM" (24h, zero-padded) in the given timezone.
 *
 * Mirrors `dateStrInTz`. The returned string is directly, lexicographically
 * comparable to `Shift.startTime`/`Shift.endTime`, which are stored as "HH:MM"
 * strings — enabling "has the shift start time already passed?" checks without
 * parsing into numbers.
 */
export function timeStrInTz(utcDate: Date, tz: string): string {
  return formatInTimeZone(utcDate, tz, "HH:mm");
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
 * Tenant-local first/last day of a month range as UTC-MIDNIGHT dates — the ONLY
 * safe bounds for Prisma filters on @db.Date columns (TimeEntry.date, Shift.date,
 * PublicHoliday.date).
 *
 * Why: monthRangeUtc timestamps cast to the WRONG date for non-UTC tenants.
 * June 2026 in Europe/Berlin starts at 2026-05-31T22:00:00Z; Prisma casts that
 * param to date '2026-05-31' → `date >= monthStart` INCLUDES the last day of
 * MAY. Prod evidence: a May-31 time entry was counted in BOTH the May and the
 * June snapshot (double-counted in the carry-over chain), while the live saldo
 * path (rangeStart = periodEnd + 1 day) correctly starts at June 1 — breaking
 * the live == closed invariant by the boundary-day minutes.
 *
 * dateStrInTz resolves the timestamp to the tenant-local calendar day, so
 * firstDay/lastDay are the actual first/last day of the month in the tenant TZ.
 */
export function monthDayBounds(
  monthStart: Date,
  monthEnd: Date,
  tz: string,
): { firstDay: Date; lastDay: Date } {
  return {
    firstDay: new Date(dateStrInTz(monthStart, tz) + "T00:00:00Z"),
    lastDay: new Date(dateStrInTz(monthEnd, tz) + "T00:00:00Z"),
  };
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
  callback: (dow: number, dateStr: string) => void,
): void {
  // Work with zoned copies to iterate by calendar day
  const current = toZonedTime(from, tz);
  const endZoned = toZonedTime(to, tz);
  current.setHours(0, 0, 0, 0);
  endZoned.setHours(23, 59, 59, 999);

  while (current <= endZoned) {
    // `current` is zoned, so its Y/M/D are the tenant-local calendar day — this
    // matches dateStrInTz() semantics for the same instant (D-06 holiday exclusion).
    const y = current.getFullYear();
    const m = String(current.getMonth() + 1).padStart(2, "0");
    const d = String(current.getDate()).padStart(2, "0");
    callback(current.getDay(), `${y}-${m}-${d}`);
    current.setDate(current.getDate() + 1);
  }
}

/**
 * Internal: Ø-Methode math used for SHIFT_BASED + FLEXTIME schedules.
 *
 * Returns weeklyHours / workDaysPerWeek × workdaysInRange × 60, rounded to integer minutes.
 *   - workDaysPerWeek = count of {day}Hours fields where > 0 (D-03)
 *   - workdaysInRange = count of days in [from, to] where {day}Hours[dow] > 0 (D-02)
 *
 * Returns 0 if weeklyHours <= 0 or workDaysPerWeek === 0 (defensive guard).
 *
 * Single source of truth for the Ø-Methode math — consumed by both
 * `calcExpectedMinutesTz` (full Soll) and `calcLeaveAbsenceMinutesTz`
 * (leave/absence subtraction). Eliminates drift risk (threat T-76.12-01).
 *
 * Legal basis: BAG 9 AZR 406/17 (Urlaubs- und Abwesenheits-Soll-Reduktion
 * folgt der Durchschnittsmethode).
 */
function avgWorkMinutesCore(
  schedule: Record<string, unknown>,
  from: Date,
  to: Date,
  tz: string,
  excludeHolidays?: Set<string>,
): number {
  const wh = Number(schedule.weeklyHours ?? 0);
  if (wh <= 0) return 0;

  const DOW_KEYS = [
    "sundayHours",
    "mondayHours",
    "tuesdayHours",
    "wednesdayHours",
    "thursdayHours",
    "fridayHours",
    "saturdayHours",
  ];

  // workDaysPerWeek = count of {day}Hours > 0 (do NOT consult workDays array —
  // robust against legacy drift from pre-Phase-61 rows, per CONTEXT.md D-02).
  let workDaysPerWeek = 0;
  for (const key of DOW_KEYS) {
    if (Number(schedule[key] ?? 0) > 0) workDaysPerWeek++;
  }
  if (workDaysPerWeek === 0) return 0;

  // workdaysInRange = count of calendar days in [from, to] where the
  // corresponding {day}Hours value is > 0. D-06: a holiday inside the range is
  // excluded so it is not double-deducted (holiday minutes are subtracted separately).
  let workdaysInRange = 0;
  iterateDaysInTz(from, to, tz, (dow, dateStr) => {
    if (excludeHolidays?.has(dateStr)) return;
    if (Number(schedule[DOW_KEYS[dow]] ?? 0) > 0) workdaysInRange++;
  });

  return Math.round((wh * 60 * workdaysInRange) / workDaysPerWeek);
}

/**
 * Calculate expected working minutes between two UTC dates in a given timezone,
 * using a schedule object that maps day-of-week to hours.
 * Supports MONTHLY_HOURS schedules (Minijobber): prorates the monthly budget
 * based on working days in [from, to] relative to working days in the full calendar month.
 *
 * Per schedule type:
 *   - SHIFT_BASED + FLEXTIME: Ø-Methode via `avgWorkMinutesCore`
 *     (BAG 9 AZR 406/17 — weeklyHours / workDaysPerWeek × workdaysInRange).
 *     The prior `weeklyHours × Kalendertage ÷ 7` formula was mathematically
 *     wrong for ranges not divisible by 7 (Phase 76.12 fix).
 *   - MONTHLY_HOURS: prorate monthly budget by working-day fraction (unchanged).
 *   - FIXED_SCHEDULE: per-day sum from {day}Hours (unchanged).
 *
 * For Leave/Absence Soll-reduction (BAG 9 AZR 406/17), callers MUST use the
 * idiomatic entry point `calcLeaveAbsenceMinutesTz` (same math, plus halfDay
 * support + MONTHLY_HOURS-hart-0 semantics).
 */
export function calcExpectedMinutesTz(
  schedule: Record<string, unknown>,
  from: Date,
  to: Date,
  tz: string,
  excludeHolidays?: Set<string>,
): number {
  // SHIFT_BASED: Schichtplan ist führend. Soll = Ø-Methode (BAG 9 AZR 406/17):
  // weeklyHours × workdaysInRange ÷ workDaysPerWeek. For Leave/Absence
  // subtraction, callers MUST use `calcLeaveAbsenceMinutesTz` (same math
  // plus halfDay support). This branch is the full-range Soll-Berechner.
  // Phase 76.32 (D-08): optional excludeHolidays set — when provided, days
  // whose "YYYY-MM-DD" is in the set are not counted in workdaysInRange so
  // gesetzliche Feiertage are deducted from the Planungs-Soll.
  if (String(schedule.type ?? "") === "SHIFT_BASED") {
    return avgWorkMinutesCore(schedule, from, to, tz, excludeHolidays);
  }

  // FLEXTIME: Gleitzeit — Wochenstundensoll, freie Tagesverteilung. Identical
  // formula to SHIFT_BASED. coreStart/coreEnd/coreDays are UI-only metadata
  // and do NOT affect the saldo calculation (per Phase 49.1 CONTEXT.md locked
  // decision). Routed through `avgWorkMinutesCore` so SHIFT_BASED + FLEXTIME
  // cannot drift apart (single source of truth).
  // Phase 76.32 (D-08): excludeHolidays threaded through for consistency.
  if (String(schedule.type ?? "") === "FLEXTIME") {
    return avgWorkMinutesCore(schedule, from, to, tz, excludeHolidays);
  }

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

/**
 * Calculate leave/absence Soll-reduction minutes between two UTC dates in a
 * given timezone.
 *
 * Replaces the prior usage of `calcExpectedMinutesTz` for Leave/Absence
 * subtraction. Legal basis: BAG 9 AZR 406/17 + Markt-Konvention
 * (Clockodo/Personio/Kenjo/DATEV LODAS): Urlaubs-/Abwesenheits-Soll-Reduktion
 * folgt der Durchschnittsmethode
 *   weeklyHours ÷ workDaysPerWeek × workdaysInRange.
 *
 * Per schedule type:
 *   - SHIFT_BASED + FLEXTIME: `avgWorkMinutesCore` (Ø-Methode).
 *   - FIXED_SCHEDULE: Σ over [from, to] of {day}Hours[dow] × 60 (per-day sum,
 *     identical to the default branch in `calcExpectedMinutesTz`).
 *   - MONTHLY_HOURS: returns 0 hard (CLAUDE.md "Schedule Types" —
 *     "Holiday/absence deductions do NOT apply").
 *
 * `opts.halfDay` applies to the TOTAL (not per-day): returns
 * `Math.round(rawMinutes / 2)`. Single halfDay-Boolean per LeaveRequest
 * applies to ALL days of the request (schema convention).
 *
 * Callers MUST pre-filter (this helper is pure math and does no DB access):
 *   - LeaveRequest.status IN ('APPROVED', 'CANCELLATION_REQUESTED')
 *   - LeaveRequest.deletedAt = null
 *   - Absence.deletedAt = null
 *   - Absence.type != 'VOCATIONAL_SCHOOL' (BBiG §15 — BS-Tag ist Arbeitstag)
 *   - Absence.source != 'PATTERN' (auto-generated, not an approved request)
 *
 * @param schedule WorkSchedule shape (type, weeklyHours, {day}Hours fields)
 * @param from inclusive UTC start of range
 * @param to inclusive UTC end of range
 * @param tz tenant IANA timezone
 * @param opts.halfDay if true, return Math.round(rawMinutes / 2)
 * @returns integer minutes (Soll-reduction)
 */
export function calcLeaveAbsenceMinutesTz(
  schedule: Record<string, unknown>,
  from: Date,
  to: Date,
  tz: string,
  opts?: { halfDay?: boolean; excludeHolidays?: Set<string> },
): number {
  const type = String(schedule.type ?? "");

  let raw: number;
  if (type === "SHIFT_BASED" || type === "FLEXTIME") {
    raw = avgWorkMinutesCore(schedule, from, to, tz, opts?.excludeHolidays);
  } else if (type === "MONTHLY_HOURS") {
    // CLAUDE.md "Schedule Types": Holiday/absence deductions do NOT apply for
    // MONTHLY_HOURS (flexible Minijobber budget). Hart 0.
    return 0;
  } else {
    // FIXED_SCHEDULE (and any unknown type): per-day sum from {day}Hours.
    // D-06: skip holidays inside the range so the holiday is deducted ONCE
    // (holiday minutes are subtracted separately by the caller).
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
    iterateDaysInTz(from, to, tz, (dow, dateStr) => {
      if (opts?.excludeHolidays?.has(dateStr)) return;
      total += Number(schedule[DOW_KEYS[dow]] ?? 0) * 60;
    });
    raw = Math.round(total);
  }

  if (opts?.halfDay) return Math.round(raw / 2);
  return raw;
}
