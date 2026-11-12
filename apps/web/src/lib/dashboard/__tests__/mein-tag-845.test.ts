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
  it("the derivation link goes to Ich › Konto once that page exists (#851), else to Zeiten", () => {
    expect(src).toMatch(
      /mayOpenPath\(\$authStore\.user, "\/ich\/konto"\) \? "\/ich\/konto" : "\/ich\/zeiten"/,
    );
    expect(src).toMatch(/derivationHref: kontoHref/);
  });
  // Issue #851 moved the own Stundenkonto from Zeiten to Ich › Konto (the derivation link above), so
  // the parity partner of Mein Tag is that page: it must read the same lifetime endpoint.
  it("the Konto page, home of the own total since #851, reads the same endpoint", () => {
    const konto = readFileSync(
      resolve(__dirname, "../../../routes/(app)/ich/konto/+page.svelte"),
      "utf8",
    );
    expect(konto).toMatch(/api\.get<OvertimeAnswer>\(`\/overtime\/\$\{id\}`\)/);
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

// ── Owner acceptance 09.11.2026 (prototype v5) ────────────────────────────────────────────────
import {
  saldoMonthsLine,
  nextPlannedDay,
  plannedDaysCount,
  weekStripText,
  recentDays,
} from "../mein-tag";

describe("saldoMonthsLine — one short line by month, no sentence", () => {
  it("„Okt ±0:00 · Nov +1:55“ with one open month", () => {
    expect(
      saldoMonthsLine(
        {
          balanceHours: 0,
          confirmedMinutes: 0,
          openMonthMinutes: 115,
          hasClosedMonth: true,
          unconfirmedMonths: 1,
        },
        "2026-11-09",
      ),
    ).toBe("Okt ±0:00 · Nov +1:55");
  });
  it("several open months read „seitdem“; January wraps to December", () => {
    expect(
      saldoMonthsLine(
        {
          balanceHours: 0,
          confirmedMinutes: -60,
          openMonthMinutes: 30,
          hasClosedMonth: true,
          unconfirmedMonths: 2,
        },
        "2027-01-05",
      ),
    ).toBe("Nov −1:00 · seitdem +0:30");
  });
  it("without a closed month", () => {
    expect(
      saldoMonthsLine(
        { balanceHours: 0, confirmedMinutes: 0, openMonthMinutes: 45, hasClosedMonth: false },
        "2026-11-09",
      ),
    ).toBe("seit Eintritt +0:45");
  });
});

describe("next planned day and the week strip (32 h Tue–Fri)", () => {
  const week = [
    day({ date: "2026-11-09", isWorkday: false, expectedHours: 0 }),
    day({ date: "2026-11-10", expectedHours: 8 }),
    day({ date: "2026-11-11", expectedHours: 8 }),
    day({ date: "2026-11-14", isWorkday: false, expectedHours: 0 }),
  ];
  it("a fixed contract names the next contractual workday, never „keine geplant“", () => {
    expect(nextPlannedDay(week, null, "FIXED_SCHEDULE", "2026-11-09")).toEqual({
      date: "2026-11-10",
      text: "8:00 geplant",
    });
  });
  it("an own shift wins", () => {
    expect(
      nextPlannedDay(
        week,
        { date: "2026-11-12", startTime: "10:00", endTime: "18:30", name: null },
        "SHIFT_BASED",
        "2026-11-09",
      ),
    ).toEqual({ date: "2026-11-12", text: "10:00–18:30" });
  });
  it("counts planned days and words each strip cell", () => {
    expect(plannedDaysCount(week, "FIXED_SCHEDULE", new Set())).toBe(2);
    expect(weekStripText(week[0], "FIXED_SCHEDULE", null)).toBe("Frei");
    expect(weekStripText(week[1], "FIXED_SCHEDULE", null)).toBe("8:00 h");
    expect(weekStripText(week[1], "FIXED_SCHEDULE", "10:00–18:30")).toBe("10:00–18:30");
    expect(weekStripText(day({ holidayName: "Neujahr" }), "FIXED_SCHEDULE", null)).toBe("Neujahr");
  });
});

describe("recentDays — per day, the saldo as the step of the server's cumulative series", () => {
  const at = (d: string, h: number, m = 0) =>
    new Date(`${d}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`).toISOString();
  const entries = [
    {
      id: "a",
      startTime: at("2026-11-06", 9, 30),
      endTime: at("2026-11-06", 20, 10),
      breakMinutes: 45,
      workingMinutes: 595,
    },
    {
      id: "b",
      startTime: at("2026-10-30", 9, 30),
      endTime: at("2026-10-30", 18, 15),
      breakMinutes: 0,
      workingMinutes: 525,
    },
  ];
  const cum = new Map([
    ["2026-11-05", 0],
    ["2026-11-06", 115],
  ]);
  const totals = (rows: { breakMinutes?: number | null; workingMinutes?: number | null }[]) => ({
    breakMinutes: rows.reduce((s, r) => s + (r.breakMinutes ?? 0), 0),
    workingMinutes: rows.reduce((s, r) => s + (r.workingMinutes ?? 0), 0),
  });
  it("newest first, saldo chip from the series, break finding from the day check", () => {
    const rows = recentDays(entries, cum, new Set(["2026-10-30"]), totals);
    expect(rows.map((r) => r.date)).toEqual(["2026-11-06", "2026-10-30"]);
    expect(rows[0]).toMatchObject({
      start: "09:30",
      end: "20:10",
      saldoMinutes: 115,
      breakMissing: false,
    });
    expect(rows[1]).toMatchObject({ saldoMinutes: null, breakMissing: true });
  });
});
