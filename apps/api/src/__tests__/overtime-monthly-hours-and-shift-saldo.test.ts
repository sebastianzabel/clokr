/**
 * Integration tests for 260527-fkm:
 *
 *  1) updateOvertimeAccount uses per-month MONTHLY_HOURS pro-rata when the open
 *     range spans multiple calendar months (no single-month-denominator distortion).
 *  2) updateOvertimeAccount uses Shift rows as the source of truth for SHIFT_BASED
 *     expectedMinutes (sum of endTime - startTime), not the flat
 *     weeklyHours × calendar-days / 7 formula.
 *  3) SHIFT_BASED correctly skips Shifts on days covered by approved leave.
 *
 * Pattern mirrors apps/api/src/__tests__/overtime-absence-saldo.test.ts:
 * shared singleton Fastify app, fresh tenant per suite, no Date mocking.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, cleanupTestData } from "./setup";
import { updateOvertimeAccount } from "../routes/time-entries";
import { monthRangeUtc, dateStrInTz } from "../utils/timezone";
import { getHolidays, STATE_MAP } from "../utils/holidays";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";

const TZ = "Europe/Berlin";

// Count working days (Mon + Tue, per Test 1 schedule) inside [start, end] in TZ.
function countMondayTuesdayWorkdays(start: Date, end: Date): number {
  // Iterate as TZ-local YYYY-MM-DD strings so DST doesn't shift the count.
  let count = 0;
  const cur = new Date(dateStrInTz(start, TZ) + "T00:00:00Z");
  const last = new Date(dateStrInTz(end, TZ) + "T00:00:00Z");
  while (cur <= last) {
    const dow = cur.getUTCDay(); // 0=Sun..6=Sat; midnight UTC == midnight in TZ-local label
    if (dow === 1 || dow === 2) count++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return count;
}

// Expected minutes for a MONTHLY_HOURS Mo+Tu schedule across [start, end] using
// the SAME per-month pro-rata algorithm the production code now uses. This is
// the assertion target for Test 1.
function expectedMinutesMonthlyMonTue(start: Date, end: Date, monthlyHours: number): number {
  // Walk one calendar month at a time, summing
  //   monthlyHours * (rangeWorkdaysInMonth / monthFullWorkdays) * 60.
  let total = 0;
  const startStr = dateStrInTz(start, TZ);
  let [y, m] = startStr.split("-").map(Number);
  const endStr = dateStrInTz(end, TZ);
  for (let i = 0; i < 240; i++) {
    const { start: mStart, end: mEnd } = monthRangeUtc(y, m, TZ);
    const segStart = start > mStart ? start : mStart;
    const segEnd = end < mEnd ? end : mEnd;
    if (segStart <= segEnd) {
      const rangeWd = countMondayTuesdayWorkdays(segStart, segEnd);
      const monthFullWd = countMondayTuesdayWorkdays(mStart, mEnd);
      if (monthFullWd > 0) total += (monthlyHours * 60 * rangeWd) / monthFullWd;
    }
    if (dateStrInTz(mEnd, TZ) >= endStr) break;
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return total;
}

describe("updateOvertimeAccount — MONTHLY_HOURS multi-month pro-rata + SHIFT_BASED Shift-sum", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminUserId: string;

  // Test 1: MONTHLY_HOURS Minijobber (Mo+Tu = 2 workdays/week, 80h/month)
  let monthlyEmpId: string;
  const MONTHLY_HIRE_DATE = new Date("2026-01-01T00:00:00Z");

  // Test 2 + 3: SHIFT_BASED employee
  let shiftEmpAId: string; // used by Test 2 (no leave)
  let shiftEmpBId: string; // used by Test 3 (one leave-covered shift)
  const SHIFT_HIRE_DATE = new Date("2026-01-01T00:00:00Z");

  // Shifts seeded for Test 2 / Test 3: three 8h shifts in the current month.
  // We compute these inside beforeAll relative to "today" so the test is
  // deterministic regardless of wall-clock date.
  let shiftDates: Date[] = [];

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const s = "fkm-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    // ── Tenant ──────────────────────────────────────────────────────────────
    const tenant = await prisma.tenant.create({
      data: { name: `FKM Saldo Test ${s}`, slug: `fkm-${s}`, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    await prisma.tenantConfig.create({
      data: { tenantId: tenant.id, defaultVacationDays: 30, timezone: TZ },
    });

    // ── Admin user (needed for createdBy / token / leaveType) ────────────────
    const adminUser = await prisma.user.create({
      data: {
        email: `admin-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "ADMIN",
        isActive: true,
      },
    });
    adminUserId = adminUser.id;
    const adminEmp = await prisma.employee.create({
      data: {
        tenantId: tenant.id,
        userId: adminUser.id,
        employeeNumber: `ADM-${s}`,
        firstName: "Admin",
        lastName: "FKM",
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
    await prisma.overtimeAccount.create({ data: { employeeId: adminEmp.id, balanceHours: 0 } });

    // ── LeaveType (needed for Test 3 LeaveRequest seed) ─────────────────────
    const vacationType = await prisma.leaveType.create({
      data: {
        tenantId: tenant.id,
        name: "Urlaub",
        isPaid: true,
        requiresApproval: true,
        color: "#3B82F6",
      },
    });

    // ── Test 1 employee: MONTHLY_HOURS, hired Jan 1 2026, 80h/month, Mo+Tu ──
    const monthlyUser = await prisma.user.create({
      data: {
        email: `mh-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const monthlyEmp = await prisma.employee.create({
      data: {
        tenantId: tenant.id,
        userId: monthlyUser.id,
        employeeNumber: `MH-${s}`,
        firstName: "Mini",
        lastName: "Jobber",
        hireDate: MONTHLY_HIRE_DATE,
      },
    });
    monthlyEmpId = monthlyEmp.id;
    await prisma.workSchedule.create({
      data: {
        employeeId: monthlyEmp.id,
        type: "MONTHLY_HOURS",
        weeklyHours: null,
        monthlyHours: 80,
        // 2 workdays/week (Mo+Tu = 4h each in the Soll model, monthly = 80h cap)
        // The per-day hours here are only the workday markers used by
        // calcExpectedMinutesTz to count workdays-per-month; the actual Soll
        // comes from monthlyHours.
        mondayHours: 4,
        tuesdayHours: 4,
        wednesdayHours: 0,
        thursdayHours: 0,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: MONTHLY_HIRE_DATE,
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: monthlyEmp.id, balanceHours: 0 } });

    // ── Test 2 employee: SHIFT_BASED, no leave ──────────────────────────────
    const shiftUserA = await prisma.user.create({
      data: {
        email: `sb-a-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const shiftEmpA = await prisma.employee.create({
      data: {
        tenantId: tenant.id,
        userId: shiftUserA.id,
        employeeNumber: `SBA-${s}`,
        firstName: "Schicht",
        lastName: "Alpha",
        hireDate: SHIFT_HIRE_DATE,
      },
    });
    shiftEmpAId = shiftEmpA.id;
    await prisma.workSchedule.create({
      data: {
        employeeId: shiftEmpA.id,
        type: "SHIFT_BASED",
        weeklyHours: 40,
        monthlyHours: null,
        // Per-day fields are required defaults; SHIFT_BASED ignores them in the
        // new branch (expected comes from Shift rows).
        mondayHours: 0,
        tuesdayHours: 0,
        wednesdayHours: 0,
        thursdayHours: 0,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: SHIFT_HIRE_DATE,
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: shiftEmpA.id, balanceHours: 0 } });

    // ── Test 3 employee: SHIFT_BASED + one leave-covered shift ──────────────
    const shiftUserB = await prisma.user.create({
      data: {
        email: `sb-b-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const shiftEmpB = await prisma.employee.create({
      data: {
        tenantId: tenant.id,
        userId: shiftUserB.id,
        employeeNumber: `SBB-${s}`,
        firstName: "Schicht",
        lastName: "Beta",
        hireDate: SHIFT_HIRE_DATE,
      },
    });
    shiftEmpBId = shiftEmpB.id;
    await prisma.workSchedule.create({
      data: {
        employeeId: shiftEmpB.id,
        type: "SHIFT_BASED",
        weeklyHours: 40,
        monthlyHours: null,
        mondayHours: 0,
        tuesdayHours: 0,
        wednesdayHours: 0,
        thursdayHours: 0,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: SHIFT_HIRE_DATE,
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: shiftEmpB.id, balanceHours: 0 } });

    // ── Shift seeding: 3 past weekdays in the current month, 8h each ────────
    // Walk backwards from "yesterday" picking weekdays inside the current month.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const monthLabel = dateStrInTz(today, TZ).slice(0, 7); // "YYYY-MM"
    const collected: Date[] = [];
    const cursor = new Date(today.getTime() - 86400000); // yesterday
    while (collected.length < 3 && dateStrInTz(cursor, TZ).startsWith(monthLabel)) {
      const dow = cursor.getUTCDay();
      if (dow !== 0 && dow !== 6) {
        // Use a DB-friendly @db.Date midnight UTC
        collected.push(new Date(dateStrInTz(cursor, TZ) + "T00:00:00Z"));
      }
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    // If we don't have enough days this month yet (e.g. month just started),
    // accept what we have — Test 2/3 thresholds are computed from
    // `collected.length`.
    shiftDates = collected;

    for (const empId of [shiftEmpAId, shiftEmpBId]) {
      for (const d of shiftDates) {
        await prisma.shift.create({
          data: {
            employeeId: empId,
            date: d,
            startTime: "08:00",
            endTime: "16:00",
            label: "Test Shift",
            createdBy: adminUser.id,
          },
        });
      }
    }

    // Test 3: APPROVED leave covering the FIRST seeded shift's date for empB
    if (shiftDates.length > 0) {
      await prisma.leaveRequest.create({
        data: {
          employeeId: shiftEmpBId,
          leaveTypeId: vacationType.id,
          startDate: shiftDates[0],
          endDate: shiftDates[0],
          days: 1,
          status: "APPROVED",
        },
      });
    }
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("MONTHLY_HOURS multi-month: expected uses per-month pro-rata, not single-month denominator", async () => {
    // Seed a previous-month snapshot so the open range starts BEFORE the current
    // month — this is the only way to force the multi-month branch in updateOvertimeAccount
    // (without a snapshot, rangeStart defaults to monthStart, never multi-month).
    //
    // Snapshot covers [hireDate, 2 months ago end-of-month] with carryOver=0,
    // so the open range becomes [snapshot.periodEnd + 1, yesterday], spanning
    // at least 2 calendar months as soon as today is past day 2 of any month.
    const now = new Date();
    const todayStr = dateStrInTz(now, TZ);
    const [yNow, mNow] = todayStr.split("-").map(Number);
    // Use a snapshot that ends 2 calendar months before "now" to guarantee
    // the open range spans at least one month boundary regardless of day-of-month.
    let snapYear = yNow;
    let snapMonth = mNow - 2;
    while (snapMonth < 1) {
      snapMonth += 12;
      snapYear--;
    }
    const { start: snapStart, end: snapEnd } = monthRangeUtc(snapYear, snapMonth, TZ);
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: monthlyEmpId,
        periodType: "MONTHLY",
        periodStart: snapStart,
        periodEnd: snapEnd,
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date(),
        closedBy: adminUserId,
      },
    });

    await updateOvertimeAccount(app, monthlyEmpId);

    const account = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: monthlyEmpId },
    });
    const balanceHours = Number(account?.balanceHours ?? 0);

    // Reproduce production's range computation:
    //   rangeStart = snapshot.periodEnd + 1 day
    //   effectiveEnd = yesterday (no time entries today)
    const rangeStart = new Date(snapEnd.getTime() + 86400000);
    const todayDate = new Date(todayStr + "T00:00:00Z");
    const yesterdayDate = new Date(todayDate.getTime() - 86400000);
    const effectiveEnd = yesterdayDate < rangeStart ? rangeStart : yesterdayDate;

    // Expected (correct, per-month-segmented) value.
    let expectedMin = expectedMinutesMonthlyMonTue(rangeStart, effectiveEnd, 80);

    // Production subtracts holidays from expected when monthlyHoursHolidayDeduction
    // is FALSE (our test tenant default) via getDayHoursFromSchedule(dow) * 60.
    // For our Mo+Tu=4h schedule, any Mo/Tu Feiertag in [rangeStart, effectiveEnd]
    // subtracts 4h × 60 = 240 minutes.
    const stateCode = STATE_MAP["NIEDERSACHSEN"] ?? "NI";
    const rangeStartStr = dateStrInTz(rangeStart, TZ);
    const effectiveEndStr = dateStrInTz(effectiveEnd, TZ);
    let holidayMin = 0;
    for (let yr = rangeStart.getUTCFullYear(); yr <= effectiveEnd.getUTCFullYear(); yr++) {
      for (const h of getHolidays(yr, stateCode)) {
        if (h.date < rangeStartStr || h.date > effectiveEndStr) continue;
        // h.date is a "YYYY-MM-DD" string. Get day-of-week via UTC midnight.
        const dow = new Date(h.date + "T00:00:00Z").getUTCDay();
        if (dow === 1 || dow === 2) holidayMin += 4 * 60;
      }
    }
    expectedMin = Math.max(0, expectedMin - holidayMin);

    const expectedHours = expectedMin / 60;
    // worked = 0 → balanceHours ≈ -expectedHours
    //
    // Pre-fix bug: for a multi-month range, calcExpectedMinutesTz applies the
    // calendar-month-of-`from` denominator to the whole multi-month range,
    // distorting expected by ~4-5x. This assertion would fail spectacularly
    // without the fix (delta would be > 100h, not < 1h).
    expect(Math.abs(balanceHours - -expectedHours)).toBeLessThan(1);
  });

  it("SHIFT_BASED: expectedMinutes equals sum of Shift durations in range", async () => {
    // No leave, no absence; 3 (or fewer if the month just started) 8h shifts (08:00–16:00).
    // v1.8.9: expectedMinutes is now NETTO = brutto − getEffectiveBreakDuration().
    // Default tenant config: defaultBreakOver6h=30. 480 brutto − 30 = 450 netto = 7.5h per shift.
    await updateOvertimeAccount(app, shiftEmpAId);

    const account = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: shiftEmpAId },
    });
    const balanceHours = Number(account?.balanceHours ?? 0);

    // Expected = shiftDates.length × 7.5h (netto: 480 brutto − 30 min default break).
    // balanceHours = -expected (worked 0).
    const expectedHours = shiftDates.length * 7.5; // v1.8.9 — netto: 480 brutto − 30 min default break
    expect(Math.abs(balanceHours - -expectedHours)).toBeLessThan(0.5);
  });

  it("SHIFT_BASED: Shifts on APPROVED-leave days are excluded from expected", async () => {
    // Same 3 shifts; the first shift's date is covered by an APPROVED leave.
    // v1.8.9: Expected = (shiftDates.length - 1) × 7.5h (netto, not brutto).
    await updateOvertimeAccount(app, shiftEmpBId);

    const account = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: shiftEmpBId },
    });
    const balanceHours = Number(account?.balanceHours ?? 0);

    // If we couldn't seed any shifts (month just started), the assertion is
    // trivially 0 — skip the test rather than failing on zero data.
    if (shiftDates.length === 0) {
      expect(balanceHours).toBe(0);
      return;
    }
    // v1.8.9 — netto: 480 brutto − 30 min default break = 450 min = 7.5h per shift
    const expectedHours = (shiftDates.length - 1) * 7.5;
    expect(Math.abs(balanceHours - -expectedHours)).toBeLessThan(0.5);
  });
});
