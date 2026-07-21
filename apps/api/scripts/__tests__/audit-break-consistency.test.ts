/**
 * Phase 76.41 Plan 01 — GT-10 golden tests for the break-consistency audit predicate.
 *
 * Pure-function, DB-free: synthetic in-memory Break-row fixtures only.
 * No database, no test-app bootstrap, no ORM client — imports only the exported pure
 * helpers (computeBreakRowMinutes / isBreakDivergent / classifyBreakRow) from the audit script.
 *
 * The predicate mirrors the write-path rounding in
 * apps/api/src/routes/time-entries.ts:84 (calcBreakMinutes) + :829
 * (Math.round(calcBreakMinutes(allBreaks))) — see D-03.
 *
 * GT-10 cases:
 *   GT-10a DIVERGENT — stored 45, break rows summing to 30 → divergent (diff = 15).
 *   GT-10b CONSISTENT — Neele reference 5.25h == 5.25h (315 min); plus a rounding-parity
 *          variant where the raw ms-sum rounds to 315 → still not flagged (D-03).
 *   GT-10c LEGACY — stored 30, zero break rows → "legacy" bucket, NOT a hard divergence (D-04).
 *   GT-10d ZERO-consistent — stored 0, zero break rows → "consistent", never flagged.
 */
import { describe, it, expect } from "vitest";
import {
  computeBreakRowMinutes,
  isBreakDivergent,
  classifyBreakRow,
} from "../audit-break-consistency";

// Tiny fixture helper — build a Break row from ISO start/end strings.
function mk(startISO: string, endISO: string): { startTime: Date; endTime: Date } {
  return { startTime: new Date(startISO), endTime: new Date(endISO) };
}

describe("GT-10 break-consistency predicate (pure, DB-free)", () => {
  it("GT-10a DIVERGENT — stored=45 but break rows sum to 30 → flagged", () => {
    const rows = [mk("2026-07-21T09:00:00Z", "2026-07-21T09:30:00Z")]; // 30 min
    expect(computeBreakRowMinutes(rows)).toBe(30);
    expect(isBreakDivergent(45, rows)).toBe(true);
    expect(classifyBreakRow(45, rows)).toBe("divergent");
    // diff = stored − computed = 45 − 30 = 15
    expect(45 - computeBreakRowMinutes(rows)).toBe(15);
  });

  it("GT-10b CONSISTENT (Neele 5.25h == 5.25h, exact) — not flagged", () => {
    const rows = [mk("2026-07-21T12:00:00Z", "2026-07-21T17:15:00Z")]; // 315 min = 5.25h
    expect(computeBreakRowMinutes(rows)).toBe(315);
    expect(isBreakDivergent(315, rows)).toBe(false);
    expect(classifyBreakRow(315, rows)).toBe("consistent");
  });

  it("GT-10b CONSISTENT (rounding parity — raw ms-sum rounds to 315) — not flagged", () => {
    // 10 min + 304.6 min = 314.6 min raw → Math.round(314.6) = 315 (D-03 parity).
    const rows = [
      mk("2026-07-21T09:00:00.000Z", "2026-07-21T09:10:00.000Z"), // 10 min
      mk("2026-07-21T12:00:00.000Z", "2026-07-21T17:04:36.000Z"), // 304.6 min
    ];
    expect(computeBreakRowMinutes(rows)).toBe(315);
    expect(isBreakDivergent(315, rows)).toBe(false);
    expect(classifyBreakRow(315, rows)).toBe("consistent");
  });

  it("GT-10c LEGACY — stored=30 with zero break rows → legacy bucket, not divergent (D-04)", () => {
    expect(classifyBreakRow(30, [])).toBe("legacy");
    expect(isBreakDivergent(30, [])).toBe(false);
  });

  it("GT-10d ZERO-consistent — stored=0 with zero break rows → consistent, never flagged", () => {
    expect(classifyBreakRow(0, [])).toBe("consistent");
    expect(isBreakDivergent(0, [])).toBe(false);
  });
});
