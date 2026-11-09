// Issue #845 — the derivations of Ich › Mein Tag (day goal, Stundenkonto, next shift, history).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  dayGoalMinutes,
  saldoFigure,
  nextOwnShift,
  historySentences,
  type MyWeekDay,
} from "../mein-tag";
import { FORECAST_LABEL_CURRENT_MONTH } from "$lib/saldo/forecast-label";

const day = (over: Partial<MyWeekDay>): MyWeekDay => ({
  date: "2026-11-09",
  expectedHours: 8,
  isWorkday: true,
  holidayName: null,
  leaveType: null,
  absenceType: null,
  ...over,
});

describe("dayGoalMinutes (D-845-01)", () => {
  // A 32 h contract Tue–Fri: Monday is no contractual workday, Tuesday owes 8 h.
  it("gives no goal on the Monday of a 32 h Tue–Fri contract", () => {
    expect(
      dayGoalMinutes(
        "FIXED_SCHEDULE",
        day({ date: "2026-11-09", isWorkday: false, expectedHours: 0 }),
      ),
    ).toBeNull();
  });
  it("gives the contract Soll on a workday of that contract", () => {
    expect(dayGoalMinutes("FIXED_SCHEDULE", day({ date: "2026-11-10", expectedHours: 8 }))).toBe(
      480,
    );
    expect(dayGoalMinutes("FIXED_SCHEDULE", day({ expectedHours: 6.5 }))).toBe(390);
  });
  it("never a fixed 8 h: no goal for placeholder day hours", () => {
    for (const t of ["FLEXTIME", "MONTHLY_HOURS", "SHIFT_BASED", null, undefined]) {
      expect(dayGoalMinutes(t, day({ expectedHours: 8 }))).toBeNull();
    }
  });
  it("no goal on a holiday, a leave or an absence day", () => {
    expect(dayGoalMinutes("FIXED_SCHEDULE", day({ holidayName: "Neujahr" }))).toBeNull();
    expect(dayGoalMinutes("FIXED_SCHEDULE", day({ leaveType: "Urlaub" }))).toBeNull();
    expect(dayGoalMinutes("FIXED_SCHEDULE", day({ absenceType: "VOCATIONAL_SCHOOL" }))).toBeNull();
    expect(dayGoalMinutes("FIXED_SCHEDULE", null)).toBeNull();
  });
});

describe("saldoFigure (D-04, D-845-03)", () => {
  it("is confirmed + open period with a plain derivation", () => {
    const f = saldoFigure({
      balanceHours: 1.9167,
      confirmedMinutes: 0,
      openMonthMinutes: 115,
      hasClosedMonth: true,
      unconfirmedMonths: 1,
    });
    expect(f.value).toBe("+1:55");
    expect(f.minutes).toBe(115);
    expect(f.explanation).toBe(`Bestätigt ±0:00 · ${FORECAST_LABEL_CURRENT_MONTH} +1:55`);
    expect(f.forecast).toBe(true);
  });
  it("falls back to the endpoint total without a split", () => {
    const f = saldoFigure({ balanceHours: -2.5 });
    expect(f.value).toBe("−2:30");
    expect(f.minutes).toBe(-150);
  });
});

describe("Stundenkonto parity (AC: same figure as GET /overtime/:id on /time-entries)", () => {
  const src = readFileSync(
    resolve(__dirname, "../../../routes/(app)/dashboard/+page.svelte"),
    "utf8",
  );
  it("Mein Tag reads GET /overtime/:employeeId and words it only through saldoFigure()", () => {
    expect(src).toMatch(/api\.get<OvertimeAnswer>\(`\/overtime\/\$\{/);
    expect(src).toMatch(/saldoFigure\(/);
  });
  it("the Zeiten page reads the same endpoint", () => {
    const te = readFileSync(
      resolve(__dirname, "../../../routes/(app)/time-entries/+page.svelte"),
      "utf8",
    );
    expect(te).toMatch(/`\/overtime\/\$\{activeEmpId\}`/);
  });
});

describe("nextOwnShift (D-845-07)", () => {
  const weeks = [
    {
      days: [
        {
          date: "2026-11-09",
          ownShifts: [{ startTime: "08:00", endTime: "12:00", label: "Früh" }],
        },
        { date: "2026-11-10", ownShifts: [{ startTime: "10:00", endTime: "18:30" }] },
      ],
    },
  ];
  it("skips a shift that already started today", () => {
    expect(nextOwnShift(weeks, "2026-11-09", "09:00")).toEqual({
      date: "2026-11-10",
      startTime: "10:00",
      endTime: "18:30",
      name: null,
    });
  });
  it("keeps a later shift of today", () => {
    expect(nextOwnShift(weeks, "2026-11-09", "07:30")?.name).toBe("Früh");
  });
  it("is null without any shift", () => {
    expect(nextOwnShift([{ days: [] }], "2026-11-09", "07:30")).toBeNull();
  });
});

describe("historySentences (D-05)", () => {
  it("joins who + what into one sentence and drops duplicates", () => {
    const out = historySentences([
      { id: "1", who: "Du", what: "hast um 18:15 ausgestempelt.", when: "a" },
      { id: "2", who: "Du", what: "hast um 18:15 ausgestempelt.", when: "b" },
      { id: "3", who: "Sabine", what: "hat deinen Urlaub genehmigt.", when: "c" },
    ]);
    expect(out.map((s) => s.text)).toEqual([
      "Du hast um 18:15 ausgestempelt.",
      "Sabine hat deinen Urlaub genehmigt.",
    ]);
  });
});
