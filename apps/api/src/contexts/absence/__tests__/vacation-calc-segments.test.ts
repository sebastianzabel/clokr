/**
 * Issue #450 (D-01, D-02, D-03) — pure kernel suite for the segment-aware regular-entitlement
 * formula (EuGH Brandes C-415/12, Greenfield C-219/14): golden numbers from the issue, the
 * rounding-once rule, per-segment statutory floors, every § 5 partial-year shape, the D-03
 * boundary-month rule, and a non-vacuous D-02 equivalence property.
 *
 * No DB. Every date is built via `utcMidnight(...)` or `new Date(Date.UTC(...))` — never the
 * local `new Date(y, m, d)` constructor (this kernel's NEW code is UTC; the moved-verbatim §5
 * family stays local-accessor until #450-02, but every fixture here only ever needs to agree with
 * both, so UTC construction is safe either way).
 */
import { describe, it, expect } from "vitest";
import {
  computeRegularVacationDaysBySegments,
  computeRegularVacationDays,
  employmentYearVacationDays,
  calculatePartTimeVacation,
  statutoryMinimumVacationDays,
  statutoryMinimumVacationThresholdBySegments,
  type ScheduleForCalc,
  type VacationContractSegment,
} from "../vacation-calc";
import { utcMidnight } from "../../../__tests__/test-dates";

const HIRE_2020 = utcMidnight("2020-01-01");

function ref(workDaysPerWeek: number): ScheduleForCalc {
  return {
    mondayHours: 0,
    tuesdayHours: 0,
    wednesdayHours: 0,
    thursdayHours: 0,
    fridayHours: 0,
    saturdayHours: 0,
    sundayHours: 0,
    contractWorkDaysPerWeek: workDaysPerWeek,
  };
}

/** Oracle for the D-02 property: computes the regular entitlement the OLD (single-contract) way,
 * independently of the segment kernel under test. */
function oracle(
  workDaysPerWeek: number,
  hireDate: Date,
  exitDate: Date | null,
  year: number,
  baseDays: number,
  birthDate: Date | null,
): number {
  if (!(baseDays > 0)) return 0;
  const floored = Math.max(
    calculatePartTimeVacation(ref(workDaysPerWeek), 5, baseDays),
    statutoryMinimumVacationDays(birthDate, year, workDaysPerWeek),
  );
  return employmentYearVacationDays(floored, year, hireDate, exitDate);
}

function seg(from: Date, workDaysPerWeek: number): VacationContractSegment {
  return { from, workDaysPerWeek };
}

describe("computeRegularVacationDaysBySegments (Issue #450, D-01/D-02/D-03)", () => {
  it("golden (issue): base 30, 3->5 days from 01.07. = 24", () => {
    expect(
      computeRegularVacationDaysBySegments({
        year: 2027,
        hireDate: HIRE_2020,
        birthDate: null,
        exitDate: null,
        baseDays: 30,
        segments: [seg(HIRE_2020, 3), seg(utcMidnight("2027-07-01"), 5)],
      }),
    ).toBe(24);
  });

  it("golden (issue): base 30, 5->3 days from 01.07. = 24", () => {
    expect(
      computeRegularVacationDaysBySegments({
        year: 2027,
        hireDate: HIRE_2020,
        birthDate: null,
        exitDate: null,
        baseDays: 30,
        segments: [seg(HIRE_2020, 5), seg(utcMidnight("2027-07-01"), 3)],
      }),
    ).toBe(24);
  });

  it("rounding once (D-01): base 20, 1->2 days from 01.02. = 8 (92/12 = 7.67 -> 8, not 0.33+7.33=7.66)", () => {
    expect(
      computeRegularVacationDaysBySegments({
        year: 2027,
        hireDate: HIRE_2020,
        birthDate: null,
        exitDate: null,
        baseDays: 20,
        segments: [seg(HIRE_2020, 1), seg(utcMidnight("2027-02-01"), 2)],
      }),
    ).toBe(8);
  });

  it("per-segment statutory floor (D-01): minor (14 on 01.01.2027, § 19 JArbSchG 30 Werktage) floors both segments", () => {
    expect(
      computeRegularVacationDaysBySegments({
        year: 2027,
        hireDate: HIRE_2020,
        birthDate: utcMidnight("2012-06-15"),
        exitDate: null,
        baseDays: 20,
        segments: [seg(HIRE_2020, 3), seg(utcMidnight("2027-07-01"), 5)],
      }),
    ).toBe(20);
  });

  it("hire after 01.07. (partial, D-03): 2x18 + 3x30 = 126; 10.5 -> 11", () => {
    expect(
      computeRegularVacationDaysBySegments({
        year: 2027,
        hireDate: utcMidnight("2027-08-01"),
        birthDate: null,
        exitDate: null,
        baseDays: 30,
        segments: [seg(utcMidnight("2027-08-01"), 3), seg(utcMidnight("2027-10-01"), 5)],
      }),
    ).toBe(11);
  });

  it("exit in the first half-year (partial): 18 + 2x30 = 78; 6.5 -> 7", () => {
    expect(
      computeRegularVacationDaysBySegments({
        year: 2027,
        hireDate: HIRE_2020,
        birthDate: null,
        exitDate: utcMidnight("2027-03-31"),
        baseDays: 30,
        segments: [seg(HIRE_2020, 3), seg(utcMidnight("2027-02-01"), 5)],
      }),
    ).toBe(7);
  });

  it("exit before the Wartezeit in the second half-year (partial): 2x30 + 3x18 = 114; 9.5 -> 10", () => {
    expect(
      computeRegularVacationDaysBySegments({
        year: 2027,
        hireDate: utcMidnight("2027-07-01"),
        birthDate: null,
        exitDate: utcMidnight("2027-11-30"),
        baseDays: 30,
        segments: [seg(utcMidnight("2027-07-01"), 5), seg(utcMidnight("2027-09-01"), 3)],
      }),
    ).toBe(10);
  });

  it("hire on/before 01.07. -> full year split by calendar month: Jan-Feb count to the first segment: 8x18 + 4x30 = 264", () => {
    expect(
      computeRegularVacationDaysBySegments({
        year: 2027,
        hireDate: utcMidnight("2027-03-01"),
        birthDate: null,
        exitDate: null,
        baseDays: 30,
        segments: [seg(utcMidnight("2027-03-01"), 3), seg(utcMidnight("2027-09-01"), 5)],
      }),
    ).toBe(22);
  });

  it("D-03 exit side: a contract row starting AFTER the exit never contributes a month -> 30, not 28", () => {
    expect(
      computeRegularVacationDaysBySegments({
        year: 2027,
        hireDate: HIRE_2020,
        birthDate: null,
        exitDate: utcMidnight("2027-09-30"), // second half-year, Wartezeit fulfilled -> full year
        baseDays: 30,
        segments: [seg(HIRE_2020, 5), seg(utcMidnight("2027-11-01"), 3)],
      }),
    ).toBe(30);
  });

  it("D-03 hire side: a contract row older than the hire never wins before the hire month -> 30, not 28", () => {
    expect(
      computeRegularVacationDaysBySegments({
        year: 2027,
        hireDate: utcMidnight("2027-03-01"), // on/before 01.07. -> full year
        birthDate: null,
        exitDate: null,
        baseDays: 30,
        segments: [seg(utcMidnight("2020-01-01"), 3), seg(utcMidnight("2027-03-01"), 5)],
      }),
    ).toBe(30);
  });

  it("D-02 equal values: every owed month resolving to the same value returns today's value unrounded, not re-rounded", () => {
    expect(
      computeRegularVacationDaysBySegments({
        year: 2027,
        hireDate: HIRE_2020,
        birthDate: null,
        exitDate: null,
        baseDays: 29,
        segments: [
          seg(HIRE_2020, 3),
          seg(utcMidnight("2027-04-01"), 3),
          seg(utcMidnight("2027-09-01"), 3),
        ],
      }),
    ).toBe(17.5); // NOT 18 — roundVacationDaysBurlG(17.5) would round up; D-02 skips that second rounding
    expect(
      computeRegularVacationDaysBySegments({
        year: 2027,
        hireDate: HIRE_2020,
        birthDate: null,
        exitDate: null,
        baseDays: 30,
        segments: [seg(HIRE_2020, 5), seg(utcMidnight("2027-07-01"), 6)],
      }),
    ).toBe(30);
  });

  it("baseDays 0 -> 0, regardless of segments", () => {
    expect(
      computeRegularVacationDaysBySegments({
        year: 2027,
        hireDate: HIRE_2020,
        birthDate: null,
        exitDate: null,
        baseDays: 0,
        segments: [seg(HIRE_2020, 5)],
      }),
    ).toBe(0);
  });

  it("an empty segment list throws (fail-closed, never a silent 0)", () => {
    expect(() =>
      computeRegularVacationDaysBySegments({
        year: 2027,
        hireDate: HIRE_2020,
        birthDate: null,
        exitDate: null,
        baseDays: 30,
        segments: [],
      }),
    ).toThrow();
  });

  it("an unsorted segment list equals the sorted one", () => {
    const sorted = computeRegularVacationDaysBySegments({
      year: 2027,
      hireDate: HIRE_2020,
      birthDate: null,
      exitDate: null,
      baseDays: 30,
      segments: [seg(HIRE_2020, 3), seg(utcMidnight("2027-07-01"), 5)],
    });
    const unsorted = computeRegularVacationDaysBySegments({
      year: 2027,
      hireDate: HIRE_2020,
      birthDate: null,
      exitDate: null,
      baseDays: 30,
      segments: [seg(utcMidnight("2027-07-01"), 5), seg(HIRE_2020, 3)],
    });
    expect(unsorted).toBe(sorted);
    expect(sorted).toBe(24); // the golden number above
  });

  it("two segments with the same `from` -> the later array element wins", () => {
    const result = computeRegularVacationDaysBySegments({
      year: 2027,
      hireDate: HIRE_2020,
      birthDate: null,
      exitDate: null,
      baseDays: 30,
      segments: [seg(HIRE_2020, 3), seg(HIRE_2020, 5)], // same `from`, 5 is the later element
    });
    // Equal to a single wd=5 segment for the whole (full) year — the wd=3 entry never wins.
    expect(result).toBe(
      computeRegularVacationDays({
        year: 2027,
        hireDate: HIRE_2020,
        birthDate: null,
        exitDate: null,
        workDaysPerWeek: 5,
        baseDays: 30,
      }),
    );
    expect(result).toBe(30);
  });

  it("D-02 property: a single segment and three same-workday segments both equal the single-contract oracle, over >10,000 combinations", () => {
    const years = [2026, 2027, 2028];
    const hires = [
      utcMidnight("2020-01-01"),
      utcMidnight("2026-01-01"),
      utcMidnight("2027-01-01"),
      utcMidnight("2027-03-15"),
      utcMidnight("2027-06-30"),
      utcMidnight("2027-07-01"),
      utcMidnight("2027-07-02"),
      utcMidnight("2027-08-15"),
      utcMidnight("2028-02-01"),
    ];
    const exits: (Date | null)[] = [
      null,
      utcMidnight("2026-12-31"),
      utcMidnight("2027-01-01"),
      utcMidnight("2027-03-31"),
      utcMidnight("2027-06-15"),
      utcMidnight("2027-06-30"),
      utcMidnight("2027-07-01"),
      utcMidnight("2027-09-30"),
      utcMidnight("2027-12-31"),
      utcMidnight("2028-03-31"),
    ];
    const workdays = [1, 2, 3, 4, 5, 6];
    const bases = [0, 20, 24.5, 25, 29, 30];
    const birthDates = [null, utcMidnight("2012-06-15")];

    let checked = 0;
    for (const year of years) {
      for (const hireDate of hires) {
        for (const exitDate of exits) {
          if (exitDate !== null && exitDate.getTime() < hireDate.getTime()) continue;
          for (const wd of workdays) {
            for (const baseDays of bases) {
              for (const birthDate of birthDates) {
                const expected = oracle(wd, hireDate, exitDate, year, baseDays, birthDate);

                const oneSegment = computeRegularVacationDaysBySegments({
                  year,
                  hireDate,
                  birthDate,
                  exitDate,
                  baseDays,
                  segments: [seg(hireDate, wd)],
                });
                expect(oneSegment).toBe(expected);

                const threeSegmentsSameWorkdays = computeRegularVacationDaysBySegments({
                  year,
                  hireDate,
                  birthDate,
                  exitDate,
                  baseDays,
                  segments: [
                    seg(utcMidnight("2020-01-01"), wd),
                    seg(utcMidnight("2027-04-01"), wd),
                    seg(utcMidnight("2027-10-01"), wd),
                  ],
                });
                expect(threeSegmentsSameWorkdays).toBe(expected);

                checked++;
              }
            }
          }
        }
      }
    }

    expect(checked).toBeGreaterThan(10_000);
  });
});

/** Oracle for the single-segment equivalence property: the pre-#450 threshold formula,
 * independent of {@link statutoryMinimumVacationThresholdBySegments} under test. */
function statutoryThresholdOracle(
  birthDate: Date | null,
  year: number,
  workDaysPerWeek: number,
  hireDate: Date,
  exitDate: Date | null,
): number {
  const notEmployedInYear =
    hireDate.getUTCFullYear() > year || (exitDate !== null && exitDate.getUTCFullYear() < year);
  if (notEmployedInYear) return 0;
  return employmentYearVacationDays(
    statutoryMinimumVacationDays(birthDate, year, workDaysPerWeek),
    year,
    hireDate,
    exitDate,
  );
}

describe("statutoryMinimumVacationThresholdBySegments (Issue #450, D-09)", () => {
  it("adult, base 3->5 from 01.07.2027: 6x12 (wd=3) + 6x20 (wd=5) = 192; 192/12 = 16", () => {
    expect(
      statutoryMinimumVacationThresholdBySegments({
        birthDate: null,
        year: 2027,
        hireDate: HIRE_2020,
        exitDate: null,
        segments: [seg(HIRE_2020, 3), seg(utcMidnight("2027-07-01"), 5)],
      }),
    ).toBe(16);
  });

  it("adult, base 5->3 from 01.07.2027 (symmetric): 6x20 + 6x12 = 192; 192/12 = 16", () => {
    expect(
      statutoryMinimumVacationThresholdBySegments({
        birthDate: null,
        year: 2027,
        hireDate: HIRE_2020,
        exitDate: null,
        segments: [seg(HIRE_2020, 5), seg(utcMidnight("2027-07-01"), 3)],
      }),
    ).toBe(16);
  });

  it("minor (age 14 on 1 Jan 2027, 30 Werktage band), 3->5 from 01.07.2027: 6x15 + 6x25 = 240; 240/12 = 20", () => {
    expect(
      statutoryMinimumVacationThresholdBySegments({
        birthDate: utcMidnight("2012-06-15"),
        year: 2027,
        hireDate: HIRE_2020,
        exitDate: null,
        segments: [seg(HIRE_2020, 3), seg(utcMidnight("2027-07-01"), 5)],
      }),
    ).toBe(20);
  });

  it("not employed in the year (hire 2028-02-01, year 2027) -> 0", () => {
    expect(
      statutoryMinimumVacationThresholdBySegments({
        birthDate: null,
        year: 2027,
        hireDate: utcMidnight("2028-02-01"),
        exitDate: null,
        segments: [seg(utcMidnight("2028-02-01"), 5)],
      }),
    ).toBe(0);
  });

  it("single-segment equivalence: equals the pre-#450 threshold oracle for every hire/exit/wd/birthDate combination", () => {
    const hires = [utcMidnight("2020-01-01"), utcMidnight("2027-03-01"), utcMidnight("2027-08-01")];
    const exits: (Date | null)[] = [null, utcMidnight("2027-03-31"), utcMidnight("2027-09-30")];
    const workdays = [1, 2, 3, 4, 5, 6];
    const birthDates = [null, utcMidnight("2012-06-15")];
    const year = 2027;

    let checked = 0;
    for (const hireDate of hires) {
      for (const exitDate of exits) {
        if (exitDate !== null && exitDate.getTime() < hireDate.getTime()) continue;
        for (const wd of workdays) {
          for (const birthDate of birthDates) {
            const expected = statutoryThresholdOracle(birthDate, year, wd, hireDate, exitDate);
            const actual = statutoryMinimumVacationThresholdBySegments({
              birthDate,
              year,
              hireDate,
              exitDate,
              segments: [seg(hireDate, wd)],
            });
            expect(actual).toBe(expected);
            checked++;
          }
        }
      }
    }

    expect(checked).toBeGreaterThan(0);
  });
});
