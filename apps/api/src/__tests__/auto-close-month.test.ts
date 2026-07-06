/**
 * Integration tests for the auto-close-month plugin grace period guard (D-11).
 *
 * D-11: tryAutoCloseMonth() exits early without touching the DB when
 *       dayOfMonth < DEFAULT_CLOSE_AFTER_DAY (15).
 *
 * Phase 66 fix: the prior version mocked `node-cron` and captured callbacks by
 * cron expression. Both `autoCloseMonthPlugin` and `carryoverWarningPlugin`
 * register `"0 6 * * *"`, so the capture map was last-writer-wins — the test
 * actually invoked the carryover-warning callback (visible in failure output
 * as `tenant.findMany({ select: { id: true } })`, which is carryover's signature).
 *
 * Plugin now exposes `app.tryAutoCloseMonth` via Fastify decorator. The test
 * invokes it directly — no cron plumbing involved.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("auto-close-month plugin — grace period guard (D-11)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    // Seed for snapshot presence checks in the "does not exit" test
    data = await seedTestData(app, "acm");
  });

  afterAll(async () => {
    try {
      const employees = await app.prisma.employee.findMany({
        where: { tenantId: data.tenant.id },
        select: { id: true },
      });
      const employeeIds = employees.map((e) => e.id);
      await app.prisma.saldoSnapshot.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("auto-close-month test cleanup failed:", err);
    }
    await closeTestApp();
    vi.useRealTimers();
  });

  // Helper: did the per-employee snapshot lookup fire for THIS tenant's employees?
  // saldoSnapshot.findUnique runs inside the tenant loop only AFTER the grace check
  // passes, so its presence/absence is a reliable "was this tenant processed?" probe.
  function findUniqueFiredForSeededTenant(
    spy: ReturnType<typeof vi.spyOn>,
    employeeIds: string[],
  ): boolean {
    return spy.mock.calls.some((call: unknown[]) => {
      const where = (
        call[0] as { where?: { employeeId_periodType_periodStart?: { employeeId?: string } } }
      )?.where?.employeeId_periodType_periodStart;
      return where?.employeeId != null && employeeIds.includes(where.employeeId);
    });
  }

  it("D-11: grace check skips the tenant (no processing) when the tenant-local day < 15", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 2024-02-05T06:00Z → Europe/Berlin local day 5 (< 15) → tenant skipped via continue.
    vi.setSystemTime(new Date("2024-02-05T06:00:00.000Z"));

    const findUniqueSpy = vi.spyOn(app.prisma.saldoSnapshot, "findUnique");
    const snapshotCreateSpy = vi.spyOn(app.prisma.saldoSnapshot, "create");
    const seededIds = [data.adminEmployee.id, data.employee.id];

    try {
      await app.tryAutoCloseMonth();
      // Grace fired → this tenant's employees were never looked up or closed.
      expect(findUniqueFiredForSeededTenant(findUniqueSpy, seededIds)).toBe(false);
      expect(snapshotCreateSpy).not.toHaveBeenCalled();
    } finally {
      findUniqueSpy.mockRestore();
      snapshotCreateSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("D-11: grace check is TENANT-TZ-aware — UTC day 14 but Berlin-local day 15 proceeds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 2024-02-14T23:30Z is UTC day 14 (< 15) but Europe/Berlin local day 15 (>= 15).
    // A UTC-based guard would wrongly SKIP; the per-tenant dateStrInTz guard PROCEEDS.
    vi.setSystemTime(new Date("2024-02-14T23:30:00.000Z"));

    const findUniqueSpy = vi.spyOn(app.prisma.saldoSnapshot, "findUnique");
    const seededIds = [data.adminEmployee.id, data.employee.id];

    try {
      await app.tryAutoCloseMonth();
      // Local day 15 → the Berlin tenant IS processed (employees looked up).
      expect(findUniqueFiredForSeededTenant(findUniqueSpy, seededIds)).toBe(true);
    } finally {
      findUniqueSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("D-11: proceeds to process the tenant when the tenant-local day >= 15", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2024-02-16T06:00:00.000Z")); // Berlin local day 16 >= 15

    const findUniqueSpy = vi.spyOn(app.prisma.saldoSnapshot, "findUnique");
    const seededIds = [data.adminEmployee.id, data.employee.id];

    try {
      await app.tryAutoCloseMonth();
      expect(findUniqueFiredForSeededTenant(findUniqueSpy, seededIds)).toBe(true);
    } finally {
      findUniqueSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
