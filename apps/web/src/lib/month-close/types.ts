/**
 * Issue #854 (plan 854-26) - the wire shapes the Monatsabschluss page reads. Reads only: the page
 * and `MonthStatusTable` share them, nothing is written back in this shape. The day lists follow
 * Issue #86 (D-02): a reader without `time-entry:read` reach gets the lists emptied and
 * `dayDetailsWithheld: true`, the counts stay - always read them through `./day-lists`.
 */

export interface MissingEmployee {
  employeeName: string;
  employeeNumber: string;
  missingDates: string[];
  /** Issue #86 (D-02): the server's count; survives a withheld (emptied) `missingDates`. */
  missingDateCount?: number;
  dayDetailsWithheld?: boolean;
}

export type MonthStatusKind =
  "closed" | "partial" | "ready" | "open" | "blocked" | "future" | "no_data";

// Type aliases (not interfaces) so the rows satisfy the Record row type of the DataTable.
export type MonthStatus = {
  month: number;
  name: string;
  status: MonthStatusKind;
  closedCount: number;
  totalCount: number;
  missing?: MissingEmployee[];
};

export interface YearStatusResponse {
  year: number;
  months: MonthStatus[];
  autoCloseDeadline: number;
  earliestYear: number;
}

export type EmployeeStatus = {
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  status: "ready" | "missing" | "closed";
  /** Issue #613 (P-03): the tenant-local exit day (`YYYY-MM-DD`) of a person who leaves or left. */
  exitDate?: string | null;
  missingDates?: string[];
  /** Issue #86 (D-02): the server's counts and the flag (see the header). */
  missingDateCount?: number;
  unconfirmedBreakDayCount?: number;
  breakFindingDayCount?: number;
  karenzOverrunDayCount?: number;
  dayDetailsWithheld?: boolean;
  /** Phase 104 (D-21): § 5 EFZG - sick days without a certificate beyond the Karenzzeit. A hint,
   *  NOT a gate: closing stays possible. The server deliberately sends [] for closed months and
   *  flexible contracts. */
  karenzOverrunDays?: string[];
  /** Issue #80 (D-09b/D-15) + #511 (D-12): days with an open, unacknowledged § 4 ArbZG /
   *  § 11 JArbSchG break finding. Blocks the close only while the tenant's break-confirmation flag
   *  is on, but is shown regardless; display-only here. Empty for a closed month. */
  breakFindingDays?: string[];
};

export interface MonthDetailResponse {
  year: number;
  month: number;
  employees: EmployeeStatus[];
}

/** Phase 292 (issue #292) - GET /overtime/close-month/deferred. */
export interface DeferredEmployee {
  employeeId: string;
  employeeName: string;
  oldestOpenMonth: { year: number; month: number };
  monthsBehind: number;
  reason:
    | "GAPS"
    | "UNCONFIRMED_BREAKS"
    | "CROSS_SALON_BREAKS"
    | "BREAK_PLACEMENT"
    | "EXIT_DATE_MISSING"
    | "UNKNOWN";
  gapDates: string[];
  gapCount: number;
  /** Issue #86 (D-02): `gapDates` is emptied while `gapCount` stays. */
  dayDetailsWithheld?: boolean;
}

export interface DeferredState {
  employeeCount: number;
  oldestOpenMonth: { year: number; month: number } | null;
  monthsBehind: number;
  gapCount: number;
  severity: "NONE" | "INFO" | "WARNING" | "CRITICAL";
  employees: DeferredEmployee[];
}
