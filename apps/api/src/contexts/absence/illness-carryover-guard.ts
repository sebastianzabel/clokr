/**
 * illness-carryover-guard.ts — the ONE predicate that answers "does this LeaveEntitlement row
 * carry a documented carry-over deadline that must NOT be overwritten by an automatic
 * recompute?".
 *
 * Phase 104, D-19 / R9 introduced the predicate for ILLNESS only: § 9 BUrlG returns vacation days
 * that were consumed while sick, and if the origin year's Übertragsfrist has already passed,
 * plan 104-06 marks the following year's row `carryOverReason = "ILLNESS"` and extends
 * `carryOverDeadline` to 15 months after the end of the accrual year (EuGH KHS C-214/10).
 *
 * Issue #445 (D-16/D-17) generalises this to every documented reason an admin can set via
 * `PUT /api/v1/settings/vacation/:employeeId`:
 *   - `ILLNESS` — EuGH KHS C-214/10 (15 months after the end of the accrual year).
 *   - `MATERNITY` — § 24 S. 2 MuSchG (Mutterschutz).
 *   - `PARENTAL_LEAVE` — § 17 Abs. 2 BEEG (Elternzeit).
 *   - `OTHER` — any other documented reason; requires a non-empty `carryOverNote`.
 * The legacy stored value `OPERATIONAL` (pre-#445 rows) stays readable and is treated as
 * protected too — it is simply a reason this predicate no longer distinguishes from the others.
 * ONLY the deadline is protected: `carriedOverDays` is still recomputed on a protected row
 * (Phase 104 D-20 rationale — the expiry-warning mechanism still needs an accurate, up-to-date
 * remaining entitlement). Every code path that writes `carryOverDeadline` must consult this
 * predicate first, or it silently reinstates a lapse date the law/ECJ forbids.
 *
 * Deliberately a pure predicate over a partial row: it is called from an `update` path that has
 * already loaded the row AND from an `upsert` path where the row may not exist yet (null => false,
 * because a row that does not exist cannot carry a documented reason).
 */
export const ILLNESS_CARRY_OVER_REASON = "ILLNESS";

/** Issue #445 (D-16) — every reason `PUT /settings/vacation/:employeeId` accepts. */
export const CARRY_OVER_REASONS = ["ILLNESS", "MATERNITY", "PARENTAL_LEAVE", "OTHER"] as const;
export type CarryOverReason = (typeof CARRY_OVER_REASONS)[number];
/** Issue #445 (D-16) — the reason that requires a non-empty `carryOverNote`. */
export const OTHER_CARRY_OVER_REASON = "OTHER";

/**
 * Issue #445 (D-17) — replaces the previous, ILLNESS-only predicate of the same purpose: ANY
 * documented reason (including the legacy `OPERATIONAL` value) protects the deadline from an
 * automatic recompute. The old name no longer exists — there is only ever one predicate.
 */
export function preserveCarryOverDeadline(
  row: { carryOverReason: string | null } | null | undefined,
): boolean {
  return row?.carryOverReason != null;
}
