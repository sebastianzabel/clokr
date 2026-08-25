/**
 * Regression test for soll-ignores-workdays-on-legacy-schedules (debug session
 * .planning/debug/resolved/soll-ignores-workdays-on-legacy-schedules.md).
 *
 * End-to-end reproduction of the exact prod symptom via GET /shifts/week:
 * a SHIFT_BASED employee with a legacy WorkSchedule row where `workDays` was
 * hand-corrected to the real contractual pattern (Tue/Wed/Thu) but `{day}Hours`
 * still carries a stale bulk-migration Mon-Fri=1.00 placeholder. Guards BOTH
 * halves of the fix:
 *   1. avgWorkMinutesCore (timezone.ts) must be workDays-primary.
 *   2. The GET /shifts/week Prisma `select` for workSchedules must actually
 *      fetch `workDays` — otherwise the endpoint silently falls back to the
 *      {day}Hours divisor regardless of the timezone.ts fix (this is exactly
 *      how the bug reached prod: the fix in (1) alone is not sufficient).
 *
 * Pattern mirrors shifts-under-coverage.test.ts (Phase 76.23 sibling).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, cleanupTestData } from "./setup";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";

const TZ = "Europe/Berlin";

function futureMondayIso(weeksAhead: number): string {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const dow = today.getUTCDay(); // 0=Sun..6=Sat
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(today);
  monday.setUTCDate(monday.getUTCDate() + mondayOffset + weeksAhead * 7);
  return monday.toISOString().slice(0, 10);
}

function mondayDate(iso: string): Date {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

describe("GET /shifts/week — workDays-primary divisor, end-to-end (SOLL-WORKDAYS-01)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let vacationTypeId: string;
  let empId: string;
  let weekMonday: string;
  let monday: Date;

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const suffix = "soll-wd-01-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    // 10 weeks ahead — avoids collision with 76.10/76.11/76.23 fixture weeks.
    weekMonday = futureMondayIso(10);
    monday = mondayDate(weekMonday);

    const tenant = await prisma.tenant.create({
      data: {
        name: `SOLL-WORKDAYS-01 Test ${suffix}`,
        slug: `soll-wd-01-${suffix}`,
        federalState: "NIEDERSACHSEN",
      },
    });
    tenantId = tenant.id;
    await prisma.tenantConfig.create({
      data: { tenantId, defaultVacationDays: 30, timezone: TZ },
    });

    const adminPasswordHash = await bcrypt.hash("test1234", 10);
    const adminUser = await prisma.user.create({
      data: {
        email: `admin-${suffix}@test.de`,
        passwordHash: adminPasswordHash,
        role: "ADMIN",
        isActive: true,
      },
    });
    const adminEmployee = await prisma.employee.create({
      data: {
        tenantId,
        userId: adminUser.id,
        employeeNumber: `ADM-${suffix}`,
        firstName: "Admin",
        lastName: "Test",
        hireDate: new Date("2024-01-01"),
      },
    });
    await prisma.workSchedule.create({
      data: {
        employeeId: adminEmployee.id,
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
      data: { employeeId: adminEmployee.id, balanceHours: 0 },
    });

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `admin-${suffix}@test.de`, password: "test1234" },
    });
    adminToken = JSON.parse(loginRes.body).accessToken;

    // ── The reproduction employee: legacy pre-Phase-61 divergent schedule ──
    // Mirrors prod emp 3229a3ff exactly: SHIFT_BASED, 30h/week, workDays hand
    // -corrected to [2,3,4] (Tue/Wed/Thu), but {day}Hours still a stale
    // Mon-Fri=1.00 bulk-migration placeholder (does not sum to weeklyHours).
    const empUser = await prisma.user.create({
      data: {
        email: `emp-${suffix}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const emp = await prisma.employee.create({
      data: {
        tenantId,
        userId: empUser.id,
        employeeNumber: `EMP-${suffix}`,
        firstName: "Legacy",
        lastName: "Divergent",
        hireDate: new Date("2024-01-01"),
      },
    });
    empId = emp.id;

    await prisma.workSchedule.create({
      data: {
        employeeId: empId,
        type: "SHIFT_BASED",
        weeklyHours: 30,
        workDays: [2, 3, 4], // Tue, Wed, Thu — hand-corrected, real contract
        mondayHours: 1, // stale bulk-migration placeholder
        tuesdayHours: 1,
        wednesdayHours: 1,
        thursdayHours: 1,
        fridayHours: 1,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2024-01-01"),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: empId, balanceHours: 0 } });

    const vacationType = await prisma.leaveType.create({
      data: {
        tenantId,
        name: "Urlaub",
        isPaid: true,
        requiresApproval: true,
        color: "#3B82F6",
      },
    });
    vacationTypeId = vacationType.id;

    // Approved Urlaub covering exactly the 3 real workdays (Tue-Thu) of the test week.
    const tuesday = new Date(monday);
    tuesday.setUTCDate(tuesday.getUTCDate() + 1);
    const thursday = new Date(monday);
    thursday.setUTCDate(thursday.getUTCDate() + 3);
    await prisma.leaveRequest.create({
      data: {
        employeeId: empId,
        leaveTypeId: vacationTypeId,
        startDate: tuesday,
        endDate: thursday,
        days: 3,
        status: "APPROVED",
        reviewedBy: "system",
        reviewedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("SOLL-WORKDAYS-01 test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("SOLL-WORKDAYS-01 — 3-day Urlaub on the 3 real workdays leaves 0h residual Soll, not the prod-reported 12h phantom Soll", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/week?date=${weekMonday}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      contractSollMinutesByEmp?: Record<string, number>;
      leaveMinutesByEmp?: Record<string, number>;
    };

    // `contractSollMinutesByEmp` is ALREADY leave/absence-net (Phase 76.32:
    // max(0, baseSoll − leaveMin − absenceMin)) — it IS the residual Soll the
    // Schichtplaner renders, not the raw pre-leave weekly Soll.
    const residualSoll = body.contractSollMinutesByEmp?.[empId] ?? -1;
    const leaveCredit = body.leaveMinutesByEmp?.[empId] ?? 0;

    // Before the fix (dayHours-primary divisor + missing `workDays` select):
    // leaveCredit = 30h × 60 × 3/5 = 1080min (18h) → residualSoll =
    // max(0, 1800 − 1080) = 720min (12h) — the exact "Soll 12h" phantom
    // residual reported in prod (Aug 10-16 2026, emp 3229a3ff).
    // After the fix (workDays-primary, workDays selected in shifts.ts):
    // leaveCredit = 30h × 60 × 3/3 = 1800min (30h) → residualSoll =
    // max(0, 1800 − 1800) = 0.
    expect(leaveCredit).toBe(1800);
    expect(residualSoll).toBe(0);
  });
});
