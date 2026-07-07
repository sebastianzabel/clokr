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
import { monthRangeUtc } from "../utils/timezone";

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

  // ── Plan 76.19-04: absence subtraction + §18-exempt exclusion (DATA-V1814-02) ──

  async function createFixedEmployee(
    tenantId: string,
    exempt: boolean,
  ): Promise<{ id: string; userId: string }> {
    const s = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const user = await app.prisma.user.create({
      data: {
        email: `acm2-${s}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const emp = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `ACM2-${s}`,
        firstName: "Auto",
        lastName: "Close",
        hireDate: new Date("2024-01-01"),
        isTimeTrackingExempt: exempt,
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2024-01-01"),
      },
    });
    await app.prisma.overtimeAccount.create({
      data: { employeeId: emp.id, balanceHours: 0 },
    });
    return { id: emp.id, userId: user.id };
  }

  it("D-02: excludes §18 time-tracking-exempt employees from the snapshot loop", async () => {
    const exempt = await createFixedEmployee(data.tenant.id, true);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2024-02-16T06:00:00.000Z")); // Berlin local day 16 >= 15

    const findUniqueSpy = vi.spyOn(app.prisma.saldoSnapshot, "findUnique");
    try {
      await app.tryAutoCloseMonth();
      // Non-exempt seeded employee IS looked up; exempt employee is NOT.
      expect(findUniqueFiredForSeededTenant(findUniqueSpy, [data.employee.id])).toBe(true);
      expect(findUniqueFiredForSeededTenant(findUniqueSpy, [exempt.id])).toBe(false);
    } finally {
      findUniqueSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("D-02: subtracts general Absence minutes from netExpected (parity with manual close)", async () => {
    const emp = await createFixedEmployee(data.tenant.id, false);
    // A general absence (Sonderurlaub) covering all of February 2024 → the whole
    // month is covered (reaches readyToClose) and expected must be reduced to ~0.
    await app.prisma.absence.create({
      data: {
        employeeId: emp.id,
        type: "SPECIAL_LEAVE",
        source: "MANUAL",
        startDate: new Date("2024-02-01"),
        endDate: new Date("2024-02-29"),
        days: 21,
        createdBy: data.adminEmployee.id,
      },
    });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2024-03-16T06:00:00.000Z")); // closes Feb 2024
    try {
      await app.tryAutoCloseMonth();
    } finally {
      vi.useRealTimers();
    }

    const snapshot = await app.prisma.saldoSnapshot.findFirst({
      where: { employeeId: emp.id, periodType: "MONTHLY" },
    });
    expect(snapshot).not.toBeNull();
    // Without the fix, netExpected would be the full month Soll (~10080 min);
    // with the absence subtracted it is ~0 (worked 0 − expected ~0 → balance ~0).
    expect(snapshot!.expectedMinutes).toBeLessThan(480);
    expect(snapshot!.balanceMinutes).toBeGreaterThan(-480);
  });

  // ── Plan 76.21-08: COMP-V1814-08 mid-year hire yearly snapshot threshold ──

  describe("edge cases", () => {
    /**
     * Create a minimal employee in an isolated tenant with a standard work schedule
     * and overtime account. The tenant is fresh per test call to prevent cross-test
     * interference when tryAutoCloseMonth() iterates ALL tenants.
     */
    async function createEdgeTenant(suffix: string) {
      const s = `edge-${suffix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
      const tenant = await app.prisma.tenant.create({
        data: { name: `Edge Tenant ${s}`, slug: `edge-${s}`, federalState: "NIEDERSACHSEN" },
      });
      await app.prisma.tenantConfig.create({
        data: { tenantId: tenant.id, defaultVacationDays: 30, timezone: "Europe/Berlin" },
      });
      return tenant;
    }

    async function createEdgeEmployee(tenantId: string, hireDate: Date) {
      const s = `emp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
      const user = await app.prisma.user.create({
        data: { email: `${s}@edge.test`, passwordHash: "x", role: "EMPLOYEE", isActive: true },
      });
      const emp = await app.prisma.employee.create({
        data: {
          tenantId,
          userId: user.id,
          employeeNumber: s,
          firstName: "Edge",
          lastName: "Tester",
          hireDate,
          isTimeTrackingExempt: false,
        },
      });
      await app.prisma.workSchedule.create({
        data: {
          employeeId: emp.id,
          weeklyHours: 40,
          mondayHours: 8,
          tuesdayHours: 8,
          wednesdayHours: 8,
          thursdayHours: 8,
          fridayHours: 8,
          saturdayHours: 0,
          sundayHours: 0,
          validFrom: hireDate,
        },
      });
      await app.prisma.overtimeAccount.create({
        data: { employeeId: emp.id, balanceHours: 0 },
      });
      return { empId: emp.id, userId: user.id };
    }

    /**
     * Seed MONTHLY SaldoSnapshots for the given employee for each month in `months`.
     * Uses monthRangeUtc with Europe/Berlin so periodStart matches exactly what
     * tryAutoCloseMonth() expects for the findUnique(employeeId_periodType_periodStart) lookup.
     */
    async function seedMonthlySnapshots(employeeId: string, year: number, months: number[]) {
      const tz = "Europe/Berlin";
      for (const month of months) {
        const { start, end } = monthRangeUtc(year, month, tz);
        await app.prisma.saldoSnapshot.create({
          data: {
            employeeId,
            periodType: "MONTHLY",
            periodStart: start,
            periodEnd: end,
            workedMinutes: 8 * 60 * 21, // placeholder: 21 working days × 8h
            expectedMinutes: 8 * 60 * 21,
            balanceMinutes: 0,
            carryOver: 0,
            closedAt: new Date(),
            closedBy: "test-system",
            superseded: false,
          },
        });
      }
    }

    it("edge cases — mid-year hire yearly snapshot", async () => {
      // COMP-V1814-08: employee hired July 2024 → only 6 months in 2024 (Jul-Dec).
      // With the bug (< 12 check) the YEARLY snapshot is never created.
      // After the fix (< expectedMonths = 6), it IS created.
      const tenant = await createEdgeTenant("myr");
      const { empId, userId } = await createEdgeEmployee(tenant.id, new Date("2024-07-01"));

      // Pre-seed all 6 monthly snapshots (Jul-Dec 2024) so that Dec is already "closed"
      // and the monthly loop skips our employee — leaving only the yearly check to run.
      await seedMonthlySnapshots(empId, 2024, [7, 8, 9, 10, 11, 12]);

      vi.useFakeTimers({ toFake: ["Date"] });
      // Jan 16, 2025 → prevYear=2024, prevMonth=12 → triggers yearly snapshot loop
      vi.setSystemTime(new Date("2025-01-16T06:00:00.000Z"));

      try {
        await app.tryAutoCloseMonth();

        const yearly = await app.prisma.saldoSnapshot.findFirst({
          where: { employeeId: empId, periodType: "YEARLY", superseded: false },
        });
        // BUG (before fix): yearly is null (6 < 12 → skipped)
        // PASS (after fix): yearly is not null (6 >= expectedMonths=6 → created)
        expect(yearly).not.toBeNull();
      } finally {
        vi.useRealTimers();
        await cleanupTestData(app, tenant.id);
      }
    });

    it("edge cases — full-year hire still needs all months", async () => {
      // Sanity check: full-year employee with only 11 closed months must NOT get a
      // YEARLY snapshot (regardless of hireDate-aware fix). This ensures the fix
      // doesn't accidentally lower the bar for full-year employees.
      const tenant = await createEdgeTenant("fyr");
      const { empId, userId } = await createEdgeEmployee(tenant.id, new Date("2024-01-01"));

      // Seed only 11 months — December 2024 intentionally missing.
      await seedMonthlySnapshots(empId, 2024, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2025-01-16T06:00:00.000Z"));

      try {
        await app.tryAutoCloseMonth();

        const yearly = await app.prisma.saldoSnapshot.findFirst({
          where: { employeeId: empId, periodType: "YEARLY", superseded: false },
        });
        // 11 months < expectedMonths=12 → no YEARLY snapshot yet
        expect(yearly).toBeNull();
      } finally {
        vi.useRealTimers();
        await cleanupTestData(app, tenant.id);
      }
    });
  });
});
