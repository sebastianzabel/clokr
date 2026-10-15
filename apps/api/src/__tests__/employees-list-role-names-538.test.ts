/**
 * Issue #538 - `GET /api/v1/employees` carries `roleNames` per person: the assigned role names
 * (stored assignments, legacy-role fallback when none is stored - the same derivation as
 * `GET /me/context` `roles`), but ONLY for a caller holding `role-assignment:manage`; every other
 * caller gets `null` on every row, never a fabricated list. The web shows the role chip, filter
 * and counts from this field alone (the compat `User.role` column is removed with #539).
 *
 * No person names in fixtures.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { normalizeRolePermissions, roleNameKey, SYSTEM_ROLE_IDS } from "../contexts/platform";

const PASSWORD = "test1234";

type Row = { id: string; user: { email: string }; roleNames: string[] | null };

describe("Issue #538 - GET /employees roleNames", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let foreign: Awaited<ReturnType<typeof seedTestData>>;
  const customName = `Rn538 ${crypto.randomBytes(3).toString("hex")}`;
  type Person = { id: string; userId: string; email: string };
  let stored: Person;
  let fallback: Person;
  let reader: Person;

  async function person(label: string, tenantId = data.tenant.id) {
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

  async function assign(userId: string, roleId: string, tenantId = data.tenant.id) {
    await app.prisma.roleAssignment.create({
      data: {
        tenantId,
        userId,
        accessRoleId: roleId,
        scopeType: "TENANT",
        salonIds: [],
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

  async function list(token: string): Promise<Row[]> {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/employees",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as Row[];
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "rn538");
    foreign = await seedTestData(app, "rn538f");

    const custom = await app.prisma.accessRole.create({
      data: {
        tenantId: data.tenant.id,
        name: customName,
        nameKey: roleNameKey(customName),
        permissions: normalizeRolePermissions(["time-entry:read:EIGENE"]),
      },
    });
    stored = await person("rn538-stored");
    await assign(stored.userId, custom.id);
    await assign(stored.userId, SYSTEM_ROLE_IDS.SALON_MANAGER);
    fallback = await person("rn538-fallback");

    // A reader that may list employees but does not manage role assignments.
    reader = await person("rn538-reader");
    const readerName = `Rn538 reader ${crypto.randomBytes(3).toString("hex")}`;
    const readerRole = await app.prisma.accessRole.create({
      data: {
        tenantId: data.tenant.id,
        name: readerName,
        nameKey: roleNameKey(readerName),
        permissions: normalizeRolePermissions(["employee:read:ZUGEWIESEN"]),
      },
    });
    await assign(reader.userId, readerRole.id);
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
    await cleanupTestData(app, foreign.tenant.id);
    await closeTestApp();
  });

  it("a role-assignment manager sees the assigned names, distinct and sorted", async () => {
    const rows = await list(data.adminToken);
    const row = rows.find((r) => r.id === stored.id);
    expect(row?.roleNames).toEqual(
      [customName, "Salonmanager"].sort((a, b) => a.localeCompare(b, "de")),
    );
  });

  it("a person without a stored assignment shows the system role of the legacy column", async () => {
    const rows = await list(data.adminToken);
    expect(rows.find((r) => r.id === fallback.id)?.roleNames).toEqual(["Mitarbeiter"]);
    for (const r of rows) expect(Array.isArray(r.roleNames), r.id).toBe(true);
  });

  it("a caller without role-assignment:manage gets null on every row", async () => {
    const rows = await list(await login(reader.email));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.roleNames, r.id).toBeNull();
  });

  it("the foreign tenant is unaffected: its list never carries this tenant's role names", async () => {
    const rows = await list(foreign.adminToken);
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(customName);
    expect(rows.some((r) => r.id === stored.id)).toBe(false);
  });
});
