/**
 * four-model-leave-analysis-429.test.ts
 *
 * Issue #429 — the committed, asserting four-model analysis that replaces the
 * orchestrator's throwaway spot-check script (`apps/api/p429-analysis.tmp.ts`, deleted by
 * this plan). Ports its exact scenario constructions (schedules, entries, shifts, leave
 * ranges — June 2026, week 08.-14.06) into vitest `describe`/`it` blocks that ASSERT the
 * numbers instead of `console.log`-ing them.
 *
 * PURE unit tests: no DB, no `getTestApp` — same style as
 * `shift-based-leave-week-soll-429.test.ts`.
 *
 * FIXED_SCHEDULE / FLEXTIME: pins the "Heute (Code)" values from 429-CONTEXT.md's
 * `<analysis_results>` table — UNCHANGED by this phase (a pin, not a new expectation).
 * MONTHLY_HOURS's B-scenario Minusstunden-durch-Urlaub was D-12's deliberately DEFERRED fix
 * (follow-up Issue #433) — that fix has now landed (owner decision 2026-10-03): leave
 * reduces the owed monthly Soll by the Ø-Methode value instead of producing minus hours.
 * See the comment on each MONTHLY_HOURS case for the derivation.
 *
 * SHIFT_BASED: pins the CORRECTED values this plan produces (+180/+180/0 minutes for
 * A/A2/B across all three `workDays` variants) — cross-referencing
 * `shift-based-leave-week-soll-429.test.ts`, the focused regression/invariant suite, rather
 * than re-deriving the numbers by hand. This file exists so the full four-model picture
 * (what changed, what didn't) lives in one place.
 */
import { describe, it, expect } from "vitest";
import {
  closeEmployeeMonth,
  toCloseMonthApprovedLeave,
  type CloseMonthInput,
} from "../contexts/working-time-account/close-employee-month";
import { monthRangeUtc, monthDayBounds } from "../contexts/working-time-account/timezone";

const TZ = "Europe/Berlin";
const { start: monthStart, end: monthEnd } = monthRangeUtc(2026, 6, TZ);
const { firstDay, lastDay } = monthDayBounds(monthStart, monthEnd, TZ);

const D = (s: string) => new Date(s + "T00:00:00Z");

function daysOfJune(): string[] {
  const out: string[] = [];
  for (let d = 1; d <= 30; d++) out.push(`2026-06-${String(d).padStart(2, "0")}`);
  return out;
}
const dow = (s: string) => D(s).getUTCDay();
const WEEK = [
  "2026-06-08",
  "2026-06-09",
  "2026-06-10",
  "2026-06-11",
  "2026-06-12",
  "2026-06-13",
  "2026-06-14",
];
const inWeek = (d: string) => WEEK.includes(d);

function entry(ds: string, netMin: number) {
  return {
    date: D(ds),
    startTime: new Date(ds + "T06:00:00Z"),
    endTime: new Date(D(ds).getTime() + 6 * 3600e3 + netMin * 60e3),
    breakMinutes: 0,
  };
}
function shift(ds: string, netMin: number) {
  const brk = netMin + 45 > 9 * 60 ? 45 : netMin + 30 > 6 * 60 ? 30 : 0;
  const s = 8 * 60;
  const e = s + netMin + brk;
  const hm = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return { date: D(ds), startTime: hm(s), endTime: hm(e) };
}

type Sched = Record<string, unknown>;
type Leave = { s: string; e: string; half?: boolean };

function run(
  schedule: Sched,
  perDay: (ds: string) => number,
  leave: Leave[],
  shiftsFn: (ds: string) => number = () => 0,
) {
  const days = daysOfJune();
  const input: CloseMonthInput = {
    employeeId: "x",
    monthStart,
    monthEnd,
    monthFirstDay: firstDay,
    monthLastDay: lastDay,
    tz: TZ,
    carryOverIn: 0,
    schedule,
    hireDate: D("2025-01-01"),
    exitDate: null,
    isTimeTrackingExempt: false,
    breakOver6hOverride: null,
    breakOver9hOverride: null,
    entries: days.filter((d) => perDay(d) > 0).map((d) => entry(d, perDay(d))),
    shifts: days.filter((d) => shiftsFn(d) > 0).map((d) => shift(d, shiftsFn(d))),
    approvedLeave: toCloseMonthApprovedLeave(
      leave.map((l) => ({
        startDate: D(l.s),
        endDate: D(l.e),
        halfDay: Boolean(l.half),
        leaveType: { code: "VACATION" },
      })),
    ),
    absences: [],
    holidayDateStrings: new Set(),
    tenantConfig: { defaultBreakOver6h: 30, defaultBreakOver9h: 45 },
  };
  return closeEmployeeMonth(input);
}

/** Week effect: this scenario's month balanceMinutes minus the baseline month's. */
function weekEffect(
  schedule: Sched,
  base: (ds: string) => number,
  scenario: { perDay: (ds: string) => number; leave: Leave[]; shifts?: (ds: string) => number },
  baseShifts?: (ds: string) => number,
): number {
  const b = run(schedule, base, [], baseShifts);
  const r = run(schedule, scenario.perDay, scenario.leave, scenario.shifts ?? baseShifts);
  return r.balanceMinutes - b.balanceMinutes;
}

function fixedSchedule(type: string): Sched {
  return {
    type,
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
}

describe("Issue #429 — four-model analysis (FIXED_SCHEDULE/FLEXTIME unchanged, SHIFT_BASED corrected, MONTHLY_HOURS updated by Issue #433)", () => {
  describe.each(["FIXED_SCHEDULE", "FLEXTIME"])(
    "%s 40h Mo-Fr — unchanged by this phase",
    (type) => {
      const schedule = fixedSchedule(type);
      const base = (d: string) => (dow(d) >= 1 && dow(d) <= 5 ? 480 : 0);

      it("A — leave Mon + Tue-Fri 10h each -> +480 min (8h)", () => {
        const effect = weekEffect(
          schedule,
          base,
          {
            perDay: (d) => (inWeek(d) ? (dow(d) >= 2 && dow(d) <= 5 ? 600 : 0) : base(d)),
            leave: [{ s: "2026-06-08", e: "2026-06-08" }],
          },
          base,
        );
        expect(effect).toBe(480);
      });

      it("B — whole week leave -> 0 min", () => {
        const effect = weekEffect(
          schedule,
          base,
          {
            perDay: (d) => (inWeek(d) ? 0 : base(d)),
            leave: [{ s: "2026-06-08", e: "2026-06-14" }],
          },
          base,
        );
        expect(effect).toBe(0);
      });
    },
  );

  describe("MONTHLY_HOURS 44h/Monat (Tagesstunden 0 = Prod-Form) — Issue #433 owed monthly Soll (Ø-Methode)", () => {
    const schedule: Sched = {
      type: "MONTHLY_HOURS",
      monthlyHours: 44,
      weeklyHours: 0,
      mondayHours: 0,
      tuesdayHours: 0,
      wednesdayHours: 0,
      thursdayHours: 0,
      fridayHours: 0,
      saturdayHours: 0,
      sundayHours: 0,
      workDays: [1, 2, 3, 4, 5],
      overtimeMode: "CARRY_FORWARD",
    };
    const base = (d: string) => (dow(d) >= 1 && dow(d) <= 5 ? 120 : 0);

    // Derivation shared by both cases below: June 2026 has 22 Mo-Fr workdays; the
    // per-workday Ø-Methode value is round(44h × 60 ÷ 22) = 120 min (= base's daily rate,
    // by construction of this fixture).

    it("A — leave Mon + Tue-Fri 3h each -> +240 min (4h), owed Soll reduced by 1 leave day (Issue #433)", () => {
      // Baseline (no leave): workedMinutes = expectedMinutes = 22 × 120 = 2640 -> balance 0.
      // Scenario: 1 leave day (Mon) -> leaveMinutes = round(2640 × 1 ÷ 22) = 120;
      //   expectedMinutes = 2640 − 120 = 2520.
      //   workedMinutes = 2640 (baseline) − 120 (Monday, now 0) + 4×60 (Tue-Fri extra 60 min
      //     each, 180 instead of 120) = 2760.
      //   balance = 2760 − 2520 = 240 ; effect = 240 − 0 = 240.
      // OLD (superseded "hart 0" rule): leave did not reduce the Soll at all -> effect 120.
      const effect = weekEffect(
        schedule,
        base,
        {
          perDay: (d) => (inWeek(d) ? (dow(d) >= 2 && dow(d) <= 5 ? 180 : 0) : base(d)),
          leave: [{ s: "2026-06-08", e: "2026-06-08" }],
        },
        base,
      );
      expect(effect).toBe(240);
    });

    it("B — whole week leave -> 0 min (owed Soll reduced by the same 5 leave days not worked, Issue #433)", () => {
      // Issue #433 (owner decision 2026-10-03, D-01/D-02): monthlyHours is an OWED monthly
      // Soll — D-12's deferred fix has landed. 5 Mo-Fr leave days of 22:
      //   leaveMinutes = round(2640 × 5 ÷ 22) = 600 ; expectedMinutes = 2640 − 600 = 2040.
      //   workedMinutes = 2640 − 5×120 (the 5 leave days, now 0) = 2040.
      //   balance = 2040 − 2040 = 0 ; effect = 0 − 0 = 0.
      // OLD (superseded "hart 0" rule) pinned -600 (-10h, Minusstunden durch Urlaub) — the
      // exact issue-#433 repro: a full leave week used to cost 10 hours of balance.
      const effect = weekEffect(
        schedule,
        base,
        { perDay: (d) => (inWeek(d) ? 0 : base(d)), leave: [{ s: "2026-06-08", e: "2026-06-14" }] },
        base,
      );
      expect(effect).toBe(0);
    });
  });

  it("MONTHLY_HOURS 44h/Monat (Tagesstunden 2) — B whole week leave -> 0 min (Issue #433, workDays wins over {day}Hours)", () => {
    // Same workDays=[1,2,3,4,5] as the "Tagesstunden 0" fixture above -> D-05 reads workDays,
    // never {day}Hours, so this non-zero {day}Hours value is irrelevant and the result is
    // byte-identical to the "Tagesstunden 0" B case: effect 0 (was -600 under the superseded rule).
    const schedule: Sched = {
      type: "MONTHLY_HOURS",
      monthlyHours: 44,
      weeklyHours: 0,
      mondayHours: 2,
      tuesdayHours: 2,
      wednesdayHours: 2,
      thursdayHours: 2,
      fridayHours: 2,
      saturdayHours: 0,
      sundayHours: 0,
      workDays: [1, 2, 3, 4, 5],
      overtimeMode: "CARRY_FORWARD",
    };
    const base = (d: string) => (dow(d) >= 1 && dow(d) <= 5 ? 120 : 0);
    const effect = weekEffect(
      schedule,
      base,
      { perDay: (d) => (inWeek(d) ? 0 : base(d)), leave: [{ s: "2026-06-08", e: "2026-06-14" }] },
      base,
    );
    expect(effect).toBe(0);
  });

  it("MONTHLY_HOURS ohne Monats-Soll (monthlyHours 0) — B whole week leave -> -600 min, unchanged (Issue #433: pure tracking has no Soll to reduce)", () => {
    // D-01 (owner decision 2026-10-03): monthlyHours null/0 stays pure tracking — there is no
    // owed Soll for leave to reduce, so a leave week simply means less worked time with no
    // Soll-side compensation (both monthlyHoursMinutesCore and the old code return 0 for
    // expectedMinutes here). This is the ONE MONTHLY_HOURS case genuinely unaffected by #433.
    const schedule: Sched = {
      type: "MONTHLY_HOURS",
      monthlyHours: 0,
      weeklyHours: 0,
      mondayHours: 0,
      tuesdayHours: 0,
      wednesdayHours: 0,
      thursdayHours: 0,
      fridayHours: 0,
      saturdayHours: 0,
      sundayHours: 0,
      workDays: [1, 2, 3, 4, 5],
      overtimeMode: "CARRY_FORWARD",
    };
    const base = (d: string) => (dow(d) >= 1 && dow(d) <= 5 ? 120 : 0);
    const effect = weekEffect(
      schedule,
      base,
      { perDay: (d) => (inWeek(d) ? 0 : base(d)), leave: [{ s: "2026-06-08", e: "2026-06-14" }] },
      base,
    );
    expect(effect).toBe(-600);
  });

  describe.each([
    { label: "Mo-Sa", workDays: [1, 2, 3, 4, 5, 6] },
    { label: "Mo-Fr", workDays: [1, 2, 3, 4, 5] },
    { label: "Mo-Do", workDays: [1, 2, 3, 4] },
  ])("SHIFT_BASED 38h/4 Tage workDays=$label — CORRECTED by this phase", ({ workDays }) => {
    const schedule: Sched = {
      type: "SHIFT_BASED",
      weeklyHours: 38,
      contractWorkDaysPerWeek: 4,
      workDays,
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 8,
      sundayHours: 0,
    };
    const base = (d: string) => (dow(d) >= 1 && dow(d) <= 4 ? 570 : 0);

    it("A — issue's own example: leave Mon unplanned + Tue-Thu 10.5h each -> +180 min (was -10/+66/+180 before #429)", () => {
      const scenA = (d: string) => (inWeek(d) ? (dow(d) >= 2 && dow(d) <= 4 ? 630 : 0) : base(d));
      const effect = weekEffect(schedule, base, {
        perDay: scenA,
        shifts: scenA,
        leave: [{ s: "2026-06-08", e: "2026-06-08" }],
      });
      expect(effect).toBe(180);
    });

    it("A2 — leave Sat unplanned + Mon-Wed 10.5h each -> +180 min (was -228/0 before #429)", () => {
      const scenA2 = (d: string) => (inWeek(d) ? (dow(d) >= 1 && dow(d) <= 3 ? 630 : 0) : base(d));
      const effect = weekEffect(schedule, base, {
        perDay: scenA2,
        shifts: scenA2,
        leave: [{ s: "2026-06-13", e: "2026-06-13" }],
      });
      expect(effect).toBe(180);
    });

    it("B — whole Mo-Sa leave week, no plan -> 0 min (unchanged before/after #429)", () => {
      const scenB = (d: string) => (inWeek(d) ? 0 : base(d));
      const effect = weekEffect(schedule, base, {
        perDay: scenB,
        shifts: scenB,
        leave: [{ s: "2026-06-08", e: "2026-06-13" }],
      });
      expect(effect).toBe(0);
    });
  });
});
