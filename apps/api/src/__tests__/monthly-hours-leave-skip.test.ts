/**
 * Integration tests for Phase 58 (issue #192):
 *
 *  A) MONTHLY_HOURS Minijobber with APPROVED leave → expected (Soll) is NOT reduced
 *     by leaveMinutes. Per CLAUDE.md "Schedule Types": MONTHLY_HOURS is a flexible
 *     schedule, holiday/absence deductions do NOT apply.
 *  B) NEGATIVE CONTROL: FIXED_SCHEDULE employee with APPROVED leave → expected IS
 *     reduced (no regression for the standard case).
 *  C) MONTHLY_HOURS pure-tracking (monthlyHours = 0) — broader gate preserves the
 *     pre-existing isPureTracking behavior.
 *
 * Test pattern mirrors apps/api/src/__tests__/overtime-monthly-hours-and-shift-saldo.test.ts:
 * shared singleton Fastify app via getTestApp, per-suite tenant slug, no Date mocking.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, cleanupTestData } from "./setup";
import { updateOvertimeAccount } from "../routes/time-entries";
import { dateStrInTz } from "../utils/timezone";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";

const TZ = "Europe/Berlin";

describe("updateOvertimeAccount — MONTHLY_HOURS leave-skip (#192)", () => {
  let app: FastifyInstance;
  let tenantId: string;

  // Test A: MONTHLY_HOURS Minijobber WITH leave
  let mhWithLeaveEmpId: string;
  // Test A reference: MONTHLY_HOURS Minijobber WITHOUT leave (same params)
  let mhNoLeaveEmpId: string;
  // Test B: FIXED_SCHEDULE WITH leave
  let fixedWithLeaveEmpId: string;
  // Test B reference: FIXED_SCHEDULE WITHOUT leave
  let fixedNoLeaveEmpId: string;
  // Test C: MONTHLY_HOURS pure-tracking (monthlyHours = 0)
  let pureTrackingEmpId: string;

  // Skip-guard: if `leaveDate === hireDate` (month just started, no past weekday
  // available inside the current month), Test B's 8h delta cannot materialize.
  let skipFixedDelta = false;

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const s = "mhleave-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    // Compute first-day-of-current-month (TZ-aware) and a past weekday inside the month
    const now = new Date();
    const monthLabel = dateStrInTz(now, TZ).slice(0, 7); // "YYYY-MM"
    const hireDate = new Date(`${monthLabel}-01T00:00:00Z`);

    // Find a past weekday inside the current month (walk back from yesterday)
    let leaveDate: Date | null = null;
    const cursor = new Date(now.getTime() - 86400000); // yesterday
    for (let i = 0; i < 30; i++) {
      const cursorStr = dateStrInTz(cursor, TZ);
      if (!cursorStr.startsWith(monthLabel)) break;
      const dow = new Date(cursorStr + "T00:00:00Z").getUTCDay();
      if (dow !== 0 && dow !== 6) {
        leaveDate = new Date(cursorStr + "T00:00:00Z");
        break;
      }
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    // If no past weekday inside the current month, fall back to hireDate itself
    // and flag that Test B's 8h-delta assertion should be skipped.
    if (!leaveDate) {
      leaveDate = hireDate;
      skipFixedDelta = true;
    }

    // ── Tenant + admin + leaveType ──────────────────────────────────────
    const tenant = await prisma.tenant.create({
      data: {
        name: `MH Leave Skip ${s}`,
        slug: `mh-leave-${s}`,
        federalState: "NIEDERSACHSEN",
      },
    });
    tenantId = tenant.id;
    await prisma.tenantConfig.create({
      data: { tenantId: tenant.id, defaultVacationDays: 30, timezone: TZ },
    });

    const adminUser = await prisma.user.create({
      data: {
        email: `admin-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "ADMIN",
        isActive: true,
      },
    });
    const adminEmp = await prisma.employee.create({
      data: {
        tenantId: tenant.id,
        userId: adminUser.id,
        employeeNumber: `ADM-${s}`,
        firstName: "Admin",
        lastName: "MhLeave",
        hireDate: new Date("2024-01-01"),
      },
    });
    await prisma.workSchedule.create({
      data: {
        employeeId: adminEmp.id,
        type: "FIXED_SCHEDULE",
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
    await prisma.overtimeAccount.create({
      data: { employeeId: adminEmp.id, balanceHours: 0 },
    });

    const vacationType = await prisma.leaveType.create({
      data: {
        tenantId: tenant.id,
        name: "Urlaub",
        isPaid: true,
        requiresApproval: true,
        color: "#3B82F6",
      },
    });

    // Helper to create an employee + WorkSchedule + OvertimeAccount.
    const mkEmployee = async (
      slug: string,
      schedType: "MONTHLY_HOURS" | "FIXED_SCHEDULE",
      monthlyHours: number | null,
    ) => {
      const u = await prisma.user.create({
        data: {
          email: `${slug}-${s}@test.de`,
          passwordHash: await bcrypt.hash("test1234", 10),
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const emp = await prisma.employee.create({
        data: {
          tenantId: tenant.id,
          userId: u.id,
          employeeNumber: `${slug.toUpperCase()}-${s}`,
          firstName: slug,
          lastName: "Test",
          hireDate,
        },
      });
      await prisma.workSchedule.create({
        data: {
          employeeId: emp.id,
          type: schedType,
          weeklyHours: schedType === "FIXED_SCHEDULE" ? 40 : null,
          monthlyHours,
          mondayHours: schedType === "FIXED_SCHEDULE" ? 8 : 3,
          tuesdayHours: schedType === "FIXED_SCHEDULE" ? 8 : 3,
          wednesdayHours: schedType === "FIXED_SCHEDULE" ? 8 : 3,
          thursdayHours: schedType === "FIXED_SCHEDULE" ? 8 : 3,
          fridayHours: schedType === "FIXED_SCHEDULE" ? 8 : 3,
          saturdayHours: 0,
          sundayHours: 0,
          validFrom: hireDate,
        },
      });
      await prisma.overtimeAccount.create({
        data: { employeeId: emp.id, balanceHours: 0 },
      });
      return emp.id;
    };

    // Helper to seed an APPROVED 1-day LeaveRequest on `leaveDate`.
    const mkLeave = async (empId: string) => {
      await prisma.leaveRequest.create({
        data: {
          employeeId: empId,
          leaveTypeId: vacationType.id,
          startDate: leaveDate!,
          endDate: leaveDate!,
          days: 1,
          status: "APPROVED",
        },
      });
    };

    mhWithLeaveEmpId = await mkEmployee("mhwl", "MONTHLY_HOURS", 15);
    mhNoLeaveEmpId = await mkEmployee("mhnl", "MONTHLY_HOURS", 15);
    fixedWithLeaveEmpId = await mkEmployee("fxwl", "FIXED_SCHEDULE", null);
    fixedNoLeaveEmpId = await mkEmployee("fxnl", "FIXED_SCHEDULE", null);
    pureTrackingEmpId = await mkEmployee("pt", "MONTHLY_HOURS", 0);

    await mkLeave(mhWithLeaveEmpId);
    await mkLeave(fixedWithLeaveEmpId);
    // mhNoLeaveEmpId and fixedNoLeaveEmpId stay leave-free as references.
    // pureTrackingEmpId stays leave-free.
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("Test A: MONTHLY_HOURS Minijobber with APPROVED leave → expected NOT reduced (issue #192)", async () => {
    await updateOvertimeAccount(app, mhWithLeaveEmpId);
    await updateOvertimeAccount(app, mhNoLeaveEmpId);

    const withLeave = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: mhWithLeaveEmpId },
    });
    const noLeave = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: mhNoLeaveEmpId },
    });

    // With the fix: balances should be (approximately) equal — leave does NOT deduct.
    // Tolerance: 0.05h (3 minutes) for floating-point + holiday arithmetic noise.
    const diff = Math.abs(
      Number(withLeave?.balanceHours ?? 0) - Number(noLeave?.balanceHours ?? 0),
    );
    expect(diff).toBeLessThan(0.05);
  });

  it("Test B: FIXED_SCHEDULE with APPROVED leave → expected IS reduced by ~8h (negative control)", async () => {
    if (skipFixedDelta) {
      // Month just started — no past weekday available; leave falls on hireDate,
      // which is outside the open range (rangeStart > leaveDate). Negative control
      // cannot demonstrate the 8h delta; skip rather than flake.
      return;
    }
    await updateOvertimeAccount(app, fixedWithLeaveEmpId);
    await updateOvertimeAccount(app, fixedNoLeaveEmpId);

    const withLeave = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: fixedWithLeaveEmpId },
    });
    const noLeave = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: fixedNoLeaveEmpId },
    });

    // With leave, expected drops by 8h → balance is 8h LESS negative.
    // delta = balanceWithLeave - balanceWithoutLeave ≈ +8 (positive, ~8h).
    const delta = Number(withLeave?.balanceHours ?? 0) - Number(noLeave?.balanceHours ?? 0);
    expect(delta).toBeGreaterThan(7.5);
    expect(delta).toBeLessThan(8.5);
  });

  it("Test C: MONTHLY_HOURS pure-tracking (monthlyHours = 0) — broader gate preserves pre-existing behavior", async () => {
    await updateOvertimeAccount(app, pureTrackingEmpId);
    const account = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: pureTrackingEmpId },
    });
    // worked = 0, expected = 0 (no monthly budget) → balance ≈ 0.
    expect(Math.abs(Number(account?.balanceHours ?? 0))).toBeLessThan(0.01);
  });
});
