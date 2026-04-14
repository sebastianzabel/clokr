/**
 * Integration tests for the auto-close-month plugin grace period guard (D-11).
 *
 * D-11: tryAutoCloseMonth() exits early without touching the DB when
 *       dayOfMonth < DEFAULT_CLOSE_AFTER_DAY (15).
 *
 * Strategy: tryAutoCloseMonth is a private inner function — it is not exported.
 * The only way to invoke it without modifying the implementation is to intercept
 * the `cron.schedule` call made during plugin registration.
 *
 * vi.mock('node-cron') is hoisted before any import by Vitest, so when buildApp()
 * is called inside the test it uses the mocked scheduler, which captures the callback.
 * A fresh buildApp() call is used (not the shared singleton) to guarantee the mocked
 * cron module is in effect when the plugin registers.
 *
 * Multiple plugins (attendance-checker, scheduler, data-retention, auto-close-month)
 * all call cron.schedule. We capture by cron expression: auto-close-month registers
 * "0 6 * * *" (daily at 06:00) — unique to that plugin.
 */

import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

// ── Capture cron callback by schedule expression ────────────────────────────────
// vi.mock is hoisted to the top of the file by Vitest's transform, so 'node-cron'
// is replaced BEFORE the plugin imports it.
// auto-close-month registers with "0 6 * * *" — captured here specifically.
const AUTO_CLOSE_CRON_EXPR = "0 6 * * *";
const capturedCallbacks: Record<string, () => void> = {};

vi.mock("node-cron", () => ({
  default: {
    schedule: vi.fn((cronExpr: string, callback: () => void) => {
      capturedCallbacks[cronExpr] = callback;
      // Return a minimal ScheduledTask stub
      return { stop: vi.fn() };
    }),
  },
}));

// ── Imports (after mock declaration — safe because vi.mock is hoisted) ─────────
import { buildApp } from "../app";
import { seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("auto-close-month plugin — grace period guard (D-11)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let autoCloseCronCallback: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    // Build a fresh app so the mocked node-cron is in effect during plugin registration.
    // This is separate from the shared getTestApp() singleton used in other test files.
    app = await buildApp();
    await app.ready();

    // Extract the auto-close-month callback after plugins have registered
    autoCloseCronCallback = capturedCallbacks[AUTO_CLOSE_CRON_EXPR] as (() => Promise<void>) | null;

    // Seed test data for snapshot presence checks in the "does not exit" test
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
    // Close this fresh app instance (does not affect the shared singleton)
    await app.close();
    vi.useRealTimers();
  });

  it("D-11: cron callback was captured for auto-close-month schedule (0 6 * * *)", () => {
    // Verify the mock intercepted cron.schedule("0 6 * * *", ...) during buildApp()
    expect(autoCloseCronCallback).not.toBeNull();
  });

  it("D-11: exits early without querying any tenants when dayOfMonth < 15", async () => {
    expect(autoCloseCronCallback).not.toBeNull();

    // Mock Date to day 5 of February 2024 — well below DEFAULT_CLOSE_AFTER_DAY (15)
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2024-02-05T06:00:00.000Z")); // day 5

    // Spy on tenant.findMany — the grace period guard returns before this is ever called.
    // auto-close-month calls app.prisma.tenant.findMany({ include: { config: true } })
    // only AFTER the guard. If the guard fires, this spy must NOT be called.
    const tenantFindManySpy = vi.spyOn(app.prisma.tenant, "findMany");
    // Spy on saldoSnapshot.create — must NOT be called when the guard fires
    const snapshotCreateSpy = vi.spyOn(app.prisma.saldoSnapshot, "create");

    try {
      await autoCloseCronCallback!();

      // dayOfMonth (5) < DEFAULT_CLOSE_AFTER_DAY (15) → early return
      // The function logs and returns before any DB operation
      expect(tenantFindManySpy).not.toHaveBeenCalled();
      expect(snapshotCreateSpy).not.toHaveBeenCalled();
    } finally {
      tenantFindManySpy.mockRestore();
      snapshotCreateSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("D-11: does NOT exit early when dayOfMonth >= 15 (proceeds to tenant lookup)", async () => {
    expect(autoCloseCronCallback).not.toBeNull();

    // Mock Date to day 16 of February 2024 — past the DEFAULT_CLOSE_AFTER_DAY threshold
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2024-02-16T06:00:00.000Z")); // day 16

    // Spy on tenant.findMany — must be called because the guard condition does NOT fire
    const tenantFindManySpy = vi.spyOn(app.prisma.tenant, "findMany");

    try {
      await autoCloseCronCallback!();

      // dayOfMonth (16) >= DEFAULT_CLOSE_AFTER_DAY (15) → guard skipped, tenants fetched
      expect(tenantFindManySpy).toHaveBeenCalledWith(
        expect.objectContaining({ include: expect.objectContaining({ config: true }) }),
      );
    } finally {
      tenantFindManySpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
