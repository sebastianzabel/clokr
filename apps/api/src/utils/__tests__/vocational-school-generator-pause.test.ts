// Phase 80 Plan 03 — Per-tenant pause API for the vocational-school generator.
//
// Plans 80-01 + 80-02 import `pauseTenantGeneration` / `resumeTenantGeneration`
// to stop the daily 02:30 cron from inserting fresh Absence VOCATIONAL_SCHOOL
// rows during the per-tenant migration window (M-4 mitigation in PITFALLS.md).
//
// The 7 tests below pin the contract Plans 80-01 + 80-02 depend on:
//   1. pauseTenantGeneration adds tenant to set (per-tenant isolation)
//   2. resumeTenantGeneration removes tenant from set
//   3. runVocationalSchoolGeneration short-circuits with empty result when paused
//      (NO DB read — verified via Prisma mock spy on findMany)
//   4. Resume + immediate re-run executes the full code path again
//   5. Double-pause is idempotent (Set semantics — single entry; double-resume no-op)
//   6. Two-tenant isolation (pausing tenant A does NOT pause tenant B)
//   7. _resetPausedTenantsForTests clears the set (IN-11; used by Plans 80-01/02
//      test suites in beforeEach to prevent cross-suite state leak)

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  pauseTenantGeneration,
  resumeTenantGeneration,
  isTenantPaused,
  _resetPausedTenantsForTests,
  runVocationalSchoolGeneration,
} from "../vocational-school-generator";
import type { PrismaClient } from "@clokr/db";
import type { FastifyInstance } from "fastify";

type AuditFn = FastifyInstance["audit"];

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Minimal Prisma stub that records calls to `employeeVocationalSchoolPattern.findMany`.
 * Test 3 asserts ZERO calls when the tenant is paused — proves the short-circuit
 * is BEFORE any DB read (M-4 mitigation requirement).
 */
function makePrismaSpy() {
  const findManySpy = vi.fn().mockResolvedValue([]);
  const prisma = {
    employeeVocationalSchoolPattern: {
      findMany: findManySpy,
    },
    // Other accessors are unused in the paused path; the test suite never
    // exercises the full code path (we only care about the short-circuit).
  } as unknown as PrismaClient;
  return { prisma, findManySpy };
}

const noopAudit: AuditFn = (async () => undefined) as unknown as AuditFn;

// ── tests ────────────────────────────────────────────────────────────────────

describe("pauseTenantGeneration / resumeTenantGeneration (Phase 80 Plan 03)", () => {
  beforeEach(() => {
    // IN-11: Reset the in-process pause set between every test so suite ordering
    // does not leak state. Plans 80-01 + 80-02 use the same helper.
    _resetPausedTenantsForTests();
  });

  it("Test 1: pauseTenantGeneration marks the targeted tenant as paused only", () => {
    pauseTenantGeneration("t-1");
    expect(isTenantPaused("t-1")).toBe(true);
    expect(isTenantPaused("t-2")).toBe(false);
  });

  it("Test 2: resumeTenantGeneration clears the pause for the targeted tenant", () => {
    pauseTenantGeneration("t-1");
    resumeTenantGeneration("t-1");
    expect(isTenantPaused("t-1")).toBe(false);
  });

  it("Test 3: runVocationalSchoolGeneration short-circuits with empty result when paused (NO DB read)", async () => {
    const { prisma, findManySpy } = makePrismaSpy();
    pauseTenantGeneration("t-paused");

    const result = await runVocationalSchoolGeneration(prisma, noopAudit, {
      tenantId: "t-paused",
    });

    // Empty result tuple — matches the contract Plans 80-01/02 depend on.
    expect(result).toEqual({
      created: 0,
      skipped: {
        schoolHoliday: 0,
        existing: 0,
        locked: 0,
        preHire: 0,
        postExit: 0,
        outOfWindow: 0,
      },
    });

    // Critical: ZERO DB reads. The short-circuit MUST be before any prisma call.
    expect(findManySpy).not.toHaveBeenCalled();
  });

  it("Test 4: resume + immediate re-run executes the full code path (DB read happens)", async () => {
    const { prisma, findManySpy } = makePrismaSpy();
    pauseTenantGeneration("t-1");
    resumeTenantGeneration("t-1");

    await runVocationalSchoolGeneration(prisma, noopAudit, { tenantId: "t-1" });

    // Resume → full code path → findMany IS called (returns [] from the spy,
    // so the rest of the body short-circuits naturally on the empty result).
    expect(findManySpy).toHaveBeenCalledTimes(1);
  });

  it("Test 5: pause / resume are idempotent (Set semantics + no throw on double-call)", () => {
    pauseTenantGeneration("t-1");
    pauseTenantGeneration("t-1");
    expect(isTenantPaused("t-1")).toBe(true);

    resumeTenantGeneration("t-1");
    expect(() => resumeTenantGeneration("t-1")).not.toThrow();
    expect(isTenantPaused("t-1")).toBe(false);
  });

  it("Test 6: two tenants pause independently (per-tenant isolation)", () => {
    pauseTenantGeneration("t-1");
    expect(isTenantPaused("t-1")).toBe(true);
    expect(isTenantPaused("t-2")).toBe(false);

    pauseTenantGeneration("t-2");
    expect(isTenantPaused("t-1")).toBe(true);
    expect(isTenantPaused("t-2")).toBe(true);

    resumeTenantGeneration("t-1");
    expect(isTenantPaused("t-1")).toBe(false);
    expect(isTenantPaused("t-2")).toBe(true); // unaffected
  });

  it("Test 7 (IN-11): _resetPausedTenantsForTests clears the set", () => {
    pauseTenantGeneration("t-1");
    pauseTenantGeneration("t-2");
    expect(isTenantPaused("t-1")).toBe(true);
    expect(isTenantPaused("t-2")).toBe(true);

    _resetPausedTenantsForTests();

    expect(isTenantPaused("t-1")).toBe(false);
    expect(isTenantPaused("t-2")).toBe(false);
  });
});
