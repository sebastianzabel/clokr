import { describe, it, expect } from "vitest";
import { fromZonedTime } from "date-fns-tz";
import { calcLeaveAbsenceMinutesTz } from "../timezone";

/**
 * Unit tests for calcLeaveAbsenceMinutesTz — BAG-konforme Ø-Methode for
 * leave/absence Soll-reduction (Phase 76.12).
 *
 * Naming convention: "A.S." initials only (no PII per memory
 * feedback_no_pii_in_github). The "A.S." schedule is the canonical
 * Anna-Repro fixture from CONTEXT.md D-24.
 *
 * Canonical week (Europe/Berlin):
 *   Mo 2026-06-01, Di 2026-06-02, Mi 2026-06-03, Do 2026-06-04,
 *   Fr 2026-06-05, Sa 2026-06-06, So 2026-06-07.
 *
 * Dates are constructed via `fromZonedTime` so the UTC instants map exactly
 * to start/end of the named Berlin calendar day (matches the way callers
 * construct ranges via tenant-tz-aware boundaries).
 */
describe("calcLeaveAbsenceMinutesTz", () => {
  const TZ = "Europe/Berlin";

  /** Start of `yyyy-mm-dd` in Europe/Berlin → UTC instant. */
  const tzStart = (ymd: string): Date => fromZonedTime(new Date(`${ymd}T00:00:00`), TZ);
  /** End of `yyyy-mm-dd` in Europe/Berlin (23:59:59.999) → UTC instant. */
  const tzEnd = (ymd: string): Date => fromZonedTime(new Date(`${ymd}T23:59:59.999`), TZ);

  // A.S. Repro: weeklyHours=38, Di-Fr je 9.5h, Mo/Sa/So 0h.
  // workDaysPerWeek = 4, expected Ø per Werktag = 38/4 = 9.5h = 570min.
  const asSchedule: Record<string, unknown> = {
    type: "SHIFT_BASED",
    weeklyHours: 38,
    monthlyHours: null,
    sundayHours: 0,
    mondayHours: 0,
    tuesdayHours: 9.5,
    wednesdayHours: 9.5,
    thursdayHours: 9.5,
    fridayHours: 9.5,
    saturdayHours: 0,
  };

  const asFlextimeSchedule: Record<string, unknown> = {
    ...asSchedule,
    type: "FLEXTIME",
  };

  // FIXED_SCHEDULE Mo-Fr je 8h.
  const fixedMoFr8h: Record<string, unknown> = {
    type: "FIXED_SCHEDULE",
    weeklyHours: 40,
    monthlyHours: null,
    sundayHours: 0,
    mondayHours: 8,
    tuesdayHours: 8,
    wednesdayHours: 8,
    thursdayHours: 8,
    fridayHours: 8,
    saturdayHours: 0,
  };

  // ── Anna-Repro variants (SHIFT_BASED) ─────────────────────────────────────

  it("SHIFT_BASED A.S.: 1 Tag Fr Urlaub (2026-06-05) → 570 min", () => {
    const result = calcLeaveAbsenceMinutesTz(
      asSchedule,
      tzStart("2026-06-05"),
      tzEnd("2026-06-05"),
      TZ,
    );
    expect(result).toBe(570);
  });

  it("SHIFT_BASED A.S.: 1 Tag Mo Urlaub (2026-06-01) → 0 min (Mo kein Arbeitstag)", () => {
    const result = calcLeaveAbsenceMinutesTz(
      asSchedule,
      tzStart("2026-06-01"),
      tzEnd("2026-06-01"),
      TZ,
    );
    expect(result).toBe(0);
  });

  it("SHIFT_BASED A.S.: 1 ganze Woche Mo-So → 4 workdays → 2280 min (38h)", () => {
    const result = calcLeaveAbsenceMinutesTz(
      asSchedule,
      tzStart("2026-06-01"),
      tzEnd("2026-06-07"),
      TZ,
    );
    expect(result).toBe(2280);
  });

  it("SHIFT_BASED A.S.: halfDay=true Fr → 285 min (round(570/2))", () => {
    const result = calcLeaveAbsenceMinutesTz(
      asSchedule,
      tzStart("2026-06-05"),
      tzEnd("2026-06-05"),
      TZ,
      { halfDay: true },
    );
    expect(result).toBe(285);
  });

  it("SHIFT_BASED A.S.: 2 volle Wochen Mo-So → 8 workdays → 4560 min (76h)", () => {
    const result = calcLeaveAbsenceMinutesTz(
      asSchedule,
      tzStart("2026-06-01"),
      tzEnd("2026-06-14"),
      TZ,
    );
    expect(result).toBe(4560);
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  it("SHIFT_BASED weeklyHours=0 → 0 min", () => {
    const schedule = { ...asSchedule, weeklyHours: 0 };
    const result = calcLeaveAbsenceMinutesTz(
      schedule,
      tzStart("2026-06-05"),
      tzEnd("2026-06-05"),
      TZ,
    );
    expect(result).toBe(0);
  });

  it("SHIFT_BASED Range nur Sa+So (0 workdays in range) → 0 min", () => {
    const result = calcLeaveAbsenceMinutesTz(
      asSchedule,
      tzStart("2026-06-06"), // Sa
      tzEnd("2026-06-07"), // So
      TZ,
    );
    expect(result).toBe(0);
  });

  it("SHIFT_BASED workDaysPerWeek === 0 (alle dayHours=0) → 0 min", () => {
    const schedule: Record<string, unknown> = {
      type: "SHIFT_BASED",
      weeklyHours: 38,
      monthlyHours: null,
      sundayHours: 0,
      mondayHours: 0,
      tuesdayHours: 0,
      wednesdayHours: 0,
      thursdayHours: 0,
      fridayHours: 0,
      saturdayHours: 0,
    };
    const result = calcLeaveAbsenceMinutesTz(
      schedule,
      tzStart("2026-06-01"),
      tzEnd("2026-06-07"),
      TZ,
    );
    expect(result).toBe(0);
  });

  // ── FLEXTIME parity with SHIFT_BASED ──────────────────────────────────────

  it("FLEXTIME identisch zu SHIFT_BASED: 1 Tag Fr Urlaub → 570 min", () => {
    const result = calcLeaveAbsenceMinutesTz(
      asFlextimeSchedule,
      tzStart("2026-06-05"),
      tzEnd("2026-06-05"),
      TZ,
    );
    expect(result).toBe(570);
  });

  // ── FIXED_SCHEDULE per-day sum ────────────────────────────────────────────

  it("FIXED_SCHEDULE Mo-Fr 8h, 1 Tag Mi Urlaub → 480 min (per-day sum)", () => {
    const result = calcLeaveAbsenceMinutesTz(
      fixedMoFr8h,
      tzStart("2026-06-03"), // Mi
      tzEnd("2026-06-03"),
      TZ,
    );
    expect(result).toBe(480);
  });

  it("FIXED_SCHEDULE halfDay=true Mi → 240 min", () => {
    const result = calcLeaveAbsenceMinutesTz(
      fixedMoFr8h,
      tzStart("2026-06-03"),
      tzEnd("2026-06-03"),
      TZ,
      { halfDay: true },
    );
    expect(result).toBe(240);
  });

  // ── MONTHLY_HOURS hart 0 (CLAUDE.md Schedule Types) ───────────────────────

  it("MONTHLY_HOURS mit monthlyHours=80, Range Mo-Fr → 0 min (hart 0)", () => {
    const schedule: Record<string, unknown> = {
      type: "MONTHLY_HOURS",
      weeklyHours: null,
      monthlyHours: 80,
      sundayHours: 0,
      mondayHours: 4,
      tuesdayHours: 4,
      wednesdayHours: 4,
      thursdayHours: 4,
      fridayHours: 4,
      saturdayHours: 0,
    };
    const result = calcLeaveAbsenceMinutesTz(
      schedule,
      tzStart("2026-06-01"),
      tzEnd("2026-06-05"),
      TZ,
    );
    expect(result).toBe(0);
  });

  it("MONTHLY_HOURS ohne monthlyHours (null) → 0 min (pure tracking mode)", () => {
    const schedule: Record<string, unknown> = {
      type: "MONTHLY_HOURS",
      weeklyHours: null,
      monthlyHours: null,
      sundayHours: 0,
      mondayHours: 0,
      tuesdayHours: 0,
      wednesdayHours: 0,
      thursdayHours: 0,
      fridayHours: 0,
      saturdayHours: 0,
    };
    const result = calcLeaveAbsenceMinutesTz(
      schedule,
      tzStart("2026-06-01"),
      tzEnd("2026-06-07"),
      TZ,
    );
    expect(result).toBe(0);
  });

  // ── opts handling ─────────────────────────────────────────────────────────

  it("opts omitted (undefined) → no halfDay reduction", () => {
    const result = calcLeaveAbsenceMinutesTz(
      asSchedule,
      tzStart("2026-06-05"),
      tzEnd("2026-06-05"),
      TZ,
    );
    expect(result).toBe(570);
  });

  it("halfDay rounding: Math.round, not floor — A.S. halbtag Di → 285 min", () => {
    // Di hat 9.5h = 570min. halfDay → round(570/2) = 285. Verifies the
    // round-direction contract from D-06.
    const result = calcLeaveAbsenceMinutesTz(
      asSchedule,
      tzStart("2026-06-02"), // Di
      tzEnd("2026-06-02"),
      TZ,
      { halfDay: true },
    );
    expect(result).toBe(285);
  });

  // ── D-15 dedup hook: excludeHolidays as a day-exclusion set (Phase 104-02) ──
  //
  // Pins that the mechanism close-employee-month.ts's day-based Soll dedup reuses
  // (Phase 104, D-15) already exists and needs NO signature change: excludeHolidays
  // already means "skip these YYYY-MM-DD dates" regardless of WHY a date is being
  // excluded (a public holiday, or — after 104-02 Task 2 — a day already claimed by
  // another overlapping APPROVED leave/absence row). Both branches (FIXED_SCHEDULE's
  // per-day sum and SHIFT_BASED's avgWorkMinutesCore) already honour the hook, so
  // these two units PASS immediately against unmodified code — they are the pin
  // that the mechanism this plan leans on is real, not the RED part of Task 1.

  it("D-15: excludeHolidays skips exactly the given date on a FIXED_SCHEDULE range", () => {
    const result = calcLeaveAbsenceMinutesTz(
      fixedMoFr8h,
      tzStart("2026-06-01"), // Mo
      tzEnd("2026-06-05"), // Fr
      TZ,
      { excludeHolidays: new Set(["2026-06-03"]) }, // Mi excluded
    );
    // 4 workdays × 480 (Mo, Di, Do, Fr) instead of the un-excluded 5 × 480 = 2400.
    expect(result).toBe(1920);
  });

  it("D-15: excludeHolidays skips exactly the given date on a SHIFT_BASED range (avgWorkMinutesCore)", () => {
    const result = calcLeaveAbsenceMinutesTz(
      asSchedule,
      tzStart("2026-06-01"), // Mo (A.S. non-workday, 0h either way)
      tzEnd("2026-06-05"), // Fr
      TZ,
      { excludeHolidays: new Set(["2026-06-03"]) }, // Mi excluded
    );
    // workDaysPerWeek = 4 (Di-Fr). workdaysInRange without exclusion = Di,Mi,Do,Fr = 4.
    // With Mi excluded = 3 → round(38h × 60 × 3 / 4) = round(2280 × 3 / 4) = 1710.
    expect(result).toBe(1710);
  });
});
