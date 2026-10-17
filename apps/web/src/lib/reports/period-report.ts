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
  /** Whether the person has recorded working time since the hire day (#588's fact). */
  hasRecordedTime: boolean;
  /** Tenant-local exit day (`YYYY-MM-DD`) when the employment ended on or before the period's end. */
  exitDay: string | null;
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
  /**
   * Present only when Soll and saldo are withheld: no overtime:read over the person
   * (`NO_PERMISSION`, which wins) or a chosen salon (`SALON_FILTER`, contract figures are never
   * split by salon).
   */
  sollUnavailableReason?: "NO_PERMISSION" | "SALON_FILTER";
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
  /** Vacation year of the period's last month and the Stichtag its figures are read at. */
  vacationYear: number;
  vacationAsOf: string;
  /** Column sums of that year's Urlaub table (placeholder persons count 0). */
  vacationTakenDays: number;
  vacationApprovedDays: number;
  vacationEntitlementDays: number;
}

/**
 * One person's row of the Urlaub table of one calendar year, at the year's Stichtag. A person
 * without a VACATION entitlement is a placeholder: `missingEntitlement` true, every figure `null`.
 */
export interface PeriodVacationRow {
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  year: number;
  entitlementId: string | null;
  entitlementDays: number | null;
  carriedOverDays: number | null;
  carriedOverEffectiveDays: number | null;
  carriedOverExpiredDays: number | null;
  exitReductionDays: number | null;
  availableDays: number | null;
  takenDays: number | null;
  approvedUpcomingDays: number | null;
  pendingDays: number | null;
  remainingDays: number | null;
  atRiskDays: number | null;
  /** `YYYY-MM-DD` of the carry-over deadline, or `null`. */
  carryOverDeadline: string | null;
  /** ISO instant of the newest carry-over notice, or `null`. */
  lastWarningSentAt: string | null;
  missingEntitlement: boolean;
  entitlementWarning: string | null;
}

export interface PeriodVacationYear {
  year: number;
  /** Stichtag (`YYYY-MM-DD`): the year's last period day, never later than yesterday. */
  asOf: string;
  rows: PeriodVacationRow[];
}

/** Codes the absence statistics are keyed by; `SICK` counts calendar days, the rest Arbeitstage. */
export type PeriodAbsenceCode =
  | "VACATION"
  | "OVERTIME_COMP"
  | "SPECIAL"
  | "EDUCATION"
  | "UNPAID"
  | "MATERNITY"
  | "PARENTAL"
  | "SICK";

export interface PeriodAbsence {
  code: PeriodAbsenceCode;
  unit: "WORKDAYS" | "CALENDAR_DAYS";
  personCount: number;
  totalDays: number;
}

export interface PeriodReport {
  from: string;
  to: string;
  months: YearMonth[];
  kpis: PeriodKpis;
  rows: PeriodRow[];
  vacation: { year: number; asOf: string; years: PeriodVacationYear[] };
  absences: PeriodAbsence[];
  /**
   * The four envelope keys below are present ONLY under a salon filter (#542 rules): working time
   * counts the salon's entries, Soll/saldo and the priced leave counts are withheld.
   */
  salonId?: string;
  workedBasis?: "SALON_ENTRIES";
  sollUnavailableReason?: "SALON_FILTER";
  leaveDaysUnavailableReason?: "SALON_FILTER";
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
