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

  it("D-11: exits early without querying any tenants when dayOfMonth < 15", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2024-02-05T06:00:00.000Z")); // day 5 < 15

    // Spy on tenant.findMany — must NOT be called when guard fires.
    // auto-close-month signature: `tenant.findMany({ include: { config: true } })`.
    // We match that exact shape so any unrelated tenant.findMany from other code
    // paths doesn't accidentally satisfy the assertion.
    const tenantFindManySpy = vi.spyOn(app.prisma.tenant, "findMany");
    const snapshotCreateSpy = vi.spyOn(app.prisma.saldoSnapshot, "create");

    try {
      await app.tryAutoCloseMonth();
      const autoCloseCalls = tenantFindManySpy.mock.calls.filter(
        (call) =>
          call[0] !== undefined &&
          typeof call[0] === "object" &&
          "include" in call[0] &&
          (call[0] as { include?: { config?: boolean } }).include?.config === true,
      );
      expect(autoCloseCalls).toHaveLength(0);
      expect(snapshotCreateSpy).not.toHaveBeenCalled();
    } finally {
      tenantFindManySpy.mockRestore();
      snapshotCreateSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("D-11: does NOT exit early when dayOfMonth >= 15 (proceeds to tenant lookup)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2024-02-16T06:00:00.000Z")); // day 16 >= 15

    const tenantFindManySpy = vi.spyOn(app.prisma.tenant, "findMany");

    try {
      await app.tryAutoCloseMonth();
      expect(tenantFindManySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({ config: true }),
        }),
      );
    } finally {
      tenantFindManySpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
