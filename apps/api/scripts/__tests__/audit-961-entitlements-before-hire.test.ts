/**
 * Issue #961 — the read-only audit's pure classification (no database).
 */
import { describe, it, expect } from "vitest";
import { entitlementsBeforeHire } from "../audit-961-entitlements-before-hire";

describe("Issue #961 — read-only audit script", () => {
  const ent = (year: number, totalDays: number, carriedOverDays = 0, usedDays = 0) => ({
    year,
    totalDays,
    carriedOverDays,
    usedDays,
  });

  it("lists only employees with a row of a year before the hire year, with counts", () => {
    const found = entitlementsBeforeHire([
      {
        id: "e1",
        tenantId: "t",
        hireDate: new Date("2026-10-19T00:00:00Z"),
        leaveEntitlements: [ent(2024, 0), ent(2025, 24), ent(2026, 6, 24), ent(2027, 24, 22)],
      },
      {
        id: "e2",
        tenantId: "t",
        hireDate: new Date("2025-02-01T00:00:00Z"),
        leaveEntitlements: [ent(2025, 24), ent(2026, 30, 24)],
      },
    ]);
    expect(found).toEqual([
      {
        tenantId: "t",
        employeeId: "e1",
        hireYear: 2026,
        rowsBeforeHire: 2,
        rowsWithDays: 1,
        rowsWithUsedDays: 0,
        laterRowsWithCarry: 2,
      },
    ]);
  });
});
