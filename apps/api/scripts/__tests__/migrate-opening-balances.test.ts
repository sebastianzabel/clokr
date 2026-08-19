/**
 * Phase 99 Plan 07 — Task 1: DB-free unit proof of the OB-04 migration's pure decision
 * core (eligibility, zero-drift, provenance).
 *
 * No database, no Prisma, no Fastify — `ChainLink[]` fixtures are hand-built plain objects,
 * mirroring apps/api/src/utils/__tests__/saldo-chain-classification.test.ts.
 */
import { describe, it, expect } from "vitest";
import { classifyCandidate, type ClassifyCandidateResult } from "../migrate-opening-balances";
import type { ChainLink } from "../../src/utils/saldo-chain-integrity";

/** Minimal ChainLink builder — every field defaultable, `rowId` and `delta` always explicit
 *  at the call site so each fixture states its point unambiguously. */
function link(overrides: Partial<ChainLink> & Pick<ChainLink, "rowId" | "delta">): ChainLink {
  return {
    rowId: overrides.rowId,
    monthLabel: overrides.monthLabel ?? "2026-01",
    periodStart: overrides.periodStart ?? new Date("2026-01-01T00:00:00Z"),
    periodEnd: overrides.periodEnd ?? new Date("2026-01-31T00:00:00Z"),
    isFirstLink: overrides.isFirstLink ?? false,
    kind: overrides.kind ?? "normal",
    carryOverIn: overrides.carryOverIn ?? 0,
    workedMinutes: overrides.workedMinutes ?? 0,
    expectedMinutes: overrides.expectedMinutes ?? 0,
    balanceMinutes: overrides.balanceMinutes ?? 0,
    expectedCarryOver: overrides.expectedCarryOver ?? 0,
    storedCarryOver: overrides.storedCarryOver ?? overrides.delta,
    delta: overrides.delta,
  };
}

function assertEligible(result: ClassifyCandidateResult) {
  expect(result.status).toBe("eligible");
  if (result.status !== "eligible") throw new Error("unreachable");
  return result;
}

function assertNeedsReview(result: ClassifyCandidateResult) {
  expect(result.status).toBe("needs_review");
  if (result.status !== "needs_review") throw new Error("unreachable");
  return result;
}

describe("OB-04 migrate-opening-balances classifyCandidate (pure, DB-free)", () => {
  it("Test 1: only non-zero delta at chain head -> eligible, minutes equals the delta (zero-drift positive form)", () => {
    const links: ChainLink[] = [
      link({ rowId: "row-head", isFirstLink: true, delta: 4200, kind: "normal" }),
      link({ rowId: "row-2", monthLabel: "2026-02", isFirstLink: false, delta: 0 }),
      link({ rowId: "row-3", monthLabel: "2026-03", isFirstLink: false, delta: 0 }),
    ];
    const result = classifyCandidate(links, new Map());
    const eligible = assertEligible(result);
    expect(eligible.minutes).toBe(4200);
    expect(eligible.headRowId).toBe("row-head");
  });

  it("Test 2: non-zero delta on a NON-first link -> needs_review delta_not_at_chain_head", () => {
    const links: ChainLink[] = [
      link({ rowId: "row-head", isFirstLink: true, delta: 0 }),
      link({ rowId: "row-2", monthLabel: "2026-02", isFirstLink: false, delta: 500 }),
    ];
    const result = classifyCandidate(links, new Map());
    const needsReview = assertNeedsReview(result);
    expect(needsReview.blocker).toBe("delta_not_at_chain_head");
  });

  it("Test 3: TWO non-zero deltas -> needs_review multiple_deltas", () => {
    const links: ChainLink[] = [
      link({ rowId: "row-head", isFirstLink: true, delta: 300 }),
      link({ rowId: "row-2", monthLabel: "2026-02", isFirstLink: false, delta: -50 }),
    ];
    const result = classifyCandidate(links, new Map());
    const needsReview = assertNeedsReview(result);
    expect(needsReview.blocker).toBe("multiple_deltas");
  });

  it("Test 4: a chain containing any duplicate_month link -> needs_review duplicate_month_links", () => {
    const links: ChainLink[] = [
      link({ rowId: "row-head", isFirstLink: true, delta: 100, kind: "normal" }),
      link({
        rowId: "row-2a",
        monthLabel: "2026-02",
        isFirstLink: false,
        delta: 10,
        kind: "duplicate_month",
      }),
      link({
        rowId: "row-2b",
        monthLabel: "2026-02",
        isFirstLink: false,
        delta: -10,
        kind: "duplicate_month",
      }),
    ];
    const result = classifyCandidate(links, new Map());
    const needsReview = assertNeedsReview(result);
    expect(needsReview.blocker).toBe("duplicate_month_links");
    expect(needsReview.message).toContain("cleanup-tz-duplicate-snapshots.ts");
  });

  it("Test 5: all deltas 0 -> not_a_candidate (nothing to migrate, not an error)", () => {
    const links: ChainLink[] = [
      link({ rowId: "row-head", isFirstLink: true, delta: 0 }),
      link({ rowId: "row-2", monthLabel: "2026-02", isFirstLink: false, delta: 0 }),
    ];
    const result = classifyCandidate(links, new Map());
    expect(result.status).toBe("not_a_candidate");
  });

  it("Test 6: head audit reasons contain the allowlisted string -> MIGRATED_FROM_SNAPSHOT, reason carried verbatim", () => {
    const links: ChainLink[] = [
      link({ rowId: "row-head", isFirstLink: true, delta: 90, kind: "normal" }),
    ];
    const reasons = new Map<string, readonly string[]>([
      ["row-head", ["opening balance from old time-tracking system"]],
    ]);
    const result = classifyCandidate(links, reasons);
    const eligible = assertEligible(result);
    expect(eligible.source).toBe("MIGRATED_FROM_SNAPSHOT");
    expect(eligible.reason).toBe("opening balance from old time-tracking system");
    expect(eligible.matchedAuditReason).toBe("opening balance from old time-tracking system");
  });

  it("Test 7: no matching audit reason and no reason string at all -> RECONSTRUCTED, honest German reason, not a blanket collective reason", () => {
    const linksA: ChainLink[] = [
      link({ rowId: "row-head-a", isFirstLink: true, delta: 540, monthLabel: "2026-03" }),
    ];
    const linksB: ChainLink[] = [
      link({ rowId: "row-head-b", isFirstLink: true, delta: 750, monthLabel: "2026-06" }),
    ];
    const resultA = assertEligible(classifyCandidate(linksA, new Map()));
    const resultB = assertEligible(classifyCandidate(linksB, new Map()));

    expect(resultA.source).toBe("RECONSTRUCTED");
    expect(resultB.source).toBe("RECONSTRUCTED");
    expect(resultA.matchedAuditReason).toBeNull();
    expect(resultB.matchedAuditReason).toBeNull();
    // Honest German reason: real value, unrecoverable justification — no invented reason.
    expect(resultA.reason).toContain("konnte im AuditLog nicht rekonstruiert werden");
    expect(resultA.reason).toContain("real");
    // NOT a blanket collective reason shared across employees — each RECONSTRUCTED reason
    // carries its own row id / month / amount and must differ from every other one.
    expect(resultA.reason).not.toBe(resultB.reason);
  });

  it("Test 8: head link kind 'bridge' carrying the delta -> eligible, flagged carrierRemainsBridgeSnapshot: true", () => {
    const links: ChainLink[] = [
      link({
        rowId: "row-bridge",
        isFirstLink: true,
        delta: 600,
        kind: "bridge",
        storedCarryOver: 600,
      }),
    ];
    const result = assertEligible(classifyCandidate(links, new Map()));
    expect(result.carrierRemainsBridgeSnapshot).toBe(true);
    expect(result.minutes).toBe(600);
  });

  it("Test 9: a negative delta (-1080) at the head behaves identically to a positive one", () => {
    const links: ChainLink[] = [
      link({ rowId: "row-head", isFirstLink: true, delta: -1080, kind: "bridge" }),
    ];
    const result = assertEligible(classifyCandidate(links, new Map()));
    expect(result.minutes).toBe(-1080);
    expect(result.carrierRemainsBridgeSnapshot).toBe(true);
  });
});
