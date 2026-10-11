// Issue #511 (D-05) — isMinorAtDate(): the ONE "is the employee under 18 on this calendar day"
// decision, shared by the § 11 JArbSchG break regime and the § 9 JArbSchG Berufsschule block.
// DB-free.

import { describe, it, expect } from "vitest";
import { isMinorAtDate } from "../minor-at-date";
import { isMinorAtDate as isMinorViaIndex } from "../index";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe("isMinorAtDate (Issue #511, D-05)", () => {
  it("is reachable through the context index (the only legal way in for other contexts)", () => {
    expect(isMinorViaIndex).toBe(isMinorAtDate);
  });

  it("fails open: a missing birth date is never a minor", () => {
    expect(isMinorAtDate(null, d("2027-03-09"))).toBe(false);
    expect(isMinorAtDate(undefined, d("2027-03-09"))).toBe(false);
  });

  it("the day before the 18th birthday is a minor, the birthday itself is not (§ 187 Abs. 2 S. 2 BGB)", () => {
    const birth = d("2009-03-10");
    expect(isMinorAtDate(birth, d("2027-03-09"))).toBe(true);
    expect(isMinorAtDate(birth, d("2027-03-10"))).toBe(false);
    expect(isMinorAtDate(birth, d("2027-03-11"))).toBe(false);
  });

  it("a leap-day birth date turns 18 on 1 March in a non-leap year", () => {
    const birth = d("2008-02-29");
    expect(isMinorAtDate(birth, d("2026-02-28"))).toBe(true);
    expect(isMinorAtDate(birth, d("2026-03-01"))).toBe(false);
  });

  it("a child and an adult are decided correctly far from the boundary", () => {
    expect(isMinorAtDate(d("2012-06-01"), d("2026-10-09"))).toBe(true);
    expect(isMinorAtDate(d("1990-06-01"), d("2026-10-09"))).toBe(false);
  });
});
