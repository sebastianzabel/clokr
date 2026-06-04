import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../__tests__/setup";
import type { FastifyInstance } from "fastify";

/**
 * Phase 49-01 — GET /api/v1/shifts/my-week
 * Employee self-view: own shifts + anonymized colleague list (firstName only).
 * 410 Gone for users without employeeId or non-SHIFT_BASED schedule.
 */
describe("GET /api/v1/shifts/my-week (Phase 49-01)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  // Monday in the future to avoid clashes with seedTestData defaults
  // 2026-07-13 = Monday
  const MONDAY_ISO = "2026-07-13";
  const WEDNESDAY_ISO = "2026-07-15";

  let employeeAId: string; // SHIFT_BASED, own shifts
  let tokenA: string;
  let employeeBId: string; // SHIFT_BASED, colleague
  let employeeCId: string; // FIXED_SCHEDULE, should get 410
  let tokenC: string;
  let userOrphanId: string; // User without employee
  let orphanToken: string;
  let templateId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "myweek");
    const prisma = app.prisma;
    const tenantId = data.tenant.id;
    const suffix = "myweek-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    // Employee A — SHIFT_BASED (own user)
    const passwordHash = await bcrypt.hash("test1234", 10);
    const userA = await prisma.user.create({
      data: {
        email: `a-${suffix}@test.de`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employeeA = await prisma.employee.create({
      data: {
        tenantId,
        userId: userA.id,
        employeeNumber: `A-${suffix}`,
        firstName: "Alice",
        lastName: "MyWeek",
        hireDate: new Date("2024-01-01"),
      },
    });
    employeeAId = employeeA.id;
    await prisma.workSchedule.create({
      data: {
        employeeId: employeeA.id,
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
    await prisma.overtimeAccount.create({ data: { employeeId: employeeA.id, balanceHours: 0 } });

    // Employee B — colleague (SHIFT_BASED)
    const userB = await prisma.user.create({
      data: {
        email: `b-${suffix}@test.de`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employeeB = await prisma.employee.create({
      data: {
        tenantId,
        userId: userB.id,
        employeeNumber: `B-${suffix}`,
        firstName: "Bea",
        lastName: "Kollegin",
        hireDate: new Date("2024-01-01"),
      },
    });
    employeeBId = employeeB.id;
    await prisma.workSchedule.create({
      data: {
        employeeId: employeeB.id,
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
    await prisma.overtimeAccount.create({ data: { employeeId: employeeB.id, balanceHours: 0 } });

    // Employee C — FIXED_SCHEDULE (should get 410)
    const userC = await prisma.user.create({
      data: {
        email: `c-${suffix}@test.de`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employeeC = await prisma.employee.create({
      data: {
        tenantId,
        userId: userC.id,
        employeeNumber: `C-${suffix}`,
        firstName: "Carla",
        lastName: "Fix",
        hireDate: new Date("2024-01-01"),
      },
    });
    employeeCId = employeeC.id;
    await prisma.workSchedule.create({
      data: {
        employeeId: employeeC.id,
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
    await prisma.overtimeAccount.create({ data: { employeeId: employeeC.id, balanceHours: 0 } });

    // Orphan user — User with no Employee
    const userOrphan = await prisma.user.create({
      data: {
        email: `orphan-${suffix}@test.de`,
        passwordHash,
        role: "ADMIN",
        isActive: true,
      },
    });
    userOrphanId = userOrphan.id;

    // Shift template
    const template = await prisma.shiftTemplate.create({
      data: {
        tenantId,
        name: "Früh",
        startTime: "08:00",
        endTime: "12:00",
        color: "#FF0000",
      },
    });
    templateId = template.id;

    // Shifts: A and B on Monday, B alone on Wednesday
    await prisma.shift.create({
      data: {
        employeeId: employeeA.id,
        templateId: template.id,
        date: new Date(MONDAY_ISO + "T00:00:00Z"),
        startTime: "08:00",
        endTime: "12:00",
      },
    });
    await prisma.shift.create({
      data: {
        employeeId: employeeB.id,
        templateId: template.id,
        date: new Date(MONDAY_ISO + "T00:00:00Z"),
        startTime: "08:00",
        endTime: "12:00",
      },
    });
    await prisma.shift.create({
      data: {
        employeeId: employeeB.id,
        templateId: template.id,
        date: new Date(WEDNESDAY_ISO + "T00:00:00Z"),
        startTime: "08:00",
        endTime: "12:00",
      },
    });

    // Login tokens
    const loginA = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `a-${suffix}@test.de`, password: "test1234" },
    });
    tokenA = JSON.parse(loginA.body).accessToken;

    const loginC = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `c-${suffix}@test.de`, password: "test1234" },
    });
    tokenC = JSON.parse(loginC.body).accessToken;

    const loginOrphan = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `orphan-${suffix}@test.de`, password: "test1234" },
    });
    orphanToken = JSON.parse(loginOrphan.body).accessToken;
  });

  afterAll(async () => {
    try {
      // Clean up orphan user (not tied to tenant via employee)
      await app.prisma.refreshToken.deleteMany({ where: { userId: userOrphanId } });
      await app.prisma.user.deleteMany({ where: { id: userOrphanId } });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("returns own + anonymized colleagues for SHIFT_BASED employee", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/my-week?date=${MONDAY_ISO}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.weekStart).toBe(MONDAY_ISO);
    expect(body.weekEnd).toBe("2026-07-19");
    expect(body.days).toHaveLength(7);

    const mon = body.days.find((d: { date: string }) => d.date === MONDAY_ISO);
    expect(mon.ownShifts).toHaveLength(1);
    expect(mon.ownShifts[0].templateName).toBe("Früh");
    expect(mon.ownShifts[0].templateColor).toBe("#FF0000");
    expect(mon.ownShifts[0].startTime).toBe("08:00");

    expect(mon.colleagues).toHaveLength(1);
    expect(mon.colleagues[0].firstName).toBe("Bea");
    expect(mon.colleagues[0].lastName).toBeUndefined();
    expect(mon.colleagues[0].employeeNumber).toBeUndefined();
    expect(mon.colleagues[0].id).toBeUndefined();
    expect(mon.colleagues[0].templateName).toBe("Früh");
  });

  it("shows colleague-only shift on Wednesday (no own shift)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/my-week?date=${MONDAY_ISO}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const wed = body.days.find((d: { date: string }) => d.date === WEDNESDAY_ISO);
    expect(wed.ownShifts).toHaveLength(0);
    expect(wed.colleagues).toHaveLength(1);
    expect(wed.colleagues[0].firstName).toBe("Bea");
  });

  it("returns 410 for FIXED_SCHEDULE employee", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/shifts/my-week",
      headers: { authorization: `Bearer ${tokenC}` },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe("Nicht im Schichtsystem");
  });

  it("returns 410 for user without employeeId", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/shifts/my-week",
      headers: { authorization: `Bearer ${orphanToken}` },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe("Kein Mitarbeiter-Profil verknüpft");
  });

  it("respects ?date parameter for different week", async () => {
    // 2026-07-20 = next Monday
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/shifts/my-week?date=2026-07-22",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.weekStart).toBe("2026-07-20");
    expect(body.weekEnd).toBe("2026-07-26");
    // No shifts in that week
    expect(
      body.days.every(
        (d: { ownShifts: unknown[]; colleagues: unknown[] }) =>
          d.ownShifts.length === 0 && d.colleagues.length === 0,
      ),
    ).toBe(true);
  });

  // Silence unused-var lint for IDs used only as seed inputs
  it("seeded employee IDs are non-empty", () => {
    expect(employeeAId).toBeTruthy();
    expect(employeeBId).toBeTruthy();
    expect(employeeCId).toBeTruthy();
    expect(templateId).toBeTruthy();
  });
});
