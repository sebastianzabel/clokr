/**
 * Phase 91b Plan 04 (Issue #91), D-10/D-14 — closes the confirmed `GET /api/v1/leave/requests`
 * unscoped-list bug: a SALONS/PERSONS-scoped manager saw every request in the tenant. Scoping is
 * Stammsalon-only (D-10) — `LeaveRequest` has no `salonId` column, so there is no entry-salon
 * fallback the way `TimeEntry` (D-09) has.
 *
 * No person names in fixtures (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { DEFAULT_SALON_OPENING_HOURS } from "../contexts/platform/facade/salons";
import { normalizeRolePermissions, roleNameKey } from "../contexts/platform";

const PASSWORD = "test1234";

describe("Issue #91 (Phase 91b Plan 04) — LeaveRequest salon/person scope", () => {
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
        lastName: "LeaveScopeTest",
        hireDate: new Date("2020-01-01"),
      },
    });
    return { user, employee };
  }

  function createHome(
    employeeId: string,
    salonId: string,
    validFrom: string,
    validUntil: string | null = null,
  ) {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId,
        salonId,
        kind: "HOME",
        validFrom: new Date(validFrom),
        validUntil: validUntil ? new Date(validUntil) : null,
        weekdays: [],
      },
    });
  }

  function createLeaveRequest(employeeId: string, startDate: string, endDate: string) {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        days: 1,
        status: "PENDING",
      },
    });
  }

  async function createScopedManager(
    label: string,
    permissions: string[],
    scope: {
      scopeType: "SALONS" | "PERSONS" | "TENANT";
      salonIds?: string[];
      employeeIds?: string[];
    },
  ) {
    const { user } = await createEmployee(label);
    const name = `LeaveScope ${crypto.randomBytes(3).toString("hex")}`;
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
    data = await seedTestData(app, "lrsc");
    salonA = await app.prisma.salon.create({
      data: {
        tenantId: data.tenant.id,
        name: "LRSC Salon A",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
        federalState: "NIEDERSACHSEN", // Phase 71b (issue #71) — required since the merge; irrelevant to this test's own assertions
      },
    });
    salonB = await app.prisma.salon.create({
      data: {
        tenantId: data.tenant.id,
        name: "LRSC Salon B",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
        federalState: "NIEDERSACHSEN", // Phase 71b (issue #71) — required since the merge; irrelevant to this test's own assertions
      },
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

  it("a SALONS-scoped manager sees only in-scope-Stammsalon-today employees' requests", async () => {
    const inScopeEmp = await createEmployee("inscope-leave-list");
    await createHome(inScopeEmp.employee.id, salonA.id, "2020-01-01");
    const inScopeRequest = await createLeaveRequest(
      inScopeEmp.employee.id,
      "2026-06-01",
      "2026-06-02",
    );

    const outOfScopeEmp = await createEmployee("outscope-leave-list");
    await createHome(outOfScopeEmp.employee.id, salonB.id, "2020-01-01");
    const outOfScopeRequest = await createLeaveRequest(
      outOfScopeEmp.employee.id,
      "2026-06-01",
      "2026-06-02",
    );

    const manager = await createScopedManager("mgr-leave-list", ["leave-request:read:ZUGEWIESEN"], {
      scopeType: "SALONS",
      salonIds: [salonA.id],
    });
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const ids = (JSON.parse(res.body) as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain(inScopeRequest.id);
    expect(ids).not.toContain(outOfScopeRequest.id);
  });

  it("a PERSONS-scoped manager sees only the listed employees' requests", async () => {
    const listedEmp = await createEmployee("listed-leave-list");
    await createHome(listedEmp.employee.id, salonB.id, "2020-01-01");
    const listedRequest = await createLeaveRequest(
      listedEmp.employee.id,
      "2026-06-03",
      "2026-06-03",
    );

    const unlistedEmp = await createEmployee("unlisted-leave-list");
    await createHome(unlistedEmp.employee.id, salonA.id, "2020-01-01");
    const unlistedRequest = await createLeaveRequest(
      unlistedEmp.employee.id,
      "2026-06-03",
      "2026-06-03",
    );

    const manager = await createScopedManager(
      "mgr-leave-persons",
      ["leave-request:read:ZUGEWIESEN"],
      {
        scopeType: "PERSONS",
        employeeIds: [listedEmp.employee.id],
      },
    );
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const ids = (JSON.parse(res.body) as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain(listedRequest.id);
    expect(ids).not.toContain(unlistedRequest.id);
  });

  it("a TENANT-scope (wholeTenant) manager's response is unchanged — sees every request, no regression", async () => {
    const emp = await createEmployee("wholetenant-leave-list");
    await createHome(emp.employee.id, salonB.id, "2020-01-01");
    const request = await createLeaveRequest(emp.employee.id, "2026-06-04", "2026-06-04");

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const ids = (JSON.parse(res.body) as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain(request.id);
  });

  it("?year uses January 1st of that year as the Stichtag, not today — a Stammsalon change straddling the year boundary changes the answer", async () => {
    // Stammsalon is salon A from 2024-01-01 through 2024-12-31, then salon B from 2025-01-01.
    const emp = await createEmployee("year-stichtag-leave-list");
    await createHome(emp.employee.id, salonA.id, "2024-01-01", "2024-12-31");
    await createHome(emp.employee.id, salonB.id, "2025-01-01");
    const request2024 = await createLeaveRequest(emp.employee.id, "2024-06-01", "2024-06-02");
    const request2025 = await createLeaveRequest(emp.employee.id, "2025-06-01", "2025-06-02");

    const manager = await createScopedManager("mgr-leave-year", ["leave-request:read:ZUGEWIESEN"], {
      scopeType: "SALONS",
      salonIds: [salonA.id],
    });
    const token = await login(manager.user.email);

    // ?year=2024: Stichtag Jan 1 2024 -> Stammsalon A -> in scope.
    const res2024 = await app.inject({
      method: "GET",
      url: "/api/v1/leave/requests?year=2024",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res2024.statusCode).toBe(200);
    const ids2024 = (JSON.parse(res2024.body) as Array<{ id: string }>).map((r) => r.id);
    expect(ids2024).toContain(request2024.id);

    // ?year=2025: Stichtag Jan 1 2025 -> Stammsalon B -> out of scope for a salon-A-only manager.
    const res2025 = await app.inject({
      method: "GET",
      url: "/api/v1/leave/requests?year=2025",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res2025.statusCode).toBe(200);
    const ids2025 = (JSON.parse(res2025.body) as Array<{ id: string }>).map((r) => r.id);
    expect(ids2025).not.toContain(request2025.id);
  });

  it("an out-of-scope employeeId query param yields an empty result, not that employee's full history", async () => {
    const outOfScopeEmp = await createEmployee("outscope-explicit-leave-list");
    await createHome(outOfScopeEmp.employee.id, salonB.id, "2020-01-01");
    const outOfScopeRequest = await createLeaveRequest(
      outOfScopeEmp.employee.id,
      "2026-06-05",
      "2026-06-05",
    );

    const manager = await createScopedManager(
      "mgr-leave-explicit-id",
      ["leave-request:read:ZUGEWIESEN"],
      { scopeType: "SALONS", salonIds: [salonA.id] },
    );
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/requests?employeeId=${outOfScopeEmp.employee.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const ids = (JSON.parse(res.body) as Array<{ id: string }>).map((r) => r.id);
    expect(ids).not.toContain(outOfScopeRequest.id);
  });

  it("a SALONS/PERSONS manager with an empty resolved reach sees zero requests", async () => {
    const emp = await createEmployee("emptyreach-leave-list");
    await createHome(emp.employee.id, salonA.id, "2020-01-01");
    const request = await createLeaveRequest(emp.employee.id, "2026-06-06", "2026-06-06");

    const manager = await createScopedManager(
      "mgr-leave-empty",
      ["leave-request:read:ZUGEWIESEN"],
      {
        scopeType: "SALONS",
        salonIds: [],
      },
    );
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const ids = (JSON.parse(res.body) as Array<{ id: string }>).map((r) => r.id);
    expect(ids).not.toContain(request.id);
  });
});
