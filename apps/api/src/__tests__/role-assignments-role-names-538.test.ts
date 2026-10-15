/**
 * Issue #538 - `GET /api/v1/role-assignments/role-names` returns the assigned role names per user
 * (one derivation with `GET /me/context` `roles`), for the role chip of the employee list. It is
 * guarded by `role-assignment:manage`, a Mandant-reference permission: only a whole-tenant holder
 * passes, a salon-scoped holder and a caller without it get 403. Anonymized employees and other
 * tenants never appear.
 *
 * No person names in fixtures.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { normalizeRolePermissions, roleNameKey, SYSTEM_ROLE_IDS } from "../contexts/platform";

const PASSWORD = "test1234";

describe("Issue #538 - GET /role-assignments/role-names", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let foreign: Awaited<ReturnType<typeof seedTestData>>;
  type Person = { id: string; userId: string; email: string };
  let stored: Person;
  let fallback: Person;
  let anonymized: Person;
  let foreignPerson: Person;
  let plain: Person;
  let scopedHolder: Person;
  const customName = `Rn538 ${crypto.randomBytes(3).toString("hex")}`;

  async function person(label: string, tenantId = data.tenant.id): Promise<Person> {
    const s = `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `${s}@test.de`,
        passwordHash: await bcrypt.hash(PASSWORD, 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: label,
        lastName: "RoleNames538",
        hireDate: new Date("2020-01-01"),
      },
    });
    return { id: employee.id, userId: user.id, email: user.email };
  }

  async function customRole(name: string, permissions: string[]) {
    return app.prisma.accessRole.create({
      data: {
        tenantId: data.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions(permissions),
      },
    });
  }

  function assign(
    userId: string,
    roleId: string,
    scopeType: "TENANT" | "SALONS" = "TENANT",
    salonIds: string[] = [],
  ) {
    return app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId,
        accessRoleId: roleId,
        scopeType,
        salonIds,
        employeeIds: [],
      },
    });
  }

  async function login(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode, res.body).toBe(200);
    return (JSON.parse(res.body) as { accessToken: string }).accessToken;
  }

  function get(token: string) {
    return app.inject({
      method: "GET",
      url: "/api/v1/role-assignments/role-names",
      headers: { authorization: `Bearer ${token}` },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "rn538");
    foreign = await seedTestData(app, "rn538f");
    const salon = await createTestSalon(app.prisma, data.tenant.id, { name: "RN538 Salon" });

    stored = await person("rn538-stored");
    const custom = await customRole(customName, ["time-entry:read:EIGENE"]);
    await assign(stored.userId, custom.id);
    await assign(stored.userId, SYSTEM_ROLE_IDS.SALON_MANAGER);
    fallback = await person("rn538-fallback");

    anonymized = await person("rn538-anon");
    await app.prisma.employee.update({
      where: { id: anonymized.id },
      data: { firstName: "Gelöscht", lastName: "GELÖSCHT-538" },
    });
    foreignPerson = await person("rn538-foreign", foreign.tenant.id);

    plain = await person("rn538-plain");
    const reader = await customRole(`Rn538 reader ${crypto.randomBytes(3).toString("hex")}`, [
      "employee:read:ZUGEWIESEN",
    ]);
    await assign(plain.userId, reader.id);

    scopedHolder = await person("rn538-scoped");
    const scopedRole = await customRole(`Rn538 scoped ${crypto.randomBytes(3).toString("hex")}`, [
      "role-assignment:manage:ZUGEWIESEN",
    ]);
    await assign(scopedHolder.userId, scopedRole.id, "SALONS", [salon.id]);
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
    await cleanupTestData(app, foreign.tenant.id);
    await closeTestApp();
  });

  it("a whole-tenant holder sees sorted names per user, the legacy fallback included", async () => {
    const res = await get(data.adminToken);
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as { roleNames: Record<string, string[]> };
    expect(body.roleNames[stored.userId]).toEqual(
      [customName, "Salonmanager"].sort((a, b) => a.localeCompare(b, "de")),
    );
    expect(body.roleNames[fallback.userId]).toEqual(["Mitarbeiter"]);
  });

  it("neither anonymized people nor another tenant's users appear", async () => {
    const body = JSON.parse((await get(data.adminToken)).body) as {
      roleNames: Record<string, string[]>;
    };
    expect(Object.keys(body.roleNames)).not.toContain(anonymized.userId);
    expect(Object.keys(body.roleNames)).not.toContain(foreignPerson.userId);
    const foreignBody = JSON.parse((await get(foreign.adminToken)).body) as {
      roleNames: Record<string, string[]>;
    };
    expect(Object.keys(foreignBody.roleNames)).toContain(foreignPerson.userId);
    expect(JSON.stringify(foreignBody)).not.toContain(customName);
    expect(Object.keys(foreignBody.roleNames)).not.toContain(stored.userId);
  });

  it("a caller without role-assignment:manage gets 403", async () => {
    expect((await get(await login(plain.email))).statusCode).toBe(403);
  });

  it("a salon-scoped holder of the permission does not pass (the resource is whole-tenant)", async () => {
    expect((await get(await login(scopedHolder.email))).statusCode).toBe(403);
  });

  it("an unauthenticated request gets 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/role-assignments/role-names" });
    expect(res.statusCode).toBe(401);
  });
});
