/**
 * Pro-rata vacation calculation for part-time employees.
 * Formula (BUrlG): (employee work days/week ÷ full-time days/week) × base vacation days
 * Result rounded to nearest 0.5 (German standard).
 *
 * Phase 49.5: `workDays` ist die Quelle der Wahrheit für "an welchen Tagen
 * arbeitet diese Person?" — unabhängig vom AZ-Modell. Per-Tag-Soll-Felder
 * (mondayHours…) bleiben für FIXED_SCHEDULE Saldo-Berechnung relevant, sind
 * aber nicht mehr Grundlage für Urlaubs-Tagezählung.
 *
 * Issue #435 — this file's only import. `ageAtDate` lives in the zero-import leaf
 * `age-at-date.ts` (never `jarbschg.ts`, which imports `../working-time-account` and would pull
 * this file into the capped import cycle — RESEARCH.md Pitfall 1). This file must stay a
 * zero-import leaf itself beyond this one line.
 */
import { ageAtDate } from "./age-at-date";

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
 *
 * Issue #468 (D-06): a contract with MORE workdays than the reference week scales UP exactly
 * like a part-time contract scales DOWN — BUrlG § 3 counts Werktage, not a weekly-hours ratio, so
 * a Mo-Sa (6-day) contract is 6/5 of the Mo-Fr base (30 at 5 days -> 36 at 6 days), never capped
 * at the 5-day value. Only the EQUALITY branch (`employeeWorkDays === fullTimeWorkDays`) returns
 * `baseVacationDays` unrounded and unchanged: it exists so a person base with a non-half fraction
 * (`Employee.annualVacationDays Decimal(5,2)`, e.g. 29.3) stays byte-identical at the reference
 * week count instead of being re-rounded by the general formula below (`Math.ceil(29.3 * 2) / 2`
 * would return 29.5). Every `employeeWorkDays > fullTimeWorkDays` case now reaches that general
 * proportional formula. The statutory minimum floor is computed separately
 * ({@link statutoryMinimumVacationDays}) and is unaffected by this change.
 *
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
  if (employeeWorkDays === fullTimeWorkDays) return baseVacationDays;

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
 * {@link employmentYearVacationDays} (Issue #447, via {@link fullEmploymentMonthsInYear}) — the
 * two § 5 Abs. 1 BUrlG "Zwölftelung" (twelfthing) calculations for hire-year and exit-year
 * pro-rata entitlement. This rule does NOT apply to {@link calculatePartTimeVacation}'s
 * full-time/part-time day-count conversion, which is a different calculation outside § 5's
 * twelfthing rule (Issue #421 research, backed by the Arnold/Tillmanns BUrlG § 5 commentary
 * § "Bruchteile außerhalb der Zwölftelungsregelung" and BAG 9 AZR 7/16, 14.03.2017) —
 * deliberately left unrounded-to-full-day there.
 */
export function roundVacationDaysBurlG(raw: number): number {
  const frac = raw - Math.floor(raw);
  if (frac >= 0.5) return Math.ceil(raw);
  return Math.round(raw * 100) / 100;
}

/**
 * Calculate pro-rata vacation entitlement for an employee HIRED mid-year.
 * Formula (§ 5 Abs. 1 lit. a BUrlG): baseDays × (volleBeschäftigungsmonate / 12), rounded UP to
 * nearest 0.5. Counts full calendar months REMAINING in the year, from `hireDate` (inclusive)
 * through December.
 *
 * "Volle Beschäftigungsmonate": a month counts as full here when `hireDate` falls ON OR BEFORE
 * that month's LAST DAY. Concretely this means the HIRE month itself always counts in full, no
 * matter which day within it the hire happened (e.g. hired the 3rd of the month) — BUrlG does
 * not require day-level proration within the first month. A hire on the last day of a month and
 * a hire on the first day of the NEXT month differ by exactly one month's worth, because that is
 * where the calendar-month boundary actually falls. Issue #447 (D-05): the counting itself is
 * delegated to the shared span counter {@link fullEmploymentMonthsInYear} (exitDate `null` →
 * every month passes the exit side), which also drives the EXIT-year decision in
 * {@link employmentYearVacationDays} — one month counter instead of two independent copies of the
 * same loop.
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
 * shared helper's docblock and Issue #421). The EXIT-year side ({@link employmentYearVacationDays})
 * uses the identical shared helper — the two are not divergent.
 *
 * @param baseDays - Full-year vacation entitlement (may already be part-time adjusted)
 * @param year - The calendar year to calculate for
 * @param hireDate - The employee's first working day
 * @returns Pro-rata entitlement: `baseDays` unchanged if hired before `year`; `0` if not yet
 *   hired in `year`; otherwise the § 5 Abs. 2 BUrlG rounding above.
 *
 * Pure twelfthing — this function does not decide WHETHER a hire year is pro-rated at all; it only
 * computes the result once pro-rating has been decided elsewhere. Issue #435 (owner Ergänzung G9,
 * § 4 BUrlG Wartezeit) applies that decision FIRST, in {@link hireYearVacationDays}: a hire on or
 * before 1 July of the hire year never reaches this function's reduction at all. Production callers
 * reach this function only through `hireYearVacationDays` — see that function's docblock.
 *
 * Issue #450: since {@link employmentYearVacationDays} (and, through it,
 * {@link hireYearVacationDays}) now applies the twelfthing directly via
 * {@link fullEmploymentMonthsInYear}/{@link roundVacationDaysBurlG}, no production path calls this
 * function any more — its own unit tests keep pinning the § 5 Abs. 2 arithmetic it still encodes.
 *
 * Issue #450 (D-10): `hireDate` is read with UTC accessors — since Issue #450 (D-10, owner
 * decision P4) the whole § 5 family reads and builds dates in UTC, so results no longer depend
 * on the process timezone. Proven by `vacation-calc-timezone.test.ts`.
 */
export function calculateProRataVacationForHire(
  baseDays: number,
  year: number,
  hireDate: Date,
): number {
  if (!Number.isFinite(baseDays) || baseDays <= 0) return 0;

  const hireYear = hireDate.getUTCFullYear();

  // Not yet employed in this year → no entitlement.
  if (hireYear > year) return 0;

  // Already employed before this year started → full entitlement for this year.
  if (hireYear < year) return baseDays;

  // Count volle Beschäftigungsmonate remaining in the year: month is full when hireDate is
  // ON OR BEFORE the last day of that month (see this function's own docblock above). Issue #447
  // (D-05): delegates to the shared span counter with no exit (exitDate null -> every month
  // passes the exit side) — identical result, now the ONE month counter instead of a second copy
  // of the same loop.
  const monthsWorked = fullEmploymentMonthsInYear(year, hireDate, null);

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

/** The inverse of `toDateStrUtc()` for the "what weekday is this" question — parses a
 * "YYYY-MM-DD" string (already UTC-midnight by construction) and returns `getUTCDay()`
 * (0=Sun..6=Sat). Phase 436 (D-03). */
function dowOfDateStr(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00.000Z`).getUTCDay();
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
 * Algorithm (revised, Issue #425): Sunday is never a Werktag — § 3 Abs. 2 BUrlG defines
 * Werktage as every calendar day that is not a Sunday or a statutory holiday — so it must never
 * be counted as a vacation-consuming day, in either branch. The previous version counted Sunday
 * as an ordinary calendar day inside a week FRAGMENT — that was the bug #425 fixes.
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
 *      `max(0, min(moSaDaysInFragment, contractWorkDaysPerWeek) - moSaHolidaysInFragment)` — the
 *      requested Mo-Sat days, capped at the contractual count, minus each Mo-Sat holiday exactly
 *      once (a Sunday holiday is never counted, so it can never be deducted). This is the same
 *      holiday rule as the whole-week branch (contract minus Mo-Sat holidays), so the cost is
 *      monotone in the request: extending a request by a day never makes it cheaper. The
 *      alternative "count non-holiday days first, then cap" was rejected (Issue #425 decision
 *      comment): with a 4-day contract and a Wednesday holiday it would charge Mo-Fr 4 days
 *      while the whole Mo-Sa week costs 3.
 *   6. Sum every week's contribution. The result is never provisional any more (Issue #417):
 *      nothing here depends on data that can still change (the roster), so there is nothing
 *      left to converge later. `provisional` stays in the return shape only so every existing
 *      caller (`resolveLeaveDays()`, `shift-leave-recalc-resolver.ts`) keeps compiling against
 *      the same `{ days, provisional }` shape — it is now always `false`.
 */
/**
 * The shared per-week kernel (Issue #429, D-02; extended Phase 436, D-03) behind BOTH
 * `countShiftBasedLeaveDays()` (a single running total) and `leaveDaysPerWeek()`
 * (per-week/per-date breakdown, below). Extracting this as one function is the "dieselbe Formel"
 * proof Issue #429 AC-2 asks for: both callers literally run the same code, not two independently
 * written formulas that could drift.
 *
 * `requestedDates` is every calendar date (Mo-So, as UTC "YYYY-MM-DD" strings) requested in THIS
 * ISO week's fragment/whole span — Sunday dates ARE included here; this function decides whether
 * a date counts, the caller no longer pre-filters.
 *
 * Branches (Phase 436, D-03):
 *   - WHOLE (every Mo-Sat day of the week is inside the requested range): `countedDates` is the
 *     requested Mo-Sat dates (Sunday is never a Werktag, § 3 Abs. 2 BUrlG, so it is dropped even
 *     here), `days = max(0, contractWorkDaysPerWeek - holidays among countedDates)` — the
 *     contractual cap always binds for a whole week. `usualWorkDays` is NEVER applied to this
 *     branch (D-03: "Full-week detection unchanged" — see Pitfall 4 in 436-RESEARCH.md: filtering
 *     a restricted employee's whole week would wrongly undercount it).
 *   - FRAGMENT, `usualWorkDays` empty: `countedDates` is the requested dates minus Sunday
 *     (unchanged pre-436 behaviour).
 *   - FRAGMENT, `usualWorkDays` non-empty: `countedDates` is the requested dates whose UTC weekday
 *     is a member of `usualWorkDays` — Sunday now follows the SAME set-membership rule as any
 *     other weekday (Phase 436 Task 2, D-03: if `0` is a usual day, a requested Sunday counts).
 *     Either way, `days = max(0, min(|countedDates|, contractWorkDaysPerWeek) - holidays among
 *     countedDates)`.
 * A holiday is therefore deducted exactly once, and only for a date that would otherwise count.
 */
function weekLeaveDays(
  requestedDates: string[],
  isWhole: boolean,
  contractWorkDaysPerWeek: number,
  holidays: Set<string>,
  usualWorkDays: readonly number[] = [],
): { days: number; countedDates: string[] } {
  if (isWhole) {
    const countedDates = requestedDates.filter((d) => dowOfDateStr(d) !== 0);
    const holidayCount = countedDates.filter((d) => holidays.has(d)).length;
    return { days: Math.max(0, contractWorkDaysPerWeek - holidayCount), countedDates };
  }

  const countedDates =
    usualWorkDays.length === 0
      ? requestedDates.filter((d) => dowOfDateStr(d) !== 0)
      : requestedDates.filter((d) => usualWorkDays.includes(dowOfDateStr(d)));
  const holidayCount = countedDates.filter((d) => holidays.has(d)).length;
  const days = Math.max(0, Math.min(countedDates.length, contractWorkDaysPerWeek) - holidayCount);
  return { days, countedDates };
}

/** Phase 436 (D-03, Task 2) — does a HALF-DAY request on UTC weekday `dow` count? `true` when
 * `usualWorkDays` is empty (unchanged pre-436 behaviour: a half day always counts 0.5 regardless
 * of weekday), else iff `dow` is a member of `usualWorkDays`. Shared by
 * `countShiftBasedLeaveDays()`'s halfDay short-circuit and `buildHalfShareForWeek()` so the two
 * half-day paths can never disagree about which weekday counts. */
function halfDayCounts(dow: number, usualWorkDays: readonly number[]): boolean {
  return usualWorkDays.length === 0 || usualWorkDays.includes(dow);
}

export function countShiftBasedLeaveDays(
  start: Date,
  end: Date,
  halfDay: boolean,
  contractWorkDaysPerWeek: number,
  holidays: Set<string>,
  usualWorkDays: readonly number[] = [],
): { days: number; provisional: boolean } {
  if (halfDay) {
    const counts = halfDayCounts(utcMidnight(start).getUTCDay(), usualWorkDays);
    return { days: counts ? 0.5 : 0, provisional: false };
  }

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

    const requestedDates: string[] = [];
    for (let d = fragStart; d.getTime() <= fragEnd.getTime(); d = addUtcDays(d, 1)) {
      requestedDates.push(toDateStrUtc(d));
    }

    totalDays += weekLeaveDays(
      requestedDates,
      isWhole,
      contractWorkDaysPerWeek,
      holidays,
      usualWorkDays,
    ).days;

    weekMonday = addUtcDays(weekMonday, 7);
  }

  return { days: totalDays, provisional: false };
}

// ── Issue #445 (D-01) — the regular yearly vacation entitlement, in ONE place ──────────────────

/**
 * Issue #435, owner Ergänzung G9 (01.10.2026, "Wartezeit im Eintrittsjahr") — § 4 / § 5 Abs. 1 a
 * BUrlG: the hire-year pro-rata reduction applies ONLY when the 6-month § 4 BUrlG Wartezeit is NOT
 * yet fulfilled within the hire year, i.e. the hire happened AFTER 1 July. A hire on or before 1
 * July has a Wartezeit that ends within the same calendar year (a 01.07. hire's Wartezeit ends
 * 31.12.) — § 5 Abs. 1 a BUrlG's reduction does not apply, so the FULL (already contract-scaled)
 * entitlement is owed, with no twelfthing at all.
 *
 * This is the ONE place deciding WHETHER a hire year is pro-rated —
 * {@link calculateProRataVacationForHire} stays the pure twelfthing step this function delegates
 * to for a later hire. Delegates to {@link employmentYearVacationDays} (Issue #450, D-10: UTC
 * accessors throughout the § 5 family, so results no longer depend on the process timezone —
 * proven by `vacation-calc-timezone.test.ts`).
 *
 * @param fullYearDays - the already contract-scaled full-year entitlement (e.g. via
 *   {@link calculatePartTimeVacation})
 * @param year - the calendar year being computed
 * @param hireDate - the employee's hire date
 * @returns `fullYearDays` unchanged for any year other than the hire year, and for a hire on or
 *   before 1 July of the hire year; otherwise the § 5 Abs. 1 a BUrlG pro-rata via
 *   {@link calculateProRataVacationForHire}
 */
export function hireYearVacationDays(fullYearDays: number, year: number, hireDate: Date): number {
  // Issue #450 (D-01/D-02): a one-line delegate — the hire-year decision is now one case of
  // the general employment-span decision ({@link isFullEntitlementYear}, via
  // {@link employmentYearVacationDays}), with no exit date.
  return employmentYearVacationDays(fullYearDays, year, hireDate, null);
}

/**
 * Issue #447 (D-05) — § 4 BUrlG Wartezeit: the day the 6-month waiting period ends, per
 * §§ 187 Abs. 2, 188 Abs. 2/3 BGB. The Wartezeit runs from `hireDate` (inclusive, § 187 Abs. 2
 * BGB) for six months; it ends on the day BEFORE the numerically matching day six months later
 * (e.g. hire 01.01. -> ends 30.06.), or on the LAST DAY of that sixth month when it has no
 * numerically matching day (e.g. hire 31.08. -> the "31." of February does not exist -> ends on
 * the last real day of that month, § 188 Abs. 3 BGB).
 *
 * Implemented as the earlier of the two candidate dates in the UTC frame of `hireDate`
 * (`y`/`m`/`d` via `getUTCFullYear`/`getUTCMonth`/`getUTCDate` — Issue #450, D-10, owner decision
 * P4: since this function no longer depends on the process timezone, the two candidates are
 * built via `Date.UTC` rather than the local constructor): `new Date(Date.UTC(y, m + 6, d - 1))`
 * (the day-before-matching-day candidate, which `Date.UTC` arithmetic naturally clamps into the
 * correct month when `d - 1` or the overflow month spills over) and
 * `new Date(Date.UTC(y, m + 7, 0))` (the last day of the sixth month). Taking the earlier of the
 * two always yields the correct § 188 Abs. 3 BGB result, including across a leap-year February.
 * Proven timezone-independent by `vacation-calc-timezone.test.ts`.
 *
 * @param hireDate - the employee's hire date
 * @returns the last day of the § 4 BUrlG Wartezeit, as a UTC-midnight `Date`
 */
export function wartezeitEndDate(hireDate: Date): Date {
  const y = hireDate.getUTCFullYear();
  const m = hireDate.getUTCMonth();
  const d = hireDate.getUTCDate();
  const matchingDayMinusOne = new Date(Date.UTC(y, m + 6, d - 1));
  const lastDayOfSixthMonth = new Date(Date.UTC(y, m + 7, 0));
  return matchingDayMinusOne < lastDayOfSixthMonth ? matchingDayMinusOne : lastDayOfSixthMonth;
}

/**
 * Issue #447 (D-05) — the ONE month counter for an employment span within a calendar year,
 * combining the hire-side convention already used by {@link calculateProRataVacationForHire}
 * (the hire month counts in full whenever `hireDate` is on or before that month's last day) with
 * the exit-side convention the old exit-only twelfthing used (a month counts only when `exitDate`
 * is on or after that month's last day) — counted ONCE over the span
 * `max(hireDate, 1.1.year)…min(exitDate, 31.12.year)`.
 *
 * `exitDate === null` means "not yet exited" — every month passes the exit-side test. A `hireDate`
 * in a year before `year` means every month passes the hire-side test; a `hireDate` in a year
 * after `year` means no month passes it (comparison against `year`'s own month-end dates already
 * produces this without a separate year check).
 *
 * Open assumption (not resolved by this function): this counts whole calendar MONTHS, matching
 * the existing #416/#421 convention. A strict § 188 BGB elapsed-time count from the exact start
 * date can differ by one twelfth from this month-based count when both the hire and the exit fall
 * mid-month in asymmetric ways — out of scope for Issue #447.
 *
 * @param year - the calendar year being counted
 * @param hireDate - the employee's hire date
 * @param exitDate - the employee's exit date, or `null` if still employed
 * @returns the number of full employment months within `year`, 0-12
 *
 * Issue #450 (D-01): the month loop itself now lives in {@link employmentMonthIndicesInYear} —
 * this function keeps its original signature and docblock, returning that array's length.
 *
 * Issue #450 (D-10, owner decision P4): that month loop builds every month-end date in UTC, so
 * this function's result no longer depends on the process timezone — proven by
 * `vacation-calc-timezone.test.ts`.
 */
export function fullEmploymentMonthsInYear(
  year: number,
  hireDate: Date,
  exitDate: Date | null,
): number {
  return Math.min(employmentMonthIndicesInYear(year, hireDate, exitDate).length, 12);
}

/**
 * Issue #447 (D-05) — the ONE exit-year regular-entitlement decision, § 5 Abs. 1 BUrlG:
 *
 * - exit before `year` -> `0` (not employed in `year`)
 * - exit `null` or after `year` -> {@link hireYearVacationDays} unchanged — the #435 hire-year path,
 *   byte-identical for every still-employed (or not-yet-exited-this-year) employee
 * - exit inside `year`:
 *   - § 5 Abs. 1 b BUrlG: the § 4 BUrlG Wartezeit ({@link wartezeitEndDate}) is not yet fulfilled
 *     by the exit day -> Teilurlaub, regardless of which half-year the exit falls in
 *   - § 5 Abs. 1 c BUrlG: the exit falls in the FIRST half-year (January-June) after a fulfilled
 *     Wartezeit -> Teilurlaub
 *   - otherwise (SECOND half-year, July-December, after a fulfilled Wartezeit) -> the full
 *     entitlement, via {@link hireYearVacationDays} (which still applies the hire-year Wartezeit
 *     rule when hire and exit are both in `year`)
 *
 * Teilurlaub is `roundVacationDaysBurlG(fullYearDays * fullEmploymentMonthsInYear(...) / 12)` — the
 * ONE span twelfthing of {@link fullEmploymentMonthsInYear}, so hire and exit in the same year are
 * twelfthed exactly once (fixes the pre-#447 double-twelfthing bug).
 *
 * @param fullYearDays - the already-scaled, already-floored full-year entitlement
 * @param year - the calendar year being computed
 * @param hireDate - the employee's hire date
 * @param exitDate - the employee's exit date, or `null` if still employed
 *
 * Issue #450 (D-10, owner decision P4): since Issue #450 the whole § 5 BUrlG family reads and
 * builds dates in UTC, so results no longer depend on the process timezone — proven by
 * `vacation-calc-timezone.test.ts`.
 *
 * Issue #450 (D-01/D-02/D-03): the WHETHER-a-year-is-owed-in-full decision this function's body
 * used to inline (via {@link hireYearVacationDays}) now lives in ONE place,
 * {@link isFullEntitlementYear} — this function's own behaviour is unchanged, it just asks that
 * decision instead of re-deriving it.
 */
export function employmentYearVacationDays(
  fullYearDays: number,
  year: number,
  hireDate: Date,
  exitDate: Date | null,
): number {
  if (exitDate !== null && exitDate.getUTCFullYear() < year) return 0;
  if (isFullEntitlementYear(year, hireDate, exitDate)) return fullYearDays;
  return roundVacationDaysBurlG(
    (fullYearDays * fullEmploymentMonthsInYear(year, hireDate, exitDate)) / 12,
  );
}

// ── Issue #450 (D-01/D-02/D-03) — the regular entitlement per contract segment
// (EuGH Brandes C-415/12, Greenfield C-219/14; BAG 10.02.2015 – 9 AZR 53/14) ───────────────────

/**
 * Issue #450 (D-01) — THE § 5 BUrlG decision whether `year` is owed IN FULL (no twelfthing at
 * all), assembled from the exact conditions {@link employmentYearVacationDays} and
 * {@link hireYearVacationDays} already used before this issue: `false` for a `year` the employee
 * had already exited before; otherwise the hire rule (`year` differs from the hire year, OR the
 * hire fell on/before 1 July of the hire year) decides, UNLESS the exit falls inside `year` and
 * either the § 4 BUrlG Wartezeit is not yet fulfilled by the exit day or the exit falls in the
 * first half-year (January-June) — either of which makes the year a Teilurlaub year regardless of
 * the hire rule.
 *
 * This is the ONE place deciding WHETHER a year is owed in full — {@link employmentYearVacationDays}
 * (and, through it, {@link hireYearVacationDays}) delegates here instead of inlining the decision,
 * and {@link apportionAcrossContractSegments} uses it to pick which calendar months are owed at
 * all before apportioning them across contract segments.
 *
 * Issue #450 (D-10): reads `hireDate`/`exitDate` with UTC accessors — since Issue #450 (D-10,
 * owner decision P4) the whole § 5 family reads and builds dates in UTC, so results no longer
 * depend on the process timezone. Proven by `vacation-calc-timezone.test.ts`.
 */
export function isFullEntitlementYear(
  year: number,
  hireDate: Date,
  exitDate: Date | null,
): boolean {
  if (exitDate !== null && exitDate.getUTCFullYear() < year) return false;
  const hireRule =
    year !== hireDate.getUTCFullYear() ||
    hireDate.getUTCMonth() < 6 ||
    (hireDate.getUTCMonth() === 6 && hireDate.getUTCDate() === 1);
  if (exitDate === null || exitDate.getUTCFullYear() > year) return hireRule;

  // Exit happens inside `year`.
  const wartezeitFulfilled = wartezeitEndDate(hireDate) <= exitDate;
  const firstHalfYear = exitDate.getUTCMonth() < 6;
  if (!wartezeitFulfilled || firstHalfYear) return false;
  return hireRule;
}

/**
 * Issue #450 (D-01) — the month-loop half of {@link fullEmploymentMonthsInYear}, extracted so the
 * segment apportionment below can know WHICH months are owed, not just how many. Moved verbatim
 * from that function's own loop (Issue #447, D-05) — only the return shape changed, from a count
 * to the list of month indices (0-11) themselves.
 *
 * @returns the month indices (0-11) within `year` that fall inside the employment span
 *   `max(hireDate, 1 Jan year)…min(exitDate, 31 Dec year)`, in ascending order
 *
 * Issue #450 (D-10): each month's last day is built via `Date.UTC` — since Issue #450 (D-10,
 * owner decision P4) the whole § 5 family reads and builds dates in UTC, so results no longer
 * depend on the process timezone. Proven by `vacation-calc-timezone.test.ts`.
 */
export function employmentMonthIndicesInYear(
  year: number,
  hireDate: Date,
  exitDate: Date | null,
): number[] {
  const months: number[] = [];
  for (let month = 0; month < 12; month++) {
    const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0));
    const hireSide = hireDate <= lastDayOfMonth;
    const exitSide = exitDate === null || exitDate >= lastDayOfMonth;
    if (hireSide && exitSide) months.push(month);
  }
  return months;
}

/**
 * Issue #450 (D-01/D-04) — one contract period: `from` (UTC) is the segment's start, and the
 * FIRST segment of a sorted list also covers every month before the second segment starts (there
 * is no "before the first segment" — the earliest known contract always reaches back to the
 * employee's hire).
 */
export type VacationContractSegment = { from: Date; workDaysPerWeek: number };

/**
 * Issue #450 (D-01/D-03) — apportions a per-contract-segment full-year value across the calendar
 * months `year` owes (per {@link isFullEntitlementYear}/{@link employmentMonthIndicesInYear}),
 * picking for each owed month the LAST sorted segment whose `from` is on or before that month's
 * reference instant (1st of the month, UTC), falling back to the first segment for any month
 * before every segment starts. D-01: the months' values are summed FIRST and
 * {@link roundVacationDaysBurlG} is applied ONCE to the total — never per segment. D-02: when
 * every owed month resolves to the SAME value (a single-contract year, several segments with
 * equal workdays, or workday counts that all collapse to the same statutory/base ceiling), this is
 * a one-contract year by construction — it returns {@link employmentYearVacationDays}'s own,
 * unrounded-here value instead of rounding the (already-equal) sum, so a single-segment year is
 * byte-identical to today's {@link computeRegularVacationDays}.
 *
 * D-03 (boundary months): each owed month's reference instant is clamped into the employment
 * range — never earlier than the hire month, and, when an exit exists, never later than the exit
 * month — BEFORE looking up the active segment. A contract row that starts after the exit or
 * ended before the hire therefore never contributes a month: without the clamp, a full-year exit
 * (§ 5 Abs. 1 c BUrlG second half-year case) could pick up a segment dated AFTER the exit for its
 * last calendar months, and a full-year hire (on/before 1 July) could pick up a segment dated
 * BEFORE the hire for its first calendar months — months before hire and after exit intersect
 * with the employment range at the hire/exit month itself, not at the calendar month's own date.
 *
 * Not exported — every caller goes through {@link computeRegularVacationDaysBySegments}.
 *
 * @throws if `segments` is empty — never a silent `0` (fail-closed)
 */
type ApportionAcrossContractSegmentsInput = {
  year: number;
  hireDate: Date;
  exitDate: Date | null;
  segments: readonly VacationContractSegment[];
  fullYearValue: (workDaysPerWeek: number) => number;
};

function apportionAcrossContractSegments(input: ApportionAcrossContractSegmentsInput): number {
  const { year, hireDate, exitDate, segments, fullYearValue } = input;
  if (segments.length === 0) {
    throw new Error("apportionAcrossContractSegments: segments must not be empty");
  }
  const sorted = [...segments].sort((a, b) => a.from.getTime() - b.from.getTime());

  const ownedMonths = isFullEntitlementYear(year, hireDate, exitDate)
    ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
    : employmentMonthIndicesInYear(year, hireDate, exitDate);
  if (ownedMonths.length === 0) return 0;

  // D-03: the employment-range clamp for the active-segment lookup below — UTC accessors, new
  // code (the moved-verbatim § 5 family above stays local-accessor until Issue #450-02, D-10).
  const hireClamp = Date.UTC(hireDate.getUTCFullYear(), hireDate.getUTCMonth(), 1);
  const exitClamp =
    exitDate !== null ? Date.UTC(exitDate.getUTCFullYear(), exitDate.getUTCMonth(), 1) : null;

  const monthValues = ownedMonths.map((month) => {
    let reference = Date.UTC(year, month, 1);
    if (reference < hireClamp) reference = hireClamp;
    if (exitClamp !== null && reference > exitClamp) reference = exitClamp;

    let active = sorted[0];
    for (const segment of sorted) {
      if (segment.from.getTime() <= reference) active = segment;
    }
    return fullYearValue(active.workDaysPerWeek);
  });

  const distinctValues = new Set(monthValues);
  if (distinctValues.size <= 1) {
    // D-02 precedence: every owed month carries the same full-year value — this IS a
    // one-contract year, so it returns today's (unrounded-here) value rather than rounding an
    // already-uniform sum a second time. `monthValues[0]` is always defined here: `ownedMonths`
    // (and therefore `monthValues`, its 1:1 map) is guaranteed non-empty by the `length === 0`
    // return above (code review finding IN-01 — `noUncheckedIndexedAccess` is not enabled in this
    // project, so no `?? 0` fallback is needed to satisfy the type checker).
    return employmentYearVacationDays(monthValues[0], year, hireDate, exitDate);
  }

  const sum = monthValues.reduce((acc, value) => acc + value, 0);
  return roundVacationDaysBurlG(sum / 12);
}

/**
 * Issue #450 (D-01) — the segment-aware regular-entitlement kernel {@link computeRegularVacationDays}
 * delegates to (single segment, byte-identical, D-02). `segments` need not be sorted or
 * deduplicated — see {@link apportionAcrossContractSegments}. Per segment, `fullYearValue` mirrors
 * {@link computeRegularVacationDays}'s own scaling step exactly: scale by that segment's
 * contractual workdays first ({@link calculatePartTimeVacation}, reference week 5), then floor at
 * the statutory minimum ({@link statutoryMinimumVacationDays}) for that same workday count.
 *
 * @param input.baseDays - the full-time base entitlement (e.g. tenant default 30); `<= 0` → `0`
 *   (same not-employed-in-year guard {@link computeRegularVacationDays} has always had)
 */
export function computeRegularVacationDaysBySegments(input: {
  year: number;
  hireDate: Date;
  birthDate: Date | null;
  exitDate: Date | null;
  segments: readonly VacationContractSegment[];
  baseDays: number;
}): number {
  const { year, hireDate, birthDate, exitDate, segments, baseDays } = input;
  if (!(baseDays > 0)) return 0;

  const fullYearValue = (workDaysPerWeek: number): number => {
    const referenceSchedule: ScheduleForCalc = {
      mondayHours: 0,
      tuesdayHours: 0,
      wednesdayHours: 0,
      thursdayHours: 0,
      fridayHours: 0,
      saturdayHours: 0,
      sundayHours: 0,
      contractWorkDaysPerWeek: workDaysPerWeek,
    };
    return Math.max(
      calculatePartTimeVacation(referenceSchedule, 5, baseDays),
      statutoryMinimumVacationDays(birthDate, year, workDaysPerWeek),
    );
  };

  return apportionAcrossContractSegments({ year, hireDate, exitDate, segments, fullYearValue });
}

/**
 * Issue #435 (D-07/D-08) — the statutory MINIMUM vacation entitlement (§ 19 Abs. 2 JArbSchG for
 * minors, § 3 Abs. 1 BUrlG otherwise), at `contractWorkDaysPerWeek` days/week, for `year`.
 *
 * Age gate (§ 19 Abs. 2 JArbSchG: "not yet N years old at the start of the calendar year"): the age
 * is taken at 1 January of `year`, via {@link ageAtDate} — which already implements § 187 Abs. 2
 * S. 2 BGB's "birthday on the reference date counts as the new age" rule (a person born 1 January
 * is already that year's new age ON 1 January; born 2 January is still the old age). The age is
 * re-evaluated per `year` — someone turning 18 during `year` drops to the § 3 BUrlG band only in
 * the FOLLOWING year, because 1 January of `year` itself still sees the old (lower) age.
 *
 * Werktage (statutory, 6-day-week basis) by age band:
 *   - age < 16  -> 30 Werktage (§ 19 Abs. 2 Nr. 1 JArbSchG)
 *   - age < 17  -> 27 Werktage (§ 19 Abs. 2 Nr. 2 JArbSchG)
 *   - age < 18  -> 25 Werktage (§ 19 Abs. 2 Nr. 3 JArbSchG)
 *   - else      -> 24 Werktage (§ 3 Abs. 1 BUrlG — the adult statutory minimum)
 * `birthDate === null` is treated as an ADULT (24 Werktage) — the only fail-open direction that
 * never undercuts the law for an adult; a minor without a recorded birth date instead gets a
 * "Geburtsdatum fehlt" UI hint elsewhere (D-12), never a silently-wrong floor.
 *
 * Conversion to `contractWorkDaysPerWeek` days/week mirrors the existing (now-dead-code)
 * {@link calculateStatutoryMinimum}'s own `werktage / 6 × days` shape for the adult/§3 case — this
 * function generalises it to all four Werktage bands. Result is rounded to 2 decimals, the
 * storage precision of `LeaveEntitlement.totalDays` (`Decimal(5,2)`) — NEVER rounded to a whole or
 * half day (the law's fraction, e.g. 20.83 or 16.67, stays exact — fractional days are never
 * rounded down).
 *
 * @param birthDate - the employee's birth date, or `null` (fail-open to the adult/§3 floor)
 * @param year - the calendar year the entitlement is computed for
 * @param contractWorkDaysPerWeek - the employee's contractual work days per week
 * @returns the statutory-minimum entitlement at 2-decimal precision; `0` for a non-finite or
 *   non-positive `contractWorkDaysPerWeek`
 */
export function statutoryMinimumVacationDays(
  birthDate: Date | null,
  year: number,
  contractWorkDaysPerWeek: number,
): number {
  if (!Number.isFinite(contractWorkDaysPerWeek) || contractWorkDaysPerWeek <= 0) return 0;

  let werktage = 24; // § 3 Abs. 1 BUrlG — adult default, also birthDate === null fail-open
  if (birthDate !== null) {
    const age = ageAtDate(birthDate, new Date(Date.UTC(year, 0, 1)));
    if (age < 16) werktage = 30;
    else if (age < 17) werktage = 27;
    else if (age < 18) werktage = 25;
  }

  return Math.round((werktage / 6) * contractWorkDaysPerWeek * 100) / 100;
}

/**
 * Issue #450 (D-09) — the segment-aware form of {@link statutoryMinimumVacationThreshold}: the
 * statutory-minimum floor a `PUT /settings/vacation/:employeeId` write (or the `GET` suggestion)
 * must not undercut, apportioned across the employee's contract segments exactly like
 * {@link computeRegularVacationDaysBySegments} apportions the regular entitlement — same reason
 * CLAUDE.md names for sharing `hireYearVacationDays`/`employmentYearVacationDays` (#435 D-10):
 * the threshold is the floor half of the same per-segment computation, so a correct segment value
 * (e.g. base 20, 3->5 days from 01.07.: regular 16) is never rejected against a newest-row-only
 * floor that ignores the earlier segment (which would wrongly answer 20).
 *
 * Not-employed-in-`year` short-circuits to `0` (same guard {@link statutoryMinimumVacationThreshold}
 * has always had) — the floor must never invent an entitlement for a year the employee wasn't
 * employed in. `fullYearValue` is the statutory minimum ITSELF for that segment's workdays — no
 * `calculatePartTimeVacation`/base-days scaling, unlike the regular-entitlement kernel — because
 * the threshold IS the floor, not a value floored against something else.
 *
 * @returns the statutory-minimum threshold at 2-decimal precision; `0` when not employed in `year`
 */
export function statutoryMinimumVacationThresholdBySegments(input: {
  birthDate: Date | null;
  year: number;
  segments: readonly VacationContractSegment[];
  hireDate: Date;
  exitDate: Date | null;
}): number {
  const { birthDate, year, segments, hireDate, exitDate } = input;
  const notEmployedInYear =
    hireDate.getUTCFullYear() > year || (exitDate !== null && exitDate.getUTCFullYear() < year);
  if (notEmployedInYear) return 0;
  return apportionAcrossContractSegments({
    year,
    hireDate,
    exitDate,
    segments,
    fullYearValue: (workDaysPerWeek) =>
      statutoryMinimumVacationDays(birthDate, year, workDaysPerWeek),
  });
}

/**
 * Issue #435 (D-10) — the statutory-minimum THRESHOLD a `PUT /settings/vacation/:employeeId`
 * write (or the `GET` suggestion, D-14) must not undercut, for one employee/year. This is the
 * SAME hire-year Wartezeit decision {@link computeRegularVacationDays} applies to the regular
 * entitlement — {@link hireYearVacationDays} — applied to the statutory minimum instead of the
 * person/tenant base value, so the threshold a late hire owes is pro-rated exactly like their
 * regular entitlement would be. One shared helper, not a second hire-year formula.
 *
 * Not-employed-in-`year` short-circuits to `0` (mirrors {@link computeRegularVacationDays}'s own
 * `baseDays` guard) — the floor must never invent an entitlement for a year the employee wasn't
 * employed in. Employed-in-`year` test: `hireDate.getUTCFullYear() <= year` AND, if the employee
 * has since exited, `exitDate.getUTCFullYear() >= year` — the same UTC calendar-year comparison
 * `loadRegularVacationInputs` (`leave-days.ts`) already uses.
 *
 * Issue #447 (D-11): the exit year now follows the SAME § 5 BUrlG twelfthing as the regular
 * entitlement, via {@link employmentYearVacationDays} — ONE shared helper, no second exit rule.
 * An exit mid-year twelfths the threshold exactly like it twelfths the regular entitlement, so a
 * correct Teilurlaub never triggers a false statutory-minimum violation and the floor is never set
 * below what the law actually requires for that partial year.
 *
 * Issue #450 (D-09): this signature and this function's own behavior are UNCHANGED — it is now a
 * one-line delegate to {@link statutoryMinimumVacationThresholdBySegments} with a single segment
 * spanning the whole employed range (`from: 1 January of year`), which is byte-identical to the
 * body this docblock describes (the D-02-style single-segment collapse in
 * {@link apportionAcrossContractSegments} guarantees it).
 *
 * @returns the statutory-minimum threshold at 2-decimal precision; `0` when not employed in `year`
 */
export function statutoryMinimumVacationThreshold(input: {
  birthDate: Date | null;
  year: number;
  workDaysPerWeek: number;
  hireDate: Date;
  exitDate: Date | null;
}): number {
  const { birthDate, year, workDaysPerWeek, hireDate, exitDate } = input;
  return statutoryMinimumVacationThresholdBySegments({
    birthDate,
    year,
    hireDate,
    exitDate,
    segments: [{ from: new Date(Date.UTC(year, 0, 1)), workDaysPerWeek }],
  });
}

/**
 * Issue #435 (D-10/D-11) — the ONE German error message naming the statutory-minimum violation:
 * the computed minimum (German number format, e.g. "20,83") and the applicable law — § 19
 * JArbSchG when `birthDate` is known and the employee is still a minor (age < 18) on 1 January of
 * `year`, else § 3 BUrlG. Deliberately NEVER includes the birth date itself (T-435-16,
 * Information Disclosure) — mirrors `jarbschg.ts`'s own documented invariant of never returning
 * the birth date to a caller.
 *
 * @param minimumDays - the computed statutory-minimum number to report (not re-derived here)
 * @param birthDate - the employee's birth date, or `null` (never reflected in the message itself)
 * @param year - the calendar year the minimum was computed for (used only for the age gate)
 */
export function statutoryMinimumViolationMessage(
  minimumDays: number,
  birthDate: Date | null,
  year: number,
): string {
  const isMinor = birthDate !== null && ageAtDate(birthDate, new Date(Date.UTC(year, 0, 1))) < 18;
  const law = isMinor ? "§ 19 JArbSchG" : "§ 3 BUrlG";
  const formatted = minimumDays.toLocaleString("de-DE", { maximumFractionDigits: 2 });
  return `Der Urlaubsanspruch unterschreitet den gesetzlichen Mindesturlaub von ${formatted} Tagen (${law}).`;
}

/**
 * The ONE regular-entitlement computation for a VACATION `LeaveEntitlement` row (Issue #445,
 * D-01). Moved verbatim from `facade/entitlements.ts`'s `ensureVacationEntitlementForYear`
 * (Issue #416): scale by contractual workdays FIRST ({@link calculatePartTimeVacation}, reference
 * week 5), THEN apply the hire-year Wartezeit/pro-rata decision ({@link hireYearVacationDays},
 * Issue #435) — unchanged for every year other than the employee's hire year.
 *
 * Issue #435 (D-09) adds the § 19 JArbSchG / § 3 BUrlG statutory-minimum floor HERE, via
 * {@link statutoryMinimumVacationDays}: `scaled = max(calculatePartTimeVacation(base),
 * statutoryMinimumVacationDays(birthDate, year, workDays))`, applied BEFORE the hire-year
 * Wartezeit/pro-rata decision ({@link hireYearVacationDays}) — the floor binds on the full-year
 * value, and the already-floored amount is what a late hire gets prorated from. The not-employed
 * guard (`baseDays` 0, `loadRegularVacationInputs`' signal for an exited or not-yet-hired year)
 * runs FIRST and short-circuits to `0` — the floor must never invent an entitlement for a year the
 * employee wasn't employed in.
 *
 * `birthDate` is REQUIRED (Issue #435 Plan 02 Task 2) — every in-src caller threads it through
 * (`leave-days.ts`'s `loadRegularVacationInputs`, `facade/entitlements.ts`'s
 * `ensureVacationEntitlementForYear`), so the compiler enumerates every writer that must apply
 * the floor. Pass `null` explicitly for an adult/unknown birth date (fails open to § 3 BUrlG).
 *
 * `exitDate` is REQUIRED (Issue #447, D-05) for the same reason — every writer must pass the
 * employee's real exit date so the compiler enumerates them. Its last step delegates to
 * {@link employmentYearVacationDays} instead of {@link hireYearVacationDays} directly: the exit
 * year and the hire year are now one span, computed together (§ 5 Abs. 1 b/c BUrlG); an
 * `exitDate` of `null` or a year after `year` reproduces every pre-#447 hire-year result
 * unchanged, because {@link employmentYearVacationDays} itself delegates to
 * {@link hireYearVacationDays} on that path.
 *
 * Issue #450 (D-02): this signature and this function's own behaviour are UNCHANGED — it is now a
 * one-line delegate to {@link computeRegularVacationDaysBySegments} with a single segment spanning
 * the whole employed range, which is byte-identical to the body this docblock describes.
 */
export function computeRegularVacationDays(input: {
  year: number;
  hireDate: Date;
  birthDate: Date | null;
  exitDate: Date | null;
  workDaysPerWeek: number;
  baseDays: number;
}): number {
  const { year, hireDate, birthDate, exitDate, workDaysPerWeek, baseDays } = input;
  return computeRegularVacationDaysBySegments({
    year,
    hireDate,
    birthDate,
    exitDate,
    baseDays,
    segments: [{ from: new Date(Date.UTC(year, 0, 1)), workDaysPerWeek }],
  });
}

/** One ISO week's leave-day contribution (Issue #429, D-01): the week's Monday (UTC
 * "YYYY-MM-DD"), the total `days` that week costs, and a per-calendar-date fractional
 * breakdown (`dayShares`) of that total — `Σ dayShares === days`. `leaveDaysPerWeek()` below is
 * the only producer of this type. */
export type LeaveWeek = {
  weekMonday: string;
  days: number;
  dayShares: Map<string, number>;
};

/**
 * Per-ISO-week leave-day count AND per-calendar-date fractional breakdown for a set of leave
 * rows (Issue #429, D-01) — the information the saldo side (Arbeitszeitkonto, plan 429-02) needs
 * to know WHICH date gets WHICH share of a week's leave days, something `countShiftBasedLeaveDays`
 * (a single running total) cannot answer.
 *
 * Computes over the UNION of all rows: a calendar date covered by two rows counts once. Uses the
 * SAME `weekLeaveDays` kernel `countShiftBasedLeaveDays()` uses — proven identical on a single
 * full-day row by this file's own property tests (`vacation-calc.test.ts`).
 *
 * `rows` — full-day and half-day leave rows (UTC-midnight `@db.Date` values), NOT yet clipped to
 * any month boundary — the caller applies month clipping to the returned `dayShares`, not to the
 * input (D-07, plan 429-02).
 * `holidays` — same UTC "YYYY-MM-DD" format as `countShiftBasedLeaveDays()`. The saldo side
 * passes an empty set (D-05) — SHIFT_BASED contract Soll is not holiday-reduced today.
 *
 * `usualWorkDays` (Phase 436, D-03) — the employee's stored "übliche Arbeitstage" Angabe
 * (0=So..6=Sa), or `[]` when none is recorded. Threaded verbatim into the shared `weekLeaveDays`
 * kernel: with an empty list every branch below is byte-identical to the pre-436 behaviour
 * (D-05 equivalence); with a non-empty list a FRAGMENT week's union of requested full-day dates
 * — and a half-day request's single date — only count when their UTC weekday is a member of the
 * list, Sunday included on equal footing with any other weekday. A WHOLE week's detection and
 * day-count are never filtered by this list (Pitfall 4 — see `weekLeaveDays()`'s own docblock).
 */
export function leaveDaysPerWeek(
  rows: Array<{ startDate: Date; endDate: Date; halfDay?: boolean }>,
  contractWorkDaysPerWeek: number,
  holidays: Set<string>,
  usualWorkDays: readonly number[] = [],
): LeaveWeek[] {
  if (rows.length === 0) return [];

  let minStart = utcMidnight(rows[0].startDate);
  let maxEnd = utcMidnight(rows[0].endDate);
  for (const row of rows) {
    const s = utcMidnight(row.startDate);
    const e = utcMidnight(row.endDate);
    if (s.getTime() < minStart.getTime()) minStart = s;
    if (e.getTime() > maxEnd.getTime()) maxEnd = e;
  }

  const result: LeaveWeek[] = [];

  let weekMonday = mondayOfWeekUtc(minStart);
  const lastMonday = mondayOfWeekUtc(maxEnd);
  while (weekMonday.getTime() <= lastMonday.getTime()) {
    const weekSunday = addUtcDays(weekMonday, 6);

    // Union of full-day dates this week across ALL full-day rows (halfDay falsy). Sunday is
    // included in the union only when `usualWorkDays` names it a usual day (Phase 436, D-03) —
    // with an empty list this stays the pre-436 unconditional Sunday exclusion (§ 3 Abs. 2
    // BUrlG). The WHOLE-week test below only ever looks at the six Mo-Sat dates, so this change
    // cannot affect whole-week detection either way.
    const fullDayUnion = new Set<string>();
    for (const row of rows) {
      if (row.halfDay) continue;
      const s = utcMidnight(row.startDate);
      const e = utcMidnight(row.endDate);
      const fragStart = weekMonday.getTime() > s.getTime() ? weekMonday : s;
      const fragEnd = weekSunday.getTime() < e.getTime() ? weekSunday : e;
      for (let d = fragStart; d.getTime() <= fragEnd.getTime(); d = addUtcDays(d, 1)) {
        if (d.getUTCDay() === 0 && !usualWorkDays.includes(0)) continue;
        fullDayUnion.add(toDateStrUtc(d));
      }
    }

    if (fullDayUnion.size === 0) {
      // No full-day leave touches this week — check for half-day-only contribution below before
      // moving on (a week can be half-day-only).
      const halfOnly = buildHalfShareForWeek(
        rows,
        weekMonday,
        weekSunday,
        fullDayUnion,
        usualWorkDays,
      );
      if (halfOnly.size > 0) {
        const days = Array.from(halfOnly.values()).reduce((a, b) => a + b, 0);
        const capped = Math.min(days, contractWorkDaysPerWeek);
        const scale = days > 0 ? capped / days : 0;
        const dayShares = new Map<string, number>();
        for (const [date, share] of halfOnly) dayShares.set(date, share * scale);
        if (capped > 0)
          result.push({ weekMonday: toDateStrUtc(weekMonday), days: capped, dayShares });
      }
      weekMonday = addUtcDays(weekMonday, 7);
      continue;
    }

    // Whole-ness generalises to the union: a week is WHOLE when all six Mo-Sat dates are members
    // of fullDayUnion (equivalent to countShiftBasedLeaveDays's single-row test when there is
    // exactly one row; correctly extends it to several adjoining rows covering a whole week).
    let isWhole = true;
    for (let i = 0; i < 6; i++) {
      if (!fullDayUnion.has(toDateStrUtc(addUtcDays(weekMonday, i)))) {
        isWhole = false;
        break;
      }
    }

    // Phase 436 (D-03, plan 03): the Angabe is threaded into the same kernel — with an empty
    // list weekLeaveDays()'s fragment branch behaves byte-identically to the pre-436 kernel.
    const { days: fullDayTotal, countedDates } = weekLeaveDays(
      Array.from(fullDayUnion),
      isWhole,
      contractWorkDaysPerWeek,
      holidays,
      usualWorkDays,
    );

    // Distribute the full-day total UNIFORMLY over the non-holiday counted dates — holiday dates
    // get share 0.
    const nonHolidayDates = countedDates.filter((d) => !holidays.has(d));
    const dayShares = new Map<string, number>();
    if (nonHolidayDates.length > 0) {
      const perDate = fullDayTotal / nonHolidayDates.length;
      for (const date of nonHolidayDates) dayShares.set(date, perDate);
    }

    // Half-day contribution: +0.5 per distinct date (a full-day row on the same date always
    // wins — OPEN-01, so buildHalfShareForWeek skips dates already in fullDayUnion).
    const halfShare = buildHalfShareForWeek(
      rows,
      weekMonday,
      weekSunday,
      fullDayUnion,
      usualWorkDays,
    );
    const halfTotal = Array.from(halfShare.values()).reduce((a, b) => a + b, 0);

    let days = fullDayTotal;
    if (halfTotal > 0) {
      const room = Math.max(0, contractWorkDaysPerWeek - fullDayTotal);
      const cappedHalfTotal = Math.min(halfTotal, room);
      const scale = cappedHalfTotal > 0 ? cappedHalfTotal / halfTotal : 0;
      for (const [date, share] of halfShare) {
        const scaled = share * scale;
        if (scaled > 0) dayShares.set(date, (dayShares.get(date) ?? 0) + scaled);
      }
      days = Math.min(fullDayTotal + halfTotal, contractWorkDaysPerWeek);
    }

    if (days > 0) {
      result.push({ weekMonday: toDateStrUtc(weekMonday), days, dayShares });
    }

    weekMonday = addUtcDays(weekMonday, 7);
  }

  return result;
}

/**
 * Issue #436, D-04 (owner Ergänzung 01.10.2026) — the MARGINAL leave-day cost of one request
 * against the ISO weeks already occupied by `others` (the employee's other counted VACATION
 * requests overlapping those weeks). Per-week union cost, using the SAME `leaveDaysPerWeek()`
 * kernel both branches of this function already share:
 *
 *   marginal = Σ days(union(others ∪ {request})) − Σ days(union(others))
 *
 * capped at 0 (a request can never SUBTRACT from what `others` already cost). With `others`
 * empty this collapses to `countShiftBasedLeaveDays(request, ...)` — byte-identical to the
 * pre-436 single-request price (D-05).
 *
 * Owner example (4-day contract, no Angabe, one ISO week): A = Mo-Mi, B = Do-Sa.
 *   marginal(A, []) = cost({A}) = 3
 *   marginal(B, [A]) = cost({A, B}) − cost({A}) = 4 − 3 = 1
 *   marginal(A, [B]) = cost({A, B}) − cost({B}) = 4 − 1 = 3  (NOT 1 — see the ordering rule in
 *   leave-days.ts: A is priced against requests created BEFORE it, so B never enters A's own
 *   marginal cost once A already exists).
 *
 * Weeks outside the request's own span cancel out algebraically: `others`' contribution to a
 * week the request never touches is identical in both the "with request" and "without request"
 * union, so the subtraction leaves only the weeks the request actually overlaps.
 */
export function marginalShiftBasedLeaveDays(
  request: { startDate: Date; endDate: Date; halfDay: boolean },
  others: Array<{ startDate: Date; endDate: Date; halfDay?: boolean }>,
  contractWorkDaysPerWeek: number,
  holidays: Set<string>,
  usualWorkDays: readonly number[],
): number {
  if (others.length === 0) {
    return countShiftBasedLeaveDays(
      request.startDate,
      request.endDate,
      request.halfDay,
      contractWorkDaysPerWeek,
      holidays,
      usualWorkDays,
    ).days;
  }

  const sumDays = (weeks: LeaveWeek[]): number => weeks.reduce((acc, w) => acc + w.days, 0);

  const withRequest = sumDays(
    leaveDaysPerWeek([...others, request], contractWorkDaysPerWeek, holidays, usualWorkDays),
  );
  const withoutRequest = sumDays(
    leaveDaysPerWeek(others, contractWorkDaysPerWeek, holidays, usualWorkDays),
  );

  return Math.max(0, withRequest - withoutRequest);
}

/**
 * Issue #429 (D-13, #293 "the receipt follows the account") — the per-REQUEST SHIFT_BASED
 * leave-minutes receipt for a single request in isolation: Σ `leaveDaysPerWeek()` days ×
 * (`weeklyHours` × 60 ÷ `contractWorkDaysPerWeek`). Consumed by `scheduledLeaveMinutes()`
 * (`./api/leave.ts`, Issue #468 renamed this function from its original name). The saldo side
 * (`working-time-account/shift-based-leave-credit.ts`)
 * applies the SAME per-week count and the SAME daily value per date; for a lone request with
 * no cap binding both are one number (pinned by `leave-overtime-comp-shift-based.test.ts`).
 *
 * Lives in Abwesenheiten (not Arbeitszeitkonto) so the receipt path needs no import of
 * `contexts/working-time-account/index.ts` for it — keeping `shift-based-leave-credit.ts` out
 * of the cross-context import cycle gated by `measure-context-boundary-imports --cycles`.
 * Empty holiday set, mirroring the saldo side's D-05 decision.
 *
 * `usualWorkDays` (Phase 436, D-03) — passed verbatim into the `leaveDaysPerWeek()` call below,
 * so the per-request receipt follows the same Angabe the saldo credit does.
 */
export function shiftBasedLeaveMinutesForRequest(
  schedule: { weeklyHours?: unknown },
  start: Date,
  end: Date,
  halfDay: boolean,
  contractWorkDaysPerWeek: number,
  usualWorkDays: readonly number[] = [],
): number {
  const weeklyHours = Number(schedule.weeklyHours ?? 0);
  if (weeklyHours <= 0 || contractWorkDaysPerWeek <= 0) return 0;
  const daily = (weeklyHours * 60) / contractWorkDaysPerWeek;
  const weeks = leaveDaysPerWeek(
    [{ startDate: start, endDate: end, halfDay }],
    contractWorkDaysPerWeek,
    new Set(),
    usualWorkDays,
  );
  const totalDays = weeks.reduce((sum, w) => sum + w.days, 0);
  return Math.round(totalDays * daily);
}

/** Half-day rows' contribution for a single week: +0.5 per distinct startDate that falls inside
 * [weekMonday, weekSunday] AND is not already a member of `fullDayUnion` (a full-day row on the
 * same date always wins — OPEN-01). Several half-day rows on the same date count once, because a
 * `Map.set()` on the same key is idempotent. */
function buildHalfShareForWeek(
  rows: Array<{ startDate: Date; endDate: Date; halfDay?: boolean }>,
  weekMonday: Date,
  weekSunday: Date,
  fullDayUnion: Set<string>,
  usualWorkDays: readonly number[] = [],
): Map<string, number> {
  const halfShare = new Map<string, number>();
  for (const row of rows) {
    if (!row.halfDay) continue;
    const s = utcMidnight(row.startDate);
    if (s.getTime() < weekMonday.getTime() || s.getTime() > weekSunday.getTime()) continue;
    if (!halfDayCounts(s.getUTCDay(), usualWorkDays)) continue; // Phase 436 (D-03, Task 2)
    const dateStr = toDateStrUtc(s);
    if (fullDayUnion.has(dateStr)) continue;
    halfShare.set(dateStr, 0.5);
  }
  return halfShare;
}
