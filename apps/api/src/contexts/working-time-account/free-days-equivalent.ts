/**
 * Issue #605 — "Plusstunden als freie Tage": converts a positive saldo into the number of free days
 * it buys, so the Stundenkonto can say "etwa 1,5 freie Tage" next to the hours.
 *
 * This is a DISPLAY conversion of Arbeitszeitkonto, not a booking: the amount an Überstundenausgleich
 * request really withdraws is still priced per request by `scheduledLeaveMinutes` (Issue #468) and is
 * never read from here. To stay faithful to that pricing the daily Soll below is taken from the same
 * per-day leave credit functions of `timezone.ts` (`calcLeaveAbsenceMinutesTz`,
 * `calcMonthlyHoursDayMinutesTz`), never from a Soll derivation of its own.
 *
 * Daily Soll per schedule type ("average daily Soll of the valid contract"):
 *   - FIXED_SCHEDULE / FLEXTIME: the Ø-day of a reference week without holidays — the week's
 *     credit minutes divided by the number of days that carry a credit (FIXED: Σ {day}Hours; FLEXTIME:
 *     weeklyHours ÷ workdays, the Ø-Methode).
 *   - SHIFT_BASED: weeklyHours × 60 ÷ contractual workdays per week (`contractWorkDaysPerWeekFrom`,
 *     the same count the shift-based leave credit divides by). The roster weekdays are not consulted.
 *   - MONTHLY_HOURS: the Ø-day of the current tenant-local month (`calcMonthlyHoursDayMinutesTz`).
 *     A track-only contract (`isTrackOnlySchedule`, #494) has no saldo and gets no conversion.
 *   - Anything with no sensible daily Soll (0 minutes) gives `null`, i.e. no conversion is shown.
 *
 * Pure: no I/O. Deliberately not exported through `index.ts` (the route in this context is the caller).
 */
import { contractWorkDaysPerWeekFrom } from "../absence";
import { isTrackOnlySchedule } from "./track-only-schedule";
import { calcLeaveAbsenceMinutesTz, calcMonthlyHoursDayMinutesTz } from "./timezone";

export interface FreeDaysEquivalent {
  /** Saldo expressed in free days, one decimal place. Always > 0. */
  freeDays: number;
  /** The average daily Soll in minutes the conversion divided by. */
  dailySollMinutes: number;
}

// A Monday-to-Sunday week used only to average a FIXED/FLEXTIME contract; holidays are ignored.
const REFERENCE_WEEK_DAYS = [5, 6, 7, 8, 9, 10, 11].map((d) => new Date(Date.UTC(2026, 0, d, 12)));

/** Average daily Soll in whole minutes, or 0 when the contract has none. */
export function averageDailySollMinutes(
  schedule: Record<string, unknown>,
  opts: { tz: string; todayDay: string; defaultWorkDays?: readonly number[] | null },
): number {
  const type = String(schedule.type ?? "");

  if (type === "SHIFT_BASED") {
    const weeklyMinutes = Number(schedule.weeklyHours ?? 0) * 60;
    const days = contractWorkDaysPerWeekFrom(
      schedule as never,
      opts.defaultWorkDays as number[] | null | undefined,
    );
    return weeklyMinutes > 0 && days > 0 ? Math.round(weeklyMinutes / days) : 0;
  }

  if (type === "MONTHLY_HOURS") {
    // The Ø-day is the same on every contractual workday of a month; take the first one.
    const monthStart = opts.todayDay.slice(0, 8);
    for (let d = 1; d <= 7; d++) {
      const minutes = calcMonthlyHoursDayMinutesTz(
        schedule,
        `${monthStart}${String(d).padStart(2, "0")}`,
        opts.tz,
        opts.defaultWorkDays,
      );
      if (minutes > 0) return minutes;
    }
    return 0;
  }

  let total = 0;
  let creditedDays = 0;
  for (const day of REFERENCE_WEEK_DAYS) {
    const minutes = calcLeaveAbsenceMinutesTz(schedule, day, day, opts.tz, {
      defaultWorkDays: opts.defaultWorkDays,
    });
    if (minutes > 0) {
      total += minutes;
      creditedDays++;
    }
  }
  return creditedDays > 0 ? Math.round(total / creditedDays) : 0;
}

/**
 * The free-day equivalent of a saldo, or `null` when none applies: saldo ≤ 0, no contract, a
 * track-only contract, no daily Soll, or a saldo too small to reach 0.1 days.
 */
export function freeDaysEquivalent(input: {
  balanceMinutes: number;
  schedule: Record<string, unknown> | null;
  tz: string;
  todayDay: string;
  defaultWorkDays?: readonly number[] | null;
}): FreeDaysEquivalent | null {
  const { balanceMinutes, schedule } = input;
  if (!schedule || !(balanceMinutes > 0)) return null;
  if (schedule.overtimeMode === "TRACK_ONLY" || isTrackOnlySchedule(schedule as never)) return null;
  const dailySollMinutes = averageDailySollMinutes(schedule, input);
  if (dailySollMinutes <= 0) return null;
  const freeDays = Math.round((balanceMinutes / dailySollMinutes) * 10) / 10;
  return freeDays > 0 ? { freeDays, dailySollMinutes } : null;
}
