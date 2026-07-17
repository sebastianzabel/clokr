import { describe, it, expect } from "vitest";
import { calcShiftBasedSaldo } from "../shift-based-saldo";

// Unit tests for the D-01 two-clause reconciliation formula (CONTEXT.md Phase 76.22).
//
// Formula:
//   overtimeMinutes  = max(0, W − C)
//   undertimeMinutes = max(0, R − W)
//   balanceDelta     = overtimeMinutes − undertimeMinutes
//
// § 615 guarantee: caller pre-excludes soft-deleted (deletedAt != null) and covered-day
// shifts before passing R. This helper trusts the caller's R verbatim.
//
// All fixture values from RESEARCH.md § "Test fixtures (SALDO-V1816-04)".
// Employee config for all fixtures: weeklyHours=38, workDays=[1,2,3,4,5] (Mon–Fri, 5 days).
// Standard 4-week month: C = round(38 × 60 × 20 / 5) = 9120 min.

describe("calcShiftBasedSaldo — D-01 formula", () => {
  // ── Fixture A: Phantom-overtime fix (the +36h prod case) ─────────────────
  // 0 shifts assigned (R=0). Employee works 5 days × 7.6h = 2280 min.
  // Model A would give balance = +2280 (phantom overtime). Model B: 0.
  it("Fixture A: no shifts assigned, worked 2280 min → zero balance (phantom-overtime fix)", () => {
    const result = calcShiftBasedSaldo({
      contractSollMinutes: 9120, // C
      rosterMinutes: 0, // R
      workedMinutes: 2280, // W
    });
    expect(result.overtimeMinutes).toBe(0); // max(0, 2280 − 9120) = 0
    expect(result.undertimeMinutes).toBe(0); // max(0, 0 − 2280) = 0
    expect(result.balanceDelta).toBe(0);
    expect(result.expectedMinutes).toBe(9120); // snapshots store C, not R
  });

  // ── Fixture B: Worked beyond C — overtime ────────────────────────────────
  // 20 × 9h shifts assigned and worked. R = 20 × 495 = 9900 min. C = 9120 min.
  it("Fixture B: worked 9900 min against C=9120 → overtime 780 min", () => {
    const result = calcShiftBasedSaldo({
      contractSollMinutes: 9120, // C
      rosterMinutes: 9900, // R
      workedMinutes: 9900, // W
    });
    expect(result.overtimeMinutes).toBe(780); // max(0, 9900 − 9120) = 780
    expect(result.undertimeMinutes).toBe(0); // max(0, 9900 − 9900) = 0
    expect(result.balanceDelta).toBe(780);
    expect(result.expectedMinutes).toBe(9120);
  });

  // ── Fixture C: Rostered-but-not-worked — employee undertime ──────────────
  // 5 shifts assigned 8h each (R = 5 × 450 = 2250 min). Employee works only 3 (W = 1350 min).
  it("Fixture C: employee no-shows on 2 of 5 offered shifts → undertime 900 min", () => {
    const result = calcShiftBasedSaldo({
      contractSollMinutes: 9120, // C
      rosterMinutes: 2250, // R
      workedMinutes: 1350, // W
    });
    expect(result.overtimeMinutes).toBe(0); // max(0, 1350 − 9120) = 0
    expect(result.undertimeMinutes).toBe(900); // max(0, 2250 − 1350) = 900
    expect(result.balanceDelta).toBe(-900);
    expect(result.expectedMinutes).toBe(9120);
  });

  // ── Fixture D: § 615 — contracted-but-never-rostered, no employee minus ──
  // 0 shifts, 0 worked. Employer's scheduling gap is Betriebsrisiko (§ 615 BGB).
  // Must NOT produce balance = −9120 (Model A pathology).
  it("Fixture D: § 615 — zero shifts and zero work → balance 0 (NOT −9120)", () => {
    const result = calcShiftBasedSaldo({
      contractSollMinutes: 9120, // C
      rosterMinutes: 0, // R
      workedMinutes: 0, // W
    });
    expect(result.overtimeMinutes).toBe(0);
    expect(result.undertimeMinutes).toBe(0);
    expect(result.balanceDelta).toBe(0);
    expect(result.expectedMinutes).toBe(9120);
  });

  // ── Fixture E: Ausfallprinzip — leave credited into C ────────────────────
  // 5 leave days: C_net = max(0, 9120 − 2280) = 6840. R = 15 shifts × 450 = 6750.
  // Employee works all 15 shifts (W = 6750). § 615 not triggered (R < C_net by only 90 min).
  it("Fixture E: 5 leave days credited → C_net=6840, all shifts worked → balance 0", () => {
    const result = calcShiftBasedSaldo({
      contractSollMinutes: 6840, // C_net (leave already credited by caller)
      rosterMinutes: 6750, // R
      workedMinutes: 6750, // W
    });
    expect(result.overtimeMinutes).toBe(0); // max(0, 6750 − 6840) = 0
    expect(result.undertimeMinutes).toBe(0); // max(0, 6750 − 6750) = 0
    expect(result.balanceDelta).toBe(0);
    expect(result.expectedMinutes).toBe(6840); // stored C_net, not R
  });

  // ── Fixture F: Partial-month start (hire mid-period) ─────────────────────
  // Hired on the 11th of a 20-workday month → 10 remaining workdays.
  // C = round(38 × 60 × 10 / 5) = 4560. 10 shifts × 456 min netto = 4560 (R). W = 4560.
  it("Fixture F: partial month (10 workdays from hire) → C=4560, all worked → balance 0", () => {
    const result = calcShiftBasedSaldo({
      contractSollMinutes: 4560, // C (prorated by caller via effectiveStart)
      rosterMinutes: 4560, // R
      workedMinutes: 4560, // W
    });
    expect(result.overtimeMinutes).toBe(0);
    expect(result.undertimeMinutes).toBe(0);
    expect(result.balanceDelta).toBe(0);
    expect(result.expectedMinutes).toBe(4560);
  });

  // ── § 615 edge cases ─────────────────────────────────────────────────────

  // Employer assigns fewer hours than contract (R < C); employee works all rostered.
  // Employer gap must NOT become employee Minusstunden (BAG 5 AZR 676/11).
  it("§615 employer gap: C=480, R=420, W=420 → balance 0", () => {
    const result = calcShiftBasedSaldo({
      contractSollMinutes: 480, // C
      rosterMinutes: 420, // R < C
      workedMinutes: 420, // W = R (employee fulfilled all offered shifts)
    });
    expect(result.overtimeMinutes).toBe(0); // max(0, 420 − 480) = 0
    expect(result.undertimeMinutes).toBe(0); // max(0, 420 − 420) = 0
    expect(result.balanceDelta).toBe(0);
    expect(result.expectedMinutes).toBe(480);
  });

  // Employee works between R and C (i.e. R < W < C).
  // Employer gap still covered; no employee obligation beyond R.
  it("§615 worked between R and C: C=480, R=420, W=450 → balance 0", () => {
    const result = calcShiftBasedSaldo({
      contractSollMinutes: 480,
      rosterMinutes: 420,
      workedMinutes: 450, // W between R and C
    });
    expect(result.overtimeMinutes).toBe(0); // max(0, 450 − 480) = 0
    expect(result.undertimeMinutes).toBe(0); // max(0, 420 − 450) = 0
    expect(result.balanceDelta).toBe(0);
    expect(result.expectedMinutes).toBe(480);
  });

  // ── Overtime-only sanity ──────────────────────────────────────────────────
  // W > C: pure overtime beyond contract, no undertime.
  it("overtime-only: C=480, R=420, W=600 → overtime 120, balance +120", () => {
    const result = calcShiftBasedSaldo({
      contractSollMinutes: 480,
      rosterMinutes: 420,
      workedMinutes: 600,
    });
    expect(result.overtimeMinutes).toBe(120); // max(0, 600 − 480) = 120
    expect(result.undertimeMinutes).toBe(0); // max(0, 420 − 600) = 0
    expect(result.balanceDelta).toBe(120);
    expect(result.expectedMinutes).toBe(480);
  });

  // ── Undertime-only sanity ─────────────────────────────────────────────────
  // W < R < C: employee skipped offered shifts.
  it("undertime-only: C=480, R=420, W=300 → undertime 120, balance −120", () => {
    const result = calcShiftBasedSaldo({
      contractSollMinutes: 480,
      rosterMinutes: 420,
      workedMinutes: 300,
    });
    expect(result.overtimeMinutes).toBe(0); // max(0, 300 − 480) = 0
    expect(result.undertimeMinutes).toBe(120); // max(0, 420 − 300) = 120
    expect(result.balanceDelta).toBe(-120);
    expect(result.expectedMinutes).toBe(480);
  });

  // ── Cancelled-shift guard (D-02 / D-05 contract) ─────────────────────────
  // Fixture G: 5 shifts originally; 3 soft-deleted by employer.
  // Caller pre-excludes deletedAt shifts → R = 2 remaining shifts netto = 900 min.
  // W = 900 min (employee worked the 2 active shifts).
  // This test asserts the helper uses R verbatim (the caller's pre-exclusion is the contract).
  // Cancelled shifts do NOT produce employee Minusstunden.
  it("Fixture G: cancelled shifts excluded by caller → R=900, W=900, C=9120 → balance 0", () => {
    // Caller has already excluded the 3 soft-deleted shifts from R.
    const result = calcShiftBasedSaldo({
      contractSollMinutes: 9120, // C (full month)
      rosterMinutes: 900, // R: only the 2 non-deleted shifts (caller responsibility)
      workedMinutes: 900, // W: employee worked both active shifts
    });
    expect(result.overtimeMinutes).toBe(0); // max(0, 900 − 9120) = 0
    expect(result.undertimeMinutes).toBe(0); // max(0, 900 − 900) = 0
    expect(result.balanceDelta).toBe(0);
    expect(result.expectedMinutes).toBe(9120);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D-09 roster-proration (Phase 76.22-04) — LIVE / open-month path only.
//
//   C_toDate = R_periodFull == 0 ? 0 : round(C × R_toDate ÷ R_periodFull)
//   overtime = max(0, W − C_toDate),  undertime = max(0, R_toDate − W)
//
// When rosterProration is ABSENT the helper is byte-identical to the un-prorated formula
// (proven by all tests above still passing unchanged). These tests cover the option.
// ─────────────────────────────────────────────────────────────────────────────
describe("calcShiftBasedSaldo — D-09 roster-proration (open-month)", () => {
  // Full-roster proration: R_toDate == R_periodFull → factor 1 → identical to no option.
  // This is the month-end / complete-month case that keeps four-path parity green.
  it("full roster (R_toDate == R_periodFull) → factor 1 → same as un-prorated", () => {
    const params = {
      contractSollMinutes: 9120, // C
      rosterMinutes: 9900, // R (= R_toDate)
      workedMinutes: 9900, // W
    };
    const withoutOption = calcShiftBasedSaldo(params);
    const withFullRoster = calcShiftBasedSaldo({
      ...params,
      rosterProration: { rosterToDateMinutes: 9900, rosterPeriodMinutes: 9900 },
    });
    expect(withFullRoster.expectedMinutes).toBe(9120); // round(9120 × 9900/9900) = 9120
    expect(withFullRoster.overtimeMinutes).toBe(780); // max(0, 9900 − 9120) = 780
    expect(withFullRoster.undertimeMinutes).toBe(0);
    expect(withFullRoster.balanceDelta).toBe(780);
    // Byte-identical to the absent-option result.
    expect(withFullRoster).toEqual(withoutOption);
  });

  // Half-progress proration: today is mid-month, half the month's roster is in the past.
  // R_toDate = 4560, R_periodFull = 9120 → factor 0.5 → C_toDate = round(9120 × 0.5) = 4560.
  // Employee has worked the first-half roster (W = 4560) → balance 0 (on-track, no phantom +).
  it("half-progress (R_toDate/R_periodFull = 0.5) → C_toDate halved, worked matches → balance 0", () => {
    const result = calcShiftBasedSaldo({
      contractSollMinutes: 9120, // C_periodFull
      rosterMinutes: 4560, // R_toDate (undertime clause uses this)
      workedMinutes: 4560, // W — worked the first-half roster
      rosterProration: { rosterToDateMinutes: 4560, rosterPeriodMinutes: 9120 },
    });
    expect(result.expectedMinutes).toBe(4560); // round(9120 × 4560/9120) = 4560
    expect(result.overtimeMinutes).toBe(0); // max(0, 4560 − 4560) = 0 (no phantom overtime)
    expect(result.undertimeMinutes).toBe(0); // max(0, 4560 − 4560) = 0
    expect(result.balanceDelta).toBe(0);
  });

  // Front-loaded roster: today mid-month, ALL of the month's shifts are in the first half
  // (R_toDate == R_periodFull even though the calendar month is only half over).
  // C_toDate = full C. Worked all rostered → over/undertime both 0 (contract not yet due? no:
  // the whole roster is already delivered, so C_toDate = C and W = C_toDate handled by clause).
  it("front-loaded roster (all shifts in first half) → C_toDate == C (roster fully accrued)", () => {
    const result = calcShiftBasedSaldo({
      contractSollMinutes: 9120,
      rosterMinutes: 9120, // R_toDate — whole roster already in the past half
      workedMinutes: 9120, // W — worked all of it
      rosterProration: { rosterToDateMinutes: 9120, rosterPeriodMinutes: 9120 },
    });
    expect(result.expectedMinutes).toBe(9120); // factor 1 — full roster already accrued
    expect(result.overtimeMinutes).toBe(0);
    expect(result.undertimeMinutes).toBe(0);
    expect(result.balanceDelta).toBe(0);
  });

  // R_periodFull == 0 fallback: no roster planned for the open period → no daily Soll AND
  // a zero open-month contribution. The Soll is *distributed* by the roster; with no roster
  // nothing is due yet. Worked-without-a-roster must NOT read as phantom overtime (v1.8.15
  // root bug) and an empty roster must NOT read as employee minus (§615) → balance 0.
  it("R_periodFull == 0 fallback → expected 0, worked tracks to balance 0 (no phantom overtime)", () => {
    const result = calcShiftBasedSaldo({
      contractSollMinutes: 9120,
      rosterMinutes: 0, // R_toDate = 0 (no shifts)
      workedMinutes: 2280, // employee tracked time but no roster exists
      rosterProration: { rosterToDateMinutes: 0, rosterPeriodMinutes: 0 },
    });
    expect(result.expectedMinutes).toBe(0); // fallback: no daily Soll
    expect(result.overtimeMinutes).toBe(0); // pure tracking — NOT max(0, 2280 − 0)
    expect(result.undertimeMinutes).toBe(0);
    expect(result.balanceDelta).toBe(0); // balance 0 — worked tracks, no phantom +
  });

  // §615 under-rostered open month: employer under-schedules; employee works all rostered.
  // R_toDate = 3000, R_periodFull = 3000 (roster complete for the days that exist),
  // C_periodFull = 9120 → C_toDate = round(9120 × 3000/3000) = 9120. But W = 3000 (all rostered).
  // overtime = max(0, 3000 − 9120) = 0, undertime = max(0, 3000 − 3000) = 0 → balance 0 (§615).
  it("§615 under-rostered: prorated C ≥ R_toDate, worked all rostered → balance 0 (no employee minus)", () => {
    const result = calcShiftBasedSaldo({
      contractSollMinutes: 9120,
      rosterMinutes: 3000, // R_toDate
      workedMinutes: 3000, // W — worked every offered shift
      rosterProration: { rosterToDateMinutes: 3000, rosterPeriodMinutes: 3000 },
    });
    // C_toDate = 9120 (factor 1: all planned shifts are in the past). Prorated C ≥ R_toDate.
    expect(result.expectedMinutes).toBe(9120);
    expect(result.overtimeMinutes).toBe(0); // max(0, 3000 − 9120) = 0
    expect(result.undertimeMinutes).toBe(0); // max(0, 3000 − 3000) = 0
    expect(result.balanceDelta).toBe(0); // §615: employer under-roster gap is NOT employee minus
  });
});
