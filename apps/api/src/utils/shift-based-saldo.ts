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
 *              − calcLeaveAbsenceMinutesTz (approved leave)
 *              − calcLeaveAbsenceMinutesTz (absences, INCL. VOCATIONAL_SCHOOL+PATTERN —
 *                v1.8.27 subtract-then-recredit: the BS day's Ø-Method day credit is
 *                subtracted here, then re-added as the precise §15 slot credit via
 *                bsExpectedMinutes, so each BS day is counted exactly once)
 *            then Math.max(0, ...). bsExpectedMinutes (VOCATIONAL_SCHOOL §15 slot credit)
 *            is added by the caller before passing.
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
 * Optional roster-proration (D-09, Phase 76.22-04) — LIVE / open-period path ONLY:
 *   For the current OPEN (not-yet-closed) month the days on which the contract Soll accrues
 *   come from the Schichtplan (roster), not from the static workDays[] whitelist (a floating
 *   "38h / 4 Tage" roster is not encodable in the whitelist). When `rosterProration` is
 *   supplied, the effective contract Soll used for the overtime clause is prorated by roster
 *   progress:
 *       C_toDate = R_periodFull == 0 ? 0 : round(C × R_toDate ÷ R_periodFull)
 *   - `rosterToDateMinutes`  = R_toDate    = Σ active shift netto for shift-days ≤ today.
 *   - `rosterPeriodMinutes`  = R_periodFull = Σ active shift netto for the WHOLE open month
 *                                             (incl. future-planned shifts).
 *   - Fallback `rosterPeriodMinutes == 0` → no daily Soll AND a zero open-month contribution
 *     (expected 0, overtime 0, undertime 0, balance 0): pure tracking until a roster exists,
 *     exactly like MONTHLY_HOURS. Worked-without-a-roster is NOT phantom overtime (the v1.8.15
 *     root bug) and an empty roster is NOT employee minus (§615).
 *   When `rosterProration` is ABSENT the effective contract Soll is the full `contractSollMinutes`
 *   — so the close / cron / recalc paths that never pass it stay byte-identical (parity-preserving).
 *   At month end R_toDate == R_periodFull → factor 1 → identical to the un-prorated result, so a
 *   fully-complete month is unchanged. The undertime clause always uses R_toDate (= rosterMinutes).
 *
 * @returns
 *   overtimeMinutes  — minutes worked beyond the (effective) contract (additive to saldo)
 *   undertimeMinutes — minutes the employee failed to work on offered shifts (subtractive)
 *   balanceDelta     — net saldo delta for the period (replaces `totalWorked − netExpected`)
 *   expectedMinutes  — = effective contract Soll (C_net, prorated when rosterProration present);
 *                       this is what gets stored in SaldoSnapshot.expectedMinutes — NOT R
 *                       (D-07: snapshots store C). For close/cron/recalc (no proration) this is
 *                       the full contractSollMinutes.
 *
 * Purity contract: no DB, no network, no date-range work, no side effects.
 * All inputs are pre-computed by the caller (four paths have incompatible DB access patterns;
 * only the formula is shared). See Phase 76.22 CONTEXT.md D-07 / D-09.
 */
export function calcShiftBasedSaldo(params: {
  contractSollMinutes: number; // C_net — already holiday/leave/absence credited + bsExpectedMinutes folded in by caller
  rosterMinutes: number; // R — Σ netto active shifts (deletedAt=null, covered days excluded)
  workedMinutes: number; // W — TimeEntry netto (isInvalid=false, type=WORK, deletedAt=null)
  // D-09 (live path only): prorate the contract Soll by roster progress for the open month.
  // Absent → effective Soll = contractSollMinutes (byte-identical to close/cron/recalc).
  rosterProration?: {
    rosterToDateMinutes: number; // R_toDate    — Σ active shift netto for shift-days ≤ today
    rosterPeriodMinutes: number; // R_periodFull — Σ active shift netto for the whole open month
  };
}): {
  overtimeMinutes: number; // max(0, W − C_eff)
  undertimeMinutes: number; // max(0, R − W)
  balanceDelta: number; // overtimeMinutes − undertimeMinutes  (replaces the per-path `totalWorked − netExpected`)
  expectedMinutes: number; // = effective contract Soll  (stored in SaldoSnapshot.expectedMinutes)
} {
  const { contractSollMinutes: C, rosterMinutes: R, workedMinutes: W, rosterProration } = params;

  // D-09 fallback: no roster planned for the open period (R_periodFull == 0) → no daily Soll.
  // The Soll is *distributed* by the roster; with no roster there is nothing due yet, so the
  // open-month contribution is a pure no-op (balance 0), exactly like MONTHLY_HOURS tracking.
  // Worked-without-a-roster must NOT read as phantom overtime (that was the v1.8.15 root bug),
  // and an empty roster must NOT read as employee minus (§615). Both clauses collapse to 0.
  if (rosterProration && rosterProration.rosterPeriodMinutes === 0) {
    return { overtimeMinutes: 0, undertimeMinutes: 0, balanceDelta: 0, expectedMinutes: 0 };
  }

  // Effective contract Soll: full C by default; roster-prorated for the live open month (D-09).
  const effectiveC = rosterProration
    ? Math.round((C * rosterProration.rosterToDateMinutes) / rosterProration.rosterPeriodMinutes)
    : C;

  const overtimeMinutes = Math.max(0, W - effectiveC);
  const undertimeMinutes = Math.max(0, R - W);
  const balanceDelta = overtimeMinutes - undertimeMinutes;
  return { overtimeMinutes, undertimeMinutes, balanceDelta, expectedMinutes: effectiveC };
}
