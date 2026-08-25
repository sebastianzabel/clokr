// Regression tests for soll-ignores-workdays-on-legacy-schedules (debug session
// .planning/debug/resolved/soll-ignores-workdays-on-legacy-schedules.md).
//
// Pure helper unit tests for `avgWorkMinutesCore` (via its two public entry points
// `calcExpectedMinutesTz` / `calcLeaveAbsenceMinutesTz`) in ../utils/timezone.ts.
// No DB, no Prisma — same convention as break-effective.test.ts.
//
// Background: avgWorkMinutesCore used to derive its Ø-Methode divisor exclusively
// from `count({day}Hours > 0)`, ignoring `WorkSchedule.workDays` entirely. For
// pre-Phase-61 legacy rows where `{day}Hours` still carries a stale bulk-migration
// placeholder (e.g. 1.00 across every Mon-Fri column) while `workDays` was
// hand-corrected to the real contractual pattern, this silently spread the weekly
// Soll across days the employee never works and under-credited leave taken on the
// real workdays (prod-confirmed: emp 3229a3ff, 30h/week, workDays=[2,3,4], showed
// "Soll 12h" phantom residual on Mon+Fri for a week where she was on approved
// Urlaub for all 3 of her real workdays). The fix makes `workDays` authoritative
// when non-empty, falling back to `{day}Hours>0` unchanged when it is empty —
// aligning with the precedence `vacation-calc.ts:countWorkDaysPerWeek()` already uses.

import { describe, it, expect } from "vitest";
import { calcExpectedMinutesTz, calcLeaveAbsenceMinutesTz } from "../utils/timezone";

const TZ = "Europe/Berlin";

function d(iso: string): Date {
  return new Date(iso + "T12:00:00Z"); // noon UTC — safely inside the correct
  // Europe/Berlin calendar day regardless of CET/CEST, avoiding the month/day
  // -boundary rollover pitfall documented in the debug session's audit evidence.
}

describe("avgWorkMinutesCore — workDays-primary divisor (soll-ignores-workdays-on-legacy-schedules)", () => {
  // ── (a) The exact reported prod scenario ──────────────────────────────────
  // emp 3229a3ff: SHIFT_BASED, 30h/week, workDays=[2,3,4] (Tue/Wed/Thu), but
  // legacy {day}Hours still carries the stale Mon-Fri=1.00 placeholder that does
  // not even sum to weeklyHours. Week 2026-08-10..16 (Mon-Sun), approved Urlaub
  // on her 3 real workdays (Aug 11-13, Tue-Thu).
  const legacyDivergentSchedule = {
    type: "SHIFT_BASED",
    weeklyHours: 30,
    workDays: [2, 3, 4], // Tue, Wed, Thu — hand-corrected, real contract
    sundayHours: 0,
    mondayHours: 1, // stale bulk-migration placeholder — does not reflect reality
    tuesdayHours: 1,
    wednesdayHours: 1,
    thursdayHours: 1,
    fridayHours: 1,
    saturdayHours: 0,
  };

  it("a) full week Soll is unaffected by the divisor source (30h either way)", () => {
    const weekSoll = calcExpectedMinutesTz(
      legacyDivergentSchedule,
      d("2026-08-10"),
      d("2026-08-16"),
      TZ,
    );
    expect(weekSoll).toBe(1800); // 30h × 60
  });

  it("a) leave credit for the 3 real workdays is now the FULL 30h (10h/day), not 18h (6h/day)", () => {
    const leaveCredit = calcLeaveAbsenceMinutesTz(
      legacyDivergentSchedule,
      d("2026-08-11"),
      d("2026-08-13"),
      TZ,
      { halfDay: false },
    );
    // Before the fix: 30h × 60 × 3(workdaysInRange, dayHours>0) / 5(workDaysPerWeek) = 1080min (18h).
    // After the fix:  30h × 60 × 3(workdaysInRange, workDays)   / 3(workDaysPerWeek) = 1800min (30h).
    expect(leaveCredit).toBe(1800);
  });

  it("a) residual weekly Soll after the 3-day Urlaub is 0h, not the prod-reported 12h phantom Soll", () => {
    const weekSoll = calcExpectedMinutesTz(
      legacyDivergentSchedule,
      d("2026-08-10"),
      d("2026-08-16"),
      TZ,
    );
    const leaveCredit = calcLeaveAbsenceMinutesTz(
      legacyDivergentSchedule,
      d("2026-08-11"),
      d("2026-08-13"),
      TZ,
      { halfDay: false },
    );
    const residual = weekSoll - leaveCredit;
    expect(residual).toBe(0); // was 720min (12h) before the fix — the exact reported symptom
  });

  // ── (b) Empty workDays → unchanged {day}Hours fallback ────────────────────
  it("b) empty workDays[] falls back to {day}Hours>0 unchanged (e.g. legacy rows that never set it)", () => {
    const scheduleNoWorkDays = {
      type: "SHIFT_BASED",
      weeklyHours: 30,
      workDays: [], // explicitly empty — must fall back, not treat as "zero workdays"
      sundayHours: 0,
      mondayHours: 1,
      tuesdayHours: 1,
      wednesdayHours: 1,
      thursdayHours: 1,
      fridayHours: 1,
      saturdayHours: 0,
    };
    // Same math as the pre-fix behaviour: 5 {day}Hours>0 days, Mon-Sun range has
    // exactly those 5 days present → 30h × 60 × 5 / 5 = 1800min, unaffected.
    const weekSoll = calcExpectedMinutesTz(
      scheduleNoWorkDays,
      d("2026-08-10"),
      d("2026-08-16"),
      TZ,
    );
    expect(weekSoll).toBe(1800);

    // And the leave credit for the SAME 3-day Tue-Thu range reproduces the OLD
    // (buggy-looking but here CORRECT, since there's no workDays override to trust)
    // 6h/day valuation — proving the fallback path is byte-identical to before.
    const leaveCredit = calcLeaveAbsenceMinutesTz(
      scheduleNoWorkDays,
      d("2026-08-11"),
      d("2026-08-13"),
      TZ,
      { halfDay: false },
    );
    expect(leaveCredit).toBe(1080); // 18h — unchanged fallback behaviour
  });

  it("b) schedule with no workDays key at all (undefined) also falls back to {day}Hours>0", () => {
    const scheduleUndefinedWorkDays = {
      type: "SHIFT_BASED",
      weeklyHours: 40,
      // workDays intentionally omitted (undefined) — e.g. the synthetic
      // tenant-default FIXED_SCHEDULE object getEffectiveSchedule() returns
      // when no explicit WorkSchedule row exists.
      sundayHours: 0,
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
    };
    const weekSoll = calcExpectedMinutesTz(
      scheduleUndefinedWorkDays,
      d("2026-08-10"),
      d("2026-08-16"),
      TZ,
    );
    expect(weekSoll).toBe(2400); // 40h × 60 × 5/5 — pure {day}Hours>0 fallback
  });

  // ── (c) Well-behaved row (workDays and {day}Hours agree) → no behaviour change ──
  it("c) well-behaved schedule (workDays matches {day}Hours>0 exactly) is a provable no-op", () => {
    const wellBehaved = {
      type: "SHIFT_BASED",
      weeklyHours: 40,
      workDays: [1, 2, 3, 4, 5], // Mon-Fri — matches the {day}Hours below exactly
      sundayHours: 0,
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
    };
    // Same fixture/expected value as shifts-under-coverage.test.ts Test A
    // (40h Mon-Fri SHIFT_BASED over a full Mon-Sun week → 2400min).
    const weekSoll = calcExpectedMinutesTz(wellBehaved, d("2026-08-10"), d("2026-08-16"), TZ);
    expect(weekSoll).toBe(2400);

    // A 3-day Tue-Thu leave credit is identical whether the divisor set comes
    // from workDays or from {day}Hours>0, because for this row they are the
    // same set — proves no behaviour change for tenants who were never affected.
    const leaveCredit = calcLeaveAbsenceMinutesTz(
      wellBehaved,
      d("2026-08-11"),
      d("2026-08-13"),
      TZ,
      {
        halfDay: false,
      },
    );
    expect(leaveCredit).toBe(1440); // 8h/day × 3 days = 24h = 1440min
  });

  it("c) partial-week FLEXTIME schedule with workDays matching {day}Hours>0 is also a no-op", () => {
    // FLEXTIME shares avgWorkMinutesCore with SHIFT_BASED — a second, independent
    // well-behaved fixture (25h/4-day contract) to guard against a fix that only
    // happens to work for the 5-day case.
    const wellBehavedFlex = {
      type: "FLEXTIME",
      weeklyHours: 25,
      workDays: [1, 2, 3, 5], // Mon, Tue, Wed, Fri — matches {day}Hours below exactly
      sundayHours: 0,
      mondayHours: 6.25,
      tuesdayHours: 6.25,
      wednesdayHours: 6.25,
      thursdayHours: 0,
      fridayHours: 6.25,
      saturdayHours: 0,
    };
    const weekSoll = calcExpectedMinutesTz(wellBehavedFlex, d("2026-08-10"), d("2026-08-16"), TZ);
    expect(weekSoll).toBe(1500); // 25h × 60 × 4/4
  });
});
