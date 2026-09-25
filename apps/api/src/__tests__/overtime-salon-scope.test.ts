/**
 * Phase 91b Plan 05 (Issue #91), D-10/D-14 — Plan 91b-01's D-05 gate change means a SALONS/PERSONS
 * holder of `overtime:read:ZUGEWIESEN` now passes the 403 gate for the first time; this closes the
 * gap that would otherwise admit them to EVERY employee's saldo, not just their scope.
 *
 * No person names in fixtures (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { normalizeRolePermissions, roleNameKey } from "../contexts/platform";

const PASSWORD = "test1234";

describe("Issue #91 (Phase 91b Plan 05) — overtime.ts salon/person scope", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };

  function uniqueSuffix(label: string): string {
    return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  async function createEmployeeWithAccount(label: string) {
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
        lastName: "OvertimeScopeTest",
        hireDate: new Date("2020-01-01"),
      },
    });
    const account = await app.prisma.overtimeAccount.create({
      data: { employeeId: employee.id, balanceHours: 0 },
    });
    return { user, employee, account };
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

  async function createManagerEmployee(label: string) {
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
        lastName: "OvertimeScopeManager",
        hireDate: new Date("2020-01-01"),
      },
    });
    return { user, employee };
  }

  async function createScopedManager(
    label: string,
    permissions: string[],
    scope: { scopeType: "SALONS" | "PERSONS"; salonIds?: string[]; employeeIds?: string[] },
  ) {
    const { user } = await createManagerEmployee(label);
    const name = `OvertimeScope ${crypto.randomBytes(3).toString("hex")}`;
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
    data = await seedTestData(app, "otsc");
    salonA = await createTestSalon(app.prisma, data.tenant.id, { name: "OTSC Salon A" });
    salonB = await createTestSalon(app.prisma, data.tenant.id, { name: "OTSC Salon B" });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("GET /:employeeId: an out-of-scope employee's account 404s byte-identically to a nonexistent one, with SCOPE_ACCESS_DENIED audit", async () => {
    const outOfScope = await createEmployeeWithAccount("outscope-get");
    await createHome(outOfScope.employee.id, salonB.id);

    const manager = await createScopedManager("mgr-get-salons", ["overtime:read:ZUGEWIESEN"], {
      scopeType: "SALONS",
      salonIds: [salonA.id],
    });
    const token = await login(manager.user.email);

    const nonExistentRes = await app.inject({
      method: "GET",
      url: "/api/v1/overtime/00000000-0000-0000-0000-000000000000",
      headers: { authorization: `Bearer ${token}` },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/${outOfScope.employee.id}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(nonExistentRes.statusCode);
    expect(res.body).toBe(nonExistentRes.body);
    expect(res.statusCode).toBe(404);

    const audit = await app.prisma.auditLog.findFirst({
      where: {
        action: "SCOPE_ACCESS_DENIED",
        entity: "OvertimeAccount",
        entityId: outOfScope.account.id,
      },
    });
    expect(audit).not.toBeNull();
  });

  it("GET /:employeeId: an in-scope employee's account still succeeds (no regression)", async () => {
    const inScope = await createEmployeeWithAccount("inscope-get");
    await createHome(inScope.employee.id, salonA.id);

    const manager = await createScopedManager("mgr-get-inscope", ["overtime:read:ZUGEWIESEN"], {
      scopeType: "SALONS",
      salonIds: [salonA.id],
    });
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/${inScope.employee.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("GET /:employeeId: a PERSONS-scoped manager whose employeeIds includes the target succeeds regardless of salon", async () => {
    const listed = await createEmployeeWithAccount("listed-get");
    await createHome(listed.employee.id, salonB.id);

    const manager = await createScopedManager("mgr-get-persons", ["overtime:read:ZUGEWIESEN"], {
      scopeType: "PERSONS",
      employeeIds: [listed.employee.id],
    });
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/${listed.employee.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("GET /:employeeId: a TENANT-scope (wholeTenant) manager is unaffected — no new scope check blocks it", async () => {
    const emp = await createEmployeeWithAccount("wholetenant-get");
    await createHome(emp.employee.id, salonB.id);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/${emp.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("GET /:employeeId: the EIGENE self-path is unaffected — an employee reading their own account still succeeds", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.empToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  // ── Task 2 — every other single-employee ZUGEWIESEN route, plus two NEW findings ──────────

  it("GET /snapshots/:employeeId (NEW finding beyond Task 1's literal list — same shape as GET /:employeeId): an out-of-scope employee 404s with SCOPE_ACCESS_DENIED audit", async () => {
    const outOfScope = await createEmployeeWithAccount("outscope-snapshots");
    await createHome(outOfScope.employee.id, salonB.id);

    const manager = await createScopedManager("mgr-snapshots", ["overtime:read:ZUGEWIESEN"], {
      scopeType: "SALONS",
      salonIds: [salonA.id],
    });
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/snapshots/${outOfScope.employee.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(JSON.stringify({ error: "Mitarbeiter nicht gefunden" }));

    const audit = await app.prisma.auditLog.findFirst({
      where: {
        action: "SCOPE_ACCESS_DENIED",
        entity: "Employee",
        entityId: outOfScope.employee.id,
      },
    });
    expect(audit).not.toBeNull();
  });

  it("GET /month-saldo/:employeeId (NEW finding beyond Task 1's literal list — same shape as GET /:employeeId): an out-of-scope employee 404s with SCOPE_ACCESS_DENIED audit", async () => {
    const outOfScope = await createEmployeeWithAccount("outscope-monthsaldo");
    await createHome(outOfScope.employee.id, salonB.id);

    const manager = await createScopedManager("mgr-monthsaldo", ["overtime:read:ZUGEWIESEN"], {
      scopeType: "SALONS",
      salonIds: [salonA.id],
    });
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/month-saldo/${outOfScope.employee.id}?year=2026&month=6`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(JSON.stringify({ error: "Mitarbeiter nicht gefunden" }));

    const audit = await app.prisma.auditLog.findFirst({
      where: {
        action: "SCOPE_ACCESS_DENIED",
        entity: "Employee",
        entityId: outOfScope.employee.id,
      },
    });
    expect(audit).not.toBeNull();
  });

  it("POST /plans: an out-of-scope employee 404s with SCOPE_ACCESS_DENIED audit", async () => {
    const outOfScope = await createEmployeeWithAccount("outscope-plans");
    await createHome(outOfScope.employee.id, salonB.id);

    const manager = await createScopedManager("mgr-plans", ["overtime:settle:ZUGEWIESEN"], {
      scopeType: "SALONS",
      salonIds: [salonA.id],
    });
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/overtime/plans",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        employeeId: outOfScope.employee.id,
        hoursToReduce: 5,
        deadline: "2026-12-31T00:00:00.000Z",
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(JSON.stringify({ error: "Mitarbeiter nicht gefunden" }));

    const audit = await app.prisma.auditLog.findFirst({
      where: {
        action: "SCOPE_ACCESS_DENIED",
        entity: "Employee",
        entityId: outOfScope.employee.id,
      },
    });
    expect(audit).not.toBeNull();
  });

  it("POST /payout: an out-of-scope employee 404s with SCOPE_ACCESS_DENIED audit", async () => {
    const outOfScope = await createEmployeeWithAccount("outscope-payout");
    await createHome(outOfScope.employee.id, salonB.id);

    const manager = await createScopedManager("mgr-payout", ["overtime:settle:ZUGEWIESEN"], {
      scopeType: "SALONS",
      salonIds: [salonA.id],
    });
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/overtime/payout",
      headers: { authorization: `Bearer ${token}` },
      payload: { employeeId: outOfScope.employee.id, hours: 1 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(JSON.stringify({ error: "Mitarbeiter nicht gefunden" }));

    const audit = await app.prisma.auditLog.findFirst({
      where: {
        action: "SCOPE_ACCESS_DENIED",
        entity: "Employee",
        entityId: outOfScope.employee.id,
      },
    });
    expect(audit).not.toBeNull();
  });

  it("POST /close-month: an out-of-scope employee 404s with SCOPE_ACCESS_DENIED audit", async () => {
    const outOfScope = await createEmployeeWithAccount("outscope-closemonth");
    await createHome(outOfScope.employee.id, salonB.id);

    const manager = await createScopedManager("mgr-closemonth", ["month-close:close:ZUGEWIESEN"], {
      scopeType: "SALONS",
      salonIds: [salonA.id],
    });
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/overtime/close-month",
      headers: { authorization: `Bearer ${token}` },
      payload: { employeeId: outOfScope.employee.id, year: 2026, month: 6 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(JSON.stringify({ error: "Mitarbeiter nicht gefunden" }));

    const audit = await app.prisma.auditLog.findFirst({
      where: {
        action: "SCOPE_ACCESS_DENIED",
        entity: "Employee",
        entityId: outOfScope.employee.id,
      },
    });
    expect(audit).not.toBeNull();
  });

  it("POST /unlock-month: an out-of-scope employee 404s with SCOPE_ACCESS_DENIED audit (before the closed-month check even runs)", async () => {
    const outOfScope = await createEmployeeWithAccount("outscope-unlock");
    await createHome(outOfScope.employee.id, salonB.id);

    const manager = await createScopedManager("mgr-unlock", ["month-close:unlock:ZUGEWIESEN"], {
      scopeType: "SALONS",
      salonIds: [salonA.id],
    });
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/overtime/unlock-month",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        employeeId: outOfScope.employee.id,
        year: 2026,
        month: 6,
        reason: "Testfall 91b-05",
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(JSON.stringify({ error: "Mitarbeiter nicht gefunden" }));

    const audit = await app.prisma.auditLog.findFirst({
      where: {
        action: "SCOPE_ACCESS_DENIED",
        entity: "Employee",
        entityId: outOfScope.employee.id,
      },
    });
    expect(audit).not.toBeNull();
  });

  it("POST /close-year: an out-of-scope employee 404s with SCOPE_ACCESS_DENIED audit", async () => {
    const outOfScope = await createEmployeeWithAccount("outscope-closeyear");
    await createHome(outOfScope.employee.id, salonB.id);

    const manager = await createScopedManager(
      "mgr-closeyear",
      ["month-close:close-year:ZUGEWIESEN"],
      { scopeType: "SALONS", salonIds: [salonA.id] },
    );
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/overtime/close-year",
      headers: { authorization: `Bearer ${token}` },
      payload: { employeeId: outOfScope.employee.id, year: 2024 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(JSON.stringify({ error: "Mitarbeiter nicht gefunden" }));

    const audit = await app.prisma.auditLog.findFirst({
      where: {
        action: "SCOPE_ACCESS_DENIED",
        entity: "Employee",
        entityId: outOfScope.employee.id,
      },
    });
    expect(audit).not.toBeNull();
  });

  it("POST /opening-balance: an out-of-scope employee 404s with SCOPE_ACCESS_DENIED audit", async () => {
    const outOfScope = await createEmployeeWithAccount("outscope-opening");
    await createHome(outOfScope.employee.id, salonB.id);

    const manager = await createScopedManager(
      "mgr-opening",
      ["overtime:set-opening-balance:ZUGEWIESEN"],
      { scopeType: "SALONS", salonIds: [salonA.id] },
    );
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/overtime/opening-balance",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        employeeId: outOfScope.employee.id,
        minutes: 60,
        effectiveFrom: "2026-01-01",
        reason: "Testfall 91b-05 Eröffnungssaldo",
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(JSON.stringify({ error: "Mitarbeiter nicht gefunden" }));

    const audit = await app.prisma.auditLog.findFirst({
      where: {
        action: "SCOPE_ACCESS_DENIED",
        entity: "OpeningBalance",
        entityId: outOfScope.employee.id,
      },
    });
    expect(audit).not.toBeNull();
  });

  describe("list routes narrow BEFORE aggregating (D-13)", () => {
    it("GET /close-month/status: a SALONS-scoped manager's response excludes an out-of-scope employee", async () => {
      const inScope = await createEmployeeWithAccount("inscope-status");
      await createHome(inScope.employee.id, salonA.id);
      const outOfScope = await createEmployeeWithAccount("outscope-status");
      await createHome(outOfScope.employee.id, salonB.id);

      const manager = await createScopedManager("mgr-status", ["month-close:read:ZUGEWIESEN"], {
        scopeType: "SALONS",
        salonIds: [salonA.id],
      });
      const token = await login(manager.user.email);

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/overtime/close-month/status?year=2026&month=6",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const ids = (
        JSON.parse(res.body) as { employees: Array<{ employeeId: string }> }
      ).employees.map((e) => e.employeeId);
      expect(ids).toContain(inScope.employee.id);
      expect(ids).not.toContain(outOfScope.employee.id);
    });

    it("GET /close-month/year-status: adding an out-of-scope employee never changes a SALONS-scoped manager's month totals (before/after delta, robust against this suite's shared, accumulating tenant)", async () => {
      // Employees with no WorkSchedule are always "ready" (never "missing"), so they never appear
      // in any month's `missing[]` array regardless of scope — a string-containment check on the
      // out-of-scope employee's name/number would be VACUOUS here (passes whether or not scoping
      // works). `totalCount` is the field that DOES reflect every relevant employee whether or not
      // they're "missing" — but this suite's tenant accumulates employees across many `it` blocks
      // sharing one beforeAll, so comparing it to a fixed literal is unreliable. Comparing the SAME
      // manager's SAME month before/after creating the out-of-scope employee isolates exactly its
      // marginal effect, independent of how many other employees already exist in the tenant.
      const inScope = await createEmployeeWithAccount("inscope-yearstatus");
      await createHome(inScope.employee.id, salonA.id);

      const manager = await createScopedManager("mgr-yearstatus", ["month-close:read:ZUGEWIESEN"], {
        scopeType: "SALONS",
        salonIds: [salonA.id],
      });
      const token = await login(manager.user.email);

      const before = await app.inject({
        method: "GET",
        url: "/api/v1/overtime/close-month/year-status?year=2026",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(before.statusCode).toBe(200);
      const beforeBody = JSON.parse(before.body) as { months: Array<{ totalCount: number }> };

      const outOfScope = await createEmployeeWithAccount("outscope-yearstatus");
      await createHome(outOfScope.employee.id, salonB.id);

      const after = await app.inject({
        method: "GET",
        url: "/api/v1/overtime/close-month/year-status?year=2026",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(after.statusCode).toBe(200);
      const afterBody = JSON.parse(after.body) as { months: Array<{ totalCount: number }> };

      expect(afterBody.months.map((m) => m.totalCount)).toEqual(
        beforeBody.months.map((m) => m.totalCount),
      );
    });

    it("GET /close-month/deferred: a SALONS-scoped manager's response excludes an out-of-scope, genuinely-overdue employee", async () => {
      const inScope = await createEmployeeWithAccount("inscope-deferred");
      await createHome(inScope.employee.id, salonA.id);
      const outOfScope = await createEmployeeWithAccount("outscope-deferred");
      await createHome(outOfScope.employee.id, salonB.id);

      const manager = await createScopedManager("mgr-deferred", ["month-close:read:ZUGEWIESEN"], {
        scopeType: "SALONS",
        salonIds: [salonA.id],
      });
      const token = await login(manager.user.email);

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/overtime/close-month/deferred",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        employees: Array<{ employeeId: string }>;
      };
      const ids = body.employees.map((e) => e.employeeId);
      expect(ids).toContain(inScope.employee.id);
      expect(ids).not.toContain(outOfScope.employee.id);
    });

    it("GET /close-month/status: a TENANT-scope (wholeTenant) manager sees both employees — unaffected", async () => {
      const empA = await createEmployeeWithAccount("wholetenant-status-a");
      await createHome(empA.employee.id, salonA.id);
      const empB = await createEmployeeWithAccount("wholetenant-status-b");
      await createHome(empB.employee.id, salonB.id);

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/overtime/close-month/status?year=2026&month=6",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const ids = (
        JSON.parse(res.body) as { employees: Array<{ employeeId: string }> }
      ).employees.map((e) => e.employeeId);
      expect(ids).toContain(empA.employee.id);
      expect(ids).toContain(empB.employee.id);
    });
  });
});
