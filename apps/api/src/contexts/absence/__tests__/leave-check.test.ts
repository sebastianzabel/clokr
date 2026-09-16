import { describe, it, expect, vi } from "vitest";
import type { Prisma } from "@clokr/db";
import { hasApprovedLeaveOnDate } from "../leave-check";

/**
 * Phase 98b (D-01): pure unit test for `hasApprovedLeaveOnDate`'s MATERNITY/PARENTAL branch —
 * no `buildApp()`, no database, mirrors `leave-type.test.ts`'s style. Pins the two DISPLAY_NAME
 * lookups that replaced the ternary this plan folded away (see Task 1).
 */
function stubPrisma(absenceType: "MATERNITY" | "PARENTAL" | null): Prisma.TransactionClient {
  return {
    leaveRequest: { findFirst: vi.fn().mockResolvedValue(null) },
    absence: {
      findFirst: vi.fn().mockResolvedValue(absenceType === null ? null : { type: absenceType }),
    },
  } as unknown as Prisma.TransactionClient;
}

describe("hasApprovedLeaveOnDate — MATERNITY/PARENTAL Absence branch (Phase 98b, D-01)", () => {
  it("returns 'Mutterschutz' for a MATERNITY absence row", async () => {
    const result = await hasApprovedLeaveOnDate(stubPrisma("MATERNITY"), "emp-1", "2026-09-15");
    expect(result).toEqual({ type: "Mutterschutz", status: "APPROVED" });
  });

  it("returns 'Elternzeit' for a PARENTAL absence row", async () => {
    const result = await hasApprovedLeaveOnDate(stubPrisma("PARENTAL"), "emp-1", "2026-09-15");
    expect(result).toEqual({ type: "Elternzeit", status: "APPROVED" });
  });

  it("returns null when neither a LeaveRequest nor a MATERNITY/PARENTAL Absence exists", async () => {
    const result = await hasApprovedLeaveOnDate(stubPrisma(null), "emp-1", "2026-09-15");
    expect(result).toBeNull();
  });
});
