/**
 * Phase 430 (D-12/D-13), Issue #430 — `GET /shifts/planning-overview`: the "Wochenübersicht
 * Planungsbedarf" read. One row per SHIFT_BASED employee in scope — contract days, this week's
 * approved leave days (+ which weekdays), other absences, days still to plan, and, once shifts
 * exist for the week, the planned count and the difference. Query-param-only (weekStart, optional
 * salonId) — no path parameter, so it needs no T-100-09 register entry. Guarded by
 * `shift:plan:ZUGEWIESEN` (owner's explicit instruction — NOT `shift:read`), salon-scoped via the
 * standard `EmployeeScope` pattern.
 *
 * Fixed far-future Monday fixture weeks (distinct from every other fixture window in this file's
 * sibling test files) — this endpoint is a pure read, so a past/future date carries no
 * SHIFT_PAST_IMMUTABLE restriction; fixed dates keep the test deterministic.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
} from "../../../../__tests__/setup";
import { SYSTEM_ROLE_IDS } from "../../../platform";
import type { FastifyInstance } from "fastify";

const WEEK_START = "2031-02-03"; // Monday
const WEEK_END = "2031-02-09"; // Sunday
const WEEK_START_FAR = "2031-08-04"; // Monday, ~6 months later — proves no artificial range cap

describe("GET /shifts/planning-overview (Phase 430, Issue #430)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  let sbEmployeeA: { id: string; firstName: string; lastName: string };
  let sbEmployeeB: { id: string; firstName: string; lastName: string };
  const createdUserIds: string[] = [];
  const createdEmployeeIds: string[] = [];

  async function createEmployee(
    label: string,
    opts: { shiftBased?: boolean; contractWorkDaysPerWeek?: number } = {},
  ) {
    const suffix = `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const passwordHash = await bcrypt.hash("test1234", 10);
    const user = await app.prisma.user.create({
      data: { email: `${suffix}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: suffix.toUpperCase().slice(0, 20),
        firstName: label,
        lastName: "PlanningOverview",
        hireDate: new Date("2024-01-01"),
      },
    });
    createdUserIds.push(user.id);
    createdEmployeeIds.push(employee.id);
    if (opts.shiftBased) {
      await app.prisma.workSchedule.create({
        data: {
          employeeId: employee.id,
          type: "SHIFT_BASED",
          weeklyHours: 32,
          contractWorkDaysPerWeek: opts.contractWorkDaysPerWeek ?? 5,
          validFrom: new Date("2025-01-01"),
        },
      });
    }
    return { user, employee };
  }

  async function createHome(employeeId: string, salonId: string) {
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId,
        salonId,
        kind: "HOME",
        validFrom: new Date("2020-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "shpo");
    salonA = await createTestSalon(app.prisma, data.tenant.id, {
      name: "Planning Overview Salon A",
    });
    salonB = await createTestSalon(app.prisma, data.tenant.id, {
      name: "Planning Overview Salon B",
    });

    const a = await createEmployee("sb-a", { shiftBased: true, contractWorkDaysPerWeek: 5 });
    sbEmployeeA = a.employee;
    await createHome(sbEmployeeA.id, salonA.id);

    const b = await createEmployee("sb-b", { shiftBased: true, contractWorkDaysPerWeek: 3 });
    sbEmployeeB = b.employee;
    await createHome(sbEmployeeB.id, salonB.id);

    // data.employee stays the seedTestData default FIXED_SCHEDULE employee — proves exclusion.
  });

  afterAll(async () => {
    try {
      await app.prisma.employeeSalonAssignment.deleteMany({
        where: { employeeId: { in: createdEmployeeIds } },
      });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("5-day contract, 2 approved leave days (Do, Fr) this week, no shifts -> stillToPlan 3, no plannedDays/difference", async () => {
    const leave = await app.prisma.leaveRequest.create({
      data: {
        employeeId: sbEmployeeA.id,
        leaveTypeId: data.vacationType.id,
        startDate: new Date("2031-02-06T00:00:00Z"), // Thursday
        endDate: new Date("2031-02-07T00:00:00Z"), // Friday
        days: 2,
        status: "APPROVED",
        halfDay: false,
      },
    });
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/shifts/planning-overview?weekStart=${WEEK_START}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.weekStart).toBe(WEEK_START);
      expect(body.weekEnd).toBe(WEEK_END);
      const row = body.employees.find(
        (e: { employeeId: string }) => e.employeeId === sbEmployeeA.id,
      );
      expect(row).toBeTruthy();
      expect(row.contractDays).toBe(5);
      expect(row.leaveDays).toBe(2);
      expect(row.leaveWeekdays).toEqual(["Do", "Fr"]);
      expect(row.otherAbsenceDays).toBe(0);
      expect(row.stillToPlan).toBe(3);
      expect(row.plannedDays).toBeUndefined();
      expect(row.difference).toBeUndefined();
    } finally {
      await app.prisma.leaveRequest.delete({ where: { id: leave.id } });
    }
  });

  it("3 shifts already in that week -> plannedDays 3, difference 0", async () => {
    const leave = await app.prisma.leaveRequest.create({
      data: {
        employeeId: sbEmployeeA.id,
        leaveTypeId: data.vacationType.id,
        startDate: new Date("2031-02-06T00:00:00Z"),
        endDate: new Date("2031-02-07T00:00:00Z"),
        days: 2,
        status: "APPROVED",
        halfDay: false,
      },
    });
    const shiftDates = ["2031-02-03", "2031-02-04", "2031-02-05"];
    const shiftIds: string[] = [];
    for (const iso of shiftDates) {
      const shift = await app.prisma.shift.create({
        data: {
          employeeId: sbEmployeeA.id,
          salonId: salonA.id,
          date: new Date(`${iso}T00:00:00Z`),
          startTime: "08:00",
          endTime: "12:00",
        },
      });
      shiftIds.push(shift.id);
    }
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/shifts/planning-overview?weekStart=${WEEK_START}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const row = body.employees.find(
        (e: { employeeId: string }) => e.employeeId === sbEmployeeA.id,
      );
      expect(row.plannedDays).toBe(3);
      expect(row.difference).toBe(0);
    } finally {
      await app.prisma.shift.deleteMany({ where: { id: { in: shiftIds } } });
      await app.prisma.leaveRequest.delete({ where: { id: leave.id } });
    }
  });

  it("a non-SHIFT_BASED employee of the same tenant is NOT included", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/planning-overview?weekStart=${WEEK_START}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const ids = body.employees.map((e: { employeeId: string }) => e.employeeId);
    expect(ids).not.toContain(data.employee.id);
  });

  it("salonId query param narrows to that salon's employees only; omitted -> all salons in scope", async () => {
    const narrowed = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/planning-overview?weekStart=${WEEK_START}&salonId=${salonA.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(narrowed.statusCode).toBe(200);
    const narrowedIds = JSON.parse(narrowed.body).employees.map(
      (e: { employeeId: string }) => e.employeeId,
    );
    expect(narrowedIds).toContain(sbEmployeeA.id);
    expect(narrowedIds).not.toContain(sbEmployeeB.id);

    const all = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/planning-overview?weekStart=${WEEK_START}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(all.statusCode).toBe(200);
    const allIds = JSON.parse(all.body).employees.map((e: { employeeId: string }) => e.employeeId);
    expect(allIds).toContain(sbEmployeeA.id);
    expect(allIds).toContain(sbEmployeeB.id);
  });

  it("a user holding only shift:read:ZUGEWIESEN (not shift:plan) gets 403", async () => {
    const passwordHash = await bcrypt.hash("test1234", 10);
    const readOnlyUser = await app.prisma.user.create({
      data: {
        email: `shpo-readonly-${Date.now()}@test.de`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const readOnlyEmployee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: readOnlyUser.id,
        employeeNumber: `RO-${Date.now()}`,
        firstName: "ReadOnly",
        lastName: "PlanningOverview",
        hireDate: new Date("2024-01-01"),
      },
    });
    // Ausbilder (TRAINER) template: shift:read:ZUGEWIESEN but NOT shift:plan:ZUGEWIESEN.
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: readOnlyUser.id,
        accessRoleId: SYSTEM_ROLE_IDS.TRAINER,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
    try {
      const loginRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: readOnlyUser.email, password: "test1234" },
      });
      expect(loginRes.statusCode).toBe(200);
      const { accessToken } = JSON.parse(loginRes.body);

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/shifts/planning-overview?weekStart=${WEEK_START}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.prisma.roleAssignment.deleteMany({ where: { userId: readOnlyUser.id } });
      await app.prisma.employee.delete({ where: { id: readOnlyEmployee.id } });
      await app.prisma.user.delete({ where: { id: readOnlyUser.id } });
    }
  });

  it("a salon-A-only planner (no tenant-wide reach) never sees salon-B's employee; salonId=salonB and an unknown salonId are byte-identical (Phase 430-05, T-100-09)", async () => {
    const passwordHash = await bcrypt.hash("test1234", 10);
    const plannerUser = await app.prisma.user.create({
      data: {
        email: `shpo-scope-planner-${Date.now()}@test.de`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    // Needs an Employee row — User carries no tenantId of its own, so without one the login
    // token resolves no tenant and the permission check silently falls back to the EMPLOYEE
    // legacy role (403) instead of the intended SALONS assignment.
    const plannerEmployee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: plannerUser.id,
        employeeNumber: `SHPO-SCOPE-${Date.now()}`,
        firstName: "Planner",
        lastName: "PlanningOverviewScope",
        hireDate: new Date("2024-01-01"),
      },
    });
    // Salonmanager template, SALONS scope limited to salon A only — no wholeTenant reach.
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: plannerUser.id,
        accessRoleId: SYSTEM_ROLE_IDS.SALON_MANAGER,
        scopeType: "SALONS",
        salonIds: [salonA.id],
        employeeIds: [],
      },
    });
    try {
      const loginRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: plannerUser.email, password: "test1234" },
      });
      expect(loginRes.statusCode).toBe(200);
      const { accessToken } = JSON.parse(loginRes.body);

      // Default listing (no salonId): salon-A planner sees salon-A's employee, never salon-B's.
      const defaultRes = await app.inject({
        method: "GET",
        url: `/api/v1/shifts/planning-overview?weekStart=${WEEK_START}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(defaultRes.statusCode).toBe(200);
      const defaultIds = JSON.parse(defaultRes.body).employees.map(
        (e: { employeeId: string }) => e.employeeId,
      );
      expect(defaultIds).toContain(sbEmployeeA.id);
      expect(defaultIds).not.toContain(sbEmployeeB.id);

      // T-100-09: explicitly asking for salon B (real, foreign-to-this-reach salon) and asking
      // for a wholly unknown salon id must be indistinguishable — same status, same body. The
      // route never 404s on an unknown/out-of-reach salonId; both answer an empty employees list.
      const foreignSalonRes = await app.inject({
        method: "GET",
        url: `/api/v1/shifts/planning-overview?weekStart=${WEEK_START}&salonId=${salonB.id}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const unknownSalonRes = await app.inject({
        method: "GET",
        url: `/api/v1/shifts/planning-overview?weekStart=${WEEK_START}&salonId=00000000-0000-4000-8000-000000000000`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(foreignSalonRes.statusCode).toBe(unknownSalonRes.statusCode);
      expect(foreignSalonRes.statusCode).toBe(200);
      expect(JSON.parse(foreignSalonRes.body)).toEqual(JSON.parse(unknownSalonRes.body));
      expect(JSON.parse(foreignSalonRes.body).employees).toEqual([]);
    } finally {
      await app.prisma.roleAssignment.deleteMany({ where: { userId: plannerUser.id } });
      await app.prisma.employee.delete({ where: { id: plannerEmployee.id } });
      await app.prisma.user.delete({ where: { id: plannerUser.id } });
    }
  });

  it("paging: two different weekStart values (one 6 months out) return correct, independent results", async () => {
    const nearRes = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/planning-overview?weekStart=${WEEK_START}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    const farRes = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/planning-overview?weekStart=${WEEK_START_FAR}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(nearRes.statusCode).toBe(200);
    expect(farRes.statusCode).toBe(200);
    const nearBody = JSON.parse(nearRes.body);
    const farBody = JSON.parse(farRes.body);
    expect(nearBody.weekStart).toBe(WEEK_START);
    expect(farBody.weekStart).toBe("2031-08-04");
    expect(farBody.weekEnd).toBe("2031-08-10");

    // No leave/shifts were ever created in the far week -> stillToPlan == contractDays, no
    // plannedDays/difference keys; independent from whatever the near week's fixtures left behind.
    const farRow = farBody.employees.find(
      (e: { employeeId: string }) => e.employeeId === sbEmployeeA.id,
    );
    expect(farRow.leaveDays).toBe(0);
    expect(farRow.stillToPlan).toBe(5);
    expect(farRow.plannedDays).toBeUndefined();
  });
});
