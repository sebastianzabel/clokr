/**
 * Pro-rata vacation calculation for part-time employees.
 * Formula (BUrlG): (employee work days/week ÷ full-time days/week) × base vacation days
 * Result rounded to nearest 0.5 (German standard).
 *
 * Phase 49.5: `workDays` ist die Quelle der Wahrheit für "an welchen Tagen
 * arbeitet diese Person?" — unabhängig vom AZ-Modell. Per-Tag-Soll-Felder
 * (mondayHours…) bleiben für FIXED_SCHEDULE Saldo-Berechnung relevant, sind
 * aber nicht mehr Grundlage für Urlaubs-Tagezählung.
 */

export interface ScheduleForCalc {
  mondayHours: number;
  tuesdayHours: number;
  wednesdayHours: number;
  thursdayHours: number;
  fridayHours: number;
  saturdayHours: number;
  sundayHours: number;
  workDays?: number[]; // 0=So, 1=Mo, …, 6=Sa. Falls vorhanden, Quelle der Wahrheit.
  // Phase 107 (D-28): contractual workday count for SHIFT_BASED — checked FIRST in
  // countWorkDaysPerWeek()'s precedence chain, below. Backfilled (D-03) to equal
  // workDays.length for every pre-existing row, so the promotion is value-neutral
  // (AC-DM-03/D-29 — see the "count-first precedence" tests in vacation-calc.test.ts).
  contractWorkDaysPerWeek?: number | null;
}

/** Count how many days per week an employee actually works. */
export function countWorkDaysPerWeek(schedule: ScheduleForCalc): number {
  // Phase 107 (D-28): the contractual count is checked FIRST when present. It is the leading
  // source of truth for SHIFT_BASED, where workDays is frozen (D-02) and may no longer reflect
  // the real roster shape. The two tiers below are UNCHANGED and still apply verbatim for every
  // schedule that leaves this field null/undefined (FIXED_SCHEDULE, FLEXTIME, MONTHLY_HOURS,
  // and any legacy caller that never sets it) — AC-REG-02.
  if (schedule.contractWorkDaysPerWeek != null) {
    return schedule.contractWorkDaysPerWeek;
  }
  // Phase 49.5: workDays ist primär. Falls nicht gesetzt, falle zurück auf
  // "Tag mit Stunden > 0" (Legacy-Verhalten für ältere Datensätze).
  if (Array.isArray(schedule.workDays) && schedule.workDays.length > 0) {
    return schedule.workDays.length;
  }
  const days = [
    schedule.mondayHours,
    schedule.tuesdayHours,
    schedule.wednesdayHours,
    schedule.thursdayHours,
    schedule.fridayHours,
    schedule.saturdayHours,
    schedule.sundayHours,
  ];
  return days.filter((h) => Number(h) > 0).length;
}

/**
 * Calculate pro-rata vacation days for a part-time employee.
 * @param schedule - Employee's work schedule
 * @param fullTimeWorkDays - Reference full-time work days per week (typically 5)
 * @param baseVacationDays - Full-time vacation entitlement (e.g. 30)
 * @returns Vacation days rounded to nearest 0.5
 */
export function calculatePartTimeVacation(
  schedule: ScheduleForCalc,
  fullTimeWorkDays: number,
  baseVacationDays: number,
): number {
  const employeeWorkDays = countWorkDaysPerWeek(schedule);

  if (employeeWorkDays === 0 || fullTimeWorkDays === 0) return 0;
  if (employeeWorkDays >= fullTimeWorkDays) return baseVacationDays;

  const raw = (employeeWorkDays / fullTimeWorkDays) * baseVacationDays;
  // Round to nearest 0.5 (German standard: always round UP to nearest 0.5)
  return Math.ceil(raw * 2) / 2;
}

/**
 * Calculate statutory minimum vacation days per § 3 BUrlG.
 * Formula: Arbeitstage/Woche × 4
 * (24 Werktage based on 6-day week, pro-rata for fewer days)
 */
export function calculateStatutoryMinimum(workDaysPerWeek: number): number {
  return workDaysPerWeek * 4;
}

/**
 * Calculate how many work days fall in each year for a cross-year date range.
 * Uses the supplied `workDays` set (0-6, So=0, Mo=1, …, Sa=6) to determine
 * which weekdays count. Excludes holidays.
 *
 * Phase 49.5: `workDays` ist Pflicht-Argument — kein Fallback auf Mo-Fr.
 */
export function splitDaysAcrossYears(
  startDate: Date,
  endDate: Date,
  halfDay: boolean,
  workDays: number[],
  holidays: Set<string>,
): { year1Days: number; year2Days: number; year1: number; year2: number } {
  const year1 = startDate.getFullYear();
  const year2 = endDate.getFullYear();

  if (year1 === year2) {
    // No split needed
    return {
      year1Days: countWorkDaysInRange(startDate, endDate, halfDay, workDays, holidays),
      year2Days: 0,
      year1,
      year2,
    };
  }

  // Year boundary: Dec 31 → Jan 1
  const year1End = new Date(year1, 11, 31); // Dec 31
  const year2Start = new Date(year2, 0, 1); // Jan 1

  const year1Days = countWorkDaysInRange(startDate, year1End, false, workDays, holidays);
  const year2Days = countWorkDaysInRange(year2Start, endDate, false, workDays, holidays);

  // If halfDay: apply to the shorter portion
  if (halfDay) {
    if (year1Days <= year2Days) {
      return { year1Days: Math.max(0, year1Days - 0.5), year2Days, year1, year2 };
    } else {
      return { year1Days, year2Days: Math.max(0, year2Days - 0.5), year1, year2 };
    }
  }

  return { year1Days, year2Days, year1, year2 };
}

/**
 * Round a raw (unrounded) pro-rata vacation-day value per § 5 Abs. 2 BUrlG, as construed by the
 * BAG: a fraction of a vacation day that amounts to AT LEAST half a day rounds UP to a FULL day.
 * A fraction BELOW half a day is NOT rounded to the nearest 0.5 — it is kept as the exact
 * fraction, to 2 decimal places (e.g. 8.33), matching how prod's existing manually-entered rows
 * already do it.
 *
 * Shared by {@link calculateProRataVacationForHire} (Issue #416) and
 * {@link calculateProRataVacation} (Issue #421) — the two § 5 Abs. 1 BUrlG "Zwölftelung"
 * (twelfthing) calculations for hire-year and exit-year pro-rata entitlement. This rule does
 * NOT apply to {@link calculatePartTimeVacation}'s full-time/part-time day-count conversion,
 * which is a different calculation outside § 5's twelfthing rule (Issue #421 research, backed by
 * the Arnold/Tillmanns BUrlG § 5 commentary § "Bruchteile außerhalb der Zwölftelungsregelung" and
 * BAG 9 AZR 7/16, 14.03.2017) — deliberately left unrounded-to-full-day there.
 */
export function roundVacationDaysBurlG(raw: number): number {
  const frac = raw - Math.floor(raw);
  if (frac >= 0.5) return Math.ceil(raw);
  return Math.round(raw * 100) / 100;
}

/**
 * Calculate pro-rata vacation entitlement for an employee leaving mid-year.
 * Formula (BUrlG § 5 Abs. 2): baseDays × (volleBeschäftigungsmonate / 12), rounded per
 * {@link roundVacationDaysBurlG}.
 *
 * "Volle Beschäftigungsmonate": a month counts as full ONLY if the exitDate is on or after
 * the LAST DAY of that month. E.g., Jun 30 → 6 full months; Jun 29 → 5.
 *
 * § 5 Abs. 2 BUrlG rounding (corrected 2026-09-30, Issue #421): previously rounded to the
 * nearest half day (`Math.ceil(raw * 2) / 2`), which silently under-granted entitlement whenever
 * the fraction was at least half a day (e.g. 12.5 stayed 12.5 instead of rounding up to 13). Now
 * uses the same {@link roundVacationDaysBurlG} rule as the sibling HIRE-date function
 * {@link calculateProRataVacationForHire} (Issue #416) — the two are no longer divergent.
 *
 * @param baseDays - Full-year vacation entitlement (may already be part-time adjusted)
 * @param year - The calendar year to calculate for
 * @param exitDate - The employee's last working day
 * @returns Pro-rata entitlement per {@link roundVacationDaysBurlG}; or baseDays if exitDate is in
 *   a future year
 */
export function calculateProRataVacation(baseDays: number, year: number, exitDate: Date): number {
  if (!Number.isFinite(baseDays) || baseDays <= 0) return 0;

  const exitYear = exitDate.getFullYear();

  // Employee leaves after this year → full entitlement for this year
  if (exitYear > year) return baseDays;

  // Employee already left before this year → no entitlement
  if (exitYear < year) return 0;

  // § 5 Abs. 2 BUrlG: Beschäftigung in der zweiten Jahreshälfte → voller Urlaubsanspruch
  if (exitDate.getMonth() >= 6) return baseDays;

  // Count volle Beschäftigungsmonate: month is full only if exitDate >= last day of that month
  let monthsWorked = 0;
  for (let month = 0; month < 12; month++) {
    // Last day of the month (day 0 of next month)
    const lastDayOfMonth = new Date(year, month + 1, 0);
    if (exitDate >= lastDayOfMonth) {
      monthsWorked++;
    }
  }
  monthsWorked = Math.min(monthsWorked, 12);

  const raw = (baseDays * monthsWorked) / 12;
  return roundVacationDaysBurlG(raw);
}

/**
 * Calculate pro-rata vacation entitlement for an employee HIRED mid-year.
 * Formula (§ 5 Abs. 1 lit. a BUrlG): baseDays × (volleBeschäftigungsmonate / 12), rounded UP to
 * nearest 0.5. Mirrors {@link calculateProRataVacation} (which is for EXIT dates — do not use
 * that function for a hire, and do not use this one for an exit) but counts full calendar months
 * REMAINING in the year, from `hireDate` (inclusive) through December, instead of months before
 * an exit date.
 *
 * "Volle Beschäftigungsmonate": mirrors the exit function's own "last day of month" technique,
 * just testing the opposite direction — a month counts as full here when `hireDate` falls ON OR
 * BEFORE that month's LAST DAY. Concretely this means the HIRE month itself always counts in
 * full, no matter which day within it the hire happened (e.g. hired the 3rd of the month) — BUrlG
 * does not require day-level proration within the first month. A hire on the last day of a month
 * and a hire on the first day of the NEXT month differ by exactly one month's worth, because that
 * is where the calendar-month boundary actually falls.
 *
 * Owner decision (Issue #416, 29.09.2026): composition order is scale-by-workdays FIRST
 * (`calculatePartTimeVacation`), THEN apply this hire-year pro-rata to the already-scaled result
 * — i.e. `baseDays` here is the day-count already owed at this employee's contract, not the raw
 * tenant default.
 *
 * § 5 Abs. 2 BUrlG rounding, via the shared {@link roundVacationDaysBurlG} helper: a fraction of
 * at least half a day rounds UP to a full day; a fraction below half a day is NOT rounded to the
 * nearest 0.5 — it stays the exact fraction, to 2 decimals. This differs from
 * `calculatePartTimeVacation()`'s round-to-nearest-0.5 convention, which is a different
 * calculation outside § 5's twelfthing rule (a separate question, left unchanged — see the
 * shared helper's docblock and Issue #421). As of Issue #421 the sibling EXIT-date
 * `calculateProRataVacation()` above uses the identical shared helper — the two are no longer
 * divergent.
 *
 * @param baseDays - Full-year vacation entitlement (may already be part-time adjusted)
 * @param year - The calendar year to calculate for
 * @param hireDate - The employee's first working day
 * @returns Pro-rata entitlement: `baseDays` unchanged if hired before `year`; `0` if not yet
 *   hired in `year`; otherwise the § 5 Abs. 2 BUrlG rounding above.
 */
export function calculateProRataVacationForHire(
  baseDays: number,
  year: number,
  hireDate: Date,
): number {
  if (!Number.isFinite(baseDays) || baseDays <= 0) return 0;

  const hireYear = hireDate.getFullYear();

  // Not yet employed in this year → no entitlement.
  if (hireYear > year) return 0;

  // Already employed before this year started → full entitlement for this year.
  if (hireYear < year) return baseDays;

  // Count volle Beschäftigungsmonate remaining in the year: month is full when hireDate is
  // ON OR BEFORE the last day of that month (mirrors calculateProRataVacation()'s technique,
  // opposite direction — see this function's own docblock above).
  let monthsWorked = 0;
  for (let month = 0; month < 12; month++) {
    // Last day of the month (day 0 of next month)
    const lastDayOfMonth = new Date(year, month + 1, 0);
    if (hireDate <= lastDayOfMonth) {
      monthsWorked++;
    }
  }
  monthsWorked = Math.min(monthsWorked, 12);

  const raw = (baseDays * monthsWorked) / 12;
  return roundVacationDaysBurlG(raw);
}

/**
 * Count work days in a date range, using the supplied `workDays` set
 * (0-6, So=0, Mo=1, …, Sa=6) and excluding holidays.
 *
 * Phase 49.5: jetzt exportiert + workDays Pflicht. Quelle der Wahrheit für
 * Urlaubs-Tageabzug ist die WorkSchedule.workDays-Konfiguration des MA,
 * NICHT mehr die hartcodierte Mo-Fr-Annahme.
 */
export function countWorkDaysInRange(
  start: Date,
  end: Date,
  halfDay: boolean,
  workDays: number[],
  holidays: Set<string>,
): number {
  if (halfDay) return 0.5;
  const workDaySet = new Set(workDays);
  let count = 0;
  const current = new Date(start);
  current.setHours(0, 0, 0, 0);
  const endDate = new Date(end);
  endDate.setHours(0, 0, 0, 0);

  while (current <= endDate) {
    const dow = current.getDay();
    // Build dateStr from LOCAL components — toISOString() would shift to UTC and break
    // the holidays Set lookup in any timezone with non-zero offset (Phase 76.15 fix).
    const yyyy = current.getFullYear();
    const mm = String(current.getMonth() + 1).padStart(2, "0");
    const dd = String(current.getDate()).padStart(2, "0");
    const dateStr = `${yyyy}-${mm}-${dd}`;
    if (workDaySet.has(dow) && !holidays.has(dateStr)) {
      count++;
    }
    current.setDate(current.getDate() + 1);
  }

  return count;
}

// ── Phase 107 (D-05..D-09), superseded 2026-09-29 by Issue #417 (owner decision) ───────────
// SHIFT_BASED Urlaubsverbrauch — by-contract calc, roster-independent

/**
 * Monday (UTC midnight) of the ISO week containing `d`. Mirrors the Monday derivation already
 * used by `weekRangeUtc()` (`utils/timezone.ts`) and the inline block in `shifts.ts:709-718` —
 * "do not invent a third one" (Phase 107 CONTEXT.md D-05) — but stays in plain UTC rather than
 * `weekRangeUtc()`'s tenant-timezone-aware machinery, because this file (and its exports) must
 * stay importable without Fastify or `date-fns-tz` (D-09's purity contract). Still used by
 * `countShiftBasedLeaveDays()` below to cut a period into ISO weeks, and by
 * `shift-leave-recalc-resolver.ts` callers deriving `(affectedWeekStart, affectedWeekEnd)`.
 */
export function mondayOfWeekUtc(d: Date): Date {
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(d);
  monday.setUTCDate(monday.getUTCDate() + mondayOffset);
  monday.setUTCHours(0, 0, 0, 0);
  return monday;
}

function utcMidnight(d: Date): Date {
  const copy = new Date(d);
  copy.setUTCHours(0, 0, 0, 0);
  return copy;
}

function addUtcDays(d: Date, n: number): Date {
  const copy = new Date(d);
  copy.setUTCDate(copy.getUTCDate() + n);
  return copy;
}

/** UTC "YYYY-MM-DD" — matches getHolidayMap()'s own key format
 * (`start.toISOString().split("T")[0]`), so Set lookups against the caller-built `holidays` set
 * line up without a second conversion. */
function toDateStrUtc(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Counts leave-day consumption for a SHIFT_BASED employee over [start, end] — BY CONTRACT, not
 * by roster (Issue #417, 2026-09-29 owner decision, supersedes Phase 107 D-06). Pure and
 * DB-free: the only inputs are the contractual weekly count and the holiday set — no roster is
 * consulted at all any more. No Prisma, no Fastify, no `Date.now()` — the same purity contract
 * `countWorkDaysInRange()` above and `calcShiftBasedSaldo()` (`shift-based-saldo.ts`) already
 * satisfy, per the 61-AUDIT.md precedent.
 *
 * Background (Issue #417): the Salon does not plan a vacation day as a shift, so the previous
 * roster-exact formula (Phase 107 D-06..D-08) always ended at 0 days for exactly the case that
 * matters — a real vacation request — regardless of whether the shift was deleted before or
 * planned around after the request. § 3 BUrlG measures a vacation day against the CONTRACT, not
 * against whatever the roster happens to show; a shift-planning tool cannot decide how many
 * vacation days a request costs.
 *
 * `holidays` — public-holiday dates at the employee's work location, same UTC "YYYY-MM-DD"
 * string format as `countWorkDaysInRange()` (see `toDateStrUtc()` above); resolved by the
 * caller via `holidaysAtWorkLocation()` (the Unterbau's only holiday-set builder).
 *
 * Algorithm (revised, Issue #425): Sunday is never a Werktag (§ 3 Abs. 2 BUrlG: "Werktage sind
 * alle Kalendertage, die nicht Sonn- oder gesetzliche Feiertage sind"), so it must never be
 * counted as a vacation-consuming day, in either branch. The previous version counted Sunday as
 * an ordinary calendar day inside a week FRAGMENT — that was the bug #425 fixes.
 *   1. `halfDay` short-circuits to 0.5 (mirrors `countWorkDaysInRange()`'s own first
 *      statement) — no week-cutting, no holiday lookup.
 *   2. `[start, end]` is cut into ISO weeks Mon-Sun (`mondayOfWeekUtc()`, same primitive as
 *      `weekRangeUtc()`/`shifts.ts`, see its own docblock above).
 *   3. For each ISO week, one loop walks the intersection of that week's Mon-Sun span with
 *      `[start, end]`, SKIPPING Sunday unconditionally, and counts two things: the number of
 *      Mo-Sat calendar days in that intersection (`moSaDaysInFragment`), and how many of them
 *      are a statutory holiday (`moSaHolidaysInFragment`).
 *   4. A week counts as WHOLE (D-07, Issue #425) when every Mo-Sat day of that ISO week lies
 *      inside `[start, end]` — i.e. `weekMonday >= start && weekSaturday <= end`. Sunday is
 *      irrelevant to this test: a Mo-Sa request already covers the whole working week and must
 *      cost the same as the identical Mo-So request (otherwise a non-working Sunday appended to
 *      a Mo-Sa request would, absurdly, LOWER the cost — see the D-07 regression test). A whole
 *      week contributes `max(0, contractWorkDaysPerWeek - moSaHolidaysInFragment)` — the
 *      contractual cap always binds for a whole week; there is no fragment to cap against.
 *   5. Any other week is a FRAGMENT: it contributes
 *      `min(moSaDaysInFragment - moSaHolidaysInFragment, contractWorkDaysPerWeek)` — the
 *      non-holiday Mo-Sat days are counted FIRST, then the result is capped at the contractual
 *      count. Capping before subtracting would double-deduct a holiday whenever the fragment has
 *      spare capacity above the contract (Issue #425 AC: "Feiertage werden nicht doppelt
 *      abgezogen").
 *   6. Sum every week's contribution. The result is never provisional any more (Issue #417):
 *      nothing here depends on data that can still change (the roster), so there is nothing
 *      left to converge later. `provisional` stays in the return shape only so every existing
 *      caller (`resolveLeaveDays()`, `shift-leave-recalc-resolver.ts`) keeps compiling against
 *      the same `{ days, provisional }` shape — it is now always `false`.
 */
export function countShiftBasedLeaveDays(
  start: Date,
  end: Date,
  halfDay: boolean,
  contractWorkDaysPerWeek: number,
  holidays: Set<string>,
): { days: number; provisional: boolean } {
  if (halfDay) return { days: 0.5, provisional: false };

  const s = utcMidnight(start);
  const e = utcMidnight(end);

  let totalDays = 0;

  let weekMonday = mondayOfWeekUtc(s);
  while (weekMonday.getTime() <= e.getTime()) {
    const weekSaturday = addUtcDays(weekMonday, 5);
    const weekSunday = addUtcDays(weekMonday, 6);
    // D-07: "whole" is decided on the Mo-Sat span only — Sunday is not a Werktag, so a Mo-Sa
    // request already covers the whole working week.
    const isWhole = weekMonday.getTime() >= s.getTime() && weekSaturday.getTime() <= e.getTime();

    const fragStart = weekMonday.getTime() > s.getTime() ? weekMonday : s;
    const fragEnd = weekSunday.getTime() < e.getTime() ? weekSunday : e;

    let moSaDaysInFragment = 0;
    let moSaHolidaysInFragment = 0;
    for (let d = fragStart; d.getTime() <= fragEnd.getTime(); d = addUtcDays(d, 1)) {
      if (d.getUTCDay() === 0) continue; // Sunday is never a Werktag (§ 3 Abs. 2 BUrlG)
      moSaDaysInFragment++;
      if (holidays.has(toDateStrUtc(d))) moSaHolidaysInFragment++;
    }

    if (isWhole) {
      totalDays += Math.max(0, contractWorkDaysPerWeek - moSaHolidaysInFragment);
    } else {
      totalDays += Math.min(moSaDaysInFragment - moSaHolidaysInFragment, contractWorkDaysPerWeek);
    }

    weekMonday = addUtcDays(weekMonday, 7);
  }

  return { days: totalDays, provisional: false };
}
