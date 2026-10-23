/**
 * Issue #713 (D-05, P-713-04) - `vocationalSchoolDayCount()`, the one count of Berufsschultage in a
 * range. A Berufsschultag is the #448 D-01 definition (`vocationalSchoolDateSetFromRows`: the
 * `startDate` of a non-deleted VOCATIONAL_SCHOOL Absence row); the helper only restricts that set to
 * [firstDay, lastDay], both bounds inclusive. DB-free: the helper is pure.
 */
import { describe, it, expect } from "vitest";
import { vocationalSchoolDayCount, vocationalSchoolDateSetFromRows } from "../bs-leave-days";

function d(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

function absence(type: string, date: string): { type: string; startDate: Date } {
  return { type, startDate: d(date) };
}

const FIRST = d("2026-09-01");
const LAST = d("2026-09-29");

describe("vocationalSchoolDayCount (Issue #713, D-05)", () => {
  it("is 0 for no rows", () => {
    expect(vocationalSchoolDayCount([], FIRST, LAST)).toBe(0);
  });

  it("counts the Berufsschule rows inside the range and not the one after it", () => {
    const rows = [
      absence("VOCATIONAL_SCHOOL", "2026-09-08"),
      absence("VOCATIONAL_SCHOOL", "2026-09-09"),
      absence("VOCATIONAL_SCHOOL", "2026-09-30"),
    ];
    expect(vocationalSchoolDayCount(rows, FIRST, LAST)).toBe(2);
  });

  it("counts a row on the first and a row on the last day (both bounds inclusive)", () => {
    const rows = [
      absence("VOCATIONAL_SCHOOL", "2026-09-01"),
      absence("VOCATIONAL_SCHOOL", "2026-09-29"),
    ];
    expect(vocationalSchoolDayCount(rows, FIRST, LAST)).toBe(2);
  });

  it("ignores rows of other types on days inside the range", () => {
    const rows = [
      absence("SICK", "2026-09-08"),
      absence("MATERNITY", "2026-09-09"),
      absence("OTHER", "2026-09-10"),
      absence("VOCATIONAL_SCHOOL", "2026-09-11"),
    ];
    expect(vocationalSchoolDayCount(rows, FIRST, LAST)).toBe(1);
  });

  it("ignores a row before the first day and one after the last day (the include overlaps, the count clips)", () => {
    const rows = [
      absence("VOCATIONAL_SCHOOL", "2026-08-31"),
      absence("VOCATIONAL_SCHOOL", "2026-09-30"),
      absence("VOCATIONAL_SCHOOL", "2026-10-01"),
    ];
    expect(vocationalSchoolDayCount(rows, FIRST, LAST)).toBe(0);
  });

  it("equals the sibling date set restricted to the range (one definition of a Berufsschultag)", () => {
    const rows = [
      absence("VOCATIONAL_SCHOOL", "2026-08-31"),
      absence("VOCATIONAL_SCHOOL", "2026-09-01"),
      absence("SICK", "2026-09-02"),
      absence("VOCATIONAL_SCHOOL", "2026-09-15"),
      absence("VOCATIONAL_SCHOOL", "2026-09-29"),
      absence("VOCATIONAL_SCHOOL", "2026-09-30"),
    ];
    const set = vocationalSchoolDateSetFromRows(rows);
    const inRange = [...set].filter((key) => key >= "2026-09-01" && key <= "2026-09-29");
    expect(set.size).toBe(5);
    expect(inRange.length).toBe(3);
    expect(vocationalSchoolDayCount(rows, FIRST, LAST)).toBe(inRange.length);
  });

  it("counts a date once even when two rows name it", () => {
    const rows = [
      absence("VOCATIONAL_SCHOOL", "2026-09-08"),
      absence("VOCATIONAL_SCHOOL", "2026-09-08"),
    ];
    expect(vocationalSchoolDayCount(rows, FIRST, LAST)).toBe(1);
  });
});
