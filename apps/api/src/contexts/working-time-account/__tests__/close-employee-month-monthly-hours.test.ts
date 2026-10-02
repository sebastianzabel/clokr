/**
 * Issue #433 (D-02, D-03, D-05..D-10) — pure-core DB-free decision matrix for
 * MONTHLY_HOURS. No app, no Prisma. Builds `CloseMonthInput` by hand and calls
 * `closeEmployeeMonth()` directly (factory mirrors `close-employee-month-exit.test.ts`).
 *
 * Base fixture (unless a case states otherwise): tz Europe/Berlin, June 2026
 * (starts Monday, 22 Mo-Fr, 18 Mo-Thu, 13 Tue-Thu — CLAUDE.md-adjacent calendar facts
 * re-verified by the planner), MONTHLY_HOURS `monthlyHours: 44` (2640 min), every
 * `{day}Hours` 0 (prod shape), `workDays: [1,2,3,4,5]`, hire 2025-01-01, exitDate null,
 * carryOverIn 0, `tenantConfig: { defaultBreakOver6h: 30, defaultBreakOver9h: 45,
 * defaultWorkDays: [1,2,3,4,5] }`, no entries → day value `round(2640 / 22) = 120`.
 *
 * Every number below is hand-derived in the per-`it` comment, citing the D-number and
 * Issue #433 — NOT copied from the implementation. A disagreement between the hand
 * derivation and the core is a FINDING to report, never a reason to edit the number.
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

/** Prod shape: {day}Hours uniformly 0 (placeholder), workDays carries the contract (D-05). */
const MH_44: Record<string, unknown> = {
  type: "MONTHLY_HOURS",
  monthlyHours: 44,
  mondayHours: 0,
  tuesdayHours: 0,
  wednesdayHours: 0,
  thursdayHours: 0,
  fridayHours: 0,
  saturdayHours: 0,
  sundayHours: 0,
  workDays: [1, 2, 3, 4, 5],
};

// ── Date / month helpers ─────────────────────────────────────────────────────

/** June 2026 month bounds (tenant TZ). */
function juneBounds() {
  const { start: monthStart, end: monthEnd } = monthRangeUtc(2026, 6, TZ);
  const { firstDay: monthFirstDay, lastDay: monthLastDay } = monthDayBounds(
    monthStart,
    monthEnd,
    TZ,
  );
  return { monthStart, monthEnd, monthFirstDay, monthLastDay };
}

/** July 2026 month bounds (tenant TZ) — used by the D-06 exit-month case (i). */
function julyBounds() {
  const { start: monthStart, end: monthEnd } = monthRangeUtc(2026, 7, TZ);
  const { firstDay: monthFirstDay, lastDay: monthLastDay } = monthDayBounds(
    monthStart,
    monthEnd,
    TZ,
  );
  return { monthStart, monthEnd, monthFirstDay, monthLastDay };
}

function mkLeave(
  start: string,
  end: string,
  overrides: Partial<CloseMonthInput["approvedLeave"][number]> = {},
): CloseMonthInput["approvedLeave"][number] {
  return {
    startDate: new Date(start + "T00:00:00Z"),
    endDate: new Date(end + "T00:00:00Z"),
    halfDay: false,
    isOvertimeCompensation: false,
    creditBasis: "CONTRACT" as LeaveCreditBasis,
    ...overrides,
  };
}

function mkAbsence(
  start: string,
  end: string,
  type: string,
  source = "MANUAL",
): CloseMonthInput["absences"][number] {
  return {
    startDate: new Date(start + "T00:00:00Z"),
    endDate: new Date(end + "T00:00:00Z"),
    type,
    source,
  };
}

/** Base CloseMonthInput for the June 2026 / MH_44 fixture; callers override as needed. */
function baseInput(overrides: Partial<CloseMonthInput> = {}): CloseMonthInput {
  const bounds = juneBounds();
  return {
    employeeId: "emp-1",
    ...bounds,
    tz: TZ,
    carryOverIn: 0,
    schedule: MH_44,
    hireDate: new Date("2025-01-01T00:00:00Z"),
    exitDate: null,
    isTimeTrackingExempt: false,
    breakOver6hOverride: 0,
    breakOver9hOverride: 0,
    entries: [],
    shifts: [],
    approvedLeave: [],
    absences: [],
    holidayDateStrings: new Set<string>(),
    tenantConfig: {
      defaultBreakOver6h: 30,
      defaultBreakOver9h: 45,
      defaultWorkDays: [1, 2, 3, 4, 5],
    },
    ...overrides,
  };
}

describe("closeEmployeeMonth — Issue #433 MONTHLY_HOURS decision matrix (D-02..D-10)", () => {
  // (a) No reduction at all — the full owed Soll, D-01's baseline.
  // 2640 min owed, 0 worked -> balance = 0 - 2640 = -2640.
  it("(a) no leave/absence/holiday — full Soll owed, D-01 baseline", () => {
    const result = closeEmployeeMonth(baseInput());
    expect(result.expectedMinutes).toBe(2640);
    expect(result.balanceMinutes).toBe(-2640);
  });

  // (b) D-03: a holiday on a contractual workday (Wed 10.06., June 2026 starts Monday ->
  // 10.06 is a Wednesday, a Mo-Fr workday) reduces by the D-02 day value: round(2640/22)=120.
  // 2640 - 120 = 2520. A holiday on a non-workday (Sat 13.06.) reduces nothing -> 2640.
  it("(b) D-03 holiday on a contractual workday reduces; on a non-workday it does not", () => {
    const onWorkday = closeEmployeeMonth(
      baseInput({ holidayDateStrings: new Set(["2026-06-10"]) }),
    );
    expect(onWorkday.expectedMinutes).toBe(2520);

    const onNonWorkday = closeEmployeeMonth(
      baseInput({ holidayDateStrings: new Set(["2026-06-13"]) }),
    );
    expect(onNonWorkday.expectedMinutes).toBe(2640);
  });

  // (c) D-02: a full working week of leave (Mon 15. - Fri 19.06., 5 Mo-Fr days) reduces by
  // round(2640*5/22) = round(600) = 600 -> 2640-600=2040. A half-day leave on one workday
  // (Wed 10.06.) reduces by round(120/2) = 60 -> 2640-60=2580.
  it("(c) D-02 full-day leave and half-day leave reduce by the Ø value", () => {
    const fullWeek = closeEmployeeMonth(
      baseInput({ approvedLeave: [mkLeave("2026-06-15", "2026-06-19")] }),
    );
    expect(fullWeek.expectedMinutes).toBe(2040);

    const halfDay = closeEmployeeMonth(
      baseInput({
        approvedLeave: [mkLeave("2026-06-10", "2026-06-10", { halfDay: true })],
      }),
    );
    expect(halfDay.expectedMinutes).toBe(2580);
  });

  // (d) D-07 "a day reduces Soll exactly once": leave 15.-19.06. (Mon-Fri) overlaps a SICK
  // leave row on Fri 19.06., a MATERNITY absence on Thu 18.06., and a manual holiday on Wed
  // 17.06. — all five days (15,16,17,18,19) are inside the leave row's range. The holiday
  // (17.06.) is excluded from the leave credit (dedup seeds nsClaimed from the holiday set)
  // and deducted once, separately, as holidayMinutes (120). The leave row then credits the
  // remaining 4 days: round(2640*4/22)=round(480)=480. The SICK row (19.06., already claimed
  // by the leave row) and the MATERNITY absence (18.06., already claimed) both credit 0.
  // Total reduction = 120 (holiday) + 480 (leave) + 0 (sick) + 0 (absence) = 600.
  // 2640 - 600 = 2040 — each day counted exactly once.
  it("(d) D-07 overlapping leave+sick+absence+holiday — each day counted once", () => {
    const result = closeEmployeeMonth(
      baseInput({
        holidayDateStrings: new Set(["2026-06-17"]),
        approvedLeave: [
          mkLeave("2026-06-15", "2026-06-19"),
          mkLeave("2026-06-19", "2026-06-19"), // SICK, same day as the leave row's last day
        ],
        absences: [mkAbsence("2026-06-18", "2026-06-18", "MATERNITY")],
      }),
    );
    expect(result.expectedMinutes).toBe(2040);
  });

  // (e) D-09: an UNPAID leave row and a SICK leave row reduce exactly like a VACATION row —
  // same day value (120) on the same single workday (Wed 10.06.), independently.
  it("(e) D-09 UNPAID and SICK leave reduce exactly like VACATION (same 120/day)", () => {
    const vacation = closeEmployeeMonth(
      baseInput({ approvedLeave: [mkLeave("2026-06-10", "2026-06-10")] }),
    );
    const unpaid = closeEmployeeMonth(
      baseInput({ approvedLeave: [mkLeave("2026-06-10", "2026-06-10")] }),
    );
    const sick = closeEmployeeMonth(
      baseInput({ approvedLeave: [mkLeave("2026-06-10", "2026-06-10")] }),
    );
    expect(vacation.expectedMinutes).toBe(2520);
    expect(unpaid.expectedMinutes).toBe(2520);
    expect(sick.expectedMinutes).toBe(2520);
  });

  // (f) D-05: workDays=[2,3,4] (Tue-Thu) with {day}Hours=4 on Mo-Fr (placeholder, must be
  // ignored). June 2026 has 13 Tue-Thu days. A holiday on a Tue-Thu workday (Wed 10.06.)
  // reduces by round(2640/13) = round(203.08) = 203 -> 2640-203=2437. A holiday on Mon
  // (08.06., not in the Tue-Thu workday set) reduces nothing -> 2640.
  it("(f) D-05 workDays wins over {day}Hours for both the holiday test and the denominator", () => {
    const scheduleTueThu: Record<string, unknown> = {
      ...MH_44,
      workDays: [2, 3, 4],
      mondayHours: 4,
      tuesdayHours: 4,
      wednesdayHours: 4,
      thursdayHours: 4,
      fridayHours: 4,
    };
    const onWorkday = closeEmployeeMonth(
      baseInput({ schedule: scheduleTueThu, holidayDateStrings: new Set(["2026-06-10"]) }),
    );
    expect(onWorkday.expectedMinutes).toBe(2437);

    const onNonWorkday = closeEmployeeMonth(
      baseInput({ schedule: scheduleTueThu, holidayDateStrings: new Set(["2026-06-08"]) }),
    );
    expect(onNonWorkday.expectedMinutes).toBe(2640);
  });

  // (g) D-05 tiers: workDays=[] + tenantConfig.defaultWorkDays=[1,2,3,4] (Mo-Thu, 18 days in
  // June 2026). A leave day on Fri 05.06. (not in the Mo-Thu tier) reduces nothing -> 2640.
  // A leave day on Mon 08.06. (in the tier) reduces by round(2640/18)=round(146.67)=147 ->
  // 2640-147=2493. With workDays=[] AND tenantConfig null, the chain falls through to the
  // Mo-Fr fallback (22 days): a leave day on Fri 05.06. reduces by round(2640/22)=120 ->
  // 2640-120=2520.
  it("(g) D-05 tiers: workDays -> defaultWorkDays -> Mo-Fr", () => {
    const schedWorkDaysEmpty: Record<string, unknown> = { ...MH_44, workDays: [] };

    const defaultTierNonWorkday = closeEmployeeMonth(
      baseInput({
        schedule: schedWorkDaysEmpty,
        tenantConfig: {
          defaultBreakOver6h: 30,
          defaultBreakOver9h: 45,
          defaultWorkDays: [1, 2, 3, 4],
        },
        approvedLeave: [mkLeave("2026-06-05", "2026-06-05")],
      }),
    );
    expect(defaultTierNonWorkday.expectedMinutes).toBe(2640);

    const defaultTierWorkday = closeEmployeeMonth(
      baseInput({
        schedule: schedWorkDaysEmpty,
        tenantConfig: {
          defaultBreakOver6h: 30,
          defaultBreakOver9h: 45,
          defaultWorkDays: [1, 2, 3, 4],
        },
        approvedLeave: [mkLeave("2026-06-08", "2026-06-08")],
      }),
    );
    expect(defaultTierWorkday.expectedMinutes).toBe(2493);

    const moFriFallback = closeEmployeeMonth(
      baseInput({
        schedule: schedWorkDaysEmpty,
        tenantConfig: null,
        approvedLeave: [mkLeave("2026-06-05", "2026-06-05")],
      }),
    );
    expect(moFriFallback.expectedMinutes).toBe(2520);
  });

  // (h) D-06: hire Mon 15.06.2026 — effective range 15.-30.06. has 12 Mo-Fr days
  // (15,16,17,18,19,22,23,24,25,26,29,30). Expected = round(2640*12/22) = round(1440) = 1440
  // (the FULL calendar month's 22 workdays is the denominator, not the 12-day range — D-06).
  // A manual holiday on 10.06. (BEFORE the hire date) is filtered out of the range entirely
  // -> still 1440. A leave day on Wed 17.06. (inside the range) reduces by round(2640/22)=120
  // (full-month denominator, same value as a full-month day) -> 1440-120=1320.
  it("(h) D-06 hire month — full-month denominator, pre-hire holiday ignored", () => {
    const hireInRange = baseInput({ hireDate: new Date("2026-06-15T00:00:00Z") });
    const noExtra = closeEmployeeMonth(hireInRange);
    expect(noExtra.expectedMinutes).toBe(1440);

    const preHireHoliday = closeEmployeeMonth({
      ...hireInRange,
      holidayDateStrings: new Set(["2026-06-10"]),
    });
    expect(preHireHoliday.expectedMinutes).toBe(1440);

    const leaveInRange = closeEmployeeMonth({
      ...hireInRange,
      approvedLeave: [mkLeave("2026-06-17", "2026-06-17")],
    });
    expect(leaveInRange.expectedMinutes).toBe(1320);
  });

  // (i) D-06: exit Fri 10.07.2026, July 2026 (starts Wednesday, 23 Mo-Fr days). Effective
  // range 01.-10.07. has 8 Mo-Fr days (01,02,03,06,07,08,09,10). Expected =
  // round(2640*8/23) = round(918.26) = 918 (full calendar month denominator). A leave day on
  // Wed 08.07. (inside the range) reduces by round(2640/23) = round(114.78) = 115 ->
  // 918-115=803. A leave day on Mon 13.07. (AFTER the exit) is clipped to nothing -> 918.
  it("(i) D-06 exit month — full-month denominator, post-exit leave clipped", () => {
    const bounds = julyBounds();
    const exitInput: CloseMonthInput = {
      ...baseInput(),
      ...bounds,
      exitDate: new Date("2026-07-10T00:00:00Z"),
    };
    const noExtra = closeEmployeeMonth(exitInput);
    expect(noExtra.expectedMinutes).toBe(918);

    const leaveInRange = closeEmployeeMonth({
      ...exitInput,
      approvedLeave: [mkLeave("2026-07-08", "2026-07-08")],
    });
    expect(leaveInRange.expectedMinutes).toBe(803);

    const leaveAfterExit = closeEmployeeMonth({
      ...exitInput,
      approvedLeave: [mkLeave("2026-07-13", "2026-07-13")],
    });
    expect(leaveAfterExit.expectedMinutes).toBe(918);
  });

  // (j) D-08: a full-month leave row (01.-30.06., all 22 Mo-Fr days) PLUS a manual holiday
  // on 10.06. (a Mo-Fr day inside that same range). The holiday is deducted once (120,
  // holidayMinutes) and excluded from the leave row's numerator (the leave row then credits
  // the remaining 21 days: round(2640*21/22)=round(2520)=2520). Total reduction =
  // 120+2520=2640, exactly the full owed Soll -> expectedMinutes = max(0, 2640-2640) = 0,
  // never negative.
  it("(j) D-08 floor at 0 — full-month leave plus a holiday inside it never goes negative", () => {
    const result = closeEmployeeMonth(
      baseInput({
        holidayDateStrings: new Set(["2026-06-10"]),
        approvedLeave: [mkLeave("2026-06-01", "2026-06-30")],
      }),
    );
    expect(result.expectedMinutes).toBe(0);
    expect(result.expectedMinutes).toBeGreaterThanOrEqual(0);
  });

  // (k) D-10: overtimeMode=TRACK_ONLY still gets the Soll reduction (2040, same as case c's
  // full week) but effectiveCarryOverOut is forced to 0 regardless of the balance.
  it("(k) D-10 TRACK_ONLY still reduces Soll but zeroes carry-over only", () => {
    const result = closeEmployeeMonth(
      baseInput({
        schedule: { ...MH_44, overtimeMode: "TRACK_ONLY" },
        approvedLeave: [mkLeave("2026-06-15", "2026-06-19")],
      }),
    );
    expect(result.expectedMinutes).toBe(2040);
    expect(result.effectiveCarryOverOut).toBe(0);
  });

  // (l) BS once: a VOCATIONAL_SCHOOL/PATTERN absence on Tue 09.06. does not reduce the
  // MONTHLY_HOURS Soll at all (D-07 skip) — expectedMinutes stays the full 2640, and whatever
  // the BS loop credits appears only on the worked side (D-04), so
  // balanceMinutes === workedMinutes - 2640. The same holds for a VOCATIONAL_SCHOOL/MANUAL row.
  it("(l) D-07 a Berufsschultag never reduces the MONTHLY_HOURS Soll (PATTERN or MANUAL)", () => {
    const pattern = closeEmployeeMonth(
      baseInput({
        absences: [mkAbsence("2026-06-09", "2026-06-09", "VOCATIONAL_SCHOOL", "PATTERN")],
      }),
    );
    expect(pattern.expectedMinutes).toBe(2640);
    expect(pattern.balanceMinutes).toBe(pattern.workedMinutes - 2640);

    const manual = closeEmployeeMonth(
      baseInput({
        absences: [mkAbsence("2026-06-09", "2026-06-09", "VOCATIONAL_SCHOOL", "MANUAL")],
      }),
    );
    expect(manual.expectedMinutes).toBe(2640);
    expect(manual.balanceMinutes).toBe(manual.workedMinutes - 2640);
  });

  // (m) Issue #220: an OVERTIME_COMP leave day on Wed 10.06. credits the Soll by the same
  // 120 as any other leave day (expectedMinutes 2520, like case b's holiday) AND withdraws
  // exactly that credit from the balance (overtimeCompensationMinutes=120) — so the net
  // balanceMinutes equals case (a)'s balance (-2640): credit == withdrawal.
  it("(m) Issue #220 OVERTIME_COMP credit == withdrawal — net balance unchanged vs. (a)", () => {
    const baseline = closeEmployeeMonth(baseInput());
    const result = closeEmployeeMonth(
      baseInput({
        approvedLeave: [mkLeave("2026-06-10", "2026-06-10", { isOvertimeCompensation: true })],
      }),
    );
    expect(result.expectedMinutes).toBe(2520);
    expect(result.overtimeCompensationMinutes).toBe(120);
    expect(result.balanceMinutes).toBe(baseline.balanceMinutes);
  });

  // (n) D-01: monthlyHours null or 0 (pure tracking) is unchanged by D-02..D-09 — leave,
  // holiday and absence all reduce nothing (the Ø-rate core's own mh<=0 guard returns 0 for
  // the full Soll, leave/absence AND holiday branches alike). expectedMinutes stays 0,
  // overtimeCompensationMinutes stays 0, and the balance is exactly the worked minutes.
  it("(n) monthlyHours null or 0 — pure tracking unaffected by leave/holiday/absence", () => {
    for (const mh of [null, 0]) {
      const schedule = { ...MH_44, monthlyHours: mh };
      const result = closeEmployeeMonth(
        baseInput({
          schedule,
          holidayDateStrings: new Set(["2026-06-10"]),
          approvedLeave: [mkLeave("2026-06-15", "2026-06-15")],
          absences: [mkAbsence("2026-06-18", "2026-06-18", "SICK")],
          entries: [
            {
              date: new Date("2026-06-01T00:00:00Z"),
              startTime: new Date("2026-06-01T08:00:00Z"),
              endTime: new Date("2026-06-01T16:00:00Z"),
              breakMinutes: 0,
            },
          ],
        }),
      );
      expect(result.expectedMinutes).toBe(0);
      expect(result.overtimeCompensationMinutes).toBe(0);
      expect(result.balanceMinutes).toBe(result.workedMinutes);
    }
  });
});
