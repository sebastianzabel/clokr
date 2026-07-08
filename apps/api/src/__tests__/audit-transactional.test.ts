/**
 * Tests for transactional audit (COMP-V1814-05).
 *
 * Covers:
 *   1. tx routing: audit() inside a rolled-back $transaction leaves NO row
 *   2. backward compat: audit() without tx creates exactly 1 row
 *   3. anonymize rollback: ANONYMIZE audit row rolled back with failed tx
 *
 * These tests are INTENTIONALLY written to FAIL against the pre-fix audit.ts
 * (which always uses app.prisma, ignoring any tx parameter). They pass once
 * audit.ts routes through params.tx ?? app.prisma.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";

describe("audit-transactional (COMP-V1814-05)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  // Unique prefix per test run — avoids cross-run collisions in the shared test DB
  const runId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "audit-tx");
  });

  afterAll(async () => {
    // Delete any audit rows written outside of rolled-back transactions
    await app.prisma.auditLog.deleteMany({
      where: { action: { startsWith: `TX_TEST_${runId}` } },
    });
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("audit-transactional test cleanup failed:", err);
    }
  });

  it("tx routing: audit row inside a rolled-back $transaction does NOT persist", async () => {
    const action = `TX_TEST_${runId}_ROUTING`;

    // Write an audit row inside a transaction that subsequently throws.
    // With the pre-fix implementation, audit() uses app.prisma (outside the tx)
    // so the row persists → this assertion fails → RED.
    // After the fix, audit() uses tx → row is rolled back → PASSES.
    await app.prisma
      .$transaction(async (tx) => {
        await app.audit({
          userId: data.adminUser.id,
          action,
          entity: "Test",
          entityId: "test-entity-id",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tx: tx as any,
        });
        throw new Error("deliberate rollback — tx routing test");
      })
      .catch(() => {
        /* expected */
      });

    const count = await app.prisma.auditLog.count({ where: { action } });
    expect(count).toBe(0);
  });

  it("backward compat: audit() without tx creates exactly 1 row", async () => {
    const action = `TX_TEST_${runId}_COMPAT`;

    await app.audit({
      userId: data.adminUser.id,
      action,
      entity: "Test",
      entityId: "test-entity-id",
    });

    const count = await app.prisma.auditLog.count({ where: { action } });
    expect(count).toBe(1);
    // Cleanup in afterAll via prefix-delete
  });

  it("anonymize rollback: ANONYMIZE audit row inside a rolled-back tx does NOT persist", async () => {
    const entityId = `anon-rollback-${runId}`;

    // Simulate the fixed employees.ts DELETE handler: audit is called inside the
    // $transaction. If the tx fails, the ANONYMIZE row must not appear.
    await app.prisma
      .$transaction(async (tx) => {
        await app.audit({
          userId: data.adminUser.id,
          action: `TX_TEST_${runId}_ANONYMIZE`,
          entity: "Employee",
          entityId,
          oldValue: { employeeNumber: "TEST-ANON" },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tx: tx as any,
        });
        // Simulate a failure after the audit write (e.g. anonymizeEmployeeData throws)
        throw new Error("simulated anonymize failure — rollback test");
      })
      .catch(() => {
        /* expected */
      });

    const count = await app.prisma.auditLog.count({
      where: { action: `TX_TEST_${runId}_ANONYMIZE`, entityId },
    });
    expect(count).toBe(0);
  });

  it("WR-01: HARD_DELETE audit row inside a rolled-back deletion tx does NOT persist (no phantom audit on failed delete)", async () => {
    // Simulates the fixed employees.ts hard-delete handler (WR-01):
    // app.audit({action:"HARD_DELETE", tx}) is now called INSIDE the $transaction.
    // If the deletion fails (e.g. a Restrict constraint fires), the audit row must
    // roll back with the transaction — no phantom HARD_DELETE entry in the audit trail.
    const entityId = `hard-delete-rollback-${runId}`;

    await app.prisma
      .$transaction(async (tx) => {
        await app.audit({
          userId: data.adminUser.id,
          action: `TX_TEST_${runId}_HARD_DELETE`,
          entity: "Employee",
          entityId,
          oldValue: { employeeNumber: "GELOESCHT-001", retentionStart: "2015-01-01" },
          newValue: { forceDelete: false, retentionExpiresAt: "2025-01-01" },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tx: tx as any,
        });
        // Simulate a deletion failure (e.g. constraint violation, DB error)
        throw new Error("simulated hard-delete failure — WR-01 rollback test");
      })
      .catch(() => {
        /* expected */
      });

    const count = await app.prisma.auditLog.count({
      where: { action: `TX_TEST_${runId}_HARD_DELETE`, entityId },
    });
    expect(count).toBe(0);
  });
});
