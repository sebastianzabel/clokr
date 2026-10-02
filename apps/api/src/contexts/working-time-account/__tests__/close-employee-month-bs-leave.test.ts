/**
 * Issue #448 (D-03, owner decision 01.10.2026) — pure-core equivalence pins for the saldo
 * side: a leave day that is also a Berufsschultag reduces Soll exactly once ("BS wins").
 *
 * DB-free: no app, no Prisma. Builds CloseMonthInput objects by hand and calls
 * closeEmployeeMonth() directly, mirroring close-employee-month-exit.test.ts's (#447) shape.
 *
 * The oracle (D-03) is EQUIVALENCE, not a hand-copied number from the code: a single approved
 * leave row spanning a Berufsschultag must produce the IDENTICAL expectedMinutes as two leave
 * rows covering the SAME dates with the BS date excluded from both ranges (the request "split
 * around the BS day"). This is true independent of which schedule type, which BS source
 * (PATTERN/MANUAL), whether the leave is half-day, or which credit basis (CONTRACT/ROSTER) the
 * leave type carries — see golden-matrix.test.ts's `az-fixed-38-5-bs_leave` /
 * `az-shift-38-5-bs_leave` for the same scenario through the full HTTP/DB path.
 */
import { describe, it, expect } from "vitest";
import {
  closeEmployeeMonth,
  type CloseMonthInput,
  type LeaveCreditBasis,
} from "../close-employee-month";
import { monthRangeUtc, monthDayBounds } from "../timezone";

const TZ = "Europe/Berlin";

// ── Schedule shells — 40h/5-day, daily Soll 480 (round(40*60/5)) ───────────────────────────────
const FIXED_40_5: Record<string, unknown> = {
  type: "FIXED_SCHEDULE",
  weeklyHours: 40,
  mondayHours: 8,
  tuesdayHours: 8,
  wednesdayHours: 8,
  thursdayHours: 8,
  fridayHours: 8,
  saturdayHours: 0,
  sundayHours: 0,
  workDays: [1, 2, 3, 4, 5],
};
const SHIFT_40_5: Record<string, unknown> = { ...FIXED_40_5, type: "SHIFT_BASED" };

// ── Helpers (mirrors close-employee-month-exit.test.ts, #447) ──────────────────────────────────

function mkLeave(
  start: string,
  end: string,
  opts: { halfDay?: boolean; creditBasis?: LeaveCreditBasis } = {},
): CloseMonthInput["approvedLeave"][number] {
  return {
    startDate: new Date(start + "T00:00:00Z"),
    endDate: new Date(end + "T00:00:00Z"),
    halfDay: opts.halfDay ?? false,
    isOvertimeCompensation: false,
    creditBasis: opts.creditBasis ?? "CONTRACT",
  };
}

function mkBsAbsence(
  date: string,
  source: "PATTERN" | "MANUAL" = "PATTERN",
): CloseMonthInput["absences"][number] {
  return {
    startDate: new Date(date + "T00:00:00Z"),
    endDate: new Date(date + "T00:00:00Z"),
    type: "VOCATIONAL_SCHOOL",
    source,
  };
}

/** All Mon-Fri date strings within [fromStr, toStr] inclusive. */
function monFri(fromStr: string, toStr: string): string[] {
  const out: string[] = [];
  const cur = new Date(fromStr + "T00:00:00Z");
  const end = new Date(toStr + "T00:00:00Z");
  while (cur <= end) {
    const dow = cur.getUTCDay();
    if (dow >= 1 && dow <= 5) out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function mkShift(dateStr: string, netto: number): CloseMonthInput["shifts"][number] {
  const totalH = Math.floor(netto / 60);
  const totalM = netto % 60;
  const endHHMM = `${String(8 + totalH).padStart(2, "0")}:${String(totalM).padStart(2, "0")}`;
  return { date: new Date(dateStr + "T00:00:00Z"), startTime: "08:00", endTime: endHHMM };
}

/** Base CloseMonthInput for January 2026; callers override schedule/leave/absences/shifts. */
function baseInput(
  schedule: Record<string, unknown>,
  overrides: Partial<CloseMonthInput> = {},
): CloseMonthInput {
  const { start: monthStart, end: monthEnd } = monthRangeUtc(2026, 1, TZ);
  const { firstDay: monthFirstDay, lastDay: monthLastDay } = monthDayBounds(
    monthStart,
    monthEnd,
    TZ,
  );
  return {
    employeeId: "emp-448",
    tz: TZ,
    carryOverIn: 0,
    schedule,
    hireDate: new Date("2025-12-01T00:00:00Z"),
    exitDate: null,
    isTimeTrackingExempt: false,
    breakOver6hOverride: 0,
    breakOver9hOverride: 0,
    entries: [],
    shifts: [],
    approvedLeave: [],
    absences: [],
    holidayDateStrings: new Set<string>(),
    tenantConfig: { defaultBreakOver6h: 30, defaultBreakOver9h: 45 },
    monthStart,
    monthEnd,
    monthFirstDay,
    monthLastDay,
    ...overrides,
  };
}

describe("closeEmployeeMonth — Issue #448 (D-03): BS day inside approved leave reduces Soll once", () => {
  // ── FIXED_SCHEDULE, PATTERN BS ──────────────────────────────────────────────────────────────
  it("FIXED + PATTERN BS Wed: Mo-Fr leave == Mon+Wed-skip+Thu-Fri split leave (equivalence + absolute pin)", () => {
    const combined = closeEmployeeMonth(
      baseInput(FIXED_40_5, {
        approvedLeave: [mkLeave("2026-01-12", "2026-01-16")],
        absences: [mkBsAbsence("2026-01-14")],
      }),
    );
    const split = closeEmployeeMonth(
      baseInput(FIXED_40_5, {
        approvedLeave: [mkLeave("2026-01-12", "2026-01-13"), mkLeave("2026-01-15", "2026-01-16")],
        absences: [mkBsAbsence("2026-01-14")],
      }),
    );
    expect(combined.expectedMinutes).toBe(split.expectedMinutes);
    // Hand-derived: contractSoll = 22 Mo-Fr x 480 = 10560. Leave credit = 4 non-BS days x 480 =
    // 1920 (BS Wed excluded). BS absence Ø-Method credit = 480 (subtracted once); bsExpected
    // (FIRST_LONG_DAY default = individual daily Soll = 480) re-added (net-neutral).
    //   expectedMinutes = max(0, 10560 + 480 - 1920 - 480) = 8640.
    expect(combined.expectedMinutes).toBe(8640);
  });

  // ── FIXED_SCHEDULE, MANUAL BS — proves claimDays' skip parameter (not just the credit skip) ──
  it("FIXED + MANUAL-source BS Wed: the BS absence still gets its own Ø-Method credit (claimDays must not claim BS dates)", () => {
    // Without the claimDays(..., skip: bsDatesInMonth) fix, the leave loop's own claim would
    // seed 14.01. into nsClaimed, and the MANUAL BS absence row (isBsAbsence() is PATTERN-only,
    // so it IS excluded by nsClaimed) would lose its Ø-Method credit entirely — expectedMinutes
    // would read 9120 (10560+480-1920-0), not 8640.
    const result = closeEmployeeMonth(
      baseInput(FIXED_40_5, {
        approvedLeave: [mkLeave("2026-01-12", "2026-01-16")],
        absences: [mkBsAbsence("2026-01-14", "MANUAL")],
      }),
    );
    expect(result.expectedMinutes).toBe(8640);
  });

  // ── SHIFT_BASED, PATTERN BS ─────────────────────────────────────────────────────────────────
  it("SHIFT_BASED + PATTERN BS Wed: Mo-Fr leave == split leave (equivalence), same number as FIXED", () => {
    const combined = closeEmployeeMonth(
      baseInput(SHIFT_40_5, {
        approvedLeave: [mkLeave("2026-01-12", "2026-01-16")],
        absences: [mkBsAbsence("2026-01-14")],
      }),
    );
    const split = closeEmployeeMonth(
      baseInput(SHIFT_40_5, {
        approvedLeave: [mkLeave("2026-01-12", "2026-01-13"), mkLeave("2026-01-15", "2026-01-16")],
        absences: [mkBsAbsence("2026-01-14")],
      }),
    );
    expect(combined.expectedMinutes).toBe(split.expectedMinutes);
    // Same arithmetic as the FIXED case above (identical schedule shape, just a different
    // crediting MECHANISM — leaveDaysPerWeek's fragment branch, contract=5, daily=480):
    // contractSoll=10560, leave credit=4x480=1920, BS absence credit=480, bsExpected=480.
    expect(combined.expectedMinutes).toBe(8640);
  });

  // ── SHIFT_BASED, MANUAL BS — same claimDays-skip proof as the FIXED case above ────────────────
  it("SHIFT_BASED + MANUAL-source BS Wed: the BS absence still gets its own Ø-Method credit (sbClaimed must not claim BS dates)", () => {
    const result = closeEmployeeMonth(
      baseInput(SHIFT_40_5, {
        approvedLeave: [mkLeave("2026-01-12", "2026-01-16")],
        absences: [mkBsAbsence("2026-01-14", "MANUAL")],
      }),
    );
    expect(result.expectedMinutes).toBe(8640);
  });

  // ── Half-day VACATION on the BS date vs no leave at all ───────────────────────────────────────
  it("FIXED + half-day VACATION on the BS date == no leave at all (both credit 0 from the leave)", () => {
    const withHalfDayLeave = closeEmployeeMonth(
      baseInput(FIXED_40_5, {
        approvedLeave: [mkLeave("2026-01-14", "2026-01-14", { halfDay: true })],
        absences: [mkBsAbsence("2026-01-14")],
      }),
    );
    const noLeaveAtAll = closeEmployeeMonth(
      baseInput(FIXED_40_5, {
        approvedLeave: [],
        absences: [mkBsAbsence("2026-01-14")],
      }),
    );
    expect(withHalfDayLeave.expectedMinutes).toBe(noLeaveAtAll.expectedMinutes);
    // Both: contractSoll(10560) + bsExpected(480) - leave(0) - bsAbsence(480) = 10560.
    expect(withHalfDayLeave.expectedMinutes).toBe(10560);
  });

  // ── SICK (ROSTER basis) over the BS date is displaced too — type-agnostic (D-03) ─────────────
  it("SHIFT_BASED + SICK (ROSTER basis) spanning the BS date == split SICK rows around it", () => {
    const rosteredShifts = monFri("2026-01-12", "2026-01-16").map((d) => mkShift(d, 480));
    const combined = closeEmployeeMonth(
      baseInput(SHIFT_40_5, {
        approvedLeave: [mkLeave("2026-01-12", "2026-01-16", { creditBasis: "ROSTER" })],
        absences: [mkBsAbsence("2026-01-14")],
        shifts: rosteredShifts,
      }),
    );
    const split = closeEmployeeMonth(
      baseInput(SHIFT_40_5, {
        approvedLeave: [
          mkLeave("2026-01-12", "2026-01-13", { creditBasis: "ROSTER" }),
          mkLeave("2026-01-15", "2026-01-16", { creditBasis: "ROSTER" }),
        ],
        absences: [mkBsAbsence("2026-01-14")],
        shifts: rosteredShifts,
      }),
    );
    expect(combined.expectedMinutes).toBe(split.expectedMinutes);
    // ROSTER-basis credit = plannedNettoByDate per date (480 each, from rosteredShifts), summed
    // over the 4 non-BS dates = 1920 — same total either way, since the per-row loop's explicit
    // `bsDatesInMonth.has(dateStr)` check (not the leaveDaysPerWeek holiday argument, which
    // ROSTER-basis rows never go through) is what suppresses the BS date's credit here.
    expect(combined.expectedMinutes).toBe(8640);
  });

  // ── No BS row in the month: unaffected (regression control) ─────────────────────────────────
  it("FIXED, no BS row at all: a Mo-Fr leave credits exactly as before (unchanged)", () => {
    const result = closeEmployeeMonth(
      baseInput(FIXED_40_5, {
        approvedLeave: [mkLeave("2026-01-12", "2026-01-16")],
        absences: [],
      }),
    );
    // contractSoll(10560) - leave(5x480=2400) = 8160; no BS credit/re-credit at all.
    expect(result.expectedMinutes).toBe(8160);
  });
});
