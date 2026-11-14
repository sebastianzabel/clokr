// Issue #854 (plan 854-20) - the pure model of the „Urlaub“ tab of the employee detail: the
// per-person vacation entitlement of one year (`PUT /settings/vacation/:employeeId`). It holds the
// form values of a stored entitlement, the checks that mirror the server's refusals, and the PUT
// body. The carry-over reason and note are sent change-only (`carryOverReasonPatch`, #445 D-16),
// so an unrelated save never removes a documented, legally protected carry-over deadline (T-451-26).

import { carryOverReasonHint, carryOverReasonPatch } from "$lib/leave/carry-over-reason";

/** The entitlement as `GET /settings/vacation/:employeeId?year=` answers it. */
export interface VacationEntitlement {
  year: number;
  totalDays: number | null;
  usedDays: number;
  carriedOverDays: number;
  carryOverDeadline: string | null;
  // Issue #451 / #445 addendum (D-09) - the documented carry-over reason and note.
  carryOverReason?: string | null;
  carryOverNote?: string | null;
  // Issue #435 (D-14) - the server's own regular-entitlement suggestion and statutory minimum.
  regularDays?: number;
  statutoryMinimumDays?: number;
  // Issue #940 - the Resturlaub facade's figures (#451), the same ones the Urlaubsübersicht shows;
  // null without a stored row. The client computes none of them.
  balance?: VacationTabBalance | null;
}

/** `balance` of `GET /settings/vacation/:employeeId` (Issue #940). */
export interface VacationTabBalance {
  availableDays: number;
  carriedOverEffectiveDays: number;
  /** Carry-over still counted after its deadline because no Hinweis was issued (EuGH C-684/16). */
  carryOverKeptWithoutNoticeDays: number;
  atRiskDays: number;
  /** Taken up to and including `splitAsOf`. */
  takenDays: number;
  /** Approved, after `splitAsOf` up to the year's end. */
  approvedUpcomingDays: number;
  pendingDays: number;
  remainingDays: number;
  /** `YYYY-MM-DD`, the tenant-local day the taken/approved split uses (yesterday). */
  splitAsOf: string;
}

/** What the section shows and compares against; a day is an ISO day or null, a blank note is "". */
export type VacationValues = {
  totalDays: number | null;
  carriedOverDays: number | null;
  carryOverDeadline: string | null;
  carryOverReason: string | null;
  carryOverNote: string;
};

export const VACATION_KEYS = [
  "totalDays",
  "carriedOverDays",
  "carryOverDeadline",
  "carryOverReason",
  "carryOverNote",
] as const satisfies readonly (keyof VacationValues)[];

export function vacationValuesOf(entitlement: VacationEntitlement | null): VacationValues {
  return {
    totalDays: entitlement?.totalDays ?? null,
    carriedOverDays: entitlement?.carriedOverDays ?? 0,
    carryOverDeadline: entitlement?.carryOverDeadline
      ? String(entitlement.carryOverDeadline).split("T")[0]
      : null,
    carryOverReason: entitlement?.carryOverReason ?? null,
    carryOverNote: entitlement?.carryOverNote ?? "",
  };
}

export type VacationErrors = Partial<Record<"totalDays" | "carriedOverDays" | "note", string>>;

/**
 * Client-side messages. The statutory-minimum refusal is the server's alone (it depends on the birth
 * date and the year) and is shown as a hint, not as an error here. The note message mirrors the
 * server's own requirement (OTHER needs a note; a non-illness reason needs a deadline).
 */
export function vacationErrors(values: VacationValues): VacationErrors {
  const errors: VacationErrors = {};
  const total = values.totalDays;
  if (total !== null && (!Number.isFinite(total) || total < 0 || total > 365)) {
    errors.totalDays = "Gib Urlaubstage zwischen 0 und 365 ein.";
  }
  const carried = values.carriedOverDays;
  if (carried === null || !Number.isFinite(carried) || carried < 0 || carried > 365) {
    errors.carriedOverDays = "Gib den Resturlaub zwischen 0 und 365 Tagen ein.";
  }
  const hint = reasonHint(values);
  if (hint?.includes("erforderlich.")) errors.note = hint;
  return errors;
}

/** The hint below the carry-over note (an error text when it ends in „erforderlich.“). */
export function reasonHint(values: VacationValues): string | null {
  return carryOverReasonHint(
    values.carryOverReason,
    values.carryOverNote,
    values.carryOverDeadline ?? "",
  );
}

/** The PUT body of the section. `suggestion` is the server's regular entitlement, used while the total is left empty. */
export function vacationBody(
  year: number,
  suggestion: number,
  values: VacationValues,
  loaded: { reason: string | null; note: string | null },
) {
  return {
    year,
    totalDays: values.totalDays ?? suggestion,
    carriedOverDays: values.carriedOverDays ?? 0,
    carryOverDeadline: values.carryOverDeadline || null,
    ...carryOverReasonPatch(loaded, {
      reason: values.carryOverReason,
      note: values.carryOverNote,
    }),
  };
}
