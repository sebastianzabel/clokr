/**
 * Issue #836 (AC-12, D-836-12) — who may be NAMED in a limit warning, a 409 body or the load view.
 * Pure, no I/O.
 *
 * A reader sees the name of another person on leave only if they may already read that leave
 * (`leave-request:read:ZUGEWIESEN`): the whole tenant, a person in their person scope, a person whose
 * Stammsalon on that day lies in their salon scope, or themself. Everyone else is a number
 * (`hiddenCount`); nothing in a response says WHO is hidden or WHY (DSGVO Art. 5/32).
 */
import type { AccessReach } from "../../platform";

export type ReaderVisibility = {
  wholeTenant: boolean;
  salonIds: ReadonlySet<string>;
  employeeIds: ReadonlySet<string>;
  /** The reader's own employee record; an own-data-only reader sees exactly this person. */
  selfEmployeeId: string | null;
};

export function readerVisibilityFrom(
  reach: AccessReach,
  selfEmployeeId: string | null,
): ReaderVisibility {
  if (reach.kind === "wholeTenant") {
    return {
      wholeTenant: true,
      salonIds: new Set(),
      employeeIds: new Set(),
      selfEmployeeId,
    };
  }
  return {
    wholeTenant: false,
    salonIds: new Set(reach.salonIds),
    employeeIds: new Set(reach.employeeIds),
    selfEmployeeId,
  };
}

/** `homeSalonId` is the person's Stammsalon on the day in question (the salon the load is keyed by). */
export function isPersonVisibleOn(
  visibility: ReaderVisibility,
  personId: string,
  homeSalonId: string,
): boolean {
  return (
    visibility.wholeTenant ||
    visibility.employeeIds.has(personId) ||
    visibility.salonIds.has(homeSalonId) ||
    personId === visibility.selfEmployeeId
  );
}
