/**
 * shift-based-leave-credit.ts
 *
 * Issue #429 (D-06 through D-09, D-13) — SHIFT_BASED leave-Soll reduction "by contract,
 * roster decides which days". Replaces the SHIFT_BASED `approvedLeave` credit loop's
 * per-row `calcLeaveAbsenceMinutesTz()` call in `close-employee-month.ts` with a
 * per-ISO-week-and-per-date credit derived from Abwesenheiten's `leaveDaysPerWeek()`
 * (Issue #429, D-01/D-02, `contexts/absence`).
 *
 * PURITY CONTRACT: pure — no DB, no network, no `Date.now()`, no side effects. Matches
 * `close-employee-month.ts`'s own purity contract.
 *
 * D-05 — an EMPTY holiday set is passed to `leaveDaysPerWeek()` here, deliberately, on
 * this (saldo) side: SHIFT_BASED contract Soll (`avgWorkMinutesCore`) is not
 * holiday-reduced at all today (a holiday is not deducted, §615 nets the gap), so a
 * holiday that falls inside a leave range keeps being a Soll-free day via the leave
 * itself, exactly as before this module existed. Feeding holidays into the week count
 * here would also create a new live-vs-close divergence (the live path filters holidays
 * to an open window; the close path sees the full month) that does not exist today.
 *
 * `calcLeaveAbsenceMinutesTz()` itself is unchanged and is NOT called from here — it
 * stays the SHIFT_BASED absence loop's (and every non-SHIFT branch's) credit function.
 */

import { leaveDaysPerWeek } from "../absence";
import { calcExpectedMinutesTz, dateStrInTz } from "./timezone";

/**
 * Per-calendar-date SHIFT_BASED leave-Soll-reduction (minutes) for a set of approved-leave
 * rows, restricted to `[effectiveStart, monthEnd]` (Issue #429, D-06..D-09).
 *
 * `rows` are passed with their FULL, UNCLIPPED `startDate`/`endDate` (D-07) — clipping to
 * the effective range happens INSIDE this function (via the returned map's keys), not on
 * the input, so a leave week straddling a month boundary contributes its correct
 * proportional share to each month's call without ever being double-counted.
 *
 * Per ISO week (Mon..Sun): the week's leave-day count (`leaveDaysPerWeek`, D-01/D-02,
 * empty holiday set per D-05) times `daily = weeklyHours × 60 ÷ contractWorkDaysPerWeek`
 * (D-04) is distributed over the week's `dayShares`, restricted to the week's intersection
 * with `[effectiveStart, monthEnd]` (the "week-part"). The week-part's total is capped at
 * that part's OWN contract Soll (`calcExpectedMinutesTz`, D-08) — scaling every date's
 * share within the part by `min(1, cap / uncapped)` — so a week-part can never go negative
 * and a request fragmented across a month boundary can never double-charge either side.
 *
 * Returns an empty map when `weeklyHours <= 0` or `contractWorkDaysPerWeek <= 0` (mirrors
 * `avgWorkMinutesCore`'s own `weeklyHours <= 0` guard, timezone.ts).
 *
 * No rounding here — the caller rounds once, per leave ROW (D-09's "per-row Math.round as
 * before"), by summing this map's values for the dates that row is first to claim.
 */
export function shiftBasedLeaveCreditByDate(
  rows: Array<{ startDate: Date; endDate: Date; halfDay?: boolean }>,
  contractWorkDaysPerWeek: number,
  schedule: Record<string, unknown>,
  effectiveStart: Date,
  monthEnd: Date,
  tz: string,
): Map<string, number> {
  const result = new Map<string, number>();

  const weeklyHours = Number(schedule.weeklyHours ?? 0);
  if (weeklyHours <= 0 || contractWorkDaysPerWeek <= 0) return result;
  const daily = (weeklyHours * 60) / contractWorkDaysPerWeek;

  // D-05: empty holiday set — see module docblock.
  const weeks = leaveDaysPerWeek(rows, contractWorkDaysPerWeek, new Set());
  if (weeks.length === 0) return result;

  const effectiveStartStr = dateStrInTz(effectiveStart, tz);
  const monthEndStr = dateStrInTz(monthEnd, tz);

  for (const week of weeks) {
    // week.weekMonday is a UTC "YYYY-MM-DD" string (leaveDaysPerWeek, D-01). Reconstruct
    // the week's Sunday the same way effectiveStart/exitDate are TZ-normalized elsewhere
    // in this context (dateStrInTz(d, tz) → "YYYY-MM-DDT00:00:00Z") — see this plan's
    // string-format note: byte-identical for every @db.Date value under a positive-offset
    // tenant timezone (Europe/Berlin, the only one configured today).
    const weekMonday = new Date(week.weekMonday + "T00:00:00Z");
    const weekSunday = new Date(weekMonday.getTime() + 6 * 24 * 60 * 60 * 1000);
    const weekSundayStr = dateStrInTz(weekSunday, tz);

    // Week-part = ISO week (Mon..Sun) ∩ [effectiveStart, monthEnd] (D-07/D-08), via
    // date-string comparison (lexicographic "YYYY-MM-DD" order == chronological order).
    const partStartStr = week.weekMonday > effectiveStartStr ? week.weekMonday : effectiveStartStr;
    const partEndStr = weekSundayStr < monthEndStr ? weekSundayStr : monthEndStr;
    if (partStartStr > partEndStr) continue; // no overlap with [effectiveStart, monthEnd]

    let uncapped = 0;
    const inPart: Array<[string, number]> = [];
    for (const [dateStr, share] of week.dayShares) {
      if (dateStr < partStartStr || dateStr > partEndStr) continue;
      const minutes = share * daily;
      inPart.push([dateStr, minutes]);
      uncapped += minutes;
    }
    if (inPart.length === 0) continue;

    // D-08: cap the week-part's total at that part's OWN contract Soll.
    const partStart = new Date(partStartStr + "T00:00:00Z");
    const partEnd = new Date(partEndStr + "T00:00:00Z");
    const cap = calcExpectedMinutesTz(schedule, partStart, partEnd, tz);
    const scale = uncapped > cap ? (uncapped > 0 ? cap / uncapped : 0) : 1;

    for (const [dateStr, minutes] of inPart) {
      result.set(dateStr, (result.get(dateStr) ?? 0) + minutes * scale);
    }
  }

  return result;
}

/**
 * Issue #429 (D-13, #293 "the receipt follows the account") — the per-REQUEST SHIFT_BASED
 * leave-minutes receipt, for a single request in isolation. Used by plan 429-03's
 * `getScheduledHours()` SHIFT_BASED branch (`contexts/absence/api/leave.ts`) — NOT wired
 * to any caller by this plan.
 *
 * No capping, no cross-row union (unlike {@link shiftBasedLeaveCreditByDate}, which
 * dedups/caps across the saldo core's whole `approvedLeave` array) — a receipt answers
 * "what would THIS one request cost", not "what does the account currently owe".
 */
export function shiftBasedLeaveMinutesForRequest(
  schedule: Record<string, unknown>,
  start: Date,
  end: Date,
  halfDay: boolean,
  contractWorkDaysPerWeek: number,
): number {
  const weeklyHours = Number(schedule.weeklyHours ?? 0);
  if (weeklyHours <= 0 || contractWorkDaysPerWeek <= 0) return 0;
  const daily = (weeklyHours * 60) / contractWorkDaysPerWeek;

  // D-05: empty holiday set, same reasoning as shiftBasedLeaveCreditByDate above.
  const weeks = leaveDaysPerWeek(
    [{ startDate: start, endDate: end, halfDay }],
    contractWorkDaysPerWeek,
    new Set(),
  );
  const totalDays = weeks.reduce((sum, w) => sum + w.days, 0);
  return Math.round(totalDays * daily);
}
