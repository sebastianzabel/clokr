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
 * Internal: read `WorkSchedule.workDays` as a plain array of weekday indices
 * (0=Sun..6=Sat), or `[]` when absent/empty.
 *
 * The sole place this array is read out of the raw schedule shape — both
 * `avgWorkMinutesCore`'s {day}Hours-fallback day-membership test and the D-05
 * `monthlyHoursWorkDays` chain (Issue #433) build on it, so the two never
 * diverge on what counts as "workDays is set".
 */
function explicitWorkDaysOf(schedule: Record<string, unknown>): number[] {
  return Array.isArray(schedule.workDays) ? (schedule.workDays as number[]) : [];
}

/**
 * Internal: Ø-Methode math used for SHIFT_BASED + FLEXTIME schedules.
 *
 * Returns weeklyHours / workDaysPerWeek × workdaysInRange × 60, rounded to integer minutes.
 *   - workDaysPerWeek = count of contracted workdays per week
 *   - workdaysInRange = count of days in [from, to] that are contracted workdays
 *   Both derived from `WorkSchedule.workDays` when it is non-empty (authoritative,
 *   per the CLAUDE.md invariant), falling back to `count({day}Hours > 0)` only when
 *   `workDays` is empty/absent. See the `isWorkday` comment below for the full
 *   rationale of this precedence (soll-ignores-workdays-on-legacy-schedules).
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

  // Day-membership source ("is weekday `dow` a contracted workday?"):
  //
  // `WorkSchedule.workDays` is authoritative when present and non-empty. Per
  // CLAUDE.md's invariant ("WorkSchedule.workDays MUST be the set of weekday
  // indices where the corresponding {day}Hours value is > 0"), workDays and
  // {day}Hours are supposed to always agree — enforced on every create/update
  // path since Phase 61's normalizeWorkDays(). This function used to ignore
  // workDays entirely and trust {day}Hours>0 instead, reasoning (see git
  // history) that {day}Hours would be "more robust against legacy drift from
  // pre-Phase-61 rows". That reasoning had it backwards for the rows that
  // actually diverge in prod: audited via debug session
  // soll-ignores-workdays-on-legacy-schedules.md, every one of the known
  // pre-Phase-61 divergent rows carries a STALE bulk-migration placeholder in
  // {day}Hours (e.g. 1.00 across every Mon-Fri column, which does not even
  // sum to weeklyHours), while `workDays` was hand-corrected per employee to
  // the real contractual pattern. Trusting {day}Hours>0 there silently
  // spread the weekly Soll across days the employee never contractually
  // works (e.g. Monday/Friday for a Tue/Wed/Thu-only contract), which
  // under-valued leave/absence credit on the real workdays and left a
  // phantom residual Soll on the non-workdays. Trusting workDays instead is
  // what actually achieves "robust against legacy drift" here, and aligns
  // this function with the precedence `vacation-calc.ts:countWorkDaysPerWeek()`
  // already uses for BUrlG Urlaubs-Tagezählung — previously the two
  // sibling functions disagreed on which field to trust for the very same
  // legacy rows. Falls back to {day}Hours>0, unchanged, when workDays is
  // empty/absent (e.g. some MONTHLY_HOURS rows never set it) so the
  // well-behaved majority (workDays and {day}Hours already in sync) sees
  // byte-identical output.
  const explicitWorkDays = explicitWorkDaysOf(schedule);
  const useWorkDays = explicitWorkDays.length > 0;
  const isWorkday = (dow: number): boolean =>
    useWorkDays ? explicitWorkDays.includes(dow) : Number(schedule[DOW_KEYS[dow]] ?? 0) > 0;

  // workDaysPerWeek = count of contracted workdays per week (workDays.length,
  // or count of {day}Hours > 0 when workDays is empty). Both this divisor AND
  // workdaysInRange below MUST use the SAME day-membership test (isWorkday) —
  // mixing sources here would make the ratio meaningless.
  let workDaysPerWeek = 0;
  for (let dow = 0; dow <= 6; dow++) {
    if (isWorkday(dow)) workDaysPerWeek++;
  }
  if (workDaysPerWeek === 0) return 0;

  // workdaysInRange = count of calendar days in [from, to] that are
  // contracted workdays per isWorkday(). D-06: a holiday inside the range is
  // excluded so it is not double-deducted (holiday minutes are subtracted separately).
  let workdaysInRange = 0;
  iterateDaysInTz(from, to, tz, (dow, dateStr) => {
    if (excludeHolidays?.has(dateStr)) return;
    if (isWorkday(dow)) workdaysInRange++;
  });

  return Math.round((wh * 60 * workdaysInRange) / workDaysPerWeek);
}

/**
 * Internal (Issue #433, D-05): the MONTHLY_HOURS contractual-workday set.
 *
 * Precedence: `WorkSchedule.workDays` (non-empty) → `defaultWorkDays`
 * (`TenantConfig.defaultWorkDays`, non-empty) → Mo-Fr. Unlike
 * `avgWorkMinutesCore`'s `isWorkday`, this NEVER falls back to `{day}Hours >
 * 0` — per CLAUDE.md § Schedule Types, `{day}Hours` are uniformly 0.00
 * placeholders for MONTHLY_HOURS on prod and must never gate anything here
 * (OQ1: the calendar-day proration fallback this function replaces is gone).
 * This is the ONE place this chain lives for MONTHLY_HOURS — it mirrors the
 * shape of the absence context's async `resolveWorkDays()`
 * (`contexts/absence/leave-days.ts`) for non-FIXED types, re-implemented as a
 * pure function because this WTA core cannot import an async, peer-context
 * DB resolver (purity + context-boundary gate). Phase 95b (D-01): stored
 * `workDays` rows are never rewritten — this function only reads them.
 */
function monthlyHoursWorkDays(
  schedule: Record<string, unknown>,
  defaultWorkDays?: readonly number[] | null,
): ReadonlySet<number> {
  const explicit = explicitWorkDaysOf(schedule);
  if (explicit.length > 0) return new Set(explicit);
  if (Array.isArray(defaultWorkDays) && defaultWorkDays.length > 0) {
    return new Set(defaultWorkDays);
  }
  return new Set([1, 2, 3, 4, 5]);
}

/**
 * Internal (Issue #433, D-02/D-06, OQ2): count of `monthlyHoursWorkDays()`
 * days in the full tenant-local calendar month identified by `monthKey`
 * ("YYYY-MM"). D-06: holidays count as workdays in this denominator (they
 * are excused workdays, not non-workdays) — this function never excludes
 * any date, unlike the numerator in `monthlyHoursMinutesCore` below.
 */
function monthlyHoursFullMonthWorkdays(
  monthKey: string,
  tz: string,
  workdaySet: ReadonlySet<number>,
): number {
  const [y, m] = monthKey.split("-").map(Number);
  const monthStart = fromZonedTime(new Date(y, m - 1, 1, 0, 0, 0, 0), tz);
  const lastDay = new Date(y, m, 0).getDate();
  const monthEnd = fromZonedTime(new Date(y, m - 1, lastDay, 23, 59, 59, 999), tz);
  let count = 0;
  iterateDaysInTz(monthStart, monthEnd, tz, (dow) => {
    if (workdaySet.has(dow)) count++;
  });
  return count;
}

/**
 * Internal (Issue #433): the MONTHLY_HOURS Ø-rate core.
 *
 * D-02: per-day value = `monthlyHours × 60 ÷ (contractual workdays of the
 * FULL calendar month)`. D-05: the workday set is `monthlyHoursWorkDays()`
 * (never `{day}Hours`). D-06: the denominator is the full calendar month,
 * also in a hire/exit month, so a day is valued identically in partial and
 * full months. OQ2: a SINGLE `Math.round()` over the total across every
 * calendar month the range spans (mirrors `avgWorkMinutesCore`'s
 * single-round convention) — for a range inside one month this collapses to
 * the one-line `Math.round((monthlyHours * 60 * count) / monthWorkdays)`.
 *
 * `includeDay(dateStr)` lets a caller exclude specific tenant-local
 * "YYYY-MM-DD" days from the numerator (e.g. `calcLeaveAbsenceMinutesTz`
 * excluding already-claimed/holiday dates) without touching the full-month
 * denominator above.
 *
 * Returns 0 when `monthlyHours` is null/0/negative (pure tracking, D-01) or
 * when the range contributes no countable day.
 */
function monthlyHoursMinutesCore(
  schedule: Record<string, unknown>,
  from: Date,
  to: Date,
  tz: string,
  defaultWorkDays: readonly number[] | null | undefined,
  includeDay: (dateStr: string) => boolean,
): number {
  const mh = Number(schedule.monthlyHours ?? 0);
  if (mh <= 0) return 0;

  const workdaySet = monthlyHoursWorkDays(schedule, defaultWorkDays);

  // Numerator: days in [from, to] that are contractual workdays AND pass
  // includeDay, grouped by tenant-local calendar month ("YYYY-MM").
  const countByMonth = new Map<string, number>();
  iterateDaysInTz(from, to, tz, (dow, dateStr) => {
    if (!workdaySet.has(dow)) return;
    if (!includeDay(dateStr)) return;
    const monthKey = dateStr.slice(0, 7);
    countByMonth.set(monthKey, (countByMonth.get(monthKey) ?? 0) + 1);
  });

  if (countByMonth.size === 0) return 0;

  let totalMinutes = 0;
  for (const [monthKey, count] of countByMonth) {
    const fullMonthWorkdays = monthlyHoursFullMonthWorkdays(monthKey, tz, workdaySet);
    // Defensive only: impossible given the Mo-Fr fallback in monthlyHoursWorkDays(),
    // which guarantees workdaySet is never empty.
    if (fullMonthWorkdays === 0) continue;
    totalMinutes += (mh * 60 * count) / fullMonthWorkdays;
  }
  return Math.round(totalMinutes);
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
 *   - MONTHLY_HOURS: prorate monthly budget by working-day fraction, via
 *     `monthlyHoursMinutesCore` (Issue #433, D-02/D-05/D-06). The day-membership
 *     test is `monthlyHoursWorkDays()` (workDays → `defaultWorkDays` → Mo-Fr),
 *     never `{day}Hours`; the prior calendar-day-proration fallback for ranges
 *     with no `{day}Hours > 0` is gone (OQ1) — the Mo-Fr tier of the D-05 chain
 *     replaces it, since the new workday set can never be empty.
 *   - FIXED_SCHEDULE: per-day sum from {day}Hours (unchanged).
 *
 * For Leave/Absence Soll-reduction (BAG 9 AZR 406/17), callers MUST use the
 * idiomatic entry point `calcLeaveAbsenceMinutesTz` (same math, plus halfDay
 * support + the Issue #433 MONTHLY_HOURS Ø-Methode reduction).
 *
 * @param defaultWorkDays `TenantConfig.defaultWorkDays` (Issue #433, D-05) — read ONLY
 *   by the MONTHLY_HOURS branch, as the middle tier of its workday-set chain.
 *   Every other schedule type ignores this parameter.
 */
export function calcExpectedMinutesTz(
  schedule: Record<string, unknown>,
  from: Date,
  to: Date,
  tz: string,
  excludeHolidays?: Set<string>,
  defaultWorkDays?: readonly number[] | null,
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

  // Minijobber / flexible monthly hours: prorate monthly budget by working-day
  // fraction. Issue #433 (D-02/D-05/D-06, OQ1): the day-membership test and the
  // full-month denominator both live in `monthlyHoursMinutesCore` /
  // `monthlyHoursWorkDays` now — `{day}Hours` is never read here, and the old
  // "fall back to calendar-day proration" branch is gone because the Mo-Fr
  // tier of `monthlyHoursWorkDays()` guarantees a non-empty workday set.
  if (String(schedule.type ?? "") === "MONTHLY_HOURS") {
    return monthlyHoursMinutesCore(schedule, from, to, tz, defaultWorkDays, () => true);
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
 *   - MONTHLY_HOURS (Issue #433, owner decision 2026-10-03, D-01/D-02): `monthlyHours`
 *     is an OWED monthly Soll, not a flexible budget — leave/sickness/absence reduce
 *     it by `monthlyHoursMinutesCore` (same Ø-Methode shape as SHIFT_BASED/FLEXTIME,
 *     but with a monthly rate and a per-calendar-month denominator, D-05/D-06). The
 *     superseded "hart 0" rule ("Holiday/absence deductions do NOT apply" per the old
 *     CLAUDE.md "Schedule Types" wording) no longer holds for leave/absence; `monthlyHours`
 *     null/0 (pure tracking) still returns 0 via `monthlyHoursMinutesCore`'s own guard.
 *

 * `opts.halfDay` applies to the TOTAL (not per-day): returns
 * `Math.round(rawMinutes / 2)`. Single halfDay-Boolean per LeaveRequest
 * applies to ALL days of the request (schema convention).
 *
 * Callers MUST pre-filter (this helper is pure math and does no DB access):
 *   - LeaveRequest.status IN ('APPROVED', 'CANCELLATION_REQUESTED')
 *   - LeaveRequest.deletedAt = null
 *   - Absence.deletedAt = null
 *
 * Absence TYPE and SOURCE filtering is deliberately NOT a precondition of this
 * function (corrected Phase 98, Issue #98 — the previous wording here demanded a
 * `type != 'VOCATIONAL_SCHOOL'` / `source != 'PATTERN'` pre-filter that its own
 * principal caller does not apply, and has not applied since v1.8.27). This
 * function receives `schedule`, `from`, `to`, `tz` and `opts`
 * (`halfDay`/`excludeHolidays`); it never sees `type` or `source` and never reads
 * `days` — it only iterates the date range. Whether to
 * filter by type/source is the CALLER's policy, decided by the caller's own
 * semantics, not a rule this function can state once for everyone:
 *   - `closeEmployeeMonth()` deliberately passes VOCATIONAL_SCHOOL / PATTERN rows
 *     IN (v1.8.27 BS double-count fix): `contractSoll` (`avgWorkMinutesCore`) has
 *     no Berufsschule awareness and already counts that day once via the average
 *     method, so the loop subtracts that credit here and re-adds the precise
 *     BBiG § 15 slot credit separately — each Berufsschule day's Soll ends up
 *     credited exactly once. `isBsAbsence()` there controls only whether the row
 *     participates in the day-level dedup (`sbClaimed`/`nsClaimed`), never whether
 *     it is credited.
 *   - The roster path in `routes/shifts.ts` deliberately does the opposite,
 *     excluding VOCATIONAL_SCHOOL in its `where`, because a Berufsschule day is a
 *     working day for the roster's Soll view, not an absence from it.
 * A stale precondition that the principal caller violates teaches the next reader
 * the wrong rule — do not add a type/source filter to a new caller just because
 * this docblock once demanded one; decide it from that caller's own semantics and
 * say which you chose and why.
 *
 * @param schedule WorkSchedule shape (type, weeklyHours, {day}Hours fields)
 * @param from inclusive UTC start of range
 * @param to inclusive UTC end of range
 * @param tz tenant IANA timezone
 * @param opts.halfDay if true, return Math.round(rawMinutes / 2)
 * @param opts.excludeHolidays tenant-TZ "YYYY-MM-DD" days already credited
 *   elsewhere; they are skipped, so a holiday inside the range is deducted ONCE
 *   (D-06/D-08). Materially changes the result — pass it whenever the caller
 *   subtracts holiday minutes separately. For MONTHLY_HOURS this is also how a
 *   caller excludes already-claimed days (Issue #433's D-07 dedup) from the
 *   Ø-rate numerator without touching the full-month denominator.
 * @param opts.defaultWorkDays `TenantConfig.defaultWorkDays` (Issue #433, D-05) —
 *   read ONLY by the MONTHLY_HOURS branch, the middle tier of its workday-set
 *   chain (`workDays` → `defaultWorkDays` → Mo-Fr). Every other type ignores it.
 * @returns integer minutes (Soll-reduction)
 */
export function calcLeaveAbsenceMinutesTz(
  schedule: Record<string, unknown>,
  from: Date,
  to: Date,
  tz: string,
  opts?: {
    halfDay?: boolean;
    excludeHolidays?: Set<string>;
    defaultWorkDays?: readonly number[] | null;
  },
): number {
  const type = String(schedule.type ?? "");

  let raw: number;
  if (type === "SHIFT_BASED" || type === "FLEXTIME") {
    raw = avgWorkMinutesCore(schedule, from, to, tz, opts?.excludeHolidays);
  } else if (type === "MONTHLY_HOURS") {
    // Issue #433 (D-01/D-02/D-05/D-07, owner decision 2026-10-03): monthlyHours is
    // an OWED monthly Soll — leave/sickness/absence reduce it by the Ø-Methode
    // day value, excluding already-claimed/holiday days from the numerator via
    // includeDay, same denominator convention as the full-Soll branch above.
    raw = monthlyHoursMinutesCore(
      schedule,
      from,
      to,
      tz,
      opts?.defaultWorkDays,
      (d) => !opts?.excludeHolidays?.has(d),
    );
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
