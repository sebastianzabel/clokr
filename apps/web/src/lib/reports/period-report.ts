/**
 * Issue #612 — the typed answer of `GET /reports/period` and its request path.
 *
 * The reports page renders this answer and never sums or recomputes it: every figure is minutes
 * (never decimal hours) taken from the working-time account by the API, and a value the caller
 * may not see arrives as `null` with `sollUnavailableReason` on the row.
 */

import type { TravelRowFields } from "$lib/time-entries/travel-entry-form";

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
  /**
   * Hours worked in the chosen salon in this month (minutes). Present ONLY under a salon filter
   * (#714); a separate figure that never meets Soll.
   */
  salonWorkedMinutes?: number;
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
   * The person's counts per leave-type code for the period: Kalendertage for SICK and SICK_CHILD,
   * Berufsschultage for VOCATIONAL_SCHOOL, Arbeitstage for the rest; never null, also under a salon
   * filter (#714). Issue #713: rendered as given, never summed by the page.
   */
  absence: Record<PeriodPersonAbsenceCode, number>;
  /**
   * Present only when Soll and saldo are withheld: no overtime:read over the person. Since #714 a
   * salon filter withholds nothing - it lists whole persons by Stammsalon at the period end.
   */
  sollUnavailableReason?: "NO_PERMISSION";
  /** Hours worked in the chosen salon across the row's months (minutes); present only under a salon filter (#714). */
  salonWorkedMinutes?: number;
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
  /** Hours worked in the chosen salon, helpers included (minutes); present only under a salon filter (#714). */
  salonWorkedMinutes?: number;
}

/** A person from another salon who worked in the chosen one: name and hours only (#714). */
export interface PeriodHelper {
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  salonWorkedMinutes: number;
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
  | "SICK"
  | "SICK_CHILD";

/**
 * The ten codes of `rows[].absence` in the canonical order - the order of the API's object and of
 * the absences CSV (713-02/03). Codes are control values; the labels live in `absence-table.ts`.
 */
export const PERIOD_PERSON_ABSENCE_CODES = [
  "SICK",
  "SICK_CHILD",
  "VACATION",
  "OVERTIME_COMP",
  "SPECIAL",
  "VOCATIONAL_SCHOOL",
  "EDUCATION",
  "UNPAID",
  "MATERNITY",
  "PARENTAL",
] as const;
export type PeriodPersonAbsenceCode = (typeof PERIOD_PERSON_ABSENCE_CODES)[number];

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
   * The keys below are present ONLY under a salon filter (owner decision #714): the rows are the
   * persons whose Stammsalon is the chosen salon at the period end, each with the whole personal
   * values; the hours worked in the salon are a separate figure that never meets Soll.
   */
  salonId?: string;
  personBasis?: "HOME_SALON_AT_PERIOD_END";
  /** Persons from other salons with hours in the chosen one - name and hours, no Soll or saldo. */
  helpers?: PeriodHelper[];
  /** Persons of the reader's reach without a Stammsalon in an active salon (counted, not listed). */
  withoutHomeSalonCount?: number;
  /** Whether the helper list covers the whole tenant or only the reader's reach. */
  helpersReach?: "WHOLE_TENANT" | "SCOPED";
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

/**
 * The request path of the CSV download of the "Zeiten & Konten" table (P-11): the same query as the
 * JSON answer, so the file shows what the page shows. The file is fetched with the session's token
 * (a plain link carries none) and saved under the name the response proposes.
 */
export function periodCsvPath(from: YearMonth, to: YearMonth, salonId: string | null): string {
  const base = `/reports/period/csv?from=${ymKey(from)}&to=${ymKey(to)}`;
  return salonId === null ? base : `${base}&salonId=${encodeURIComponent(salonId)}`;
}

/**
 * The request path of the CSV download of the table "Abwesenheiten je Person" (Issue #713, D-11):
 * the period query of `periodCsvPath` plus `table=absences`, then the salon when one is chosen.
 */
export function periodAbsencesCsvPath(
  from: YearMonth,
  to: YearMonth,
  salonId: string | null,
): string {
  const base = `/reports/period/csv?from=${ymKey(from)}&to=${ymKey(to)}&table=absences`;
  return salonId === null ? base : `${base}&salonId=${encodeURIComponent(salonId)}`;
}

/**
 * The fields of a `GET /time-entries` row the drill-down's day list shows. `workingMinutes` is a
 * rounded per-entry DISPLAY value (null for an open entry): it is never totalled (CLAUDE.md #79);
 * the month total is the series row of the period answer.
 */
export interface DayEntry extends TravelRowFields {
  id: string;
  /** Calendar day, `YYYY-MM-DD`. */
  date: string;
  startTime: string;
  endTime: string | null;
  breakMinutes: number;
  isInvalid?: boolean;
  invalidReason?: string | null;
  workingMinutes?: number | null;
}
