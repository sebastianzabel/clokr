// Issue #435 (D-11/D-12) — pins statutoryMinimumFiveDayWeek against the exact age table from the
// issue (Werktage 30/27/25/24 -> 5-day-week days 25/22,5/20,83/20) and the boundary cases around
// the 1 January reference date (§ 187 Abs. 2 S. 2 BGB).

import { describe, it, expect } from "vitest";
import {
  statutoryMinimumFiveDayWeek,
  MISSING_BIRTH_DATE_HINT,
} from "../statutory-minimum-vacation";

describe("statutoryMinimumFiveDayWeek (Issue #435 D-11/D-12)", () => {
  it.each([
    ["2012-06-15", 2027, 25, "§ 19 JArbSchG"],
    ["2010-06-15", 2027, 22.5, "§ 19 JArbSchG"],
    ["2009-06-15", 2027, 20.83, "§ 19 JArbSchG"],
    ["2000-06-15", 2027, 20, "§ 3 BUrlG"],
  ] as const)("%s in %i -> %f days (%s)", (birthDate, year, expectedDays, expectedLaw) => {
    const result = statutoryMinimumFiveDayWeek(birthDate, year);
    expect(result.days).toBe(expectedDays);
    expect(result.law).toBe(expectedLaw);
  });

  it("null birth date -> adult default (20 days, § 3 BUrlG)", () => {
    expect(statutoryMinimumFiveDayWeek(null, 2027)).toEqual({ days: 20, law: "§ 3 BUrlG" });
  });

  it("boundary: 2011-01-01 in 2027 -> already 16 -> 22.5", () => {
    expect(statutoryMinimumFiveDayWeek("2011-01-01", 2027)).toEqual({
      days: 22.5,
      law: "§ 19 JArbSchG",
    });
  });

  it("boundary: 2011-01-02 in 2027 -> still 15 -> 25", () => {
    expect(statutoryMinimumFiveDayWeek("2011-01-02", 2027)).toEqual({
      days: 25,
      law: "§ 19 JArbSchG",
    });
  });

  it("an ISO datetime gives the same result as the plain date", () => {
    const fromDatetime = statutoryMinimumFiveDayWeek("2011-01-01T00:00:00.000Z", 2027);
    const fromDate = statutoryMinimumFiveDayWeek("2011-01-01", 2027);
    expect(fromDatetime).toEqual(fromDate);
  });

  it("MISSING_BIRTH_DATE_HINT is the exact German sentence with an en dash (U+2013)", () => {
    expect(MISSING_BIRTH_DATE_HINT).toBe(
      "Geburtsdatum fehlt – Mindesturlaub nach JArbSchG kann nicht geprüft werden",
    );
  });
});
