// Issue #753 — the ONE place "which months of a year does a yearly close expect" is spelled.
//
// The auto-close cron (`plugins/auto-close-month.ts`, Issue #668 / COMP-V1814-08) and the manual
// `POST /api/v1/overtime/close-year` (`api/overtime.ts`) both ask this function. A leaver is
// expected only through the exit month (tenant zone), so a person who left in June closes the year
// after six closed months instead of being stuck on twelve. Months are read in the TENANT time
// zone, never in the zone of the Node process (Issue #277).

import { dateStrInTz } from "./timezone";

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
  const firstMonth = hireYear === year ? hireMonth : 1;

  const exitDay = exitDate ? dateStrInTz(exitDate, tz) : null;
  const exitYear = exitDay ? Number(exitDay.slice(0, 4)) : null;
  if (exitYear !== null && exitYear < year) return [];
  const lastMonth = exitDay && exitYear === year ? Number(exitDay.slice(5, 7)) : 12;

  const months: number[] = [];
  for (let m = firstMonth; m <= lastMonth; m++) months.push(m);
  return months;
}
