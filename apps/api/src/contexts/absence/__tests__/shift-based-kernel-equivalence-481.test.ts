/**
 * shift-based-kernel-equivalence-481.test.ts
 *
 * Issue #481 (R3) — for a single-contract employee, and for contract rows that change neither the
 * count nor the Angabe (PD-01), the segment-aware kernel (`*BySegments` in `../vacation-calc`) and
 * its scalar one-segment delegates must price IDENTICALLY to the verbatim pre-481 kernel
 * (`./fixtures/legacy-shift-based-kernel-pre481.ts`, frozen at commit 973553f0) over a generated
 * matrix. `dayShares` are compared with exact equality (they are floats; the operation order of
 * the refactor must be preserved).
 *
 * Every date is derived from `mondayOfWeekStr()` (the shared tenant-TZ anchor) — no calendar
 * literal, so this file cannot become a time bomb. Every matrix asserts a case-count floor so it
 * can never pass having checked nothing (anti-vacuity).
 */
import { describe, it, expect } from "vitest";
import {
  countShiftBasedLeaveDays,
  countShiftBasedLeaveDaysBySegments,
  leaveDaysPerWeek,
  leaveDaysPerWeekBySegments,
  marginalShiftBasedLeaveDays,
  marginalShiftBasedLeaveDaysBySegments,
  type LeaveWeek,
  type ShiftLeavePricingSegment,
} from "../vacation-calc";
import {
  legacyCountShiftBasedLeaveDays,
  legacyLeaveDaysPerWeek,
  legacyMarginalShiftBasedLeaveDays,
  type LegacyLeaveWeek,
} from "./fixtures/legacy-shift-based-kernel-pre481";
import { mondayOfWeekStr, utcMidnight } from "../../../__tests__/test-dates";

const DAY_MS = 24 * 60 * 60 * 1000;
const MONDAY = mondayOfWeekStr();

/** `n` whole days after the fixture Monday (UTC midnight); negative values go back in time. */
function mon(n: number): Date {
  return new Date(utcMidnight(MONDAY).getTime() + n * DAY_MS);
}

/** UTC "YYYY-MM-DD" of a Date — the kernel's own date-string format. */
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

const USUAL_SETS: number[][] = [
  [],
  [1, 2, 3, 4, 5],
  [2, 3, 4, 5],
  [2, 3, 4, 5, 6],
  [0, 1, 2, 3, 4, 5, 6],
];
const CONTRACTS = [1, 2, 3, 4, 5, 6];
const STARTS = Array.from({ length: 21 }, (_, i) => mon(i));
const LENGTHS = Array.from({ length: 16 }, (_, i) => i); // 0..15 calendar days

/** One segment starting well before every requested date (#450 `from` semantics). */
function single(contract: number, usual: readonly number[]): ShiftLeavePricingSegment[] {
  return [{ from: mon(-400), workDaysPerWeek: contract, usualWorkDays: usual }];
}

/** Serialises a week list (weekMonday, days, every dayShares entry) for exact comparison. */
function weeksKey(weeks: Array<LeaveWeek | LegacyLeaveWeek>): string {
  return JSON.stringify(
    weeks.map((w) => [
      w.weekMonday,
      w.days,
      [...w.dayShares.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ]),
  );
}

describe("R3 — countShiftBasedLeaveDays: single segment vs. frozen pre-481 kernel", () => {
  it("BySegments and the scalar delegate match over (start, length, contract, holidays, Angabe) (floor: 5000 cases)", () => {
    let caseCount = 0;
    const mismatches: string[] = [];
    for (const start of STARTS) {
      for (const length of LENGTHS) {
        const end = new Date(start.getTime() + length * DAY_MS);
        for (const contract of CONTRACTS) {
          for (const [label, holidays] of HOLIDAY_SETS) {
            for (const usual of USUAL_SETS) {
              caseCount++;
              const legacy = legacyCountShiftBasedLeaveDays(
                start,
                end,
                false,
                contract,
                holidays,
                usual,
              );
              const seg = countShiftBasedLeaveDaysBySegments(
                start,
                end,
                false,
                single(contract, usual),
                holidays,
              );
              const scalar = countShiftBasedLeaveDays(start, end, false, contract, holidays, usual);
              if (seg.days !== legacy.days || scalar.days !== legacy.days) {
                mismatches.push(
                  `start=${ds(start)} len=${length} c=${contract} h=${label} u=[${usual}]: seg=${seg.days} scalar=${scalar.days} legacy=${legacy.days}`,
                );
              }
            }
          }
        }
      }
    }
    expect(caseCount).toBeGreaterThan(5000);
    expect(mismatches).toEqual([]);
  });

  it("half days match for every start/contract/Angabe/holiday combination", () => {
    let caseCount = 0;
    const mismatches: string[] = [];
    for (const start of STARTS) {
      for (const contract of CONTRACTS) {
        for (const [label, holidays] of HOLIDAY_SETS) {
          for (const usual of USUAL_SETS) {
            caseCount++;
            const legacy = legacyCountShiftBasedLeaveDays(
              start,
              start,
              true,
              contract,
              holidays,
              usual,
            );
            const seg = countShiftBasedLeaveDaysBySegments(
              start,
              start,
              true,
              single(contract, usual),
              holidays,
            );
            const scalar = countShiftBasedLeaveDays(start, start, true, contract, holidays, usual);
            if (seg.days !== legacy.days || scalar.days !== legacy.days) {
              mismatches.push(
                `start=${ds(start)} c=${contract} h=${label} u=[${usual}]: seg=${seg.days} scalar=${scalar.days} legacy=${legacy.days}`,
              );
            }
          }
        }
      }
    }
    expect(caseCount).toBeGreaterThan(3000);
    expect(mismatches).toEqual([]);
  });
});

type Row = { startDate: Date; endDate: Date; halfDay?: boolean };

/** Second-row variants: none, three half days, three short ranges (one crossing a week). */
const SECOND_ROWS: Array<[string, Row | null]> = [
  ["none", null],
  ...[2, 5, 8].map((k): [string, Row] => [
    `half@${k}`,
    { startDate: mon(k), endDate: mon(k), halfDay: true },
  ]),
  ...[3, 6, 10].map((k): [string, Row] => [
    `range@${k}`,
    { startDate: mon(k), endDate: mon(k + 2) },
  ]),
];
const FIRST_STARTS = Array.from({ length: 10 }, (_, i) => i);
const FIRST_LENGTHS = [0, 1, 2, 4, 6, 9];
const WEEK_HOLIDAYS = HOLIDAY_SETS.slice(0, 2);

describe("R3 — leaveDaysPerWeek: single segment vs. frozen pre-481 kernel", () => {
  it("BySegments and the saldo-side scalar delegate match on weekMonday/days/dayShares (floor: 2000 cases)", () => {
    let caseCount = 0;
    const mismatches: string[] = [];
    for (const s of FIRST_STARTS) {
      for (const len of FIRST_LENGTHS) {
        for (const [rowLabel, second] of SECOND_ROWS) {
          const rows: Row[] = [{ startDate: mon(s), endDate: mon(s + len) }];
          if (second) rows.push(second);
          for (const contract of CONTRACTS) {
            for (const usual of USUAL_SETS) {
              for (const [label, holidays] of WEEK_HOLIDAYS) {
                caseCount++;
                const legacy = weeksKey(legacyLeaveDaysPerWeek(rows, contract, holidays, usual));
                const seg = weeksKey(
                  leaveDaysPerWeekBySegments(rows, single(contract, usual), holidays),
                );
                const scalar = weeksKey(leaveDaysPerWeek(rows, contract, holidays, usual));
                if (seg !== legacy || scalar !== legacy) {
                  mismatches.push(
                    `s=${s} len=${len} second=${rowLabel} c=${contract} u=[${usual}] h=${label}: seg=${seg} scalar=${scalar} legacy=${legacy}`,
                  );
                }
              }
            }
          }
        }
      }
    }
    expect(caseCount).toBeGreaterThan(2000);
    expect(mismatches).toEqual([]);
  });
});

describe("R3 — marginalShiftBasedLeaveDays: single segment vs. frozen pre-481 kernel", () => {
  it("BySegments and the scalar delegate match with 0, 1 and 2 sibling rows (floor: 2000 cases)", () => {
    const SIBLINGS: Array<[string, Row[]]> = [
      ["0", []],
      ["1", [{ startDate: mon(0), endDate: mon(2) }]],
      [
        "2",
        [
          { startDate: mon(1), endDate: mon(1), halfDay: true },
          { startDate: mon(7), endDate: mon(8) },
        ],
      ],
    ];
    let caseCount = 0;
    const mismatches: string[] = [];
    for (const s of FIRST_STARTS) {
      for (const len of FIRST_LENGTHS) {
        for (const halfDay of [false, true]) {
          if (halfDay && len !== 0) continue;
          const request = { startDate: mon(s), endDate: mon(s + len), halfDay };
          for (const [sibLabel, others] of SIBLINGS) {
            for (const contract of CONTRACTS) {
              for (const usual of USUAL_SETS) {
                for (const [label, holidays] of WEEK_HOLIDAYS) {
                  caseCount++;
                  const legacy = legacyMarginalShiftBasedLeaveDays(
                    request,
                    others,
                    contract,
                    holidays,
                    usual,
                  );
                  const seg = marginalShiftBasedLeaveDaysBySegments(
                    request,
                    others,
                    single(contract, usual),
                    holidays,
                  );
                  const scalar = marginalShiftBasedLeaveDays(
                    request,
                    others,
                    contract,
                    holidays,
                    usual,
                  );
                  if (seg !== legacy || scalar !== legacy) {
                    mismatches.push(
                      `s=${s} len=${len} half=${halfDay} sib=${sibLabel} c=${contract} u=[${usual}] h=${label}: seg=${seg} scalar=${scalar} legacy=${legacy}`,
                    );
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(caseCount).toBeGreaterThan(2000);
    expect(mismatches).toEqual([]);
  });
});

describe("PD-01 — segments with identical count AND Angabe price like one contract", () => {
  const BOUNDARIES: Array<[string, number[]]> = [
    ["Tue", [1]],
    ["Thu", [3]],
    ["Sat", [5]],
    ["Sun", [6]],
    ["next Tue", [8]],
    ["Wed + next Wed", [2, 9]],
  ];

  it("all three kernels match the frozen single-contract result (floor: 1000 cases)", () => {
    let caseCount = 0;
    const mismatches: string[] = [];
    for (const s of FIRST_STARTS) {
      for (const len of [3, 6, 9, 13]) {
        const start = mon(s);
        const end = mon(s + len);
        const rows: Row[] = [
          { startDate: start, endDate: end },
          { startDate: mon(4), endDate: mon(4), halfDay: true },
        ];
        for (const [bLabel, offsets] of BOUNDARIES) {
          for (const contract of CONTRACTS) {
            for (const usual of USUAL_SETS) {
              const segments: ShiftLeavePricingSegment[] = [
                { from: mon(-400), workDaysPerWeek: contract, usualWorkDays: usual },
                ...offsets.map((o) => ({
                  from: mon(o),
                  workDaysPerWeek: contract,
                  usualWorkDays: [...usual],
                })),
              ];
              for (const [label, holidays] of WEEK_HOLIDAYS) {
                caseCount++;
                const tag = `s=${s} len=${len} b=${bLabel} c=${contract} u=[${usual}] h=${label}`;
                const lc = legacyCountShiftBasedLeaveDays(
                  start,
                  end,
                  false,
                  contract,
                  holidays,
                  usual,
                ).days;
                const nc = countShiftBasedLeaveDaysBySegments(
                  start,
                  end,
                  false,
                  segments,
                  holidays,
                ).days;
                if (nc !== lc) mismatches.push(`count ${tag}: new=${nc} legacy=${lc}`);
                const lw = weeksKey(legacyLeaveDaysPerWeek(rows, contract, holidays, usual));
                const nw = weeksKey(leaveDaysPerWeekBySegments(rows, segments, holidays));
                if (nw !== lw) mismatches.push(`weeks ${tag}: new=${nw} legacy=${lw}`);
                const req = { startDate: start, endDate: end, halfDay: false };
                const lm = legacyMarginalShiftBasedLeaveDays(
                  req,
                  rows.slice(1),
                  contract,
                  holidays,
                  usual,
                );
                const nm = marginalShiftBasedLeaveDaysBySegments(
                  req,
                  rows.slice(1),
                  segments,
                  holidays,
                );
                if (nm !== lm) mismatches.push(`marginal ${tag}: new=${nm} legacy=${lm}`);
              }
            }
          }
        }
      }
    }
    expect(caseCount).toBeGreaterThan(1000);
    expect(mismatches).toEqual([]);
  });
});

describe("A segment boundary outside the requested range", () => {
  it("prices with the values of the one segment covering every requested date", () => {
    let caseCount = 0;
    const mismatches: string[] = [];
    for (const s of FIRST_STARTS) {
      for (const len of FIRST_LENGTHS) {
        const start = mon(s);
        const end = mon(s + len);
        for (const contract of CONTRACTS) {
          for (const usual of USUAL_SETS) {
            const other = { workDaysPerWeek: (contract % 6) + 1, usualWorkDays: [1, 3, 5] };
            const later: ShiftLeavePricingSegment[] = [
              { from: mon(-400), workDaysPerWeek: contract, usualWorkDays: usual },
              { from: mon(30), ...other },
            ];
            const earlier: ShiftLeavePricingSegment[] = [
              { from: mon(-400), ...other },
              { from: mon(-100), workDaysPerWeek: contract, usualWorkDays: usual },
            ];
            for (const [label, holidays] of HOLIDAY_SETS) {
              caseCount++;
              const legacy = legacyCountShiftBasedLeaveDays(
                start,
                end,
                false,
                contract,
                holidays,
                usual,
              ).days;
              const a = countShiftBasedLeaveDaysBySegments(start, end, false, later, holidays).days;
              const b = countShiftBasedLeaveDaysBySegments(
                start,
                end,
                false,
                earlier,
                holidays,
              ).days;
              if (a !== legacy || b !== legacy) {
                mismatches.push(
                  `s=${s} len=${len} c=${contract} u=[${usual}] h=${label}: later=${a} earlier=${b} legacy=${legacy}`,
                );
              }
            }
          }
        }
      }
    }
    expect(caseCount).toBeGreaterThan(1000);
    expect(mismatches).toEqual([]);
  });
});
