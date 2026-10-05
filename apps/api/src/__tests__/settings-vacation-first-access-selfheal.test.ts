/**
 * Issue #416, CONTEXT.md decision 6 ("first access") — GET /api/v1/settings/vacation/:employeeId
 * used to return `totalDays: null` forever when no LeaveEntitlement row existed for the current
 * year (this was, until this phase, the ONLY code path an employee's own /leave page relied on to
 * detect "no entitlement"). This pins the self-heal: an active employee's missing CURRENT-year row
 * is now created on this exact read, with a CREATE audit, once — never for a past/future year, and
 * never for an inactive (exited) employee.
 *
 * Every year is computed from `new Date()` — no hardcoded calendar literal (documented time-bomb
 * hazard, see CLAUDE.md / docs/testing.md).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("GET /api/v1/settings/vacation/:employeeId — first-access self-heal (Issue #416)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "svfa");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("auto-creates the current-year row for an active employee that has none, with a CREATE audit — and is idempotent on a second read", async () => {
    const currentYear = new Date().getFullYear();

    // seedTestData()'s employee has hireDate 2024-01-01 (a prior year) but ALSO seeds a
    // current-year entitlement row for that same employee, so use a FRESH employee here — one
    // with hireDate in the current year and no entitlement row at all, mirroring "new hire,
    // POST /employees predates this phase" exactly.
    const uid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/employees",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        usualWorkDays: [1, 2, 3, 4, 5],
        email: `selfheal-${uid}@test.de`,
        firstName: "Self",
        lastName: "Heal",
        employeeNumber: `SH-${uid}`,
        hireDate: new Date(Date.UTC(currentYear, 0, 1)).toISOString(),
        role: "EMPLOYEE",
        weeklyHours: 40,
        password: "Test@1234567!",
      },
    });
    expect(createRes.statusCode).toBe(201);
    const employeeId = JSON.parse(createRes.body).id;

    // Simulate "no code path ever created a row" (pre-#416 employees) by deleting the row
    // employees.ts's own hire-time auto-seed (this same phase's Task 3) just created.
    await app.prisma.leaveEntitlement.deleteMany({ where: { employeeId } });
    const before = await app.prisma.leaveEntitlement.findFirst({ where: { employeeId } });
    expect(before).toBeNull();

    const firstRes = await app.inject({
      method: "GET",
      url: `/api/v1/settings/vacation/${employeeId}?year=${currentYear}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(firstRes.statusCode).toBe(200);
    const firstBody = JSON.parse(firstRes.body);
    expect(firstBody.totalDays).toBe(30); // full-time, full year (hired Jan 1)

    const entitlement = await app.prisma.leaveEntitlement.findFirst({
      where: { employeeId, year: currentYear },
    });
    expect(entitlement).not.toBeNull();
    expect(entitlement?.isAutoCalculated).toBe(true);

    const audit = await app.prisma.auditLog.findFirst({
      where: { entity: "LeaveEntitlement", entityId: entitlement!.id, action: "CREATE" },
    });
    expect(audit).not.toBeNull();

    // Idempotent: a second read must NOT create a second row or a second audit.
    const secondRes = await app.inject({
      method: "GET",
      url: `/api/v1/settings/vacation/${employeeId}?year=${currentYear}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(secondRes.statusCode).toBe(200);
    expect(JSON.parse(secondRes.body).totalDays).toBe(30);

    const rowsAfter = await app.prisma.leaveEntitlement.findMany({
      where: { employeeId, year: currentYear },
    });
    expect(rowsAfter).toHaveLength(1);
    const auditsAfter = await app.prisma.auditLog.findMany({
      where: { entity: "LeaveEntitlement", entityId: entitlement!.id, action: "CREATE" },
    });
    expect(auditsAfter).toHaveLength(1);
  });

  it("heals with the person value, not the tenant default (Issue #435, D-06)", async () => {
    const currentYear = new Date().getFullYear();
    const uid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/employees",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        usualWorkDays: [1, 2, 3, 4, 5],
        email: `selfheal-pv-${uid}@test.de`,
        firstName: "Person",
        lastName: "Value",
        employeeNumber: `SHPV-${uid}`,
        hireDate: new Date(Date.UTC(currentYear, 0, 1)).toISOString(),
        role: "EMPLOYEE",
        weeklyHours: 40,
        password: "Test@1234567!",
        annualVacationDays: 20, // below the tenant default (30) — the heal must use THIS value
      },
    });
    expect(createRes.statusCode).toBe(201);
    const employeeId = JSON.parse(createRes.body).id;

    // Simulate "no code path ever created a row" — same setup as the sibling test above.
    await app.prisma.leaveEntitlement.deleteMany({ where: { employeeId } });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/settings/vacation/${employeeId}?year=${currentYear}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).totalDays).toBe(20);

    const entitlement = await app.prisma.leaveEntitlement.findFirst({
      where: { employeeId, year: currentYear },
    });
    expect(Number(entitlement?.totalDays)).toBe(20);
  });

  it("does NOT self-heal an exited (inactive) employee — totalDays stays null, no row created", async () => {
    const currentYear = new Date().getFullYear();
    const uid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/employees",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        usualWorkDays: [1, 2, 3, 4, 5],
        email: `selfheal-exited-${uid}@test.de`,
        firstName: "Exited",
        lastName: "Employee",
        employeeNumber: `EX-${uid}`,
        hireDate: new Date(Date.UTC(currentYear, 0, 1)).toISOString(),
        role: "EMPLOYEE",
        weeklyHours: 40,
        password: "Test@1234567!",
      },
    });
    expect(createRes.statusCode).toBe(201);
    const employeeId = JSON.parse(createRes.body).id;

    await app.prisma.leaveEntitlement.deleteMany({ where: { employeeId } });
    await app.prisma.employee.update({
      where: { id: employeeId },
      data: { exitDate: new Date(Date.UTC(currentYear, 5, 30)) },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/settings/vacation/${employeeId}?year=${currentYear}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).totalDays).toBeNull();

    const rows = await app.prisma.leaveEntitlement.findMany({ where: { employeeId } });
    expect(rows).toHaveLength(0);
  });

  it("does NOT self-heal a NON-current year (past/future) — totalDays stays null, no row created", async () => {
    const currentYear = new Date().getFullYear();
    const pastYear = currentYear - 3;

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/settings/vacation/${data.employee.id}?year=${pastYear}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).totalDays).toBeNull();

    const rows = await app.prisma.leaveEntitlement.findMany({
      where: { employeeId: data.employee.id, year: pastYear },
    });
    expect(rows).toHaveLength(0);
  });
});
