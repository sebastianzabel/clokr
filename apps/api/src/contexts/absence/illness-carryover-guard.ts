/**
 * illness-carryover-guard.ts — the ONE predicate that answers "does this LeaveEntitlement row
 * carry the extended, illness-related carry-over deadline that must NOT be overwritten?".
 *
 * Phase 104, D-19 / R9. § 9 BUrlG returns vacation days that were consumed while sick. If the
 * origin year's Übertragsfrist has already passed, plan 104-06 marks the following year's row
 * `carryOverReason = "ILLNESS"` and extends `carryOverDeadline` to 15 months after the end of the
 * accrual year (EuGH KHS C-214/10). Every code path that writes `carryOverDeadline` must consult
 * this predicate first, or it silently reinstates a lapse date the ECJ forbids.
 *
 * Deliberately a pure predicate over a partial row: it is called from a `update` path that has
 * already loaded the row AND from an `upsert` path where the row may not exist yet (null => false,
 * because a row that does not exist cannot carry an illness reason).
 */
export const ILLNESS_CARRY_OVER_REASON = "ILLNESS";

export function preserveIllnessDeadline(
  row: { carryOverReason: string | null } | null | undefined,
): boolean {
  return row?.carryOverReason === ILLNESS_CARRY_OVER_REASON;
}
