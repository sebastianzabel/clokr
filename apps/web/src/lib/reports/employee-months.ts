/**
 * Rows of the employee's "Monatsabschluesse" table (Issue #595, D-02/D-03).
 *
 * The month of every closed row comes from the server (`snapshotMonthOf`, the answer's `year` and
 * `month`) - never from a Date built from a `@db.Date` value or from a browser-local getter: a
 * TZ-converted snapshot (stored on the last day of the previous month) would be named one month
 * early. "Closed" means the server listed a MONTHLY snapshot for the month, i.e. the record the PDF
 * prints, so the status chip can never contradict the PDF. Open months (after the newest closed
 * month, up to the current month) carry a status only - their figures arrive with #612
 * (`GET /reports/period`); the PDF of an open month states them as a forecast.
 */

/** One row of `GET /overtime/snapshots/:employeeId` as far as this table reads it. */
export type SnapshotAnswerRow = {
  periodType: "MONTHLY" | "YEARLY";
  year: number | null;
  month: number | null;
  workedMinutes: number;
  expectedMinutes: number;
  balanceMinutes: number;
};

export type EmployeeMonthRow =
  | {
      year: number;
      month: number;
      label: string;
      status: "closed";
      workedMinutes: number;
      expectedMinutes: number;
      balanceMinutes: number;
    }
  | { year: number; month: number; label: string; status: "open" };

export const EMP_MONTH_NAMES = [
  "Januar",
  "Februar",
  "März",
  "April",
  "Mai",
  "Juni",
  "Juli",
  "August",
  "September",
  "Oktober",
  "November",
  "Dezember",
] as const;

/** "September 2026" from the calendar pair - no Date object involved. */
export function monthLabel(year: number, month: number): string {
  return `${EMP_MONTH_NAMES[month - 1]} ${year}`;
}

function isCalendarMonth(month: number | null): month is number {
  return month !== null && Number.isInteger(month) && month >= 1 && month <= 12;
}

/** Newest first: by year, then by month. */
function newestFirst(a: { year: number; month: number }, b: { year: number; month: number }) {
  if (a.year !== b.year) return b.year - a.year;
  return b.month - a.month;
}

/**
 * The table rows: closed rows from the server's MONTHLY answer, open rows for every month after
 * the newest closed month through `current` (only `current` when nothing is closed yet). Months
 * older than the newest closed month without a snapshot are not invented. Newest first, at most
 * `max` rows.
 */
export function buildEmployeeMonthRows(
  rows: SnapshotAnswerRow[],
  current: { year: number; month: number },
  max = 12,
): EmployeeMonthRow[] {
  const closed = new Map<string, EmployeeMonthRow>();
  for (const row of rows) {
    if (row.periodType !== "MONTHLY") continue;
    if (row.year === null || !Number.isInteger(row.year) || !isCalendarMonth(row.month)) continue;
    const key = `${row.year}-${row.month}`;
    if (closed.has(key)) continue;
    closed.set(key, {
      year: row.year,
      month: row.month,
      label: monthLabel(row.year, row.month),
      status: "closed",
      workedMinutes: row.workedMinutes,
      expectedMinutes: row.expectedMinutes,
      balanceMinutes: row.balanceMinutes,
    });
  }

  const result: EmployeeMonthRow[] = [...closed.values()].sort(newestFirst);
  const newestClosed = result.length > 0 ? result[0] : null;

  // Walk back from the current month to the month after the newest closed one; stop as soon as
  // `max` rows are certain to be enough, so a long-stale employee never builds a long list.
  let year = current.year;
  let month = current.month;
  let added = 0;
  while (added < max) {
    if (newestClosed !== null && newestFirst({ year, month }, newestClosed) >= 0) break;
    result.push({ year, month, label: monthLabel(year, month), status: "open" });
    added += 1;
    if (newestClosed === null) break;
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }

  return result.sort(newestFirst).slice(0, max);
}
