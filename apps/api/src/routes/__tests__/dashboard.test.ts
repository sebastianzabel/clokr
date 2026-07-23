import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../__tests__/setup";
import { computeOvertimeBalanceHours } from "../time-entries";
import type { FastifyInstance } from "fastify";

/**
 * Phase 49.1-03 — GET /api/v1/dashboard scheduleType field
 * Asserts that the dashboard response includes the employee's current WorkSchedule type
 * for all 4 ScheduleType values: FIXED_SCHEDULE, FLEXTIME, MONTHLY_HOURS, SHIFT_BASED.
 */
describe("GET /api/v1/dashboard - scheduleType field (Phase 49.1-03)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  // Tokens for each schedule-type employee
  let tokenFixed: string;
  let tokenFlex: string;
  let tokenMonthly: string;
  let tokenShift: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "dashboard-stype");
    const prisma = app.prisma;
    const tenantId = data.tenant.id;
    const suffix = "dstype-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const passwordHash = await bcrypt.hash("test1234", 10);

    // ── Employee A: FIXED_SCHEDULE ────────────────────────────────────────
    const userFixed = await prisma.user.create({
      data: { email: `fixed-${suffix}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const empFixed = await prisma.employee.create({
      data: {
        tenantId,
        userId: userFixed.id,
        employeeNumber: `FX-${suffix}`,
        firstName: "Fixed",
        lastName: "Schedule",
        hireDate: new Date("2024-01-01"),
      },
    });
    await prisma.workSchedule.create({
      data: {
        employeeId: empFixed.id,
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
    await prisma.overtimeAccount.create({ data: { employeeId: empFixed.id, balanceHours: 0 } });

    // ── Employee B: FLEXTIME ──────────────────────────────────────────────
    const userFlex = await prisma.user.create({
      data: { email: `flex-${suffix}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const empFlex = await prisma.employee.create({
      data: {
        tenantId,
        userId: userFlex.id,
        employeeNumber: `FL-${suffix}`,
        firstName: "Flex",
        lastName: "Time",
        hireDate: new Date("2024-01-01"),
      },
    });
    await prisma.workSchedule.create({
      data: {
        employeeId: empFlex.id,
        type: "FLEXTIME",
        weeklyHours: 40,
        mondayHours: 0,
        tuesdayHours: 0,
        wednesdayHours: 0,
        thursdayHours: 0,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2024-01-01"),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: empFlex.id, balanceHours: 0 } });

    // ── Employee C: MONTHLY_HOURS ─────────────────────────────────────────
    const userMonthly = await prisma.user.create({
      data: { email: `monthly-${suffix}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const empMonthly = await prisma.employee.create({
      data: {
        tenantId,
        userId: userMonthly.id,
        employeeNumber: `MH-${suffix}`,
        firstName: "Monthly",
        lastName: "Hours",
        hireDate: new Date("2024-01-01"),
      },
    });
    await prisma.workSchedule.create({
      data: {
        employeeId: empMonthly.id,
        type: "MONTHLY_HOURS",
        monthlyHours: 80,
        weeklyHours: null,
        mondayHours: 0,
        tuesdayHours: 0,
        wednesdayHours: 0,
        thursdayHours: 0,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2024-01-01"),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: empMonthly.id, balanceHours: 0 } });

    // ── Employee D: SHIFT_BASED ───────────────────────────────────────────
    const userShift = await prisma.user.create({
      data: { email: `shift-${suffix}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const empShift = await prisma.employee.create({
      data: {
        tenantId,
        userId: userShift.id,
        employeeNumber: `SB-${suffix}`,
        firstName: "Shift",
        lastName: "Based",
        hireDate: new Date("2024-01-01"),
      },
    });
    await prisma.workSchedule.create({
      data: {
        employeeId: empShift.id,
        type: "SHIFT_BASED",
        weeklyHours: 40,
        mondayHours: 0,
        tuesdayHours: 0,
        wednesdayHours: 0,
        thursdayHours: 0,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2024-01-01"),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: empShift.id, balanceHours: 0 } });

    // ── Login tokens ──────────────────────────────────────────────────────
    const loginFixed = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `fixed-${suffix}@test.de`, password: "test1234" },
    });
    tokenFixed = JSON.parse(loginFixed.body).accessToken;

    const loginFlex = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `flex-${suffix}@test.de`, password: "test1234" },
    });
    tokenFlex = JSON.parse(loginFlex.body).accessToken;

    const loginMonthly = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `monthly-${suffix}@test.de`, password: "test1234" },
    });
    tokenMonthly = JSON.parse(loginMonthly.body).accessToken;

    const loginShift = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `shift-${suffix}@test.de`, password: "test1234" },
    });
    tokenShift = JSON.parse(loginShift.body).accessToken;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("returns scheduleType='FIXED_SCHEDULE' for employee with FIXED_SCHEDULE schedule", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard",
      headers: { authorization: `Bearer ${tokenFixed}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scheduleType).toBe("FIXED_SCHEDULE");
  });

  it("returns scheduleType='FLEXTIME' for employee with FLEXTIME schedule", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard",
      headers: { authorization: `Bearer ${tokenFlex}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scheduleType).toBe("FLEXTIME");
  });

  it("returns scheduleType='MONTHLY_HOURS' for employee with MONTHLY_HOURS schedule", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard",
      headers: { authorization: `Bearer ${tokenMonthly}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scheduleType).toBe("MONTHLY_HOURS");
  });

  it("returns scheduleType='SHIFT_BASED' for employee with SHIFT_BASED schedule", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard",
      headers: { authorization: `Bearer ${tokenShift}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scheduleType).toBe("SHIFT_BASED");
  });
});

/**
 * v1.8.24 — GET /api/v1/dashboard overtime KPI is a LIVE lifetime saldo (through windowEnd),
 * NOT the stale event-driven OvertimeAccount.balanceHours. Single source of truth =
 * computeOvertimeBalanceHours (same value updateOvertimeAccount persists + calendar header uses).
 */
describe("GET /api/v1/dashboard - overtime KPI is live (v1.8.24)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  let tokenFixed: string;
  let empFixedId: string;
  let tokenTrackOnly: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "dashboard-live-ot");
    const prisma = app.prisma;
    const tenantId = data.tenant.id;
    const suffix = "dlot-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const passwordHash = await bcrypt.hash("test1234", 10);

    // ── FIXED_SCHEDULE employee with a STALE seeded OvertimeAccount.balanceHours ──
    const userFixed = await prisma.user.create({
      data: {
        email: `livefixed-${suffix}@test.de`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const empFixed = await prisma.employee.create({
      data: {
        tenantId,
        userId: userFixed.id,
        employeeNumber: `LFX-${suffix}`,
        firstName: "LiveFixed",
        lastName: "Schedule",
        hireDate: new Date("2024-01-01"),
      },
    });
    empFixedId = empFixed.id;
    await prisma.workSchedule.create({
      data: {
        employeeId: empFixed.id,
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
    // Deliberately STALE stored value — the KPI must NOT echo this; it recomputes live.
    await prisma.overtimeAccount.create({
      data: { employeeId: empFixed.id, balanceHours: 999 },
    });

    // ── MONTHLY_HOURS TRACK_ONLY employee (KPI must stay 0 even with a stale non-zero seed) ──
    const userTrack = await prisma.user.create({
      data: {
        email: `livetrack-${suffix}@test.de`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const empTrack = await prisma.employee.create({
      data: {
        tenantId,
        userId: userTrack.id,
        employeeNumber: `LTO-${suffix}`,
        firstName: "LiveTrack",
        lastName: "Only",
        hireDate: new Date("2024-01-01"),
      },
    });
    await prisma.workSchedule.create({
      data: {
        employeeId: empTrack.id,
        type: "MONTHLY_HOURS",
        monthlyHours: 80,
        overtimeMode: "TRACK_ONLY",
        weeklyHours: null,
        mondayHours: 0,
        tuesdayHours: 0,
        wednesdayHours: 0,
        thursdayHours: 0,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2024-01-01"),
      },
    });
    await prisma.overtimeAccount.create({
      data: { employeeId: empTrack.id, balanceHours: 42 },
    });

    const loginFixed = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `livefixed-${suffix}@test.de`, password: "test1234" },
    });
    tokenFixed = JSON.parse(loginFixed.body).accessToken;

    const loginTrack = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `livetrack-${suffix}@test.de`, password: "test1234" },
    });
    tokenTrackOnly = JSON.parse(loginTrack.body).accessToken;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("KPI ignores the stale stored balanceHours and returns the LIVE computed saldo", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard",
      headers: { authorization: `Bearer ${tokenFixed}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // The stored value is a deliberately-wrong 999; the live KPI must not echo it.
    expect(body.overtime.balanceHours).not.toBe(999);

    // And it must equal a fresh live computation (single source of truth), rounded to whole hours
    // like the endpoint does (round()).
    const live = await computeOvertimeBalanceHours(app, empFixedId);
    expect(live).not.toBeNull();
    expect(body.overtime.balanceHours).toBe(Math.round(live as number));
  });

  it("MONTHLY_HOURS TRACK_ONLY KPI stays 0 despite a stale non-zero stored value", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard",
      headers: { authorization: `Bearer ${tokenTrackOnly}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // TRACK_ONLY: hours are tracked but never accumulated into a saldo → always 0.
    expect(body.overtime.balanceHours).toBe(0);
  });
});
