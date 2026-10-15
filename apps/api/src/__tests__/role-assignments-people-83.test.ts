/**
 * Issue #83 (D-04) — `GET /api/v1/role-assignments/people` lists the tenant's people by name for
 * the assignee and person-scope pickers of the role-assignment UI. A `role-assignment:manage`
 * holder need not hold `employee:read`, yet must see the people it assigns roles to and the
 * people a PERSONS scope names. Data minimisation (Art. 5 Abs. 1 lit. c DSGVO): ids, first and last
 * name and whether the user account is active — nothing else. Anonymized employees and other
 * tenants never appear.
 *
 * No person names in fixtures (labels only).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  tokenWithoutSignIn,
} from "./setup";
import { SYSTEM_ROLE_IDS, normalizeRolePermissions, roleNameKey } from "../contexts/platform";

const PASSWORD = "test1234";
const byText = (a: string, b: string) => a.localeCompare(b);

type Person = {
  employeeId: string;
  userId: string;
  firstName: string;
  lastName: string;
  isActive: boolean;
};

describe("Issue #83 — GET /api/v1/role-assignments/people", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let foreign: Awaited<ReturnType<typeof seedTestData>>;
  let inactiveEmployeeId: string;
  let anonymizedEmployeeId: string;
  let managerRoleId: string;

  function uniqueSuffix(label: string): string {
    return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  async function createEmployee(
    firstName: string,
    lastName: string,
    opts: { isActive?: boolean; tenantId?: string } = {},
  ) {
    const s = uniqueSuffix("ppl");
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await app.prisma.user.create({
      data: {
        email: `${s}@test.de`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: opts.isActive ?? true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: opts.tenantId ?? data.tenant.id,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName,
        lastName,
        hireDate: new Date("2024-01-01"),
      },
    });
    return { user, employee };
  }

  function assign(userId: string, accessRoleId: string, scopeType: "TENANT" | "SALONS") {
    return app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId,
        accessRoleId,
        scopeType,
        salonIds: scopeType === "SALONS" ? [data.salonId] : [],
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

  function people(token?: string) {
    return app.inject({
      method: "GET",
      url: "/api/v1/role-assignments/people",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "rui83-ppl");
    foreign = await seedTestData(app, "rui83-pplf");
    await createEmployee("Probe-B", "Rui83-Zett");
    await createEmployee("Probe-B", "Rui83-Aal");
    await createEmployee("Probe-A", "Rui83-Aal");
    inactiveEmployeeId = (await createEmployee("Probe-I", "Rui83-Inaktiv", { isActive: false }))
      .employee.id;
    anonymizedEmployeeId = (await createEmployee("Gelöscht", "GELÖSCHT-RUI83")).employee.id;
    await createEmployee("Probe-F", "Rui83-Fremd", { tenantId: foreign.tenant.id });
    const name = `Rui83 ${crypto.randomBytes(3).toString("hex")}`;
    managerRoleId = (
      await app.prisma.accessRole.create({
        data: {
          tenantId: data.tenant.id,
          name,
          nameKey: roleNameKey(name),
          permissions: normalizeRolePermissions(["role-assignment:manage:ZUGEWIESEN"]),
        },
      })
    ).id;
  });

  afterAll(async () => {
    try {
      for (const t of [data, foreign]) {
        await app.prisma.roleAssignment.deleteMany({ where: { tenantId: t.tenant.id } });
        await app.prisma.accessRole.deleteMany({ where: { tenantId: t.tenant.id } });
      }
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, foreign.tenant.id);
    } catch (err) {
      console.error("role-assignments-people-83 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("tracer: the tenant's non-anonymized people, names only, sorted by name", async () => {
    const res = await people(data.adminToken);
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as Person[];
    const expected = await app.prisma.employee.findMany({
      where: { tenantId: data.tenant.id, NOT: { id: anonymizedEmployeeId } },
      select: { id: true },
    });
    expect(body.map((p) => p.employeeId).sort(byText)).toEqual(
      expected.map((e) => e.id).sort(byText),
    );
    for (const person of body) {
      expect(Object.keys(person).sort(byText)).toEqual([
        "employeeId",
        "firstName",
        "isActive",
        "lastName",
        "userId",
      ]);
    }
    const sorted = [...body].sort(
      (a, b) =>
        a.lastName.localeCompare(b.lastName, "de") ||
        a.firstName.localeCompare(b.firstName, "de") ||
        a.employeeId.localeCompare(b.employeeId),
    );
    expect(body).toEqual(sorted);
    const aal = body.filter((p) => p.lastName === "Rui83-Aal").map((p) => p.firstName);
    expect(aal).toEqual(["Probe-A", "Probe-B"]);
  });

  it("marks an inactive user account and never lists anonymized or foreign people", async () => {
    const body = JSON.parse((await people(data.adminToken)).body) as Person[];
    expect(body.find((p) => p.employeeId === inactiveEmployeeId)?.isActive).toBe(false);
    expect(body.some((p) => p.employeeId === anonymizedEmployeeId)).toBe(false);
    expect(body.some((p) => p.lastName === "Rui83-Fremd")).toBe(false);
  });

  it("a role-assignment:manage holder without employee:read gets the same list", async () => {
    const { user } = await createEmployee("Probe-Z", "Rui83");
    await assign(user.id, managerRoleId, "TENANT");
    const res = await people(await login(user.email));
    expect(res.statusCode, res.body).toBe(200);
    const admin = JSON.parse((await people(data.adminToken)).body) as Person[];
    expect(JSON.parse(res.body)).toEqual(admin);
  });

  it("HR (employee:read, no role-assignment:manage), a stored Manager and a user with no stored assignment get 403", async () => {
    const { user: hr } = await createEmployee("Probe-H", "Rui83");
    await assign(hr.id, SYSTEM_ROLE_IDS.HR, "TENANT");
    expect((await people(await login(hr.email))).statusCode).toBe(403);

    // The system Manager role does not hold role-assignment:manage either (was: a "fallback
    // MANAGER" through the legacy column; since #539 the role must be stored to count at all).
    const { user: storedManager } = await createEmployee("Probe-M", "Rui83");
    await assign(storedManager.id, SYSTEM_ROLE_IDS.MANAGER, "TENANT");
    expect((await people(await login(storedManager.email))).statusCode).toBe(403);

    // #539: a user whose legacy column says MANAGER but who has no stored assignment holds nothing.
    const s = uniqueSuffix("mgr");
    const manager = await app.prisma.user.create({
      data: {
        email: `${s}@test.de`,
        passwordHash: await bcrypt.hash(PASSWORD, 10),
        role: "MANAGER",
        isActive: true,
      },
    });
    await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: manager.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: "Probe-N",
        lastName: "Rui83",
        hireDate: new Date("2024-01-01"),
      },
    });
    // It cannot sign in since #539 (D-14): the token is signed directly (see tokenWithoutSignIn).
    expect((await people(await tokenWithoutSignIn(app, manager.email))).statusCode).toBe(403);
  });

  it("the managing role at SALONS scope gets 403 (MANDANT relation), no token 401", async () => {
    const { user } = await createEmployee("Probe-S", "Rui83");
    await assign(user.id, managerRoleId, "SALONS");
    // A SALONS assignment of a whole-tenant key holds nothing, so no sign-in since #539 (D-14).
    expect((await people(await tokenWithoutSignIn(app, user.email))).statusCode).toBe(403);
    expect((await people()).statusCode).toBe(401);
  });
});
