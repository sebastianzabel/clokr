/**
 * Phase 91b Plan 06 (Issue #91), D-09/D-10/D-13 — the dashboard's team-facing views
 * (GET /team-week, GET /today-attendance, GET /overtime-overview) narrow to Stammsalon-scoped
 * employees BEFORE aggregating, closing the previously-unscoped tenant-wide reads.
 *
 * No person names in fixtures (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
} from "../../__tests__/setup";
import { normalizeRolePermissions, roleNameKey } from "../../contexts/platform";

const PASSWORD = "test1234";

describe("Issue #91 (Phase 91b Plan 06) — dashboard.ts salon/person scope", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };

  function uniqueSuffix(label: string): string {
    return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  async function createEmployee(label: string) {
    const s = uniqueSuffix(label);
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await app.prisma.user.create({
      data: { email: `${s}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: label,
        lastName: "DashboardScopeTest",
        hireDate: new Date("2020-01-01"),
      },
    });
    return { user, employee };
  }

  function createHome(employeeId: string, salonId: string) {
    return app.prisma.employeeSalonAssignment.create({
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

  async function createScopedManager(
    label: string,
    permissions: string[],
    scope: { scopeType: "SALONS" | "PERSONS"; salonIds?: string[]; employeeIds?: string[] },
  ) {
    const { user } = await createEmployee(label);
    const name = `DashboardScope ${crypto.randomBytes(3).toString("hex")}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId: data.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions(permissions),
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        accessRoleId: role.id,
        scopeType: scope.scopeType,
        salonIds: scope.salonIds ?? [],
        employeeIds: scope.employeeIds ?? [],
      },
    });
    return { user };
  }

  async function login(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return (JSON.parse(res.body) as { accessToken: string }).accessToken;
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "dbsc");
    salonA = await createTestSalon(app.prisma, data.tenant.id, { name: "DBSC Salon A" });
    salonB = await createTestSalon(app.prisma, data.tenant.id, { name: "DBSC Salon B" });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("GET /team-week: a SALONS-scoped manager excludes an out-of-scope employee's row", async () => {
    const inScope = await createEmployee("inscope-teamweek");
    await createHome(inScope.employee.id, salonA.id);
    const outOfScope = await createEmployee("outscope-teamweek");
    await createHome(outOfScope.employee.id, salonB.id);

    const manager = await createScopedManager("mgr-teamweek", ["team-overview:read:ZUGEWIESEN"], {
      scopeType: "SALONS",
      salonIds: [salonA.id],
    });
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/team-week",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const ids = (JSON.parse(res.body) as { team: Array<{ id: string }> }).team.map((t) => t.id);
    expect(ids).toContain(inScope.employee.id);
    expect(ids).not.toContain(outOfScope.employee.id);
  });

  it("GET /team-week: a TENANT-scope (wholeTenant) manager sees both employees — unaffected", async () => {
    const empA = await createEmployee("wta");
    await createHome(empA.employee.id, salonA.id);
    const empB = await createEmployee("wtb");
    await createHome(empB.employee.id, salonB.id);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/team-week",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const ids = (JSON.parse(res.body) as { team: Array<{ id: string }> }).team.map((t) => t.id);
    expect(ids).toContain(empA.employee.id);
    expect(ids).toContain(empB.employee.id);
  });

  it("GET /today-attendance: a SALONS-scoped manager excludes an out-of-scope employee's row", async () => {
    const inScope = await createEmployee("inscope-attendance");
    await createHome(inScope.employee.id, salonA.id);
    const outOfScope = await createEmployee("outscope-attendance");
    await createHome(outOfScope.employee.id, salonB.id);

    const manager = await createScopedManager("mgr-attendance", ["team-overview:read:ZUGEWIESEN"], {
      scopeType: "SALONS",
      salonIds: [salonA.id],
    });
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/today-attendance",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const ids = (JSON.parse(res.body) as { employees: Array<{ id: string }> }).employees.map(
      (e) => e.id,
    );
    expect(ids).toContain(inScope.employee.id);
    expect(ids).not.toContain(outOfScope.employee.id);
  });

  it("GET /overtime-overview: a SALONS-scoped manager excludes an out-of-scope employee's account (NEW finding — this route had zero scope narrowing at all); the manager also needs overtime:read:ZUGEWIESEN since Phase 76b D-06", async () => {
    const inScope = await createEmployee("inscope-overview");
    await createHome(inScope.employee.id, salonA.id);
    await app.prisma.overtimeAccount.create({
      data: { employeeId: inScope.employee.id, balanceHours: 5 },
    });
    const outOfScope = await createEmployee("outscope-overview");
    await createHome(outOfScope.employee.id, salonB.id);
    await app.prisma.overtimeAccount.create({
      data: { employeeId: outOfScope.employee.id, balanceHours: 5 },
    });

    // Phase 76b (Issue #76), D-06: since this route additionally requires overtime:read:ZUGEWIESEN
    // (saldo IS the overtime resource), this fixture's role now carries both permissions — the
    // case still proves the exact same SALONS scope-narrowing behaviour as before D-06, this is
    // NOT a loosened test (see the plan's own note on this).
    const manager = await createScopedManager(
      "mgr-overview",
      ["team-overview:read:ZUGEWIESEN", "overtime:read:ZUGEWIESEN"],
      {
        scopeType: "SALONS",
        salonIds: [salonA.id],
      },
    );
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/overtime-overview",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const ids = (JSON.parse(res.body) as { employees: Array<{ id: string }> }).employees.map(
      (e) => e.id,
    );
    expect(ids).toContain(inScope.employee.id);
    expect(ids).not.toContain(outOfScope.employee.id);
  });

  it("GET /overtime-overview: a SALONS-scoped manager holding team-overview:read only gets 403 — the Salonmanager case (D-06)", async () => {
    const manager = await createScopedManager(
      "mgr-overview-no-overtime",
      ["team-overview:read:ZUGEWIESEN"],
      { scopeType: "SALONS", salonIds: [salonA.id] },
    );
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/overtime-overview",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "Forbidden" });
  });

  it("GET /overtime-overview: a TENANT team-overview:read holder with a SALONS-only overtime:read assignment sees only the Stammsalon-A employee — intersection of both reaches (D-06, P-04)", async () => {
    const stammsalonA = await createEmployee("inscope-intersection");
    await createHome(stammsalonA.employee.id, salonA.id);
    await app.prisma.overtimeAccount.create({
      data: { employeeId: stammsalonA.employee.id, balanceHours: 4 },
    });
    const stammsalonB = await createEmployee("outscope-intersection");
    await createHome(stammsalonB.employee.id, salonB.id);
    await app.prisma.overtimeAccount.create({
      data: { employeeId: stammsalonB.employee.id, balanceHours: 4 },
    });

    const { user } = await createEmployee("mgr-intersection");
    const tenantRoleName = `DashboardScope ${crypto.randomBytes(3).toString("hex")}`;
    const tenantRole = await app.prisma.accessRole.create({
      data: {
        tenantId: data.tenant.id,
        name: tenantRoleName,
        nameKey: roleNameKey(tenantRoleName),
        permissions: normalizeRolePermissions(["team-overview:read:ZUGEWIESEN"]),
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        accessRoleId: tenantRole.id,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
    const salonsRoleName = `DashboardScope ${crypto.randomBytes(3).toString("hex")}`;
    const salonsRole = await app.prisma.accessRole.create({
      data: {
        tenantId: data.tenant.id,
        name: salonsRoleName,
        nameKey: roleNameKey(salonsRoleName),
        permissions: normalizeRolePermissions(["overtime:read:ZUGEWIESEN"]),
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        accessRoleId: salonsRole.id,
        scopeType: "SALONS",
        salonIds: [salonA.id],
        employeeIds: [],
      },
    });
    const token = await login(user.email);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/overtime-overview",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const ids = (JSON.parse(res.body) as { employees: Array<{ id: string }> }).employees.map(
      (e) => e.id,
    );
    expect(ids).toContain(stammsalonA.employee.id);
    expect(ids).not.toContain(stammsalonB.employee.id);
  });

  it("GET /overtime-overview: a TENANT-scope (wholeTenant) manager sees both employees — unaffected", async () => {
    const empA = await createEmployee("wta2");
    await createHome(empA.employee.id, salonA.id);
    await app.prisma.overtimeAccount.create({
      data: { employeeId: empA.employee.id, balanceHours: 3 },
    });
    const empB = await createEmployee("wtb2");
    await createHome(empB.employee.id, salonB.id);
    await app.prisma.overtimeAccount.create({
      data: { employeeId: empB.employee.id, balanceHours: 3 },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/overtime-overview",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const ids = (JSON.parse(res.body) as { employees: Array<{ id: string }> }).employees.map(
      (e) => e.id,
    );
    expect(ids).toContain(empA.employee.id);
    expect(ids).toContain(empB.employee.id);
  });
});
