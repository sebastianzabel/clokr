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
import { updateOvertimeAccount } from "../routes/time-entries";
import { recalculateSnapshots } from "../utils/recalculate-snapshots";

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
  // saldoSnapshot.findFirst (COMP-V1814-04: replaced findUnique after @@unique → partial index)
  // runs inside the tenant loop only AFTER the grace check passes, so its presence/absence is
  // a reliable "was this tenant processed?" probe.
  function findFirstFiredForSeededTenant(
    spy: ReturnType<typeof vi.spyOn>,
    employeeIds: string[],
  ): boolean {
    return spy.mock.calls.some((call: unknown[]) => {
      const where = (call[0] as { where?: { employeeId?: string } })?.where;
      return where?.employeeId != null && employeeIds.includes(where.employeeId);
    });
  }

  it("D-11: grace check skips the tenant (no processing) when the tenant-local day < 15", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 2024-02-05T06:00Z → Europe/Berlin local day 5 (< 15) → tenant skipped via continue.
    vi.setSystemTime(new Date("2024-02-05T06:00:00.000Z"));

    const findFirstSpy = vi.spyOn(app.prisma.saldoSnapshot, "findFirst");
    const snapshotCreateSpy = vi.spyOn(app.prisma.saldoSnapshot, "create");
    const seededIds = [data.adminEmployee.id, data.employee.id];

    try {
      await app.tryAutoCloseMonth();
      // Grace fired → this tenant's employees were never looked up or closed.
      expect(findFirstFiredForSeededTenant(findFirstSpy, seededIds)).toBe(false);
      expect(snapshotCreateSpy).not.toHaveBeenCalled();
    } finally {
      findFirstSpy.mockRestore();
      snapshotCreateSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("D-11: grace check is TENANT-TZ-aware — UTC day 14 but Berlin-local day 15 proceeds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 2024-02-14T23:30Z is UTC day 14 (< 15) but Europe/Berlin local day 15 (>= 15).
    // A UTC-based guard would wrongly SKIP; the per-tenant dateStrInTz guard PROCEEDS.
    vi.setSystemTime(new Date("2024-02-14T23:30:00.000Z"));

    const findFirstSpy = vi.spyOn(app.prisma.saldoSnapshot, "findFirst");
    const seededIds = [data.adminEmployee.id, data.employee.id];

    try {
      await app.tryAutoCloseMonth();
      // Local day 15 → the Berlin tenant IS processed (employees looked up).
      expect(findFirstFiredForSeededTenant(findFirstSpy, seededIds)).toBe(true);
    } finally {
      findFirstSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("D-11: proceeds to process the tenant when the tenant-local day >= 15", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2024-02-16T06:00:00.000Z")); // Berlin local day 16 >= 15

    const findFirstSpy = vi.spyOn(app.prisma.saldoSnapshot, "findFirst");
    const seededIds = [data.adminEmployee.id, data.employee.id];

    try {
      await app.tryAutoCloseMonth();
      expect(findFirstFiredForSeededTenant(findFirstSpy, seededIds)).toBe(true);
    } finally {
      findFirstSpy.mockRestore();
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

    const findFirstSpy = vi.spyOn(app.prisma.saldoSnapshot, "findFirst");
    try {
      await app.tryAutoCloseMonth();
      // Non-exempt seeded employee IS looked up; exempt employee is NOT.
      expect(findFirstFiredForSeededTenant(findFirstSpy, [data.employee.id])).toBe(true);
      expect(findFirstFiredForSeededTenant(findFirstSpy, [exempt.id])).toBe(false);
    } finally {
      findFirstSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("D-02: subtracts general Absence minutes from netExpected (parity with manual close)", async () => {
    const emp = await createFixedEmployee(data.tenant.id, false);
    // Sequential-close guard: January 2024 must be closed before the cron may close
    // February. Seed a minimal January snapshot (employee hired 2024-01-01).
    const janRange = monthRangeUtc(2024, 1, "Europe/Berlin");
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: emp.id,
        periodType: "MONTHLY",
        periodStart: janRange.start,
        periodEnd: janRange.end,
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date(),
        closedBy: "test-system",
      },
    });
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
      orderBy: { periodStart: "desc" }, // February (the January guard-seed sorts earlier)
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot!.periodEnd.toISOString().slice(0, 10)).toBe("2024-02-29");
    // Without the fix, netExpected would be the full month Soll (~10080 min);
    // with the absence subtracted it is ~0 (worked 0 − expected ~0 → balance ~0).
    expect(snapshot!.expectedMinutes).toBeLessThan(480);
    expect(snapshot!.balanceMinutes).toBeGreaterThan(-480);
  });

  // ── SHIFT_BASED: auto-close must use actual shift durations, not Ø-Methode ──

  describe("SHIFT_BASED expectedMinutes", () => {
    /**
     * Create an isolated tenant + SHIFT_BASED employee, trigger tryAutoCloseMonth(),
     * and assert snapshot expectedMinutes matches actual shift netto — NOT Ø-Methode.
     *
     * Strategy: give the SHIFT_BASED schedule non-zero marker hours ONLY on the exact
     * days that have shifts (so the readiness check only demands entries on those days).
     * Also create matching time entries on those days so the employee reaches readyToClose.
     *
     * Regression for the prod bug where calcExpectedMinutesTz() (Ø-Methode) was used
     * for all schedule types including SHIFT_BASED, producing a result diverging from
     * actual shifts and flipping the saldo sign.
     */
    async function createShiftScenario(
      suffix: string,
      workScheduleOverrides?: {
        tuesdayHours?: number;
        thursdayHours?: number;
        fridayHours?: number;
      },
    ) {
      const s = `shift-${suffix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
      const tenant = await app.prisma.tenant.create({
        data: { name: `Shift ${s}`, slug: `shift-${s}`, federalState: "NIEDERSACHSEN" },
      });
      await app.prisma.tenantConfig.create({
        data: {
          tenantId: tenant.id,
          defaultVacationDays: 30,
          timezone: "Europe/Berlin",
          defaultBreakOver6h: 30,
          defaultBreakOver9h: 45,
        },
      });
      const user = await app.prisma.user.create({
        data: {
          email: `${s}@shift.test`,
          passwordHash: "x",
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const emp = await app.prisma.employee.create({
        data: {
          tenantId: tenant.id,
          userId: user.id,
          employeeNumber: s,
          firstName: "Shift",
          lastName: "Worker",
          hireDate: new Date("2024-01-01"),
          isTimeTrackingExempt: false,
        },
      });
      // SHIFT_BASED: set non-zero marker hours only on Tue + Thu + Fri so the
      // readiness check only demands time entries on those three days.
      // weeklyHours=38 → Ø-Methode (3 days/wk, Jan 2024 has 3+3+5=11 such days) would give
      // round(38*60*11/3) = 8360 min — far from the actual 1425 min shift netto below.
      await app.prisma.workSchedule.create({
        data: {
          employeeId: emp.id,
          type: "SHIFT_BASED",
          weeklyHours: 38,
          mondayHours: 0,
          tuesdayHours: workScheduleOverrides?.tuesdayHours ?? 1,
          wednesdayHours: 0,
          thursdayHours: workScheduleOverrides?.thursdayHours ?? 1,
          fridayHours: workScheduleOverrides?.fridayHours ?? 1,
          saturdayHours: 0,
          sundayHours: 0,
          workDays: [2, 4, 5], // Tue=2, Thu=4, Fri=5
          validFrom: new Date("2024-01-01"),
        },
      });
      await app.prisma.overtimeAccount.create({
        data: { employeeId: emp.id, balanceHours: 0 },
      });
      return { tenant, empId: emp.id, userId: user.id };
    }

    /**
     * Seed a minimal time entry (with endTime) on the given date so the employee
     * passes the readiness check for that workday.
     */
    async function seedEntry(empId: string, dateStr: string) {
      await app.prisma.timeEntry.create({
        data: {
          employeeId: empId,
          date: new Date(dateStr + "T00:00:00Z"),
          startTime: new Date(dateStr + "T08:00:00Z"),
          endTime: new Date(dateStr + "T16:00:00Z"),
          breakMinutes: 30,
          type: "WORK",
        },
      });
    }

    it("uses actual shift netto durations (not Ø-Methode) for expectedMinutes", async () => {
      const { tenant, empId } = await createShiftScenario("basic");

      // Three shifts in January 2024 on the days that have marker hours (Tue/Thu/Fri):
      //   Tue Jan 2:  09:00-18:00 = 9h brutto → break 30min → netto 510min
      //   Thu Jan 4:  09:00-15:00 = 6h brutto → break 0min  → netto 360min
      //   Fri Jan 5:  10:00-20:00 = 10h brutto → break 45min → netto 555min
      // Total shift netto = 510 + 360 + 555 = 1425 min
      //
      // Ø-Methode with weeklyHours=38, 3 marker days/week, 11 Tue/Thu/Fri in Jan 2024:
      //   round(38 * 60 * 11 / 3) = 8360 min — confirms divergence from actual 1425.
      const shiftDays = [
        { date: "2024-01-02", startTime: "09:00", endTime: "18:00" }, // Tue, 510 net
        { date: "2024-01-04", startTime: "09:00", endTime: "15:00" }, // Thu, 360 net
        { date: "2024-01-05", startTime: "10:00", endTime: "20:00" }, // Fri, 555 net
      ];
      for (const sh of shiftDays) {
        await app.prisma.shift.create({
          data: {
            employeeId: empId,
            date: new Date(sh.date + "T00:00:00Z"),
            startTime: sh.startTime,
            endTime: sh.endTime,
          },
        });
      }

      // Remaining Tue/Thu/Fri in January (after Jan 2/4/5) also need entries to pass
      // the readiness check. Seed dummy entries (they don't affect expectedMinutes).
      const remainingWorkdays = [
        "2024-01-09",
        "2024-01-11",
        "2024-01-12",
        "2024-01-16",
        "2024-01-18",
        "2024-01-19",
        "2024-01-23",
        "2024-01-25",
        "2024-01-26",
        "2024-01-30",
      ];
      for (const d of remainingWorkdays) {
        await seedEntry(empId, d);
      }
      // Also seed for the shift days themselves
      for (const sh of shiftDays) {
        await seedEntry(empId, sh.date);
      }

      vi.useFakeTimers({ toFake: ["Date"] });
      // Feb 16, 2024 → closes January 2024
      vi.setSystemTime(new Date("2024-02-16T06:00:00.000Z"));
      try {
        await app.tryAutoCloseMonth();
      } finally {
        vi.useRealTimers();
      }

      const snapshot = await app.prisma.saldoSnapshot.findFirst({
        where: { employeeId: empId, periodType: "MONTHLY", superseded: false },
      });
      expect(snapshot, "snapshot should have been created by auto-close").not.toBeNull();
      // Phase 76.22 — Model B re-pin (SALDO-V1816-01): expectedMinutes is now C_net
      // (contract Ø-Methode Soll), NOT Σ shift netto durations (Model A was 1425).
      //
      // Computation:
      //   Schedule: weeklyHours=38, Tue+Thu+Fri (3 days/week).
      //   January 2024 has 13 Tue+Thu+Fri workdays (5 Tue + 4 Thu + 4 Fri).
      //   C = round(38 × 60 × 13 / 3) = round(9880) = 9880 min.
      //   No leave/absence → C_net = 9880 (stored as expectedMinutes, not R=1425).
      expect(snapshot!.expectedMinutes).toBe(9880); // Model B C_net (was 1425 in Model A)

      await cleanupTestData(app, tenant.id);
    });

    it("SHIFT_BASED: excludes shifts on leave-covered dates from expectedMinutes", async () => {
      const { tenant, empId } = await createShiftScenario("leave", {
        tuesdayHours: 1,
        thursdayHours: 1,
        fridayHours: 0,
      });

      // Two shifts on Jan 2 (Tue) and Jan 4 (Thu). Jan 4 is covered by approved leave →
      // only the Jan 2 shift contributes: 9h brutto - 30min break = 510 min netto.
      await app.prisma.shift.create({
        data: {
          employeeId: empId,
          date: new Date("2024-01-02T00:00:00Z"),
          startTime: "09:00",
          endTime: "18:00",
        },
      });
      await app.prisma.shift.create({
        data: {
          employeeId: empId,
          date: new Date("2024-01-04T00:00:00Z"),
          startTime: "09:00",
          endTime: "18:00",
        },
      });

      let leaveType = await app.prisma.leaveType.findFirst({
        where: { tenantId: tenant.id },
      });
      if (!leaveType) {
        leaveType = await app.prisma.leaveType.create({
          data: {
            tenantId: tenant.id,
            name: "Urlaub",
            isPaid: true,
            requiresApproval: false,
          },
        });
      }
      await app.prisma.leaveRequest.create({
        data: {
          employeeId: empId,
          leaveTypeId: leaveType.id,
          startDate: new Date("2024-01-04"),
          endDate: new Date("2024-01-04"),
          days: 1,
          status: "APPROVED",
        },
      });

      // Seed entries for all Jan Tue/Thu (the marker days) so employee is readyToClose.
      // Jan 4 has approved leave → it's in coveredDates, so no entry needed there.
      const tuesdays = ["2024-01-02", "2024-01-09", "2024-01-16", "2024-01-23", "2024-01-30"];
      const thursdays = ["2024-01-11", "2024-01-18", "2024-01-25"];
      for (const d of [...tuesdays, ...thursdays]) {
        await seedEntry(empId, d);
      }

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2024-02-16T06:00:00.000Z"));
      try {
        await app.tryAutoCloseMonth();
      } finally {
        vi.useRealTimers();
      }

      const snapshot = await app.prisma.saldoSnapshot.findFirst({
        where: { employeeId: empId, periodType: "MONTHLY", superseded: false },
      });
      expect(snapshot, "snapshot should have been created").not.toBeNull();
      // Phase 76.22 — Model B re-pin (SALDO-V1816-01): expectedMinutes is now C_net
      // (contract Ø-Methode Soll net of leave credit), NOT Σ uncovered shift netto (Model A was 510).
      //
      // Computation:
      //   Schedule override: weeklyHours=38, Tue+Thu only (2 days/week), fridayHours=0.
      //   January 2024 has 9 Tue+Thu workdays (5 Tue + 4 Thu).
      //   C = round(38 × 60 × 9 / 2) = round(10260) = 10260 min.
      //   Leave credit (Jan 4, Thu, 1 day): calcLeaveAbsenceMinutesTz = round(38×60×1/2) = 1140 min.
      //   C_net = 10260 − 1140 = 9120 min (stored as expectedMinutes, not R=510).
      //   R (roster, Jan 2 shift only — Jan 4 in coveredDates): 510 min.
      //   W (worked) = 0 (only time entries without meaningful endTime were seeded for readiness).
      //   balance = max(0,0−9120) − max(0,510−0) = −510 min.
      expect(snapshot!.expectedMinutes).toBe(9120); // Model B C_net (was 510 in Model A)

      await cleanupTestData(app, tenant.id);
    });

    it("invariant: live saldo (all open) equals cron-closed saldo for SHIFT_BASED", async () => {
      const { tenant, empId } = await createShiftScenario("invariant");

      // Seed a zero December-2023 snapshot so the live calc's open range starts at
      // Jan 1 (without any snapshot, updateOvertimeAccount falls back to the CURRENT
      // month only and would not cover January under the Feb-16 fake clock).
      const decRange = monthRangeUtc(2023, 12, "Europe/Berlin");
      await app.prisma.saldoSnapshot.create({
        data: {
          employeeId: empId,
          periodType: "MONTHLY",
          periodStart: decRange.start,
          periodEnd: decRange.end,
          workedMinutes: 0,
          expectedMinutes: 0,
          balanceMinutes: 0,
          carryOver: 0,
          closedAt: new Date(),
          closedBy: "test-system",
        },
      });

      // 3 shifts (netto 1425) + entries on every marker workday in January.
      const shiftDays = [
        { date: "2024-01-02", startTime: "09:00", endTime: "18:00" },
        { date: "2024-01-04", startTime: "09:00", endTime: "15:00" },
        { date: "2024-01-05", startTime: "10:00", endTime: "20:00" },
      ];
      for (const sh of shiftDays) {
        await app.prisma.shift.create({
          data: {
            employeeId: empId,
            date: new Date(sh.date + "T00:00:00Z"),
            startTime: sh.startTime,
            endTime: sh.endTime,
          },
        });
      }
      const allWorkdays = [
        "2024-01-02",
        "2024-01-04",
        "2024-01-05",
        "2024-01-09",
        "2024-01-11",
        "2024-01-12",
        "2024-01-16",
        "2024-01-18",
        "2024-01-19",
        "2024-01-23",
        "2024-01-25",
        "2024-01-26",
        "2024-01-30",
      ];
      for (const d of allWorkdays) {
        await seedEntry(empId, d);
      }

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2024-02-16T06:00:00.000Z"));
      try {
        // 1) LIVE saldo with January open
        await updateOvertimeAccount(app, empId);
        const liveAccount = await app.prisma.overtimeAccount.findUnique({
          where: { employeeId: empId },
        });
        const liveBalance = Number(liveAccount!.balanceHours);

        // 2) Cron closes January → snapshot-based saldo
        await app.tryAutoCloseMonth();
        const closedAccount = await app.prisma.overtimeAccount.findUnique({
          where: { employeeId: empId },
        });
        const closedBalance = Number(closedAccount!.balanceHours);

        const snapshot = await app.prisma.saldoSnapshot.findFirst({
          where: {
            employeeId: empId,
            periodType: "MONTHLY",
            periodEnd: { gte: new Date("2024-01-30T00:00:00Z") },
            superseded: false,
          },
        });
        expect(snapshot, "January snapshot should exist after cron").not.toBeNull();

        // THE INVARIANT: closing the month must not change the saldo.
        expect(closedBalance).toBeCloseTo(liveBalance, 2);
      } finally {
        vi.useRealTimers();
      }

      await cleanupTestData(app, tenant.id);
    });

    it("backward loop: cron closes BOTH open months in one run when 2 months behind (replaces sequential guard)", async () => {
      // Phase 76.27-03 SNAP-02: the single-month sequential guard is REPLACED by a
      // bounded backward backfill loop (oldest→newest). An employee that is 2 months
      // behind gets BOTH months closed in a single cron invocation.
      //
      // Fixture: SHIFT_BASED employee, hired 2024-01-01.
      //   January 2024: shift + entries on all Tue/Thu/Fri marker days (complete).
      //   February 2024: shift + entries on all Tue/Thu/Fri marker days (complete).
      //   "Today" = March 16 2024 (cron targets February as prevMonth).
      //   NO prior snapshot exists when the cron first runs.
      //
      // With the backward loop:
      //   lastSnap = null → firstOpen = Jan 2024 (hireMonth).
      //   Months to close = [Jan 2024, Feb 2024].
      //   Jan: SHIFT_BASED, has entries + shifts, gap check passes → closes.
      //   Feb: carryOverIn = Jan.effectiveCarryOverOut → closes.
      //   Result: both Jan and Feb have active snapshots; Feb.carryOver chains off Jan.
      const { tenant, empId } = await createShiftScenario("backfill2mo");

      // January 2024 shifts and entries on all Tue/Thu/Fri marker days
      const janShiftDays = [
        { date: "2024-01-02", startTime: "09:00", endTime: "18:00" }, // Tue
        { date: "2024-01-04", startTime: "09:00", endTime: "15:00" }, // Thu
        { date: "2024-01-05", startTime: "10:00", endTime: "20:00" }, // Fri
      ];
      for (const sh of janShiftDays) {
        await app.prisma.shift.create({
          data: {
            employeeId: empId,
            date: new Date(sh.date + "T00:00:00Z"),
            startTime: sh.startTime,
            endTime: sh.endTime,
          },
        });
      }
      // Remaining Jan Tue/Thu/Fri marker days also need entries for the gap check
      const janRemainingWorkdays = [
        "2024-01-09",
        "2024-01-11",
        "2024-01-12",
        "2024-01-16",
        "2024-01-18",
        "2024-01-19",
        "2024-01-23",
        "2024-01-25",
        "2024-01-26",
        "2024-01-30",
      ];
      for (const d of [...janShiftDays.map((s) => s.date), ...janRemainingWorkdays]) {
        await seedEntry(empId, d);
      }

      // February 2024 shift + entries on all Tue/Thu/Fri marker days
      await app.prisma.shift.create({
        data: {
          employeeId: empId,
          date: new Date("2024-02-06T00:00:00Z"),
          startTime: "09:00",
          endTime: "18:00", // 540 brutto − 30 break = 510 netto
        },
      });
      const febWorkdays = [
        "2024-02-01",
        "2024-02-06",
        "2024-02-08",
        "2024-02-13",
        "2024-02-15",
        "2024-02-20",
        "2024-02-22",
        "2024-02-27",
        "2024-02-29",
      ];
      for (const d of febWorkdays) {
        await seedEntry(empId, d);
      }

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2024-03-16T06:00:00.000Z")); // targets February (prevMonth)
      try {
        // No prior snapshot — backward loop starts from hireMonth (Jan 2024).
        // Both January and February should be closed in one run.
        await app.tryAutoCloseMonth();

        const janRange = monthRangeUtc(2024, 1, "Europe/Berlin");
        const janSnapshot = await app.prisma.saldoSnapshot.findFirst({
          where: {
            employeeId: empId,
            periodType: "MONTHLY",
            periodStart: {
              gte: janRange.start,
              lt: new Date(janRange.start.getTime() + 2 * 24 * 60 * 60 * 1000),
            },
            superseded: false,
          },
        });
        expect(
          janSnapshot,
          "January 2024 must be closed by the backward loop in one run",
        ).not.toBeNull();

        const febSnapshot = await app.prisma.saldoSnapshot.findFirst({
          where: {
            employeeId: empId,
            periodType: "MONTHLY",
            periodEnd: { gte: new Date("2024-02-28T00:00:00Z") },
            superseded: false,
          },
        });
        expect(
          febSnapshot,
          "February 2024 must be closed in the same cron run (backward loop)",
        ).not.toBeNull();

        // carryOver chain: Feb.carryOver = Jan.effectiveCarryOverOut + Feb.balance
        if (janSnapshot && febSnapshot) {
          expect(febSnapshot.carryOver).toBe(janSnapshot.carryOver + febSnapshot.balanceMinutes);
        }
      } finally {
        vi.useRealTimers();
      }

      await cleanupTestData(app, tenant.id);
    });

    it("gap-break (F-02): gap in month M stops the loop — months before M closed, months after M NOT closed", async () => {
      // Phase 76.27-03 SNAP-02 F-02: when a month has gaps (missing entries) and
      // closeMonthWithGapsAllowed is false (default), the backward loop BREAKS for that
      // employee. Months before the gap-blocked month ARE closed; months after are NOT.
      //
      // Fixture: SHIFT_BASED employee, hired 2024-01-01.
      //   January 2024: shift + complete entries on all Tue/Thu/Fri marker days.
      //   February 2024: NO entries, has a shift → gap-blocked (missing entries).
      //   March 2024: complete entries + shifts → would be closeable but loop breaks at Feb.
      //   "Today" = April 16 2024 (cron targets March as prevMonth).
      //
      // Expected backward loop behavior:
      //   Months = [Jan 2024, Feb 2024, Mar 2024].
      //   Jan: complete → closes.
      //   Feb: gaps → BREAK (F-02) → loop stops for this employee.
      //   Mar: never reached (loop already broke at Feb).
      //   Result: Jan has active snapshot; Feb and Mar do NOT.
      const { tenant, empId } = await createShiftScenario("gapbreak");

      // January 2024: complete entries on all Tue/Thu/Fri marker days + shifts
      const janShifts = [
        { date: "2024-01-02", startTime: "09:00", endTime: "18:00" },
        { date: "2024-01-04", startTime: "09:00", endTime: "15:00" },
        { date: "2024-01-05", startTime: "10:00", endTime: "20:00" },
      ];
      for (const sh of janShifts) {
        await app.prisma.shift.create({
          data: {
            employeeId: empId,
            date: new Date(sh.date + "T00:00:00Z"),
            startTime: sh.startTime,
            endTime: sh.endTime,
          },
        });
      }
      const janMarkerDays = [
        "2024-01-02",
        "2024-01-04",
        "2024-01-05",
        "2024-01-09",
        "2024-01-11",
        "2024-01-12",
        "2024-01-16",
        "2024-01-18",
        "2024-01-19",
        "2024-01-23",
        "2024-01-25",
        "2024-01-26",
        "2024-01-30",
      ];
      for (const d of janMarkerDays) {
        await seedEntry(empId, d);
      }

      // February 2024: shift exists but NO time entries (gap-blocked)
      await app.prisma.shift.create({
        data: {
          employeeId: empId,
          date: new Date("2024-02-06T00:00:00Z"),
          startTime: "09:00",
          endTime: "18:00",
        },
      });
      // No entries for February → findMissingWorkdays will find gaps → F-02 break

      // March 2024: complete entries on Tue/Thu/Fri marker days + shift
      await app.prisma.shift.create({
        data: {
          employeeId: empId,
          date: new Date("2024-03-05T00:00:00Z"),
          startTime: "09:00",
          endTime: "18:00",
        },
      });
      const marMarkerDays = [
        "2024-03-05",
        "2024-03-07",
        "2024-03-12",
        "2024-03-14",
        "2024-03-19",
        "2024-03-21",
        "2024-03-26",
        "2024-03-28",
      ];
      for (const d of marMarkerDays) {
        await seedEntry(empId, d);
      }

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2024-04-16T06:00:00.000Z")); // targets March as prevMonth
      try {
        await app.tryAutoCloseMonth();

        // January must be closed (it's before the gap-blocked February)
        const janRange = monthRangeUtc(2024, 1, "Europe/Berlin");
        const janSnapshot = await app.prisma.saldoSnapshot.findFirst({
          where: {
            employeeId: empId,
            periodType: "MONTHLY",
            periodStart: {
              gte: janRange.start,
              lt: new Date(janRange.start.getTime() + 2 * 24 * 60 * 60 * 1000),
            },
            superseded: false,
          },
        });
        expect(
          janSnapshot,
          "January (before gap) must be closed by the backward loop",
        ).not.toBeNull();

        // February must NOT be closed (gap-blocked → F-02 break)
        const febRange = monthRangeUtc(2024, 2, "Europe/Berlin");
        const febSnapshot = await app.prisma.saldoSnapshot.findFirst({
          where: {
            employeeId: empId,
            periodType: "MONTHLY",
            periodStart: {
              gte: febRange.start,
              lt: new Date(febRange.start.getTime() + 2 * 24 * 60 * 60 * 1000),
            },
            superseded: false,
          },
        });
        expect(febSnapshot, "February (gap-blocked, F-02) must NOT be closed").toBeNull();

        // March must NOT be closed (loop broke at February)
        const marRange = monthRangeUtc(2024, 3, "Europe/Berlin");
        const marSnapshot = await app.prisma.saldoSnapshot.findFirst({
          where: {
            employeeId: empId,
            periodType: "MONTHLY",
            periodStart: {
              gte: marRange.start,
              lt: new Date(marRange.start.getTime() + 2 * 24 * 60 * 60 * 1000),
            },
            superseded: false,
          },
        });
        expect(
          marSnapshot,
          "March (after gap-blocked Feb, never reached) must NOT be closed",
        ).toBeNull();
      } finally {
        vi.useRealTimers();
      }

      await cleanupTestData(app, tenant.id);
    });

    it("convention-robust guard: cron skips a month closed with UTC-naive periodStart", async () => {
      const { tenant, empId } = await createShiftScenario("utcnaive");

      // Simulate a legacy/manual snapshot stored with the UTC-naive convention:
      // periodStart = Jan 1 UTC midnight (NOT the TZ-converted 2023-12-31 date).
      await app.prisma.saldoSnapshot.create({
        data: {
          employeeId: empId,
          periodType: "MONTHLY",
          periodStart: new Date("2024-01-01T00:00:00Z"),
          periodEnd: new Date("2024-01-31T00:00:00Z"),
          workedMinutes: 5000,
          expectedMinutes: 4000,
          balanceMinutes: 1000,
          carryOver: 1000,
          closedAt: new Date(),
          closedBy: "test-system",
        },
      });

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2024-02-16T06:00:00.000Z")); // targets January
      try {
        await app.tryAutoCloseMonth();
      } finally {
        vi.useRealTimers();
      }

      // A periodStart-equality check would MISS the UTC-naive row and create a
      // duplicate active snapshot for January (prod evidence: dual snapshot pairs).
      const janSnapshots = await app.prisma.saldoSnapshot.findMany({
        where: {
          employeeId: empId,
          periodType: "MONTHLY",
          periodEnd: { lte: new Date("2024-02-01T00:00:00Z") },
          superseded: false,
        },
      });
      expect(janSnapshots).toHaveLength(1);
      expect(janSnapshots[0].workedMinutes).toBe(5000); // the original row, untouched

      await cleanupTestData(app, tenant.id);
    });

    it("recalculateSnapshots: SHIFT_BASED expected uses shift NETTO (break subtracted)", async () => {
      const { tenant, empId } = await createShiftScenario("recalc");

      // 3 shifts, netto 1425 (brutto 1515 − breaks 90).
      const shiftDays = [
        { date: "2024-01-02", startTime: "09:00", endTime: "18:00" }, // 510 netto
        { date: "2024-01-04", startTime: "09:00", endTime: "15:00" }, // 360 netto
        { date: "2024-01-05", startTime: "10:00", endTime: "20:00" }, // 555 netto
      ];
      for (const sh of shiftDays) {
        await app.prisma.shift.create({
          data: {
            employeeId: empId,
            date: new Date(sh.date + "T00:00:00Z"),
            startTime: sh.startTime,
            endTime: sh.endTime,
          },
        });
      }

      // Existing (stale) active snapshot for January with wrong values.
      const janRange = monthRangeUtc(2024, 1, "Europe/Berlin");
      await app.prisma.saldoSnapshot.create({
        data: {
          employeeId: empId,
          periodType: "MONTHLY",
          periodStart: janRange.start,
          periodEnd: janRange.end,
          workedMinutes: 0,
          expectedMinutes: 9999, // wrong on purpose
          balanceMinutes: -9999,
          carryOver: -9999,
          closedAt: new Date(),
          closedBy: "test-system",
        },
      });

      await recalculateSnapshots(app, empId, janRange.start);

      const active = await app.prisma.saldoSnapshot.findFirst({
        where: { employeeId: empId, periodType: "MONTHLY", superseded: false },
      });
      expect(active).not.toBeNull();
      // Phase 76.22 — Model B re-pin (SALDO-V1816-01): expectedMinutes is now C_net
      // (contract Ø-Methode Soll), NOT Σ shift netto (Model A was 1425, before that BRUTTO 1515).
      //
      // Same fixture as the auto-close test above (Tue+Thu+Fri, Jan 2024, 13 workdays):
      //   C = round(38 × 60 × 13 / 3) = 9880 min. No leave/absence → C_net = 9880.
      expect(active!.expectedMinutes).toBe(9880); // Model B C_net (was 1425 in Model A)

      await cleanupTestData(app, tenant.id);
    });
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
     * tryAutoCloseMonth() expects for the findFirst({ employeeId, periodType, periodStart, superseded:false }) lookup.
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

// ──────────────────────────────────────────────────────────────────────────────
// Phase 76.28 Plan 00 Task 3: Cron gap-note RED scaffold
//
// When closeMonthWithGapsAllowed=true on the tenant config AND a FIXED_WEEKLY
// employee has exactly 1 gap day in the target month, the cron close path MUST
// write the gap count into the MONTHLY SaldoSnapshot.note.
//
// RED against current code: auto-close-month.ts:579 always writes the static
// note "Automatischer Monatsabschluss" with no gap info. Plan 01 Task 2 turns
// this GREEN by writing the gap count into the note.
//
// Implementation note: closeMonthWithGapsAllowed is read defensively off
// tenant.config (cast to Record<string,unknown>) in auto-close-month.ts:371-373.
// The column is NOT in the Prisma schema yet (lands in Phase 76.29 CFG-01), so
// Prisma's tenant.findMany({ include: { config: true } }) would never return it.
//
// Strategy: spy on app.prisma.tenant.findMany so that for our isolated tenant, the
// returned config object includes { closeMonthWithGapsAllowed: true }. This is
// equivalent to the column existing in the schema — the type cast in auto-close-month.ts
// reads it as Record<string,unknown> so injecting it via spy produces the same
// code path as the real column will in Phase 76.29. The spy is scoped to this one
// describe block's test only (restored in finally).
// ──────────────────────────────────────────────────────────────────────────────

describe("cron gap-note (closeMonthWithGapsAllowed)", () => {
  let app: Awaited<ReturnType<typeof getTestApp>>;
  let tenantId: string;
  let gapEmpId: string;

  // January 2024: fixture month (23 Mon–Fri workdays). Fake time: Feb 16 → closes Jan.
  // Gap day: 2024-01-09 (Tuesday of week 2)
  const GAP_DAY = "2024-01-09";

  // All Mon–Fri in January 2024
  function janMonFri(): string[] {
    const out: string[] = [];
    const cur = new Date("2024-01-01T00:00:00Z");
    const end = new Date("2024-01-31T00:00:00Z");
    while (cur <= end) {
      const dow = cur.getUTCDay();
      if (dow >= 1 && dow <= 5) out.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
  }

  async function seedEntryLocal(empId: string, dateStr: string) {
    await app.prisma.timeEntry.create({
      data: {
        employeeId: empId,
        date: new Date(dateStr + "T00:00:00Z"),
        startTime: new Date(dateStr + "T07:00:00Z"),
        endTime: new Date(dateStr + "T15:30:00Z"),
        breakMinutes: 30,
        type: "WORK",
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    const s = `gapnote-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const prisma = app.prisma;

    // Isolated tenant
    const tenant = await prisma.tenant.create({
      data: { name: `GapNote ${s}`, slug: `gapnote-${s}`, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    await prisma.tenantConfig.create({
      data: {
        tenantId,
        defaultVacationDays: 30,
        timezone: "Europe/Berlin",
        defaultBreakOver6h: 30,
        defaultBreakOver9h: 45,
      },
    });

    // FIXED_WEEKLY employee, hireDate = Jan 1 2024
    const empUser = await prisma.user.create({
      data: {
        email: `gapnote-emp-${s}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const emp = await prisma.employee.create({
      data: {
        tenantId,
        userId: empUser.id,
        employeeNumber: `GN-${s}`,
        firstName: "Gap",
        lastName: "Note",
        hireDate: new Date("2024-01-01T00:00:00Z"),
        isTimeTrackingExempt: false,
      },
    });
    await prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
        type: "FIXED_SCHEDULE",
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4, 5],
        validFrom: new Date("2024-01-01T00:00:00Z"),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });
    gapEmpId = emp.id;

    // Seed all January Mon–Fri EXCEPT the gap day
    for (const d of janMonFri()) {
      if (d !== GAP_DAY) await seedEntryLocal(emp.id, d);
    }
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("cron gap-note cleanup:", err);
    }
    vi.useRealTimers();
  });

  it("cron gap-note (RED): closeMonthWithGapsAllowed=true + 1 gap day → MONTHLY snapshot.note matches /1 Lücke/", async () => {
    // Inject closeMonthWithGapsAllowed=true into our isolated tenant's config via spy.
    // The column is not in the Prisma schema (76.29 CFG-01 adds it); reading it as
    // Record<string,unknown> in auto-close-month.ts:372 returns the injected value.
    // The spy wraps the real findMany result and augments only our test tenant's config.
    const realFindMany = app.prisma.tenant.findMany.bind(app.prisma.tenant);
    const findManySpy = vi
      .spyOn(app.prisma.tenant, "findMany")
      .mockImplementation(async (...args) => {
        const tenants = await realFindMany(...(args as Parameters<typeof realFindMany>));
        return tenants.map((t) => {
          if (t.id !== tenantId) return t;
          // Inject closeMonthWithGapsAllowed=true into this tenant's config
          return {
            ...t,
            config: t.config ? { ...t.config, closeMonthWithGapsAllowed: true } : t.config,
          };
        });
      });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2024-02-16T06:00:00.000Z"));

    try {
      await app.tryAutoCloseMonth();
    } finally {
      findManySpy.mockRestore();
      vi.useRealTimers();
    }

    // Assert the MONTHLY snapshot was created for January 2024
    const janRange = monthRangeUtc(2024, 1, "Europe/Berlin");
    const snap = await app.prisma.saldoSnapshot.findFirst({
      where: {
        employeeId: gapEmpId,
        periodType: "MONTHLY",
        periodStart: {
          gte: janRange.start,
          lt: new Date(janRange.start.getTime() + 2 * 24 * 60 * 60 * 1000),
        },
        superseded: false,
      },
    });

    // If snap is null: F-02 break fired despite closeMonthWithGapsAllowed=true injection.
    // Either assertion is RED and acceptable — the test documents the expected contract.
    expect(
      snap,
      "cron gap-note (RED): MONTHLY snapshot must be created when closeMonthWithGapsAllowed=true",
    ).not.toBeNull();

    // RED: current code writes static "Automatischer Monatsabschluss" (no gap info).
    // Plan 01 Task 2 turns this GREEN by appending the gap count to the note.
    expect(
      snap!.note,
      `cron gap-note (RED): snapshot.note must match /1 Lücke/ but got: "${snap!.note}"`,
    ).toEqual(expect.stringMatching(/1 Lücke/));
  }, 60_000);
});

// ──────────────────────────────────────────────────────────────────────────────
// Phase 76.29 Plan 00 Task 3: Cron day-N window boundary — RED scaffold
//
// SUPERSEDES the day-15 grace period (DEFAULT_CLOSE_AFTER_DAY=15) from D-11.
// The new model (Variante A — Tag-N-Fenster) defers gap-months during the
// retro self-service window and only force-closes them on day N of M+1
// (N = retroEntryWindowDays, default 10).
//
// Key invariants pinned here:
//  1. In-window defer: day 1 of M+1, gap month, flag=true  → NO snapshot, notify.
//  2. At-day-N force-close: day N of M+1, gap month, flag=true → snapshot created.
//  3. Defer-forever: day N of M+1, gap month, flag=false → NO snapshot, notify only.
//  4. Gap-free immediate close: gap-FREE prior month at day 1 of M+1 → closed.
//  5. Old backfill month: gap month 3 months in the past, flag=true → force-close.
//
// References:
//  - isMonthPastItsWindow() — Plan 04 adds this cron helper.
//    Until Plan 04 lands, assertions about deferred vs force-closed behaviour are RED.
//  - closeMonthWithGapsAllowed column — Plan 01 adds it to TenantConfig.
//    Until Plan 01 lands, tests that write the column directly are RED.
//  - These tests MUST NOT touch attendance-checker.test.ts (76.28-03 reminders).
//  - All frozen "today" values use Europe/Berlin day-of-month (never UTC).
//
// RED note: tests 1-5 below will fail RED until Plans 01+04 implement the
// day-N logic. Do NOT silence these failures — they are the guard-rail.
// ──────────────────────────────────────────────────────────────────────────────

describe("cron day-N window boundary (76.29-00 RED — SUPERSEDES day-15 grace)", () => {
  let app: Awaited<ReturnType<typeof getTestApp>>;
  let tenantId: string;
  let gapEmpId: string; // employee with a gap month
  let cleanEmpId: string; // employee with a gap-FREE month

  // Fixture month: January 2025. M+1 = February 2025. N = 10 (default).
  // in-window frozen time: 2025-02-01 Berlin (day 1 < N=10)
  // at-N frozen time:      2025-02-10 Berlin (day 10 = N)

  // February 2025-02-01T06:00Z = Berlin 2025-02-01 07:00 CET (day 1 in Berlin)
  const IN_WINDOW_UTC = new Date("2025-02-01T06:00:00.000Z");
  // 2025-02-10T06:00Z = Berlin 2025-02-10 07:00 CET (day 10 = N in Berlin)
  const AT_N_UTC = new Date("2025-02-10T06:00:00.000Z");

  // Old month: October 2024 (3 months before Jan 2025) — always past its window.
  // "today" for old-backfill = 2025-02-10 (day N of Jan+1 = Feb).

  async function seedEntry76_29(empId: string, dateStr: string) {
    await app.prisma.timeEntry.create({
      data: {
        employeeId: empId,
        date: new Date(dateStr + "T00:00:00Z"),
        startTime: new Date(dateStr + "T07:00:00Z"),
        endTime: new Date(dateStr + "T15:30:00Z"),
        breakMinutes: 30,
        type: "WORK",
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    const s = `dayn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const prisma = app.prisma;

    // Isolated tenant with Berlin TZ
    const tenant = await prisma.tenant.create({
      data: { name: `DayN ${s}`, slug: `dayn-${s}`, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;

    // Write retroEntryWindowDays=10 + closeMonthWithGapsAllowed is set per-test via update.
    // Plan 01 adds the column; until then this is a no-op (column absent in schema).
    // The test uses the spy-injection pattern (same as the existing cron gap-note test above)
    // as a fallback for the column-absent case.
    await prisma.tenantConfig.create({
      data: {
        tenantId: tenant.id,
        defaultVacationDays: 30,
        timezone: "Europe/Berlin",
      },
    });

    // Gap employee: hired 2024-10-01 (covers Oct 2024 + Jan 2025 fixture months)
    const gapUser = await prisma.user.create({
      data: {
        email: `gapdayn-${s}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const gapEmp = await prisma.employee.create({
      data: {
        tenantId,
        userId: gapUser.id,
        employeeNumber: `GD-${s}`,
        firstName: "Gap",
        lastName: "DayN",
        hireDate: new Date("2024-10-01T00:00:00Z"),
        isTimeTrackingExempt: false,
      },
    });
    await prisma.workSchedule.create({
      data: {
        employeeId: gapEmp.id,
        type: "FIXED_SCHEDULE",
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4, 5],
        validFrom: new Date("2024-10-01T00:00:00Z"),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: gapEmp.id, balanceHours: 0 } });
    gapEmpId = gapEmp.id;

    // Clean employee (gap-FREE January 2025): seed all Mon-Fri of Jan 2025
    const cleanUser = await prisma.user.create({
      data: {
        email: `cleandayn-${s}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const cleanEmp = await prisma.employee.create({
      data: {
        tenantId,
        userId: cleanUser.id,
        employeeNumber: `CD-${s}`,
        firstName: "Clean",
        lastName: "DayN",
        hireDate: new Date("2025-01-01T00:00:00Z"),
        isTimeTrackingExempt: false,
      },
    });
    await prisma.workSchedule.create({
      data: {
        employeeId: cleanEmp.id,
        type: "FIXED_SCHEDULE",
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4, 5],
        validFrom: new Date("2025-01-01T00:00:00Z"),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: cleanEmp.id, balanceHours: 0 } });
    cleanEmpId = cleanEmp.id;

    // Seed all Mon-Fri of January 2025 for cleanEmp (gap-free)
    const jan2025MonFri: string[] = [];
    const cur = new Date("2025-01-01T00:00:00Z");
    const end = new Date("2025-01-31T00:00:00Z");
    while (cur <= end) {
      if (cur.getUTCDay() >= 1 && cur.getUTCDay() <= 5) {
        jan2025MonFri.push(cur.toISOString().slice(0, 10));
      }
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    for (const d of jan2025MonFri) {
      await seedEntry76_29(cleanEmpId, d);
    }

    // Gap employee: seed Jan 2025 EXCEPT 2025-01-13 (gap day)
    const GAP_DAY_JAN25 = "2025-01-13";
    for (const d of jan2025MonFri) {
      if (d !== GAP_DAY_JAN25) await seedEntry76_29(gapEmpId, d);
    }

    // Gap employee: seed October 2024 EXCEPT 2024-10-14 (gap day for old-backfill test)
    const GAP_DAY_OCT24 = "2024-10-14";
    const oct2024MonFri: string[] = [];
    const octCur = new Date("2024-10-01T00:00:00Z");
    const octEnd = new Date("2024-10-31T00:00:00Z");
    while (octCur <= octEnd) {
      if (octCur.getUTCDay() >= 1 && octCur.getUTCDay() <= 5) {
        oct2024MonFri.push(octCur.toISOString().slice(0, 10));
      }
      octCur.setUTCDate(octCur.getUTCDate() + 1);
    }
    for (const d of oct2024MonFri) {
      if (d !== GAP_DAY_OCT24) await seedEntry76_29(gapEmpId, d);
    }

    // Seed Nov + Dec 2024 for gapEmp to avoid opening gaps in the backfill chain
    for (const [mo, moStart, moEnd] of [
      ["nov", "2024-11-01", "2024-11-30"],
      ["dec", "2024-12-01", "2024-12-31"],
    ] as [string, string, string][]) {
      const moCur = new Date(moStart + "T00:00:00Z");
      const moEndDate = new Date(moEnd + "T00:00:00Z");
      while (moCur <= moEndDate) {
        if (moCur.getUTCDay() >= 1 && moCur.getUTCDay() <= 5) {
          await seedEntry76_29(gapEmpId, moCur.toISOString().slice(0, 10));
        }
        moCur.setUTCDate(moCur.getUTCDate() + 1);
      }
    }
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("cron day-N cleanup:", err);
    }
    vi.useRealTimers();
  });

  /**
   * Inject closeMonthWithGapsAllowed into the isolated tenant's config via spy.
   * Pattern mirrors the existing cron gap-note test above.
   * Falls back to real DB column once Plan 01 lands (spy still works either way).
   */
  function withGapFlag<T>(flag: boolean, fn: () => Promise<T>): () => Promise<T> {
    return async () => {
      const realFindMany = app.prisma.tenant.findMany.bind(app.prisma.tenant);
      const spy = vi
        .spyOn(app.prisma.tenant, "findMany")
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore: mockImplementation returns Promise vs PrismaPromise — pre-existing pattern, same as cron gap-note test above
        .mockImplementation(async (...args) => {
          const tenants = await realFindMany(...(args as Parameters<typeof realFindMany>));
          return tenants.map((t) => {
            if (t.id !== tenantId) return t;
            return {
              ...t,
              config: (t as Record<string, unknown>).config
                ? {
                    ...((t as Record<string, unknown>).config as object),
                    closeMonthWithGapsAllowed: flag,
                    retroEntryWindowDays: 10,
                  }
                : { closeMonthWithGapsAllowed: flag, retroEntryWindowDays: 10 },
            };
          });
        });
      try {
        return await fn();
      } finally {
        spy.mockRestore();
      }
    };
  }

  it(
    "day-N (1): IN-WINDOW defer — day 1 of M+1, gap month, flag=true → NO SaldoSnapshot created (DEFER+notify)",
    withGapFlag(true, async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      // day 1 of February 2025 in Berlin — within the N=10 window (day 1 < N=10)
      vi.setSystemTime(IN_WINDOW_UTC);
      try {
        await app.tryAutoCloseMonth();
      } finally {
        vi.useRealTimers();
      }

      // RED: Plan 04 isMonthPastItsWindow() returns false for day 1 → gap month DEFERRED.
      // Until Plan 04 lands: current code either closes or skips via day-15 grace.
      const { monthRangeUtc } = await import("../utils/timezone");
      const janRange = monthRangeUtc(2025, 1, "Europe/Berlin");
      const snap = await app.prisma.saldoSnapshot.findFirst({
        where: {
          employeeId: gapEmpId,
          periodType: "MONTHLY",
          periodStart: {
            gte: janRange.start,
            lt: new Date(janRange.start.getTime() + 2 * 24 * 60 * 60 * 1000),
          },
          superseded: false,
        },
      });
      // In-window gap month must NOT be closed (deferred)
      expect(
        snap,
        "day-N (1): gap month in-window (day 1 of M+1) must NOT have a snapshot — should be deferred",
      ).toBeNull();
    }),
    90_000,
  );

  it(
    "day-N (2): AT-DAY-N force-close — day N of M+1, gap month, flag=true → SaldoSnapshot created",
    withGapFlag(true, async () => {
      // Clean up any snapshot from previous test
      const { monthRangeUtc } = await import("../utils/timezone");
      const janRange = monthRangeUtc(2025, 1, "Europe/Berlin");
      await app.prisma.saldoSnapshot.deleteMany({
        where: {
          employeeId: gapEmpId,
          periodType: "MONTHLY",
          periodStart: {
            gte: janRange.start,
            lt: new Date(janRange.start.getTime() + 2 * 24 * 60 * 60 * 1000),
          },
        },
      });

      vi.useFakeTimers({ toFake: ["Date"] });
      // day 10 of February 2025 in Berlin — exactly day N=10 (at/after window end)
      vi.setSystemTime(AT_N_UTC);
      try {
        await app.tryAutoCloseMonth();
      } finally {
        vi.useRealTimers();
      }

      // RED: Plan 04 isMonthPastItsWindow() returns true for day N → force-close despite gap.
      const snap = await app.prisma.saldoSnapshot.findFirst({
        where: {
          employeeId: gapEmpId,
          periodType: "MONTHLY",
          periodStart: {
            gte: janRange.start,
            lt: new Date(janRange.start.getTime() + 2 * 24 * 60 * 60 * 1000),
          },
          superseded: false,
        },
      });
      expect(
        snap,
        "day-N (2): gap month at day N of M+1, flag=true must be force-closed (snapshot created)",
      ).not.toBeNull();
    }),
    90_000,
  );

  it(
    "day-N (3): DEFER-FOREVER — day N of M+1, gap month, flag=false → NO snapshot (defer-forever)",
    withGapFlag(false, async () => {
      // Clean up any snapshot
      const { monthRangeUtc } = await import("../utils/timezone");
      const janRange = monthRangeUtc(2025, 1, "Europe/Berlin");
      await app.prisma.saldoSnapshot.deleteMany({
        where: {
          employeeId: gapEmpId,
          periodType: "MONTHLY",
          periodStart: {
            gte: janRange.start,
            lt: new Date(janRange.start.getTime() + 2 * 24 * 60 * 60 * 1000),
          },
        },
      });

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(AT_N_UTC);
      try {
        await app.tryAutoCloseMonth();
      } finally {
        vi.useRealTimers();
      }

      // RED: when flag=false, even day N must NOT force-close — defer-forever.
      const snap = await app.prisma.saldoSnapshot.findFirst({
        where: {
          employeeId: gapEmpId,
          periodType: "MONTHLY",
          periodStart: {
            gte: janRange.start,
            lt: new Date(janRange.start.getTime() + 2 * 24 * 60 * 60 * 1000),
          },
          superseded: false,
        },
      });
      expect(
        snap,
        "day-N (3): flag=false at day N must NOT force-close (defer-forever) — no snapshot",
      ).toBeNull();
    }),
    90_000,
  );

  it(
    "day-N (4): GAP-FREE immediate close — gap-FREE prior month at day 1 of M+1 → closed immediately",
    withGapFlag(true, async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      // day 1 of February 2025 — within retro window — but cleanEmp has NO gaps in Jan 2025
      vi.setSystemTime(IN_WINDOW_UTC);
      try {
        await app.tryAutoCloseMonth();
      } finally {
        vi.useRealTimers();
      }

      // RED: gap-FREE month must close immediately regardless of the day-N window.
      // (The window only defers gap months; complete months close right away.)
      const { monthRangeUtc } = await import("../utils/timezone");
      const janRange = monthRangeUtc(2025, 1, "Europe/Berlin");
      const snap = await app.prisma.saldoSnapshot.findFirst({
        where: {
          employeeId: cleanEmpId,
          periodType: "MONTHLY",
          periodStart: {
            gte: janRange.start,
            lt: new Date(janRange.start.getTime() + 2 * 24 * 60 * 60 * 1000),
          },
          superseded: false,
        },
      });
      expect(
        snap,
        "day-N (4): gap-FREE month must be closed immediately at day 1 of M+1 (no day-N wait)",
      ).not.toBeNull();
    }),
    90_000,
  );

  it(
    "day-N (5): OLD BACKFILL MONTH — gap month 3 months in the past (Oct 2024) with flag=true → force-closed immediately",
    withGapFlag(true, async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      // Today = 2025-02-10 (day N). October 2024 is 4 months in the past → always past its window.
      vi.setSystemTime(AT_N_UTC);
      try {
        await app.tryAutoCloseMonth();
      } finally {
        vi.useRealTimers();
      }

      // RED: old backfill months (well past their window) must force-close immediately.
      const { monthRangeUtc } = await import("../utils/timezone");
      const octRange = monthRangeUtc(2024, 10, "Europe/Berlin");
      const snap = await app.prisma.saldoSnapshot.findFirst({
        where: {
          employeeId: gapEmpId,
          periodType: "MONTHLY",
          periodStart: {
            gte: octRange.start,
            lt: new Date(octRange.start.getTime() + 2 * 24 * 60 * 60 * 1000),
          },
          superseded: false,
        },
      });
      expect(
        snap,
        "day-N (5): old backfill month (Oct 2024, past its window) with flag=true must be force-closed",
      ).not.toBeNull();
    }),
    90_000,
  );
});
