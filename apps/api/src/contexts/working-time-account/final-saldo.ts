import { dateStrInTz } from "./timezone";

/**
 * Issue #613 (AC-613-5): is the final saldo of an exited person still open, i.e. has the month of
 * the exit not been closed yet?
 *
 * Arbeitszeitkonto owns "is a month closed". The input is the latest closed MONTHLY snapshot of
 * the person that `getConfirmedCarryOverBulk()` already returns (its `periodEnd`), so deciding
 * costs no extra query. Both storage conventions of `SaldoSnapshot.periodEnd` (a `@db.Date`
 * column, read back as UTC midnight of the stored date) name the closed month through
 * `dateStrInTz(periodEnd, tz)`: a legacy row stores the last day of the month, a TZ-converted row
 * stores the date of the month's last instant — in a zone west of UTC that may be the 1st of the
 * following month, whose UTC midnight is still the last local day of the closed month.
 *
 * Closing is sequential (`POST /overtime/close-month` refuses a month while an earlier one is
 * open), so "the latest closed month is not before the exit month" equals "the exit month is
 * closed".
 *
 * @param exitDate              - `Employee.exitDate` (an instant, the last working day)
 * @param latestClosedPeriodEnd - `periodEnd` of the latest non-superseded MONTHLY snapshot; null = none
 * @param tz                    - the tenant time zone
 */
export function finalSaldoOpen(params: {
  exitDate: Date;
  latestClosedPeriodEnd: Date | null;
  tz: string;
}): boolean {
  if (params.latestClosedPeriodEnd === null) return true;
  const exitMonth = dateStrInTz(params.exitDate, params.tz).slice(0, 7);
  const closedMonth = dateStrInTz(params.latestClosedPeriodEnd, params.tz).slice(0, 7);
  return closedMonth < exitMonth;
}
