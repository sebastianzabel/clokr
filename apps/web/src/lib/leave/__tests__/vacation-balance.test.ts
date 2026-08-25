// Phase 104-10 dev-pass fix — regression test for the blocking defect found during
// Task 4 owner verification: switching the leave form's "Art der Abwesenheit" away
// from VACATION and back threw `TypeError: Cannot read properties of undefined
// (reading 'length')` because one of two mapping call sites omitted
// `section9Movements`. See ../vacation-balance.ts for the full root-cause writeup.
//
// Same convention as apps/web/src/lib/leave/__tests__/storno.test.ts: plain-function
// tests, no component mount, because vacation-balance.ts is a pure, dependency-free
// module by design.

import { describe, it, expect } from "vitest";
import { mapVacationBalance, type VacationEntitlementRow } from "../vacation-balance";

const baseRow: VacationEntitlementRow = {
  typeCode: "VACATION",
  leaveType: { name: "Urlaub" },
  totalDays: 30,
  usedDays: 3,
  carriedOverDays: 5,
  effectiveCarryOverDays: 5,
  carryOverDeadline: "2027-03-31",
};

describe("mapVacationBalance", () => {
  it("returns null for undefined input (no VACATION entitlement row found)", () => {
    expect(mapVacationBalance(undefined)).toBeNull();
  });

  it("defaults section9Movements to [] when the API response omits the field entirely", () => {
    // This is the exact shape that used to reach the template as `undefined` via the
    // second (loadBalanceForType) call site before this fix — `.length` on it threw.
    const result = mapVacationBalance(baseRow);
    expect(result).not.toBeNull();
    expect(result?.section9Movements).toEqual([]);
    // The specific regression: this must never throw.
    expect(() => result?.section9Movements.length).not.toThrow();
  });

  it("passes through a populated section9Movements array unchanged", () => {
    const movement = {
      creditId: "cred-1",
      days: 2,
      from: "2026-09-09",
      to: "2026-09-10",
      label: "+2 Tage gutgeschrieben (§ 9 BUrlG, Krankheit 09.09.–10.09.)",
    };
    const result = mapVacationBalance({ ...baseRow, section9Movements: [movement] });
    expect(result?.section9Movements).toEqual([movement]);
  });

  it("maps totals, used days and carry-over consistently regardless of section9Movements presence", () => {
    const withMovements = mapVacationBalance({
      ...baseRow,
      section9Movements: [{ creditId: "c1", days: 1, from: null, to: null, label: "x" }],
    });
    const withoutMovements = mapVacationBalance(baseRow);
    expect(withMovements?.total).toBe(withoutMovements?.total);
    expect(withMovements?.used).toBe(withoutMovements?.used);
    expect(withMovements?.carryOver).toBe(withoutMovements?.carryOver);
    expect(withMovements?.carryOverDeadline).toBe(withoutMovements?.carryOverDeadline);
  });

  it("falls back to carriedOverDays when effectiveCarryOverDays is nullish", () => {
    const result = mapVacationBalance({
      ...baseRow,
      effectiveCarryOverDays: undefined as unknown as number,
      carriedOverDays: 7,
    });
    expect(result?.carryOver).toBe(7);
  });
});
