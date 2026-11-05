/**
 * Deactivation of an employee with a last working day — preview and confirm client (Issue #615, D-13).
 *
 * The server decides every date and every figure: the default day, the upper bound (`today`), the
 * refusal, the saldo, the Resturlaub of the exit year and the absences the exit rule ends. The
 * browser only chooses a day inside `max = today` and renders what came back.
 */
import { api } from "$api/client";

export type PreviewAction = "CANCEL" | "SHORTEN" | "DELETE" | "SKIP";

export interface PreviewAbsence {
  entity: "LeaveRequest" | "Absence";
  id: string;
  action: PreviewAction;
  /** Control code (AFTER_EXIT, SPANS_EXIT, NO_DAY_LEFT, or the skip reason), never display text. */
  reason: string;
  /** Leave type code of a request or the type of an imposed absence. */
  typeCode: string;
  status: string | null;
  startDate: string;
  endDate: string;
  newEndDate: string | null;
  days: number;
  newDays: number | null;
}

export type SaldoUnavailableReason = "NO_PERMISSION" | "NOT_TRACKED" | "UNAVAILABLE";
export type VacationUnavailableReason = "NO_PERMISSION" | "NO_ENTITLEMENT" | "EXIT_DATE_REFUSED";

export interface PreviewRefusal {
  status: number;
  code: string;
  error: string;
}

export interface PreviewSaldo {
  /** Signed minutes. */
  balanceMinutes: number;
  /** Tenant-local yesterday, the day the figure is valid for. */
  asOf: string;
}

export interface PreviewVacation {
  year: number;
  entitlementDays: number;
  storedEntitlementDays: number;
  entitlementRecomputed: boolean;
  carriedOverEffectiveDays: number;
  availableDays: number;
  takenDays: number;
  remainingAtExitDays: number;
  asOf: string;
}

export interface DeactivatePreview {
  exitDate: string;
  /** The tenant-local today of the server; upper bound of the date field. */
  today: string;
  storedExitDate: string | null;
  refusal: PreviewRefusal | null;
  absences: PreviewAbsence[] | null;
  saldo: PreviewSaldo | null;
  saldoUnavailableReason: SaldoUnavailableReason | null;
  vacation: PreviewVacation | null;
  vacationUnavailableReason: VacationUnavailableReason | null;
}

/** Read-only: asking writes nothing. Without a day the server answers for its own today. */
export function loadDeactivatePreview(
  employeeId: string,
  exitDate?: string,
): Promise<DeactivatePreview> {
  return api.post<DeactivatePreview>(
    `/employees/${employeeId}/deactivate/preview`,
    exitDate ? { exitDate } : {},
  );
}

/** Deactivates with the chosen last working day; a rejection is the server's own message. */
export function deactivateEmployee(employeeId: string, exitDate: string): Promise<unknown> {
  return api.patch(`/employees/${employeeId}/deactivate`, { exitDate });
}
