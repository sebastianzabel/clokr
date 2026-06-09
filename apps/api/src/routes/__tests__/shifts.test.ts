import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../__tests__/setup";
import type { FastifyInstance } from "fastify";

/**
 * Phase 76.12 Plan 02 — Smoke tests for GET /api/v1/shifts/week
 *
 * Verifies that the leaveMinutesByEmp + absenceMinutesByEmp aggregation
 * (Phase 76.11 code path) now uses calcLeaveAbsenceMinutesTz with:
 *  - VOCATIONAL_SCHOOL + PATTERN Absence filter at the Prisma layer
 *  - LeaveRequest.halfDay honored end-to-end
 *  - BAG 9 AZR 406/17 Ø-Methode math (NOT the broken × Kalendertage ÷ 7)
 *
 * Fixture: A.S.-style SHIFT_BASED employee (weeklyHours=38, tue/wed/thu/fri=9.5).
 * No full names — initials only (memory `feedback_no_pii_in_github`).
 */
describe("GET /shifts/week — Ø-Methode leave/absence aggregation (Phase 76.12)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let asEmployeeId: string;

  // Week containing Fri 2026-06-05 → Monday is 2026-06-01.
  const WEEK_START = "2026-06-01";

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "shifts-svc-76-12");

    // Create an A.S.-style SHIFT_BASED employee (weeklyHours=38, Mo=0h, Di-Fr=9.5h).
    // Initials only — no PII per memory feedback_no_pii_in_github.
    const asUser = await app.prisma.user.create({
      data: {
        email: `as-${data.tenant.id.slice(0, 8)}@test.de`,
        passwordHash: "test-only-hash",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const asEmployee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: asUser.id,
        employeeNumber: `AS-${data.tenant.id.slice(0, 6)}`,
        firstName: "A.",
        lastName: "S.",
        classification: "TEILZEIT",
        hireDate: new Date("2024-01-01"),
      },
    });
    asEmployeeId = asEmployee.id;

    await app.prisma.workSchedule.create({
      data: {
        employeeId: asEmployee.id,
        type: "SHIFT_BASED",
        weeklyHours: 38,
        mondayHours: 0,
        tuesdayHours: 9.5,
        wednesdayHours: 9.5,
        thursdayHours: 9.5,
        fridayHours: 9.5,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2024-01-01"),
      },
    });

    await app.prisma.overtimeAccount.create({
      data: { employeeId: asEmployee.id, balanceHours: 0 },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("A.S. SHIFT_BASED 1-day-Fri Urlaub yields leaveMinutes=570 (NOT 977 from broken formula)", async () => {
    // Seed APPROVED LeaveRequest for Fri 2026-06-05, halfDay=false.
    const lr = await app.prisma.leaveRequest.create({
      data: {
        employeeId: asEmployeeId,
        leaveTypeId: data.vacationType.id,
        startDate: new Date("2026-06-05"),
        endDate: new Date("2026-06-05"),
        days: 1,
        halfDay: false,
        status: "APPROVED",
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/week?date=${WEEK_START}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as {
      leaveMinutesByEmp: Record<string, number>;
    };

    // Ø-Methode: 38h × 60min × 1 workday-in-range / 4 workdays-per-week = 570min
    // Broken formula was: 38 × 60 × 1 / 7 ≈ 326 OR × 9.5 / 7 × 60 = 81 OR
    // many wrong shapes; what matters here is the new helper returns exactly 570
    // for this fixture (Fri only, A.S. fri=9.5 → 38/4 × 1 = 9.5h = 570min).
    expect(body.leaveMinutesByEmp[asEmployeeId]).toBe(570);

    // Cleanup leave for next test
    await app.prisma.leaveRequest.delete({ where: { id: lr.id } });
  });

  it("VOCATIONAL_SCHOOL + PATTERN Absence is excluded from absenceMinutes (BBiG §15)", async () => {
    // Seed an Absence type=VOCATIONAL_SCHOOL, source=PATTERN on Tue 2026-06-02.
    const ab = await app.prisma.absence.create({
      data: {
        employeeId: asEmployeeId,
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        startDate: new Date("2026-06-02"),
        endDate: new Date("2026-06-02"),
        days: 1,
        createdBy: data.adminUser.id,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/week?date=${WEEK_START}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as {
      absenceMinutesByEmp: Record<string, number>;
    };

    // VOCATIONAL_SCHOOL+PATTERN MUST be filtered out at Prisma layer per D-11.
    // A.S. has no other absences this week → absenceMinutes for A.S. is undefined or 0.
    const minutes = body.absenceMinutesByEmp[asEmployeeId] ?? 0;
    expect(minutes).toBe(0);

    await app.prisma.absence.delete({ where: { id: ab.id } });
  });

  it("halfDay LeaveRequest reduces leaveMinutes to half (285 = round(570/2))", async () => {
    const lr = await app.prisma.leaveRequest.create({
      data: {
        employeeId: asEmployeeId,
        leaveTypeId: data.vacationType.id,
        startDate: new Date("2026-06-05"),
        endDate: new Date("2026-06-05"),
        days: 0.5,
        halfDay: true,
        status: "APPROVED",
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/week?date=${WEEK_START}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as {
      leaveMinutesByEmp: Record<string, number>;
    };

    // Math.round(570 / 2) = 285. Per D-06 (halfDay applies to TOTAL, not per-day).
    expect(body.leaveMinutesByEmp[asEmployeeId]).toBe(285);

    await app.prisma.leaveRequest.delete({ where: { id: lr.id } });
  });
});
