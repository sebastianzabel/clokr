/**
 * Model B + § 615 saldo reconciliation helper for SHIFT_BASED schedules.
 *
 * Formula (D-01, Phase 76.22 CONTEXT.md):
 *   overtimeMinutes  = max(0, W − C_net)   — worked beyond the contractual Soll
 *   undertimeMinutes = max(0, R − W)        — employee-fault shortfall (no-show on offered shift)
 *   balanceDelta     = overtimeMinutes − undertimeMinutes
 *
 * Parameters:
 *   C_net  = contractSollMinutes — contractual Soll net of leave/holiday/absence credits
 *            (Ausfallprinzip). Computed by the CALLER via:
 *              calcExpectedMinutesTz(schedule, effectiveStart, rangeEnd, tz)
 *              − calcLeaveAbsenceMinutesTz (approved leave, excl. VOCATIONAL_SCHOOL+PATTERN)
 *              − calcLeaveAbsenceMinutesTz (absences,      excl. VOCATIONAL_SCHOOL+PATTERN)
 *            then Math.max(0, ...). bsExpectedMinutes (VOCATIONAL_SCHOOL doubling per Phase 63)
 *            is also added by the caller before passing.
 *
 *   R      = rosterMinutes — Σ netto shift durations (deletedAt=null, coveredDates excluded).
 *            The caller MUST pre-exclude:
 *              (a) soft-deleted shifts (deletedAt != null) — employer-cancelled shifts
 *                  drop out of R automatically (D-05), so they do not produce employee minus.
 *              (b) shifts on leave/absence-covered days (coveredDates set, existing pattern).
 *            This helper trusts R verbatim.
 *
 *   W      = workedMinutes — TimeEntry netto (isInvalid=false, deletedAt=null, type=WORK).
 *
 * § 615 guarantee (BAG 5 AZR 676/11 / 681/09 — Annahmeverzug / Betriebsrisiko):
 *   When the employer under-rosters (R < C_net), the gap (C_net − R) is NEVER converted
 *   into employee Minusstunden. The max(0, R − W) undertime term structurally guarantees
 *   this: when the employee works all rostered shifts (W = R < C_net), undertimeMinutes = 0
 *   and balanceDelta = 0 (no minus, no plus). The employer's scheduling gap is Betriebsrisiko,
 *   not employee debt.
 *
 * Edge case R > C_net (over-scheduled beyond contract, employee works between C_net and R):
 *   W in [C_net, R] → overtimeMinutes = 0, undertimeMinutes = 0, balanceDelta = 0.
 *   Accepted as correct derived behavior (employer cannot create overtime obligation via
 *   over-scheduling without employee working beyond C_net; see BAG 5 AZR 767/13 for the
 *   veranlassung/tolerance requirement for overtime credit).
 *
 * @returns
 *   overtimeMinutes  — minutes worked beyond the contract (additive to saldo)
 *   undertimeMinutes — minutes the employee failed to work on offered shifts (subtractive)
 *   balanceDelta     — net saldo delta for the period (replaces `totalWorked − netExpected`)
 *   expectedMinutes  — = contractSollMinutes (C_net); this is what gets stored in
 *                       SaldoSnapshot.expectedMinutes — NOT R (D-07: snapshots store C)
 *
 * Purity contract: no DB, no network, no date-range work, no side effects.
 * All inputs are pre-computed by the caller (four paths have incompatible DB access patterns;
 * only the formula is shared). See Phase 76.22 CONTEXT.md D-07.
 */
export function calcShiftBasedSaldo(params: {
  contractSollMinutes: number; // C_net — already holiday/leave/absence credited + bsExpectedMinutes folded in by caller
  rosterMinutes: number; // R — Σ netto active shifts (deletedAt=null, covered days excluded)
  workedMinutes: number; // W — TimeEntry netto (isInvalid=false, type=WORK, deletedAt=null)
}): {
  overtimeMinutes: number; // max(0, W − C)
  undertimeMinutes: number; // max(0, R − W)
  balanceDelta: number; // overtimeMinutes − undertimeMinutes  (replaces the per-path `totalWorked − netExpected`)
  expectedMinutes: number; // = contractSollMinutes  (stored in SaldoSnapshot.expectedMinutes)
} {
  const { contractSollMinutes: C, rosterMinutes: R, workedMinutes: W } = params;
  const overtimeMinutes = Math.max(0, W - C);
  const undertimeMinutes = Math.max(0, R - W);
  const balanceDelta = overtimeMinutes - undertimeMinutes;
  return { overtimeMinutes, undertimeMinutes, balanceDelta, expectedMinutes: C };
}
