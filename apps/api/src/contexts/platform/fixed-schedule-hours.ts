/**
 * Issue #848 — the one place where a FIXED_SCHEDULE contract's `weeklyHours` and its seven
 * `{day}Hours` are kept consistent on WRITE.
 *
 * For `FIXED_SCHEDULE` the `{day}Hours` are authoritative (CLAUDE.md "Schedule Types"): the saldo
 * chain and the reports compute the Soll from them, while the month view reads `weeklyHours`. A row
 * whose two halves disagree therefore shows the same person two different Soll values. This module:
 *
 * - derives the day hours from `weeklyHours` + `workDays` where a write path has no day hours of
 *   its own (`POST /employees`, which never accepted them), and
 * - refuses a contract whose `weeklyHours` differs from Σ `{day}Hours` (German 400) on every write
 *   path that does carry both (PUT /settings/work/:employeeId, the bulk apply of the defaults).
 *
 * It is a write-path guard of the Unterbau, NOT a semantic change: no reader changes, and existing
 * divergent rows are never corrected (Phase 95b, D-01) — they are only listed, read-only, by
 * `scripts/audit-848-weekly-vs-day-hours.ts`. Other schedule types are untouched: their
 * `{day}Hours` are placeholders and `weeklyHours` means something else there.
 */
import type { PerDayHours } from "./calculate-work-days";

/** Derived day hours — plain numbers, assignable to the WorkSchedule columns. */
export type FixedDayHours = { [K in keyof PerDayHours]-?: number };

export const WEEKLY_HOURS_MISMATCH_CODE = "WEEKLY_HOURS_MISMATCH" as const;

/** Hours a FIXED_SCHEDULE workday gets when a create call names no weekly hours (the old default). */
export const DEFAULT_FIXED_DAY_HOURS = 8;

const DAY_KEYS: Record<number, keyof PerDayHours> = {
  0: "sundayHours",
  1: "mondayHours",
  2: "tuesdayHours",
  3: "wednesdayHours",
  4: "thursdayHours",
  5: "fridayHours",
  6: "saturdayHours",
};

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (v === null || v === undefined) return 0;
  if (typeof v === "string") return Number(v);
  const tn = (v as { toNumber?: () => number }).toNumber;
  if (typeof tn === "function") return tn.call(v);
  return Number(v);
}

/** Σ of the seven day hours in hundredths (the columns have scale 2). */
function dayHoursSumCents(hours: PerDayHours): number {
  return Object.values(DAY_KEYS).reduce(
    (sum, key) => sum + Math.round(toNumber(hours[key]) * 100),
    0,
  );
}

/**
 * Splits `weeklyHours` evenly over `workDays` in hundredths of an hour; the remainder of the split
 * goes to the LAST workday of the week, so Σ day hours equals `weeklyHours` exactly
 * (32 h over [2,3,4,5] → Di–Fr 8 h; 32 h over three days → 10.66 / 10.66 / 10.68).
 */
export function deriveFixedScheduleDayHours(
  weeklyHours: number,
  workDays: readonly number[],
): FixedDayHours {
  const hours: FixedDayHours = {
    mondayHours: 0,
    tuesdayHours: 0,
    wednesdayHours: 0,
    thursdayHours: 0,
    fridayHours: 0,
    saturdayHours: 0,
    sundayHours: 0,
  };
  // Monday-first order, so "last workday" means the last day of the working week (Sunday last).
  const days = [...new Set(workDays)]
    .filter((d) => d >= 0 && d <= 6)
    .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  if (days.length === 0) return hours;
  const totalCents = Math.round(weeklyHours * 100);
  const baseCents = Math.floor(totalCents / days.length);
  days.forEach((d, i) => {
    const cents = i === days.length - 1 ? totalCents - baseCents * (days.length - 1) : baseCents;
    hours[DAY_KEYS[d]] = cents / 100;
  });
  return hours;
}

/** Day hours of a FIXED_SCHEDULE create call: from the named weekly hours, else 8 h per workday. */
export function fixedScheduleCreateHours(
  weeklyHours: number | null | undefined,
  workDays: readonly number[],
): { weeklyHours: number; dayHours: FixedDayHours } {
  const weekly =
    weeklyHours && weeklyHours > 0 ? weeklyHours : DEFAULT_FIXED_DAY_HOURS * workDays.length;
  return { weeklyHours: weekly, dayHours: deriveFixedScheduleDayHours(weekly, workDays) };
}

function formatHours(cents: number): string {
  return (cents / 100).toLocaleString("de-DE", { maximumFractionDigits: 2 });
}

export function weeklyHoursMismatchMessage(weeklyCents: number, sumCents: number): string {
  return `Die Wochenstunden (${formatHours(weeklyCents)} h) stimmen nicht mit der Summe der Tagesstunden (${formatHours(sumCents)} h) überein. Bitte Wochenstunden oder Tagesstunden angleichen.`;
}

/**
 * The guard: for FIXED_SCHEDULE, `weeklyHours` must equal Σ `{day}Hours` (to the hundredth).
 * Returns the German refusal message, or null when the contract is consistent or not FIXED_SCHEDULE.
 * A null `weeklyHours` is compared as given — it never equals a positive day sum.
 */
export function fixedScheduleHoursMismatch(
  type: string,
  weeklyHours: unknown,
  hours: PerDayHours,
): string | null {
  if (type !== "FIXED_SCHEDULE") return null;
  const weeklyCents = Math.round(toNumber(weeklyHours) * 100);
  const sumCents = dayHoursSumCents(hours);
  if (weeklyCents === sumCents) return null;
  return weeklyHoursMismatchMessage(weeklyCents, sumCents);
}

/** Σ day hours as a number with scale 2 — used where a FIXED_SCHEDULE call omits `weeklyHours`. */
export function fixedScheduleDaySum(hours: PerDayHours): number {
  return dayHoursSumCents(hours) / 100;
}
