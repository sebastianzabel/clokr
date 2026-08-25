/**
 * Phase 98 Plan 02 — GT-98n..GT-98z classification tests (pure, DB-free).
 *
 * No database, no ORM client, no test-app bootstrap — AuditLog rows are
 * synthetic plain objects, exactly matching the shape `extractAuditReasons`
 * consumes.
 */
import { describe, it, expect } from "vitest";
import {
  DELIBERATE_CARRYOVER_REASONS,
  matchDeliberateReason,
  extractAuditReasons,
  classifyChainLink,
} from "../saldo-chain-classification";

describe("GT-98 saldo chain classification (pure, DB-free)", () => {
  it("GT-98n documented: allowlisted exact reason classifies as documented", () => {
    const result = classifyChainLink({ kind: "normal", isFirstLink: false }, [
      "opening balance from old time-tracking system",
    ]);
    expect(result.classification).toBe("documented");
    expect(result.rule.startsWith("allowlist:")).toBe(true);
  });

  it("GT-98o documented prefix: amount-variant restore string still matches", () => {
    const result = classifyChainLink({ kind: "normal", isFirstLink: false }, [
      "Vor-Tracking-Leistung +100h restore",
    ]);
    expect(result.classification).toBe("documented");
    expect(result.rule).toBe("allowlist:Vor-Tracking-Leistung");
  });

  it("GT-98p case-insensitivity: an all-caps reason still matches", () => {
    const result = classifyChainLink({ kind: "normal", isFirstLink: false }, [
      "VOR-TRACKING-LEISTUNG RESTORE",
    ]);
    expect(result.classification).toBe("documented");
  });

  it("GT-98q mechanical only: retroactive recalculation classifies as unexplained", () => {
    const result = classifyChainLink({ kind: "normal", isFirstLink: false }, [
      "retroactive recalculation",
    ]);
    expect(result.classification).toBe("unexplained");
    expect(result.rule).toBe("none");
  });

  it("GT-98r migration reason: a named migration script reason is still mechanical", () => {
    const result = classifyChainLink({ kind: "normal", isFirstLink: false }, [
      "v1.8.4 Ø-Methode migration (BAG 9 AZR 406/17)",
    ]);
    expect(result.classification).toBe("unexplained");
  });

  it("GT-98s TZ cleanup reason: mechanical cleanup reason is unexplained", () => {
    const result = classifyChainLink({ kind: "normal", isFirstLink: false }, [
      "TZ-duplicate cleanup — 2026-06-08 prod investigation",
    ]);
    expect(result.classification).toBe("unexplained");
  });

  it("GT-98t no audit trail at all: empty reasons classify as unexplained", () => {
    const result = classifyChainLink({ kind: "normal", isFirstLink: false }, []);
    expect(result.classification).toBe("unexplained");
  });

  it("GT-98u bridge at chain start with zero audit rows is documented by shape", () => {
    const result = classifyChainLink({ kind: "bridge", isFirstLink: true }, []);
    expect(result.classification).toBe("documented");
    expect(result.rule).toBe("bridge-at-chain-start");
  });

  it("GT-98v bridge mid-chain with only mechanical reasons is unexplained", () => {
    const result = classifyChainLink({ kind: "bridge", isFirstLink: false }, [
      "retroactive recalculation",
    ]);
    expect(result.classification).toBe("unexplained");
  });

  it("GT-98w THE 6129 HARD CASE: deliberate reason first, mechanical erosion later, still documented", () => {
    // Prod row: a deliberate 2026-05-07 restore was later partially eroded by a
    // mechanical "retroactive recalculation" UPDATE (5216 -> 4200, ~17h). The
    // classifier must call this `documented` (a deliberate act exists in the
    // lineage) while the caller's report still prints every reason seen, so a
    // human reviewer can spot the later erosion.
    const auditReasons = ["Vor-Tracking-Leistung +100h restore", "retroactive recalculation"];
    const result = classifyChainLink({ kind: "normal", isFirstLink: false }, auditReasons);
    expect(result.classification).toBe("documented");
    expect(result.matchedReason).toBe("Vor-Tracking-Leistung +100h restore");
    expect(auditReasons.length).toBe(2);
  });

  it("GT-98x reversed order: audit-row order must not change the verdict", () => {
    const result = classifyChainLink({ kind: "normal", isFirstLink: false }, [
      "retroactive recalculation",
      "Vor-Tracking-Leistung +100h restore",
    ]);
    expect(result.classification).toBe("documented");
  });

  it("GT-98y extractAuditReasons filters null/non-object/missing/non-string reason, preserves order, no dedup", () => {
    const reasons = extractAuditReasons([
      { newValue: { reason: "a" } },
      { newValue: null },
      { newValue: { carryOver: 5 } },
      { newValue: { reason: 42 } },
      { newValue: "x" },
      { newValue: { reason: "a" } },
    ]);
    expect(reasons).toEqual(["a", "a"]);
  });

  it("GT-98z allowlist shape: exactly 2 entries, no mechanical reason ever included", () => {
    expect(DELIBERATE_CARRYOVER_REASONS).toHaveLength(2);
    expect(DELIBERATE_CARRYOVER_REASONS.some((r) => r.includes("retroactive"))).toBe(false);
    expect(DELIBERATE_CARRYOVER_REASONS.some((r) => r.startsWith("v1.8."))).toBe(false);
  });

  it("matchDeliberateReason returns null for null/undefined and for mechanical reasons", () => {
    expect(matchDeliberateReason(null)).toBeNull();
    expect(matchDeliberateReason(undefined)).toBeNull();
    expect(matchDeliberateReason("retroactive recalculation")).toBeNull();
    expect(matchDeliberateReason("v1.8.4 Ø-Methode migration (BAG 9 AZR 406/17)")).toBeNull();
  });
});
