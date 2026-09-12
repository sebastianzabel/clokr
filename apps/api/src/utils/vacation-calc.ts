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
 * Calculate pro-rata vacation entitlement for an employee leaving mid-year.
 * Formula (BUrlG § 5 Abs. 2): baseDays × (volleBeschäftigungsmonate / 12), rounded UP to nearest 0.5.
 *
 * "Volle Beschäftigungsmonate": a month counts as full ONLY if the exitDate is on or after
 * the LAST DAY of that month. E.g., Jun 30 → 6 full months; Jun 29 → 5.
 *
 * @param baseDays - Full-year vacation entitlement (may already be part-time adjusted)
 * @param year - The calendar year to calculate for
 * @param exitDate - The employee's last working day
 * @returns Pro-rata entitlement rounded UP to nearest 0.5; or baseDays if exitDate is in future year
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
  // Round UP to nearest 0.5
  return Math.ceil(raw * 2) / 2;
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

// ── Phase 107 (D-05..D-09): SHIFT_BASED Urlaubsverbrauch — whole/partial-week calc ────────

/**
 * Monday (UTC midnight) of the ISO week containing `d`. Mirrors the Monday derivation already
 * used by `weekRangeUtc()` (`utils/timezone.ts`) and the inline block in `shifts.ts:709-718` —
 * "do not invent a third one" (Phase 107 CONTEXT.md D-05) — but stays in plain UTC rather than
 * `weekRangeUtc()`'s tenant-timezone-aware machinery, because this file (and its exports) must
 * stay importable without Fastify or `date-fns-tz` (D-09's purity contract). Exported so
 * `resolveLeaveDays()` (`routes/leave.ts`) can widen its Shift query to the enclosing ISO weeks
 * using this exact same primitive, instead of hand-rolling a fourth copy.
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

/** UTC "YYYY-MM-DD" — matches Shift.date's (`@db.Date`) representation and getHolidayMap()'s
 * own key format (`start.toISOString().split("T")[0]`), so Set lookups against caller-built
 * rosteredDates/holidays/weeksWithRoster line up without a second conversion. */
function toDateStrUtc(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function daysBetweenInclusiveUtc(a: Date, b: Date): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY) + 1;
}

/**
 * Counts leave-day consumption for a SHIFT_BASED employee over [start, end] (Phase 107,
 * D-05..D-09). Pure and DB-free: every input the algorithm needs — the contractual count, the
 * active roster, holidays, and which ISO weeks have ANY roster at all — is passed in by the
 * caller (`resolveLeaveDays()` in `routes/leave.ts`). No Prisma, no Fastify, no `Date.now()` —
 * the same purity contract `countWorkDaysInRange()` above and `calcShiftBasedSaldo()`
 * (`shift-based-saldo.ts`) already satisfy, per the 61-AUDIT.md precedent.
 *
 * Parameters, all keyed/compared as UTC "YYYY-MM-DD" strings (see `toDateStrUtc()` above):
 *   - `rosteredDates`   — dates with at least one ACTIVE (`deletedAt: null`) shift.
 *   - `holidays`        — public-holiday dates, same string format as `countWorkDaysInRange()`.
 *   - `weeksWithRoster` — Monday-keys of ISO weeks that have at least one active shift
 *     ANYWHERE in that week (not just inside [start, end]). This is what distinguishes "this
 *     week has a roster and the employee simply isn't scheduled on these particular days"
 *     (roster-exact branch, D-06/D-08) from "this week has no roster at all" (flat provisional
 *     branch, D-07/D-08) — a plain `rosteredDates`-only parameterisation cannot tell those
 *     apart, which is why this third set exists rather than a simpler two-set signature.
 *
 * Algorithm (D-05..D-08):
 *   1. `halfDay` short-circuits to 0.5, never provisional (mirrors `countWorkDaysInRange()`'s
 *      own first statement) — no week-cutting, no roster lookup.
 *   2. `[start, end]` is cut into ISO weeks Mon-Sun (`mondayOfWeekUtc()`, same primitive as
 *      `weekRangeUtc()`/`shifts.ts`, see its own docblock above).
 *   3. A week lying COMPLETELY inside `[start, end]` is WHOLE: it contributes
 *      `contractWorkDaysPerWeek` and ignores the roster entirely — never provisional. This is
 *      exactly why AC-RC-06 holds: planning a roster afterwards cannot change a whole week's
 *      contribution, because the roster was never consulted for it (D-06).
 *   4. A week lying PARTIALLY inside `[start, end]` is a FRAGMENT:
 *      - if its Monday-key is in `weeksWithRoster`: contribute the count of fragment days that
 *        are in `rosteredDates` AND NOT in `holidays` (D-06/D-08 exact branch) — not
 *        provisional.
 *      - otherwise: contribute `max(0, min(fragmentCalendarDays, contractWorkDaysPerWeek) -
 *        holidaysInThatFragment)` and mark the OVERALL result `provisional = true` (D-07/D-08
 *        flat branch). The `min(...)` is a deliberate UPPER bound, not an expectation (D-07):
 *        every later correction (Plan 05) can therefore only move the value DOWN — issue #94's
 *        legally uncritical direction. Do not "improve" this into an average.
 *   5. Sum every week's contribution; `provisional` is true iff AT LEAST ONE fragment lacked a
 *      roster for its week (D-11 — request-level flag, at-least-one-day granularity; a period
 *      has at most two fragments, the first and last week it touches).
 */
export function countShiftBasedLeaveDays(
  start: Date,
  end: Date,
  halfDay: boolean,
  contractWorkDaysPerWeek: number,
  rosteredDates: Set<string>,
  holidays: Set<string>,
  weeksWithRoster: Set<string>,
): { days: number; provisional: boolean } {
  if (halfDay) return { days: 0.5, provisional: false };

  const s = utcMidnight(start);
  const e = utcMidnight(end);

  let totalDays = 0;
  let provisional = false;

  let weekMonday = mondayOfWeekUtc(s);
  while (weekMonday.getTime() <= e.getTime()) {
    const weekSunday = addUtcDays(weekMonday, 6);
    const isWhole = weekMonday.getTime() >= s.getTime() && weekSunday.getTime() <= e.getTime();

    if (isWhole) {
      totalDays += contractWorkDaysPerWeek;
    } else {
      const fragStart = weekMonday.getTime() > s.getTime() ? weekMonday : s;
      const fragEnd = weekSunday.getTime() < e.getTime() ? weekSunday : e;
      const mondayKey = toDateStrUtc(weekMonday);

      if (weeksWithRoster.has(mondayKey)) {
        let count = 0;
        for (let d = fragStart; d.getTime() <= fragEnd.getTime(); d = addUtcDays(d, 1)) {
          const ds = toDateStrUtc(d);
          if (rosteredDates.has(ds) && !holidays.has(ds)) count++;
        }
        totalDays += count;
      } else {
        let holidaysInFragment = 0;
        for (let d = fragStart; d.getTime() <= fragEnd.getTime(); d = addUtcDays(d, 1)) {
          if (holidays.has(toDateStrUtc(d))) holidaysInFragment++;
        }
        const fragmentCalendarDays = daysBetweenInclusiveUtc(fragStart, fragEnd);
        totalDays += Math.max(
          0,
          Math.min(fragmentCalendarDays, contractWorkDaysPerWeek) - holidaysInFragment,
        );
        provisional = true;
      }
    }

    weekMonday = addUtcDays(weekMonday, 7);
  }

  return { days: totalDays, provisional };
}
