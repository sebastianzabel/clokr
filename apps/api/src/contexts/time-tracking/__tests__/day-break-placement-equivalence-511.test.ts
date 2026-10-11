/**
 * Issue #511 — the placement evaluation is ADDITIVE: it never moves a Phase-80 result.
 *
 * The left side of (a) is `./fixtures/legacy-day-warnings-pre80.ts`, the frozen verbatim pre-80 day
 * statements, imported read-only (the frozen equivalence test and its fixture are never edited).
 * The right side is what `checkArbZG` runs today, now with an explicit `regime`.
 *
 *   (a) every single-entry day: `dayLimitWarnings` equals the frozen warnings byte for byte;
 *   (b) the new `placement` of a day without Break rows says exactly two things — BREAK_TOO_LATE
 *       when nothing was recorded and the entry runs past six hours, the position-unknown hint when
 *       a sum was recorded, enough, and the entry runs past six hours — and nothing else;
 *   (c) a sensitivity floor: with a drifted block limit the predicate of (b) must stop holding.
 *
 * DB-free, fixed UTC instants including both 2026 Europe/Berlin DST switch days, no clock and no
 * randomness. Every matrix asserts a case-count floor so a generator that produces nothing turns the
 * test red instead of green.
 */
import { describe, it, expect } from "vitest";
import { evaluateDayBreaks, type DayBreakRow } from "../day-break-rule";
import { dayLimitWarnings } from "../arbzg";
import { BREAK_REGIMES } from "../break-regime";
import { evaluatePlacement } from "../day-break-placement";
import {
  legacyDayWarningsPre80,
  type LegacyDaySlot,
  type LegacyDayWarning,
} from "./fixtures/legacy-day-warnings-pre80";

const MS_MIN = 60_000;
const MS_H = 3_600_000;

// 2026-03-29 and 2026-10-25 are the Europe/Berlin DST switch days.
const DAYS = ["2026-02-02", "2026-03-28", "2026-03-29", "2026-06-15", "2026-10-24", "2026-10-25"];
const DURATIONS_MS: number[] = [
  0,
  1 * MS_MIN,
  4 * MS_H + 31 * MS_MIN,
  5 * MS_H + 59 * MS_MIN,
  6 * MS_H,
  6 * MS_H + 1,
  6 * MS_H + 1 * MS_MIN,
  6 * MS_H + 30 * MS_MIN,
  8 * MS_H,
  9 * MS_H,
  9 * MS_H + 1,
  9 * MS_H + 1 * MS_MIN,
  9 * MS_H + 30 * MS_MIN,
  10 * MS_H,
  10 * MS_H + 1 * MS_MIN,
  12 * MS_H,
];
const BREAKS = [0, 15, 29, 30, 44, 45, 60];
const STATUSES = ["AUTO", "CONFIRMED", "WAIVED"] as const;
const BS_MINUTES = [0, 240, 570];

type Row = DayBreakRow & LegacyDaySlot & { endTime: Date };

let idSeq = 0;
function makeRow(day: string, durationMs: number, breakMinutes: number, status: string): Row {
  idSeq += 1;
  const start = Date.parse(`${day}T00:00:00.000Z`) + 8 * MS_H;
  return {
    id: `r${String(idSeq).padStart(6, "0")}`,
    startTime: new Date(start),
    endTime: new Date(start + durationMs),
    breakMinutes,
    breakStatus: status,
    salonId: "salon-a",
  };
}

interface Case {
  row: Row;
  bs: number;
  durationMs: number;
  breakMinutes: number;
}

const CASES: Case[] = (() => {
  const cases: Case[] = [];
  for (const day of DAYS) {
    for (const durationMs of DURATIONS_MS) {
      for (const breakMinutes of BREAKS) {
        for (const status of STATUSES) {
          for (const bs of BS_MINUTES) {
            cases.push({
              row: makeRow(day, durationMs, breakMinutes, status),
              bs,
              durationMs,
              breakMinutes,
            });
          }
        }
      }
    }
  }
  return cases;
})();

/** What the placement of a single entry without Break rows must say, from first principles. */
function expectedCodes(c: Case, legacyBreakShortfall: boolean): string[] {
  const overSixHours = c.durationMs > 6 * MS_H;
  if (!overSixHours) return [];
  if (c.breakMinutes === 0) return ["BREAK_TOO_LATE"];
  return legacyBreakShortfall ? [] : ["BREAK_POSITION_UNKNOWN"];
}

describe("Issue #511 (a) — dayLimitWarnings of a single-entry day is the frozen pre-80 output", () => {
  it("is identical for the full matrix with an explicit adult regime", () => {
    let withFinding = 0;
    const mismatches: string[] = [];
    for (const c of CASES) {
      const legacy = legacyDayWarningsPre80([c.row], c.bs);
      const current = dayLimitWarnings(
        evaluateDayBreaks({ rows: [c.row], dayBreaks: [], acks: [], regime: "ARBZG_4" }),
        c.bs,
      ) as LegacyDayWarning[];
      if (legacy.length > 0) withFinding++;
      if (JSON.stringify(current) !== JSON.stringify(legacy)) {
        mismatches.push(JSON.stringify([c.durationMs, c.breakMinutes, c.bs, c.row.breakStatus]));
      }
    }
    expect(CASES.length).toBeGreaterThan(3000);
    expect(withFinding).toBeGreaterThan(500);
    expect(mismatches).toHaveLength(0);
  });
});

describe("Issue #511 (b) — the placement of a day without Break rows is the two additive statements", () => {
  it("says BREAK_TOO_LATE or the hint exactly where the predicate says so", () => {
    let late = 0;
    let hint = 0;
    const mismatches: string[] = [];
    for (const c of CASES) {
      const ev = evaluateDayBreaks({ rows: [c.row], dayBreaks: [], acks: [], regime: "ARBZG_4" });
      const actual = ev.placement.findings.map((f) => f.code).sort();
      const expected = expectedCodes(c, ev.breakShortfall);
      if (actual.includes("BREAK_TOO_LATE")) late++;
      if (actual.includes("BREAK_POSITION_UNKNOWN")) hint++;
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatches.push(JSON.stringify([c.durationMs, c.breakMinutes, actual, expected]));
      }
    }
    expect(late).toBeGreaterThan(100);
    expect(hint).toBeGreaterThan(100);
    expect(mismatches).toHaveLength(0);
  });
});

describe("Issue #511 (c) — sensitivity floor", () => {
  it("a drifted block limit breaks the predicate of (b)", () => {
    const drifted = { ...BREAK_REGIMES.ARBZG_4, maxBlockMin: 300 };
    let mismatches = 0;
    for (const c of CASES) {
      const ev = evaluateDayBreaks({ rows: [c.row], dayBreaks: [], acks: [], regime: "ARBZG_4" });
      const placement = evaluatePlacement(
        {
          rows: [c.row],
          breakSegments: ev.breakSegments,
          gaps: ev.gaps,
          netWorkedMin: ev.netWorkedMin,
          legacyBreakShortfall: ev.breakShortfall,
        },
        drifted,
      );
      const actual = placement.findings.map((f) => f.code).sort();
      if (JSON.stringify(actual) !== JSON.stringify(expectedCodes(c, ev.breakShortfall))) {
        mismatches++;
      }
    }
    expect(mismatches).toBeGreaterThan(0);
  });
});
