/**
 * shift-based-kernel-equivalence-436.test.ts
 *
 * Issue #436, D-05/436-AC-02 — with an empty `usualWorkDays` list (= "keine Angabe"), the
 * Phase-436-refactored kernel (`countShiftBasedLeaveDays`, `leaveDaysPerWeek` in
 * `../vacation-calc`) must produce results IDENTICAL to the verbatim pre-436 kernel
 * (`../__tests__/fixtures/legacy-shift-based-kernel-pre436.ts`, frozen at commit a8e4d4b5) over a
 * generated matrix — not just the handful of hand-picked examples in `vacation-calc.test.ts`.
 *
 * Every date is derived from `mondayOfWeekStr()` (the shared tenant-TZ anchor,
 * `apps/api/src/__tests__/test-dates.ts`) — no hardcoded calendar literal, so this file cannot
 * become a time bomb.
 */
import { describe, it, expect } from "vitest";
import { countShiftBasedLeaveDays, leaveDaysPerWeek, type LeaveWeek } from "../vacation-calc";
import {
  legacyCountShiftBasedLeaveDays,
  legacyLeaveDaysPerWeek,
  type LegacyLeaveWeek,
} from "./fixtures/legacy-shift-based-kernel-pre436";
import { mondayOfWeekStr, utcMidnight } from "../../../__tests__/test-dates";

const DAY_MS = 24 * 60 * 60 * 1000;
const MONDAY = mondayOfWeekStr();

/** `n` whole days after the fixture Monday (UTC midnight). n=0 -> Monday, n=6 -> Sunday, … */
function mon(n: number): Date {
  return new Date(utcMidnight(MONDAY).getTime() + n * DAY_MS);
}

/** UTC "YYYY-MM-DD" of a Date — matches the kernel's own date-string format. */
function ds(d: Date): string {
  return d.toISOString().split("T")[0];
}

const HOLIDAY_SETS: Array<[string, Set<string>]> = [
  ["none", new Set()],
  ["a Wednesday", new Set([ds(mon(2))])],
  ["a Saturday", new Set([ds(mon(5))])],
  ["a Sunday", new Set([ds(mon(6))])],
  ["Mon+Fri of week 1", new Set([ds(mon(0)), ds(mon(4))])],
];

describe("D-05 equivalence — countShiftBasedLeaveDays, new (usualWorkDays=[]) vs. legacy pre-436", () => {
  const STARTS = Array.from({ length: 21 }, (_, i) => mon(i));
  const LENGTHS = Array.from({ length: 16 }, (_, i) => i); // 0..15 calendar days
  const CONTRACTS = [1, 2, 3, 4, 5, 6];

  it("matches the legacy kernel over a generated (start, length, contract, holidays) matrix (floor: 5000 cases)", () => {
    let caseCount = 0;
    const mismatches: string[] = [];
    for (const start of STARTS) {
      for (const length of LENGTHS) {
        const end = new Date(start.getTime() + length * DAY_MS);
        for (const contract of CONTRACTS) {
          for (const [label, holidays] of HOLIDAY_SETS) {
            caseCount++;
            const actual = countShiftBasedLeaveDays(start, end, false, contract, holidays, []);
            const legacy = legacyCountShiftBasedLeaveDays(start, end, false, contract, holidays);
            if (actual.days !== legacy.days) {
              mismatches.push(
                `start=${ds(start)} length=${length} contract=${contract} holidays=${label}: new=${actual.days} legacy=${legacy.days}`,
              );
            }
          }
        }
      }
    }
    expect(caseCount).toBeGreaterThan(5000);
    expect(mismatches).toEqual([]);
  });

  it("the halfDay short-circuit (usualWorkDays=[]) matches the legacy kernel across every start/contract/holiday combination", () => {
    let caseCount = 0;
    const mismatches: string[] = [];
    for (const start of STARTS) {
      for (const contract of CONTRACTS) {
        for (const [label, holidays] of HOLIDAY_SETS) {
          caseCount++;
          const actual = countShiftBasedLeaveDays(start, start, true, contract, holidays, []);
          const legacy = legacyCountShiftBasedLeaveDays(start, start, true, contract, holidays);
          if (actual.days !== legacy.days) {
            mismatches.push(
              `start=${ds(start)} contract=${contract} holidays=${label}: new=${actual.days} legacy=${legacy.days}`,
            );
          }
        }
      }
    }
    expect(caseCount).toBeGreaterThan(0);
    expect(mismatches).toEqual([]);
  });
});

type Row = { startDate: Date; endDate: Date; halfDay?: boolean };

function row(offset: number, length: number, halfDay: boolean): Row {
  const start = mon(offset);
  const end = halfDay ? start : mon(offset + length);
  return { startDate: start, endDate: end, halfDay };
}

const ROW_OFFSETS = [0, 3, 7, 10, 13];
const ROW_LENGTHS = [0, 2, 6];

function buildRowShapes(): Row[] {
  const shapes: Row[] = [];
  for (const offset of ROW_OFFSETS) {
    for (const length of ROW_LENGTHS) shapes.push(row(offset, length, false));
    shapes.push(row(offset, 0, true)); // half-day single-date variant at this offset
  }
  return shapes;
}

/** Compares two `LeaveWeek[]`/`LegacyLeaveWeek[]` arrays (same shape, different type names) —
 * weekMonday, days and every dayShares entry, sorted by date for a stable comparison. Returns a
 * list of human-readable diffs (empty = identical). */
function compareWeeks(actual: LeaveWeek[], legacy: LegacyLeaveWeek[]): string[] {
  const diffs: string[] = [];
  if (actual.length !== legacy.length) {
    diffs.push(`week count: new=${actual.length} legacy=${legacy.length}`);
    return diffs;
  }
  for (let i = 0; i < actual.length; i++) {
    const a = actual[i];
    const l = legacy[i];
    if (a.weekMonday !== l.weekMonday) {
      diffs.push(`weekMonday[${i}]: new=${a.weekMonday} legacy=${l.weekMonday}`);
      continue;
    }
    if (Math.abs(a.days - l.days) > 0.5e-10) {
      diffs.push(`days[${a.weekMonday}]: new=${a.days} legacy=${l.days}`);
    }
    const aEntries = Array.from(a.dayShares.entries()).sort((x, y) => x[0].localeCompare(y[0]));
    const lEntries = Array.from(l.dayShares.entries()).sort((x, y) => x[0].localeCompare(y[0]));
    if (aEntries.length !== lEntries.length) {
      diffs.push(
        `dayShares size[${a.weekMonday}]: new=${aEntries.length} legacy=${lEntries.length}`,
      );
      continue;
    }
    for (let j = 0; j < aEntries.length; j++) {
      const [ad, as] = aEntries[j];
      const [ld, ls] = lEntries[j];
      if (ad !== ld || Math.abs(as - ls) > 0.5e-10) {
        diffs.push(`dayShares[${a.weekMonday}][${j}]: new=(${ad},${as}) legacy=(${ld},${ls})`);
      }
    }
  }
  return diffs;
}

describe("D-05 equivalence — leaveDaysPerWeek multi-row union, new (usualWorkDays=[]) vs. legacy pre-436", () => {
  const CONTRACTS = [1, 3, 4, 5, 6];

  it("matches the legacy kernel over a generated two-row union matrix (floor: 2000 cases)", () => {
    const shapes = buildRowShapes();
    let caseCount = 0;
    const mismatches: string[] = [];
    for (const rowA of shapes) {
      for (const rowB of shapes) {
        for (const contract of CONTRACTS) {
          for (const [label, holidays] of HOLIDAY_SETS) {
            caseCount++;
            const rows = [rowA, rowB];
            const actual = leaveDaysPerWeek(rows, contract, holidays);
            const legacy = legacyLeaveDaysPerWeek(rows, contract, holidays);
            const diffs = compareWeeks(actual, legacy);
            if (diffs.length > 0) {
              mismatches.push(
                `rowA=${ds(rowA.startDate)}..${ds(rowA.endDate)}(half=${!!rowA.halfDay}) ` +
                  `rowB=${ds(rowB.startDate)}..${ds(rowB.endDate)}(half=${!!rowB.halfDay}) ` +
                  `contract=${contract} holidays=${label}: ${diffs.join("; ")}`,
              );
            }
          }
        }
      }
    }
    expect(caseCount).toBeGreaterThan(2000);
    expect(mismatches).toEqual([]);
  });

  it("Pitfall cases: a half-day row on a Sunday under a full-day row covering that Sunday; a Sunday-only full-day row", () => {
    const sunday = mon(6);

    // A whole Mo-So week (full-day row) plus a half-day row on that week's Sunday — the
    // half-day row must be inert (a full-day row on the same date always wins, OPEN-01).
    const wholeWeekPlusHalfSunday: Row[] = [
      { startDate: mon(0), endDate: mon(6) },
      { startDate: sunday, endDate: sunday, halfDay: true },
    ];

    // A lone Sunday full-day row — never a Werktag, must cost 0 and produce no week entry.
    const sundayOnlyFullDay: Row[] = [{ startDate: sunday, endDate: sunday }];

    for (const rows of [wholeWeekPlusHalfSunday, sundayOnlyFullDay]) {
      for (const contract of CONTRACTS) {
        for (const [, holidays] of HOLIDAY_SETS) {
          const actual = leaveDaysPerWeek(rows, contract, holidays);
          const legacy = legacyLeaveDaysPerWeek(rows, contract, holidays);
          expect(compareWeeks(actual, legacy)).toEqual([]);
        }
      }
    }
  });

  it("436-AC-02/D-05: leaveDaysPerWeek(rows, contract, holidays, []) — explicit empty usualWorkDays — equals omitting the 4th parameter, over the same multi-row matrix", () => {
    const shapes = buildRowShapes();
    let caseCount = 0;
    const mismatches: string[] = [];
    for (const rowA of shapes) {
      for (const rowB of shapes) {
        for (const contract of CONTRACTS) {
          for (const [label, holidays] of HOLIDAY_SETS) {
            caseCount++;
            const rows = [rowA, rowB];
            const withOmitted = leaveDaysPerWeek(rows, contract, holidays);
            const withExplicitEmpty = leaveDaysPerWeek(rows, contract, holidays, []);
            const diffs = compareWeeks(
              withExplicitEmpty,
              withOmitted as unknown as LegacyLeaveWeek[],
            );
            if (diffs.length > 0) {
              mismatches.push(
                `rowA=${ds(rowA.startDate)}..${ds(rowA.endDate)}(half=${!!rowA.halfDay}) ` +
                  `rowB=${ds(rowB.startDate)}..${ds(rowB.endDate)}(half=${!!rowB.halfDay}) ` +
                  `contract=${contract} holidays=${label}: ${diffs.join("; ")}`,
              );
            }
          }
        }
      }
    }
    expect(caseCount).toBeGreaterThan(2000);
    expect(mismatches).toEqual([]);
  });
});
