/**
 * Phase 91b Plan 04 (Issue #91), D-10/D-14 — every single-employee Berufsschule route and the
 * GET /upcoming list scope-check to the caller's Stammsalon-resolved reach the same way leave
 * requests and Section9 do. Scoping is Stammsalon-only (D-10) — no salonId column on any of these
 * models.
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

describe("Issue #91 (Phase 91b Plan 04) — Berufsschule salon/person scope", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };

  function uniqueSuffix(label: string): string {
    return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  async function createAzubi(label: string) {
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
        lastName: "BsScopeTest",
        hireDate: new Date("2020-01-01"),
        classification: "AZUBI",
        birthDate: new Date("2005-01-01"),
      },
    });
    return { user, employee };
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
        lastName: "BsScopeManager",
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

  function createBsAbsence(employeeId: string, date: string) {
    return app.prisma.absence.create({
      data: {
        employeeId,
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        startDate: new Date(date),
        endDate: new Date(date),
        days: 1,
        createdBy: "SYSTEM",
      },
    });
  }

  async function createScopedManager(
    label: string,
    permissions: string[],
    scope: { scopeType: "SALONS" | "PERSONS"; salonIds?: string[]; employeeIds?: string[] },
  ) {
    // A real Employee row is required — the login handler derives the JWT's tenantId from
    // `user.employee?.tenantId ?? ""`, so a bare User (no linked Employee) gets an EMPTY tenantId,
    // which makes every RoleAssignment lookup below miss and silently fall back to the legacy-role
    // system role (EMPLOYEE), never granting the permission this manager needs.
    const { user } = await createManagerEmployee(label);
    const name = `BsScope ${crypto.randomBytes(3).toString("hex")}`;
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
    data = await seedTestData(app, "bssc");
    salonA = await createTestSalon(app.prisma, data.tenant.id, { name: "BSSC Salon A" });
    salonB = await createTestSalon(app.prisma, data.tenant.id, { name: "BSSC Salon B" });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("GET /upcoming: a SALONS-scoped manager excludes an out-of-scope employee's BS day", async () => {
    const inScope = await createAzubi("inscope-upcoming");
    await createHome(inScope.employee.id, salonA.id);
    const inScopeAbsence = await createBsAbsence(inScope.employee.id, "2026-08-01");

    const outOfScope = await createAzubi("outscope-upcoming");
    await createHome(outOfScope.employee.id, salonB.id);
    const outOfScopeAbsence = await createBsAbsence(outOfScope.employee.id, "2026-08-01");

    const manager = await createScopedManager(
      "mgr-upcoming",
      ["vocational-school:read:ZUGEWIESEN"],
      { scopeType: "SALONS", salonIds: [salonA.id] },
    );
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/vocational-school/upcoming?from=2026-07-01&to=2026-09-01",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const ids = (JSON.parse(res.body) as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain(inScopeAbsence.id);
    expect(ids).not.toContain(outOfScopeAbsence.id);
  });

  it("GET /upcoming: an out-of-scope explicit ?employeeId yields an empty result, not that employee's history", async () => {
    const outOfScope = await createAzubi("outscope-upcoming-explicit");
    await createHome(outOfScope.employee.id, salonB.id);
    const outOfScopeAbsence = await createBsAbsence(outOfScope.employee.id, "2026-08-02");

    const manager = await createScopedManager(
      "mgr-upcoming-explicit",
      ["vocational-school:read:ZUGEWIESEN"],
      { scopeType: "SALONS", salonIds: [salonA.id] },
    );
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/vocational-school/upcoming?from=2026-07-01&to=2026-09-01&employeeId=${outOfScope.employee.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const ids = (JSON.parse(res.body) as Array<{ id: string }>).map((r) => r.id);
    expect(ids).not.toContain(outOfScopeAbsence.id);
  });

  it("POST /manual-insert: an out-of-scope AZUBI 404s byte-identically to a nonexistent employeeId, with SCOPE_ACCESS_DENIED audit", async () => {
    const outOfScope = await createAzubi("outscope-manual-insert");
    await createHome(outOfScope.employee.id, salonB.id);

    const manager = await createScopedManager(
      "mgr-manual-insert",
      ["vocational-school:manage:ZUGEWIESEN"],
      { scopeType: "SALONS", salonIds: [salonA.id] },
    );
    const token = await login(manager.user.email);

    const nonExistentRes = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/manual-insert",
      headers: { authorization: `Bearer ${token}` },
      payload: { employeeId: "00000000-0000-0000-0000-000000000000", date: "2026-08-03" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/manual-insert",
      headers: { authorization: `Bearer ${token}` },
      payload: { employeeId: outOfScope.employee.id, date: "2026-08-03" },
    });

    expect(res.statusCode).toBe(nonExistentRes.statusCode);
    expect(res.body).toBe(nonExistentRes.body);
    expect(res.statusCode).toBe(404);

    const audit = await app.prisma.auditLog.findFirst({
      where: {
        action: "SCOPE_ACCESS_DENIED",
        entity: "Employee",
        entityId: outOfScope.employee.id,
      },
    });
    expect(audit).not.toBeNull();
  });

  it("POST /manual-insert: an in-scope AZUBI still succeeds (no regression)", async () => {
    const inScope = await createAzubi("inscope-manual-insert");
    await createHome(inScope.employee.id, salonA.id);

    const manager = await createScopedManager(
      "mgr-manual-insert-inscope",
      ["vocational-school:manage:ZUGEWIESEN"],
      { scopeType: "SALONS", salonIds: [salonA.id] },
    );
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/manual-insert",
      headers: { authorization: `Bearer ${token}` },
      payload: { employeeId: inScope.employee.id, date: "2026-08-04" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("DELETE /:absenceId: an out-of-scope BS day 404s with SCOPE_ACCESS_DENIED audit", async () => {
    const outOfScope = await createAzubi("outscope-delete");
    await createHome(outOfScope.employee.id, salonB.id);
    const absence = await createBsAbsence(outOfScope.employee.id, "2026-08-05");

    const manager = await createScopedManager(
      "mgr-delete-salons",
      ["vocational-school:manage:ZUGEWIESEN"],
      { scopeType: "SALONS", salonIds: [salonA.id] },
    );
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/vocational-school/${absence.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(JSON.stringify({ error: "Berufsschultag nicht gefunden" }));

    const audit = await app.prisma.auditLog.findFirst({
      where: { action: "SCOPE_ACCESS_DENIED", entity: "Absence", entityId: absence.id },
    });
    expect(audit).not.toBeNull();
  });

  it("GET /retroactive-preview: an out-of-scope employee 404s with SCOPE_ACCESS_DENIED audit", async () => {
    const outOfScope = await createAzubi("outscope-retro-preview");
    await createHome(outOfScope.employee.id, salonB.id);

    const manager = await createScopedManager(
      "mgr-retro-preview",
      ["vocational-school:manage:ZUGEWIESEN"],
      { scopeType: "SALONS", salonIds: [salonA.id] },
    );
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/vocational-school/retroactive-preview?employeeId=${outOfScope.employee.id}`,
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

  it("POST /retroactive-apply: an out-of-scope employee 404s with SCOPE_ACCESS_DENIED audit", async () => {
    const outOfScope = await createAzubi("outscope-retro-apply");
    await createHome(outOfScope.employee.id, salonB.id);

    const manager = await createScopedManager(
      "mgr-retro-apply",
      ["vocational-school:manage:ZUGEWIESEN"],
      { scopeType: "SALONS", salonIds: [salonA.id] },
    );
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/retroactive-apply",
      headers: { authorization: `Bearer ${token}` },
      payload: { employeeId: outOfScope.employee.id },
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

  it("GET /:id/vocational-school-pattern: an out-of-scope employee 404s with SCOPE_ACCESS_DENIED audit", async () => {
    const outOfScope = await createAzubi("outscope-pattern-get");
    await createHome(outOfScope.employee.id, salonB.id);

    const manager = await createScopedManager(
      "mgr-pattern-get",
      ["vocational-school:read:ZUGEWIESEN"],
      { scopeType: "SALONS", salonIds: [salonA.id] },
    );
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/employees/${outOfScope.employee.id}/vocational-school-pattern`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);

    const audit = await app.prisma.auditLog.findFirst({
      where: {
        action: "SCOPE_ACCESS_DENIED",
        entity: "Employee",
        entityId: outOfScope.employee.id,
      },
    });
    expect(audit).not.toBeNull();
  });

  it("PUT /:id/vocational-school-pattern: an out-of-scope employee 404s with SCOPE_ACCESS_DENIED audit", async () => {
    const outOfScope = await createAzubi("outscope-pattern-put");
    await createHome(outOfScope.employee.id, salonB.id);

    const manager = await createScopedManager(
      "mgr-pattern-put",
      ["vocational-school:manage:ZUGEWIESEN"],
      { scopeType: "SALONS", salonIds: [salonA.id] },
    );
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/employees/${outOfScope.employee.id}/vocational-school-pattern`,
      headers: { authorization: `Bearer ${token}` },
      payload: { patterns: [{ daysOfWeek: [1], validFrom: "2026-08-01" }] },
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

  it("a TENANT-scope (wholeTenant) manager is unaffected by any of the above scope checks", async () => {
    const emp = await createAzubi("wholetenant-bs");
    await createHome(emp.employee.id, salonB.id);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/employees/${emp.employee.id}/vocational-school-pattern`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
