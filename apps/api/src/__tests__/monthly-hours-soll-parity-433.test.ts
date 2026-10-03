/**
 * Issue #433 (D-11) — cross-path parity test for the MONTHLY_HOURS month Soll.
 *
 * Plan 433-01/02/03 collapsed the MONTHLY_HOURS Soll math itself onto one shared core
 * (`timezone.ts`'s `monthlyHoursMinutesCore`), reached via `closeEmployeeMonth()`. Plan 433-05
 * adds the last piece: `monthlyHoursMonthSollMinutes()`, a thin wrapper over
 * `closeEmployeeMonth()` for the FULL calendar month, and switches `GET
 * /overtime/month-saldo/:employeeId` (via `MonthSaldoResult.monthSollMinutes`), the dashboard
 * tile (`GET /dashboard/`) and the monthly report (`GET /reports/monthly`) to call it. Before this
 * plan the three endpoints held THREE independently hand-rolled copies of the MONTHLY_HOURS Soll
 * formula (RESEARCH.md Pitfall 3) — this test proves they now report the SAME number, derived from
 * the SAME call.
 *
 * Fixture (tenant "mhsp433", June 2026 — starts Monday, 22 Mo-Fr workdays, no NI statutory
 * holiday; a manual PublicHoliday on Wednesday 2026-06-10):
 *
 * Employee A (MONTHLY_HOURS 44h/month, workDays Mo-Fr, hire 2025-01-01 — full month):
 *   dailySoll = round(44*60 * 22/22) over the holiday/leave/absence numerator each use their
 *   OWN count/22 ratio (monthlyHoursMinutesCore rounds ONCE per the total, which collapses to
 *   round(2640 * count / 22) per numerator here since every numerator stays inside one month):
 *     full Soll:            round(2640 * 22/22) = 2640
 *     − holiday (Wed 10.06, 1 day):      round(2640 * 1/22)  =  120
 *     − VACATION 15.-19.06 (Mon-Fri, 5 days): round(2640 * 5/22) =  600
 *     − SICK 19.06 (same day as VACATION's last day — D-15 dedup, 0 NEW days): 0
 *     − SICK half-day 22.06 (Mon, 1 day, halved): round(2640*1/22)/2 = 60
 *     − MATERNITY absence (MANUAL) 24.06 (Thu, 1 day): round(2640*1/22) = 120
 *   expectedMinutes = 2640 - 120 - 600 - 0 - 60 - 120 = 1740
 *
 * Employee B (MONTHLY_HOURS 44h/month, workDays Mo-Fr, hire Mon 2026-06-15):
 *   effectiveStart = 15.06. Workdays in [15.06, 30.06]: 15-19 (5) + 22-26 (5) + 29-30 (2) = 12.
 *     full Soll (hire-month, FULL-month denominator per D-06): round(2640 * 12/22) = 1440
 *     − VACATION 17.06 (Wed, 1 day): round(2640 * 1/22) = 120
 *     (the 10.06 holiday lies BEFORE the hire date — closeEmployeeMonth's effectiveStart clip
 *     excludes it from the holiday numerator entirely, D-01/D-13)
 *   expectedMinutes = 1440 - 120 = 1320
 *
 * Employee C (MONTHLY_HOURS 15h/month, workDays Mo-Fr, hire 2025-01-01, no reductions, July
 * 2026 queried): a FULL month with no exclusion at all always collapses to round(mh*60*1) — the
 * same drift-free guarantee the web's former per-day helper used to pin, now pinned here for the
 * core itself. expectedMinutes = 900, regardless of July's actual workday count (23).
 *
 * Employee D (FIXED_SCHEDULE, 40h/week Mon-Fri 8h, hire 2025-01-01, same tenant): unrelated to
 * the MONTHLY_HOURS core itself — this plan (#433) did not touch the FIXED/FLEXTIME/SHIFT_BASED
 * report Soll (T-433-18).
 *
 * Issue #451 (D-03), authorised assertion-policy correction: Employee D's report `shouldHours`
 * changed from 176 (22 workdays * 8h, no holiday deduction — the D-03 bug) to 168 (minus the
 * manual holiday on Wed 10.06.2026, a workday) once plan 451-03 switched GET /reports/monthly to
 * read its Soll from the working-time-account's `fullMonth` result instead of its own
 * `{day}Hours` walk — the SAME manual holiday that already reduced employees A/B/C's
 * MONTHLY_HOURS Soll on this fixture now also reduces Employee D's FIXED_SCHEDULE Soll, which it
 * never did before 451-03.
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";

async function loginAs(app: FastifyInstance, email: string, password = "test1234") {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
  });
  const { accessToken } = JSON.parse(res.body) as { accessToken: string };
  return accessToken;
}

async function createMonthlyHoursEmployee(
  app: FastifyInstance,
  tenantId: string,
  salonId: string,
  label: string,
  hireDate: string,
  monthlyHours: number,
): Promise<{ id: string; token: string }> {
  const passwordHash = await bcrypt.hash("test1234", 10);
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const email = `${label}-${suffix}@test.de`;
  const user = await app.prisma.user.create({
    data: { email, passwordHash, role: "EMPLOYEE", isActive: true },
  });
  const employee = await app.prisma.employee.create({
    data: {
      tenantId,
      userId: user.id,
      employeeNumber: `${label}-${suffix}`,
      firstName: label,
      lastName: "Parity433",
      hireDate: new Date(`${hireDate}T00:00:00Z`),
    },
  });
  await app.prisma.workSchedule.create({
    data: {
      employeeId: employee.id,
      type: "MONTHLY_HOURS",
      monthlyHours,
      workDays: [1, 2, 3, 4, 5],
      overtimeMode: "CARRY_FORWARD",
      validFrom: new Date(`${hireDate}T00:00:00Z`),
    },
  });
  await app.prisma.employeeSalonAssignment.create({
    data: {
      tenantId,
      employeeId: employee.id,
      salonId,
      kind: "HOME",
      validFrom: new Date(`${hireDate}T00:00:00Z`),
      validUntil: null,
      weekdays: [],
    },
  });
  await app.prisma.overtimeAccount.create({
    data: { employeeId: employee.id, balanceHours: 0 },
  });
  const token = await loginAs(app, email);
  return { id: employee.id, token };
}

async function createFixedEmployee(
  app: FastifyInstance,
  tenantId: string,
  salonId: string,
  label: string,
  hireDate: string,
): Promise<{ id: string }> {
  const passwordHash = await bcrypt.hash("test1234", 10);
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const email = `${label}-${suffix}@test.de`;
  const user = await app.prisma.user.create({
    data: { email, passwordHash, role: "EMPLOYEE", isActive: true },
  });
  const employee = await app.prisma.employee.create({
    data: {
      tenantId,
      userId: user.id,
      employeeNumber: `${label}-${suffix}`,
      firstName: label,
      lastName: "Parity433Fixed",
      hireDate: new Date(`${hireDate}T00:00:00Z`),
    },
  });
  await app.prisma.workSchedule.create({
    data: {
      employeeId: employee.id,
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
      validFrom: new Date(`${hireDate}T00:00:00Z`),
    },
  });
  await app.prisma.employeeSalonAssignment.create({
    data: {
      tenantId,
      employeeId: employee.id,
      salonId,
      kind: "HOME",
      validFrom: new Date(`${hireDate}T00:00:00Z`),
      validUntil: null,
      weekdays: [],
    },
  });
  await app.prisma.overtimeAccount.create({
    data: { employeeId: employee.id, balanceHours: 0 },
  });
  return { id: employee.id };
}

async function createLeave(
  app: FastifyInstance,
  employeeId: string,
  leaveTypeId: string,
  start: string,
  end: string,
  halfDay: boolean,
) {
  return app.prisma.leaveRequest.create({
    data: {
      employeeId,
      leaveTypeId,
      startDate: new Date(`${start}T00:00:00Z`),
      endDate: new Date(`${end}T00:00:00Z`),
      days: halfDay ? 0.5 : 1,
      halfDay,
      status: "APPROVED",
    },
  });
}

async function createAbsence(
  app: FastifyInstance,
  employeeId: string,
  type: "MATERNITY",
  start: string,
  end: string,
) {
  return app.prisma.absence.create({
    data: {
      employeeId,
      type,
      source: "MANUAL",
      startDate: new Date(`${start}T00:00:00Z`),
      endDate: new Date(`${end}T00:00:00Z`),
      days: 1,
      createdBy: "test-fixture",
    },
  });
}

describe("Issue #433 D-11 — month-saldo, dashboard and monthly report agree on the MONTHLY_HOURS month Soll", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let salonId: string;
  let adminToken: string;
  let sickTypeId: string;

  let empAId: string;
  let empAToken: string;
  let empBId: string;
  let empBToken: string;
  let empCId: string;
  let empCToken: string;
  let fixedEmpId: string;

  const MANUAL_HOLIDAY_DATE = "2026-06-10"; // Wednesday, no NI statutory holiday this week
  const MANUAL_HOLIDAY_NAME = "Betriebsfeiertag Parity433";

  const EXPECTED_A_MINUTES = 1740; // 2640 - 120 (holiday) - 600 (vacation) - 0 (overlap) - 60 (half day) - 120 (absence)
  const EXPECTED_B_MINUTES = 1320; // round(2640*12/22)=1440 - 120 (vacation); holiday before hire ignored
  const EXPECTED_C_MINUTES = 900; // 15h * 60, full month, no exclusions — drift-free by construction
  // Employee D (FIXED_SCHEDULE, 40h/week Mon-Fri 8h): 22 workdays in June 2026 * 8h = 176h,
  // minus the manual holiday on Wed 10.06.2026 (a workday, 8h) = 168h.
  // Issue #451 (D-03): this is the authorised assertion-policy correction (176 -> 168) —
  // the OLD value encoded the D-03 bug (public/manual holiday not deducted from a
  // FIXED_SCHEDULE report Soll); the monthly report now reads its Soll from the
  // working-time-account's `fullMonth` result (`computeMonthReportFigures`), which deducts
  // the same manual holiday the MONTHLY_HOURS employees A/B/C on this fixture already have
  // deducted — unaffected by the MONTHLY_HOURS core change itself (T-433-18 still holds: no
  // MONTHLY_HOURS code path is involved for Employee D), but no longer unaffected by 451-03.
  const EXPECTED_D_HOURS = 168;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-20T10:00:00.000Z"));

    app = await getTestApp();
    const seed = await seedTestData(app, "mhsp433", { withDefaultSalon: false });
    tenantId = seed.tenant.id;
    adminToken = seed.adminToken;

    const salon = await createTestSalon(app.prisma, tenantId, { federalState: "NIEDERSACHSEN" });
    salonId = salon.id;

    await app.prisma.publicHoliday.create({
      data: {
        tenantId,
        salonId,
        date: new Date(`${MANUAL_HOLIDAY_DATE}T00:00:00Z`),
        name: MANUAL_HOLIDAY_NAME,
        federalState: "NIEDERSACHSEN",
        year: 2026,
      },
    });

    const sickType = await app.prisma.leaveType.create({
      data: { tenantId, code: "SICK", name: "Krankheit", color: "#EF4444", isPaid: true },
    });
    sickTypeId = sickType.id;

    const empA = await createMonthlyHoursEmployee(
      app,
      tenantId,
      salonId,
      "mhsp433a",
      "2025-01-01",
      44,
    );
    empAId = empA.id;
    empAToken = empA.token;
    await createLeave(app, empAId, seed.vacationType.id, "2026-06-15", "2026-06-19", false);
    await createLeave(app, empAId, sickTypeId, "2026-06-19", "2026-06-19", false);
    await createLeave(app, empAId, sickTypeId, "2026-06-22", "2026-06-22", true);
    await createAbsence(app, empAId, "MATERNITY", "2026-06-24", "2026-06-24");

    const empB = await createMonthlyHoursEmployee(
      app,
      tenantId,
      salonId,
      "mhsp433b",
      "2026-06-15",
      44,
    );
    empBId = empB.id;
    empBToken = empB.token;
    await createLeave(app, empBId, seed.vacationType.id, "2026-06-17", "2026-06-17", false);

    const empC = await createMonthlyHoursEmployee(
      app,
      tenantId,
      salonId,
      "mhsp433c",
      "2025-01-01",
      15,
    );
    empCId = empC.id;
    empCToken = empC.token;

    const fixedEmp = await createFixedEmployee(app, tenantId, salonId, "mhsp433d", "2025-01-01");
    fixedEmpId = fixedEmp.id;
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("monthly-hours-soll-parity-433 cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function monthSaldo(employeeId: string) {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/month-saldo/${employeeId}?year=2026&month=6`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as { monthSollMinutes?: number };
  }

  async function dashboardMonthTargetHours(token: string) {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { month?: { targetHours: number } };
    return body.month?.targetHours;
  }

  async function reportShouldHours(employeeId: string, year: number, month: number) {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly?employeeId=${employeeId}&year=${year}&month=${month}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      rows: Array<{ employeeId: string; shouldHours: number }>;
    };
    return body.rows.find((r) => r.employeeId === employeeId)?.shouldHours;
  }

  it(`Employee A (overlapping leave+sick+absence+holiday): month-saldo monthSollMinutes == ${EXPECTED_A_MINUTES}`, async () => {
    const result = await monthSaldo(empAId);
    expect(result.monthSollMinutes).toBe(EXPECTED_A_MINUTES);
  });

  it(`Employee A: dashboard month.targetHours == ${EXPECTED_A_MINUTES / 60}`, async () => {
    const targetHours = await dashboardMonthTargetHours(empAToken);
    expect(targetHours).toBe(Math.round((EXPECTED_A_MINUTES / 60) * 100) / 100);
  });

  it(`Employee A: report shouldHours == ${EXPECTED_A_MINUTES / 60}`, async () => {
    const shouldHours = await reportShouldHours(empAId, 2026, 6);
    expect(shouldHours).toBe(Math.round((EXPECTED_A_MINUTES / 60) * 100) / 100);
  });

  it(`Employee B (hired mid-month, holiday before hire ignored): month-saldo monthSollMinutes == ${EXPECTED_B_MINUTES}`, async () => {
    const result = await monthSaldo(empBId);
    expect(result.monthSollMinutes).toBe(EXPECTED_B_MINUTES);
  });

  it(`Employee B: dashboard month.targetHours == ${EXPECTED_B_MINUTES / 60}`, async () => {
    const targetHours = await dashboardMonthTargetHours(empBToken);
    expect(targetHours).toBe(Math.round((EXPECTED_B_MINUTES / 60) * 100) / 100);
  });

  it(`Employee B: report shouldHours == ${EXPECTED_B_MINUTES / 60}`, async () => {
    const shouldHours = await reportShouldHours(empBId, 2026, 6);
    expect(shouldHours).toBe(Math.round((EXPECTED_B_MINUTES / 60) * 100) / 100);
  });

  it(`Employee C (full month, no reductions, July 2026): month-saldo monthSollMinutes == ${EXPECTED_C_MINUTES} (drift-free)`, async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/month-saldo/${empCId}?year=2026&month=7`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { monthSollMinutes?: number };
    expect(body.monthSollMinutes).toBe(EXPECTED_C_MINUTES);
  });

  it("Employee D (FIXED_SCHEDULE): month-saldo has NO monthSollMinutes key", async () => {
    const result = await monthSaldo(fixedEmpId);
    expect(result.monthSollMinutes).toBeUndefined();
  });

  it(`Employee D (FIXED_SCHEDULE): report shouldHours == ${EXPECTED_D_HOURS} (Issue #451 D-03: manual holiday now deducted)`, async () => {
    const shouldHours = await reportShouldHours(fixedEmpId, 2026, 6);
    expect(shouldHours).toBe(EXPECTED_D_HOURS);
  });
});
