/**
 * Issue #447 (D-01, D-02, D-13) — pure-core boundary pins for the exit-month clip.
 *
 * DB-free: no app, no Prisma. Builds CloseMonthInput objects by hand and calls
 * closeEmployeeMonth() directly. Covers the boundaries the golden-matrix exit cells
 * (fw-40-5-exit, fx-30-4-exit, mj-80-exit, sb-40-5-exit) don't reach:
 *   (a)-(c) holiday/leave/absence credit clipped at the exit date (non-SHIFT)
 *   (d)     a VOCATIONAL_SCHOOL/PATTERN absence after the exit contributes nothing
 *   (e)-(f) the live SHIFT_BASED roster-proration shape — unchanged without an exit
 *           inside the month (D-13), clipped to the exit date when one exists
 *   (g)     exit on the last day of the month == no exit (byte-identity edge case)
 *   (h)     exit before the month == the existing zeroed early return (unchanged)
 *
 * See GOLDEN-MATRIX-SPEC.md "Exit-month cells (Issue #447)" for the golden-cell
 * derivations; this file pins the boundaries those cells don't exercise.
 */
import { describe, it, expect } from "vitest";
import {
  closeEmployeeMonth,
  type CloseMonthInput,
  type LeaveCreditBasis,
} from "../close-employee-month";
import { monthRangeUtc, monthDayBounds } from "../timezone";

const TZ = "Europe/Berlin";

// ── Schedule shells ──────────────────────────────────────────────────────────
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

// ── Date helpers ─────────────────────────────────────────────────────────────

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

/** Entry netto = endTime - startTime - breakMinutes, so breakMinutes:0 makes it exact. */
function mkEntry(dateStr: string, netto: number): CloseMonthInput["entries"][number] {
  const start = new Date(dateStr + "T08:00:00Z");
  return {
    date: new Date(dateStr + "T00:00:00Z"),
    startTime: start,
    endTime: new Date(start.getTime() + netto * 60_000),
    breakMinutes: 0,
  };
}

/** Shift netto = brutto (breakOver*Override: 0 on every test input below). */
function mkShift(dateStr: string, netto: number): CloseMonthInput["shifts"][number] {
  const totalH = Math.floor(netto / 60);
  const totalM = netto % 60;
  const endHHMM = `${String(8 + totalH).padStart(2, "0")}:${String(totalM).padStart(2, "0")}`;
  return { date: new Date(dateStr + "T00:00:00Z"), startTime: "08:00", endTime: endHHMM };
}

function mkLeave(
  start: string,
  end: string,
  creditBasis: LeaveCreditBasis = "CONTRACT",
): CloseMonthInput["approvedLeave"][number] {
  return {
    startDate: new Date(start + "T00:00:00Z"),
    endDate: new Date(end + "T00:00:00Z"),
    halfDay: false,
    isOvertimeCompensation: false,
    creditBasis,
  };
}

function mkAbsence(
  start: string,
  end: string,
  type: string,
  source: string,
): CloseMonthInput["absences"][number] {
  return {
    startDate: new Date(start + "T00:00:00Z"),
    endDate: new Date(end + "T00:00:00Z"),
    type,
    source,
  };
}

/** Base CloseMonthInput; callers override month bounds, exitDate, entries, etc. */
function baseInput(
  schedule: Record<string, unknown>,
  overrides: Partial<CloseMonthInput> & {
    monthStart: Date;
    monthEnd: Date;
    monthFirstDay: Date;
    monthLastDay: Date;
  },
): CloseMonthInput {
  return {
    employeeId: "emp-1",
    tz: TZ,
    carryOverIn: 0,
    schedule,
    hireDate: new Date("2020-01-01T00:00:00Z"),
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
    ...overrides,
  };
}

describe("closeEmployeeMonth — Issue #447 exit-month boundary pins", () => {
  // (a) FIXED 40/5, May 2026, exit Fri 2026-05-08, holidays 01./14./25.05 — only the
  // 01.05 holiday (inside the clipped range) is deducted; 14./25.05 (after exit) are not.
  it("(a) holiday after the exit date is not deducted", () => {
    const { start: monthStart, end: monthEnd } = monthRangeUtc(2026, 5, TZ);
    const { firstDay: monthFirstDay, lastDay: monthLastDay } = monthDayBounds(
      monthStart,
      monthEnd,
      TZ,
    );
    const input = baseInput(FIXED_40_5, {
      monthStart,
      monthEnd,
      monthFirstDay,
      monthLastDay,
      exitDate: new Date("2026-05-08T00:00:00Z"),
      entries: monFri("2026-05-04", "2026-05-08").map((d) => mkEntry(d, 480)),
      holidayDateStrings: new Set(["2026-05-01", "2026-05-14", "2026-05-25"]),
    });
    const result = closeEmployeeMonth(input);
    // 6 Mo-Fr days (01.,04.-08.05.) x 480 = 2880, minus the 01.05. holiday (480) = 2400.
    expect(result.expectedMinutes).toBe(2400);
    expect(result.workedMinutes).toBe(2400);
    expect(result.balanceMinutes).toBe(0);
  });

  // (b) FIXED 40/5, July 2026, exit 10.07, one APPROVED vacation row 08.-17.07 — only
  // 08.-10.07 (inside the clipped range) is credited.
  it("(b) leave after the exit date is clipped, not fully credited", () => {
    const { start: monthStart, end: monthEnd } = monthRangeUtc(2026, 7, TZ);
    const { firstDay: monthFirstDay, lastDay: monthLastDay } = monthDayBounds(
      monthStart,
      monthEnd,
      TZ,
    );
    const input = baseInput(FIXED_40_5, {
      monthStart,
      monthEnd,
      monthFirstDay,
      monthLastDay,
      exitDate: new Date("2026-07-10T00:00:00Z"),
      entries: monFri("2026-07-01", "2026-07-07").map((d) => mkEntry(d, 480)),
      approvedLeave: [mkLeave("2026-07-08", "2026-07-17")],
    });
    const result = closeEmployeeMonth(input);
    // 8 Mo-Fr days (01.-10.07.) x 480 = 3840, minus 3 credited leave days (08.-10.07.) x 480
    // = 1440 -> 2400. Entries 01.-07.07. (5 days) x 480 = 2400 -> balance 0.
    expect(result.expectedMinutes).toBe(2400);
    expect(result.workedMinutes).toBe(2400);
    expect(result.balanceMinutes).toBe(0);
  });

  // (c) FIXED 40/5, July 2026, exit 10.07, a SICK/MANUAL absence 13.-15.07 (entirely
  // after the exit) — contributes 0.
  it("(c) an absence entirely after the exit date contributes nothing", () => {
    const { start: monthStart, end: monthEnd } = monthRangeUtc(2026, 7, TZ);
    const { firstDay: monthFirstDay, lastDay: monthLastDay } = monthDayBounds(
      monthStart,
      monthEnd,
      TZ,
    );
    const input = baseInput(FIXED_40_5, {
      monthStart,
      monthEnd,
      monthFirstDay,
      monthLastDay,
      exitDate: new Date("2026-07-10T00:00:00Z"),
      entries: monFri("2026-07-01", "2026-07-10").map((d) => mkEntry(d, 480)),
      absences: [mkAbsence("2026-07-13", "2026-07-15", "SICK", "MANUAL")],
    });
    const result = closeEmployeeMonth(input);
    expect(result.expectedMinutes).toBe(3840);
    expect(result.workedMinutes).toBe(3840);
    expect(result.balanceMinutes).toBe(0);
  });

  // (d) FIXED 40/5, July 2026, exit 10.07, a VOCATIONAL_SCHOOL/PATTERN absence on Mon
  // 13.07 (after the exit) — result deep-equals the same input without that absence.
  it("(d) a Berufsschule day after the exit date contributes nothing (deep-equal pin)", () => {
    const { start: monthStart, end: monthEnd } = monthRangeUtc(2026, 7, TZ);
    const { firstDay: monthFirstDay, lastDay: monthLastDay } = monthDayBounds(
      monthStart,
      monthEnd,
      TZ,
    );
    const common = {
      monthStart,
      monthEnd,
      monthFirstDay,
      monthLastDay,
      exitDate: new Date("2026-07-10T00:00:00Z"),
      entries: monFri("2026-07-01", "2026-07-10").map((d) => mkEntry(d, 480)),
    };
    const withoutBs = closeEmployeeMonth(baseInput(FIXED_40_5, common));
    const withBs = closeEmployeeMonth(
      baseInput(FIXED_40_5, {
        ...common,
        absences: [mkAbsence("2026-07-13", "2026-07-13", "VOCATIONAL_SCHOOL", "PATTERN")],
      }),
    );
    expect(withBs).toEqual(withoutBs);
  });

  // (e) SHIFT_BASED live shape WITHOUT an exit: monthLastDay is the "today" boundary
  // (2026-07-07), monthEnd is the FULL calendar month end (the live caller's convention,
  // see overtime-balance.ts), exitDate null. Characterization pin for D-13: the live
  // roster proration keeps its full-month C_net (11040) when there is no exit.
  it("(e) SHIFT_BASED live shape without exit — full-month C_net unchanged (D-13)", () => {
    const { start: monthStart, end: monthEnd } = monthRangeUtc(2026, 7, TZ);
    const monthFirstDay = new Date("2026-07-01T00:00:00Z");
    const monthLastDay = new Date("2026-07-07T00:00:00Z"); // "today" in the open month
    const shiftDays = monFri("2026-07-01", "2026-07-07"); // 5 days x 480 = 2400
    const input = baseInput(SHIFT_40_5, {
      monthStart,
      monthEnd, // full July end — the live caller's convention for SHIFT_BASED
      monthFirstDay,
      monthLastDay,
      exitDate: null,
      shifts: shiftDays.map((d) => mkShift(d, 480)),
      entries: shiftDays.map((d) => mkEntry(d, 480)),
      rosterProration: { rosterToDateMinutes: 2400, rosterPeriodMinutes: 11040 },
    });
    const result = closeEmployeeMonth(input);
    // effectiveC = round(11040 * 2400 / 11040) = 2400.
    expect(result.expectedMinutes).toBe(2400);
    expect(result.workedMinutes).toBe(2400);
    expect(result.balanceMinutes).toBe(0);
  });

  // (f) Same live shape as (e), but exitDate 2026-07-20 (after "today" 07.07, inside the
  // month). RED before the fix: C_net used the full-month contractSoll (11040) regardless
  // of the exit, so effectiveC = round(11040*2400/6720) = 3943. Fixed: C_net spans
  // 01.-20.07. (the 14 Mo-Fr days through the exit, contractSoll=6720), matching
  // rosterPeriodMinutes (also computed through the exit by the live caller) ->
  // effectiveC = round(6720*2400/6720) = 2400.
  it("(f) SHIFT_BASED live shape with an exit inside the month — C_net spans to the exit (D-13)", () => {
    const { start: monthStart, end: monthEnd } = monthRangeUtc(2026, 7, TZ);
    const monthFirstDay = new Date("2026-07-01T00:00:00Z");
    const monthLastDay = new Date("2026-07-07T00:00:00Z"); // "today" in the open month
    const shiftDays = monFri("2026-07-01", "2026-07-07"); // 5 days x 480 = 2400
    const input = baseInput(SHIFT_40_5, {
      monthStart,
      monthEnd,
      monthFirstDay,
      monthLastDay,
      exitDate: new Date("2026-07-20T00:00:00Z"),
      shifts: shiftDays.map((d) => mkShift(d, 480)),
      entries: shiftDays.map((d) => mkEntry(d, 480)),
      // rosterPeriodMinutes reflects the roster through the exit date (14 Mo-Fr days x 480).
      rosterProration: { rosterToDateMinutes: 2400, rosterPeriodMinutes: 6720 },
    });
    const result = closeEmployeeMonth(input);
    expect(result.expectedMinutes).toBe(2400);
    expect(result.workedMinutes).toBe(2400);
    expect(result.balanceMinutes).toBe(0);
  });

  // (g) exit on the last day of the month == no exit (byte-identity edge case), both for
  // FIXED and for SHIFT_BASED close shape (monthLastDay == the true calendar month end).
  it("(g) exit on the last day of the month deep-equals no exit — FIXED", () => {
    const { start: monthStart, end: monthEnd } = monthRangeUtc(2026, 7, TZ);
    const { firstDay: monthFirstDay, lastDay: monthLastDay } = monthDayBounds(
      monthStart,
      monthEnd,
      TZ,
    );
    const entries = monFri("2026-07-01", "2026-07-31").map((d) => mkEntry(d, 480));
    const noExit = closeEmployeeMonth(
      baseInput(FIXED_40_5, { monthStart, monthEnd, monthFirstDay, monthLastDay, entries }),
    );
    const exitLastDay = closeEmployeeMonth(
      baseInput(FIXED_40_5, {
        monthStart,
        monthEnd,
        monthFirstDay,
        monthLastDay,
        entries,
        exitDate: new Date("2026-07-31T00:00:00Z"),
      }),
    );
    expect(exitLastDay).toEqual(noExit);
  });

  it("(g) exit on the last day of the month deep-equals no exit — SHIFT_BASED", () => {
    const { start: monthStart, end: monthEnd } = monthRangeUtc(2026, 7, TZ);
    const { firstDay: monthFirstDay, lastDay: monthLastDay } = monthDayBounds(
      monthStart,
      monthEnd,
      TZ,
    );
    const days = monFri("2026-07-01", "2026-07-31");
    const shifts = days.map((d) => mkShift(d, 480));
    const entries = days.map((d) => mkEntry(d, 480));
    const noExit = closeEmployeeMonth(
      baseInput(SHIFT_40_5, { monthStart, monthEnd, monthFirstDay, monthLastDay, shifts, entries }),
    );
    const exitLastDay = closeEmployeeMonth(
      baseInput(SHIFT_40_5, {
        monthStart,
        monthEnd,
        monthFirstDay,
        monthLastDay,
        shifts,
        entries,
        exitDate: new Date("2026-07-31T00:00:00Z"),
      }),
    );
    expect(exitLastDay).toEqual(noExit);
  });

  // (h) exit before the month (2026-06-30, July closed) — the existing zeroed early
  // return (balance 0, carryOverOut == carryOverIn) — unchanged by this plan.
  it("(h) exit before the month returns the existing zeroed result, unchanged", () => {
    const { start: monthStart, end: monthEnd } = monthRangeUtc(2026, 7, TZ);
    const { firstDay: monthFirstDay, lastDay: monthLastDay } = monthDayBounds(
      monthStart,
      monthEnd,
      TZ,
    );
    const input = baseInput(FIXED_40_5, {
      monthStart,
      monthEnd,
      monthFirstDay,
      monthLastDay,
      exitDate: new Date("2026-06-30T00:00:00Z"),
      carryOverIn: 500,
    });
    const result = closeEmployeeMonth(input);
    expect(result.workedMinutes).toBe(0);
    expect(result.expectedMinutes).toBe(0);
    expect(result.balanceMinutes).toBe(0);
    expect(result.carryOverOut).toBe(500);
    expect(result.effectiveCarryOverOut).toBe(500);
  });
});
