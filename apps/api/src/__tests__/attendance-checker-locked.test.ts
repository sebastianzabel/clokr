/**
 * Integration tests for the attendance-checker auto-invalidate locked-entry guard.
 *
 * COMP-V1814-08 (T-76.21-23): The auto-invalidate scan (Feature 3 of
 * attendanceCheckerPlugin) must NEVER mutate a locked TimeEntry. Locked entries
 * belong to a closed month and are subject to Revisionssicherheit — they must not
 * be changed by any automated job.
 *
 * The fix adds `isLocked: false` to the findMany where clause so locked entries
 * are never even returned to the scan, preventing any downstream update.
 *
 * Test strategy: seed a locked open entry and an unlocked open entry in an isolated
 * tenant, invoke app.tryAutoInvalidate(), then assert the locked entry remains
 * untouched while the unlocked entry is set to isInvalid: true.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("attendance-checker — auto-invalidate locked-entry guard (COMP-V1814-08)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe("edge cases", () => {
    it("edge cases — attendance-checker skips locked entries", async () => {
      // ── Arrange: isolated tenant so other test tenants are not affected ──
      const s = `achk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
      const tenant = await app.prisma.tenant.create({
        data: { name: `ACHKTest ${s}`, slug: `achk-${s}`, federalState: "NIEDERSACHSEN" },
      });
      // Set autoDeleteOpenHours = 12 so entries older than 12 h are found
      await app.prisma.tenantConfig.create({
        data: {
          tenantId: tenant.id,
          defaultVacationDays: 30,
          timezone: "Europe/Berlin",
          autoDeleteOpenHours: 12,
        },
      });

      // Create a single employee for both entries (different dates, respects unique constraint)
      const user = await app.prisma.user.create({
        data: {
          email: `achk-${s}@test.de`,
          passwordHash: "x",
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const emp = await app.prisma.employee.create({
        data: {
          tenantId: tenant.id,
          userId: user.id,
          employeeNumber: `ACHK-${s}`,
          firstName: "Achk",
          lastName: "Tester",
          hireDate: new Date("2024-01-01"),
          isTimeTrackingExempt: false,
        },
      });
      await app.prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });

      // startTime values: both older than the 12 h autoDeleteOpenHours threshold
      const dayBeforeYesterday = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

      // Date-only values (midnight UTC) — satisfies the @@unique([employeeId, date]) index
      const dateDbyString = dayBeforeYesterday.toISOString().slice(0, 10);
      const dateYestString = yesterday.toISOString().slice(0, 10);

      // Locked open entry (isLocked:true) — should NOT be invalidated by the scan
      const lockedEntry = await app.prisma.timeEntry.create({
        data: {
          employeeId: emp.id,
          startTime: dayBeforeYesterday,
          endTime: null,
          date: new Date(dateDbyString + "T00:00:00.000Z"),
          isInvalid: false,
          isLocked: true, // closed-month entry that somehow lacks an endTime (defensive test)
        },
      });

      // Unlocked open entry (isLocked:false) — SHOULD be invalidated by the scan
      const unlockedEntry = await app.prisma.timeEntry.create({
        data: {
          employeeId: emp.id,
          startTime: yesterday,
          endTime: null,
          date: new Date(dateYestString + "T00:00:00.000Z"),
          isInvalid: false,
          isLocked: false,
        },
      });

      try {
        // ── Act ──
        await app.tryAutoInvalidate();

        // ── Assert ──
        const lockedAfter = await app.prisma.timeEntry.findUnique({
          where: { id: lockedEntry.id },
        });
        const unlockedAfter = await app.prisma.timeEntry.findUnique({
          where: { id: unlockedEntry.id },
        });

        // Locked entry MUST remain untouched (Revisionssicherheit)
        // BUG (before fix): locked entry IS invalidated (isLocked not in findMany where)
        // PASS (after fix): locked entry stays isInvalid: false
        expect(lockedAfter!.isInvalid).toBe(false);

        // Unlocked entry must be auto-invalidated (this is the intended behaviour)
        expect(unlockedAfter!.isInvalid).toBe(true);
      } finally {
        await cleanupTestData(app, tenant.id);
      }
    });
  });
});
