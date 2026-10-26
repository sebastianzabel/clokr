// Issue #753 — the ONE place "which months of a year does a yearly close expect" is spelled.
//
// The auto-close cron (`plugins/auto-close-month.ts`, Issue #668 / COMP-V1814-08) and the manual
// `POST /api/v1/overtime/close-year` (`api/overtime.ts`) both ask this function. A leaver is
// expected only through the exit month (tenant zone), so a person who left in June closes the year
// after six closed months instead of being stuck on twelve. Months are read in the TENANT time
// zone, never in the zone of the Node process (Issue #277).

import { dateStrInTz, monthRangeUtc } from "./timezone";
import { isPeriodStartInMonth } from "./snapshot-period";

export interface ExpectedCloseMonthsInput {
  year: number;
  tz: string;
  /**
   * When given, a hire inside `year` starts the span at the hire month (cron behaviour). The
   * manual route passes `null` and keeps expecting January onward: its mid-year-hire behaviour is
   * deliberately unchanged by #753.
   */
  hireDate: Date | null;
  exitDate: Date | null;
}

/**
 * Calendar months (1-12) a yearly snapshot of `year` requires closed MONTHLY snapshots for, in
 * order. Empty when the person left in an earlier year (no month in this year to close).
 */
export function expectedCloseMonthsOfYear(input: ExpectedCloseMonthsInput): number[] {
  const { year, tz, hireDate, exitDate } = input;
  const hireDay = hireDate ? dateStrInTz(hireDate, tz) : null; // YYYY-MM-DD
  const hireYear = hireDay ? Number(hireDay.slice(0, 4)) : null;
  const hireMonth = hireDay ? Number(hireDay.slice(5, 7)) : 1;
  if (hireYear !== null && hireYear > year) return []; // hired after the year: nothing to close
  const firstMonth = hireYear === year ? hireMonth : 1;

  const exitDay = exitDate ? dateStrInTz(exitDate, tz) : null;
  const exitYear = exitDay ? Number(exitDay.slice(0, 4)) : null;
  if (exitYear !== null && exitYear < year) return [];
  const lastMonth = exitDay && exitYear === year ? Number(exitDay.slice(5, 7)) : 12;

  const months: number[] = [];
  for (let m = firstMonth; m <= lastMonth; m++) months.push(m);
  return months;
}

/** True when the tenant-local exit day lies inside `year` (the leaver's year of exit). */
export function exitedInYear(exitDate: Date | null, year: number, tz: string): boolean {
  return exitDate !== null && Number(dateStrInTz(exitDate, tz).slice(0, 4)) === year;
}

/**
 * Why `expectedCloseMonthsOfYear` came back empty, so the caller can word the refusal by cause.
 * `null` when the span is not empty.
 */
export function emptyCloseYearCause(
  input: ExpectedCloseMonthsInput,
): "EXITED_EARLIER" | "HIRED_LATER" | null {
  if (expectedCloseMonthsOfYear(input).length > 0) return null;
  const exitDay = input.exitDate ? dateStrInTz(input.exitDate, input.tz) : null;
  if (exitDay !== null && Number(exitDay.slice(0, 4)) < input.year) return "EXITED_EARLIER";
  return "HIRED_LATER";
}

/**
 * Calendar day (UTC-midnight Date) on which the Stammsalon reach of a yearly close is judged
 * (same Stichtag idea as the report reach day of #679): the tenant-local exit day for a person who
 * left inside `year`, else the last day of the year (`yearEnd`, unchanged for everyone else).
 * Passed to `isStammsalonScopeMatch`, which always wants a calendar day.
 */
export function yearCloseReachDay(
  exitDate: Date | null,
  year: number,
  tz: string,
  yearEnd: Date,
): Date {
  if (exitDate !== null && exitedInYear(exitDate, year, tz)) {
    return new Date(`${dateStrInTz(exitDate, tz)}T00:00:00Z`);
  }
  return yearEnd;
}

interface SnapshotRowForYear {
  id: string;
  periodStart: Date;
  closedAt: Date;
}

/**
 * The ONE per-month assignment of MONTHLY snapshots for a yearly close (Issue #753, #595 rules):
 * each expected month gets exactly the first row of `monthlySnapshotOrder()` order (smallest
 * `periodStart`, then `closedAt`, then `id`) whose periodStart lies in that month's window - so a
 * duplicate legacy + TZ-converted pair counts once and cannot mask a month without a row. Rows
 * outside the expected months (after an exit, before a hire, a following January) are ignored.
 * `assigned` is in expected-month order and only complete when `missing` is empty.
 */
export function assignYearMonthSnapshots<T extends SnapshotRowForYear>(
  rows: T[],
  expectedMonths: number[],
  year: number,
  tz: string,
): { assigned: T[]; missing: number[] } {
  const ordered = [...rows].sort(
    (a, b) =>
      a.periodStart.getTime() - b.periodStart.getTime() ||
      a.closedAt.getTime() - b.closedAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const assigned: T[] = [];
  const missing: number[] = [];
  for (const month of expectedMonths) {
    const start = monthRangeUtc(year, month, tz).start;
    const row = ordered.find((r) => isPeriodStartInMonth(r.periodStart, start));
    if (row) assigned.push(row);
    else missing.push(month);
  }
  return { assigned, missing };
}

export interface YearCarryOverResult {
  appliedCarryOver: number;
  /** "RESET" / "CAPPED" only when the rule actually changed the figure's treatment. */
  ruleApplied: "NONE" | "RESET" | "CAPPED";
  /** True when the person left in the year: the exit month's carry-over stays untouched. */
  exitKept: boolean;
}

/**
 * The ONE carry-over decision of a yearly close (cron and route). Owner decision 26.10.2026
 * (#753): RESET / CAPPED do NOT apply to a year in which the person exited - the exit month's
 * actual carryOver stays (it is settled, never silently set to 0 or capped). Everyone else keeps
 * the tenant rule as before.
 */
export function resolveYearCarryOver(input: {
  finalCarryOver: number;
  mode: string;
  cap: number | null | undefined;
  leftInYear: boolean;
}): YearCarryOverResult {
  const { finalCarryOver, mode, cap, leftInYear } = input;
  if (leftInYear) return { appliedCarryOver: finalCarryOver, ruleApplied: "NONE", exitKept: true };
  if (mode === "RESET") return { appliedCarryOver: 0, ruleApplied: "RESET", exitKept: false };
  if (mode === "CAPPED" && cap != null && finalCarryOver > cap) {
    return { appliedCarryOver: cap, ruleApplied: "CAPPED", exitKept: false };
  }
  return { appliedCarryOver: finalCarryOver, ruleApplied: "NONE", exitKept: false };
}
