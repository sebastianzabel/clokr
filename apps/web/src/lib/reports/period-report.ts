/**
 * Issue #612 — the typed answer of `GET /reports/period` and its request path.
 *
 * The reports page renders this answer and never sums or recomputes it: every figure is minutes
 * (never decimal hours) taken from the working-time account by the API, and a value the caller
 * may not see arrives as `null` with `sollUnavailableReason` on the row.
 */

export interface YearMonth {
  year: number;
  month: number;
}

/** One month of one person's series — the account's own answer for that month. */
export interface PeriodMonth {
  year: number;
  month: number;
  workedMinutes: number;
  expectedMinutes: number | null;
  balanceMinutes: number | null;
  closingBalanceMinutes: number | null;
  confirmed: boolean;
  labelled: boolean;
  sickDays: number;
}

export interface PeriodRow {
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  workedMinutes: number;
  expectedMinutes: number | null;
  balanceMinutes: number | null;
  /** Gesamtsaldo at the end of the month before `from`; null when not belonging to it. */
  openingBalanceMinutes: number | null;
  /** Gesamtsaldo of the person's last listed month. */
  closingBalanceMinutes: number | null;
  /**
   * Split of the closing saldo for the drill-down: the confirmed part (a closed month's stored
   * carry-over) and the open forecast on top. All three are `null` where the split is not exact.
   */
  closingConfirmedMinutes: number | null;
  closingOpenMinutes: number | null;
  unconfirmedMonths: number | null;
  monthCount: number;
  confirmedMonthCount: number;
  labelled: boolean;
  sickDays: number;
  /** Present only when Soll and saldo are withheld (no overtime:read over the person). */
  sollUnavailableReason?: "NO_PERMISSION";
  months: PeriodMonth[];
}

export interface PeriodKpis {
  personCount: number;
  saldoPersonCount: number;
  workedMinutes: number;
  expectedMinutes: number | null;
  balanceMinutes: number | null;
  closingBalanceMinutes: number | null;
  /** Calendar day the closing figure runs through (`YYYY-MM-DD`). */
  closingAsOf: string;
  closingConfirmed: boolean;
  allMonthsConfirmed: boolean;
  sickDays: number;
}

export interface PeriodReport {
  from: string;
  to: string;
  months: YearMonth[];
  kpis: PeriodKpis;
  rows: PeriodRow[];
}

/** `YYYY-MM` of a year-month, the form the API and the URL use. */
export function ymKey(ym: YearMonth): string {
  return `${ym.year}-${String(ym.month).padStart(2, "0")}`;
}

/** The request path of the period answer; the salon is appended only when one is chosen. */
export function periodReportPath(from: YearMonth, to: YearMonth, salonId: string | null): string {
  const base = `/reports/period?from=${ymKey(from)}&to=${ymKey(to)}`;
  return salonId === null ? base : `${base}&salonId=${encodeURIComponent(salonId)}`;
}
