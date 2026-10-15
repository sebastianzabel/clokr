/**
 * Issue #539 (Release A), D-09 — the fixture mechanism behind the removal of the legacy-role
 * fallback: `grantSystemRole()` gives a fixture user its system role as a STORED tenant
 * assignment.
 *
 * What this file protects: a fixture user that holds its role through the helper must resolve to
 * exactly what the production creation path produces (`POST /api/v1/employees` writes the
 * assignment through `replaceSystemRoleAssignment`), and — as long as the fallback still exists —
 * exactly what an unassigned user of the same role resolved to. A helper that granted more or
 * less than either would make every test that uses the shared seed prove the wrong thing.
 *
 * Five answers are compared per system role: effective permission keys, the reach for every
 * ZUGEWIESEN key, membership in the recipient lists, the managed salons of the salon context and
 * the displayed role names.
 *
 * Fixtures: synthetic `@example.invalid` addresses only, no person names.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  grantSystemRole,
  removeFixtureRoleAssignments,
  type LegacySystemRoleName,
} from "./setup";
import {
  PERMISSIONS,
  permissionKey,
  resolveAccessReach,
  userIdsHoldingPermission,
  SYSTEM_ROLE_IDS,
  type AccessContext,
  type PermissionKey,
} from "../contexts/platform";
import { contextSalonIds, roleNamesByUserId } from "../contexts/platform/facade/role-assignments";
import { effectivePermissionKeysForUser } from "../contexts/platform/request-permissions";

const PASSWORD = "Test@1234567!";
const ROLES: readonly LegacySystemRoleName[] = ["ADMIN", "MANAGER", "EMPLOYEE"];
const ZUGEWIESEN_KEYS: PermissionKey[] = PERMISSIONS.filter((p) => p.reach === "ZUGEWIESEN").map(
  permissionKey,
);
const TODAY = new Date("2026-06-15T10:00:00.000Z");

type Seed = Awaited<ReturnType<typeof seedTestData>>;

describe("fixture role assignments (#539, D-09)", () => {
  let app: FastifyInstance;
  let seed: Seed;
  let remoteCounter = 0;
  const personIds: string[] = [];

  function nextRemoteAddress(): string {
    const n = remoteCounter++;
    return `10.239.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`;
  }

  /** A user + employee created directly (the way fixtures do), with the legacy column set. */
  async function createPlainPerson(label: string, role: LegacySystemRoleName) {
    const s = `${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const email = `fx539-${label}-${s}@example.invalid`;
    const user = await app.prisma.user.create({
      data: { email, passwordHash, role, isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: seed.tenant.id,
        userId: user.id,
        employeeNumber: `FX-${s}`.slice(0, 20),
        firstName: label,
        lastName: "Fixture",
        hireDate: new Date("2024-01-01"),
      },
    });
    personIds.push(user.id);
    return { user, employee, email };
  }

  /** A user created through the production path (the seed admin creates it). */
  async function createThroughApi(label: string, role: LegacySystemRoleName) {
    const uid = randomBytes(4).toString("hex");
    const email = `fx539-api-${label}-${uid}@example.invalid`;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/employees",
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: {
        usualWorkDays: [1, 2, 3, 4, 5],
        email,
        firstName: label,
        lastName: "Fixture",
        employeeNumber: `FA-${uid}`,
        hireDate: "2026-01-01T00:00:00.000Z",
        role,
        password: PASSWORD,
      },
    });
    expect(res.statusCode).toBe(201);
    const user = await app.prisma.user.findUniqueOrThrow({ where: { email } });
    personIds.push(user.id);
    return { user, email };
  }

  async function login(email: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: PASSWORD },
      remoteAddress: nextRemoteAddress(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      accessToken: string;
      user: { permissions: string[] };
    };
    return { accessToken: body.accessToken, permissions: body.user.permissions };
  }

  function ctxFor(userId: string): AccessContext {
    return {
      tenantId: seed.tenant.id,
      actor: { kind: "user", userId },
      reach: { kind: "wholeTenant" },
    };
  }

  /** The five answers the fallback and a stored assignment must agree on. */
  async function profileOf(userId: string) {
    const prisma = app.prisma;
    const tenantId = seed.tenant.id;
    const keys = await effectivePermissionKeysForUser(prisma, userId, tenantId);
    const reach: Record<string, unknown> = {};
    const recipient: Record<string, boolean> = {};
    for (const key of ZUGEWIESEN_KEYS) {
      reach[key] = await resolveAccessReach(prisma, ctxFor(userId), key);
      recipient[key] = (await userIdsHoldingPermission(prisma, tenantId, key)).includes(userId);
    }
    const context = await contextSalonIds(prisma, ctxFor(userId), TODAY);
    const names = (await roleNamesByUserId(prisma, tenantId, [userId])).get(userId);
    return { keys, reach, recipient, managedSalonIds: context.managedSalonIds, names };
  }

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "539-eq");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, seed.tenant.id);
    } catch (error) {
      console.error("fixture-role-assignments-539 cleanup failed", error);
    }
    await closeTestApp();
  });

  it("the walked role set and the catalog slice are not empty (anti-vacuity)", () => {
    expect(ROLES.length).toBe(3);
    expect(ZUGEWIESEN_KEYS.length).toBeGreaterThan(0);
  });

  it("seedTestData hands out its two users with exactly one stored TENANT assignment each", async () => {
    const rows = await app.prisma.roleAssignment.findMany({
      where: { userId: { in: [seed.adminUser.id, seed.empUser.id] } },
      select: { userId: true, accessRoleId: true, scopeType: true, tenantId: true },
    });
    const byUser = new Map(rows.map((row) => [row.userId, row]));
    expect(rows).toHaveLength(2);
    expect(byUser.get(seed.adminUser.id)).toMatchObject({
      accessRoleId: SYSTEM_ROLE_IDS.ADMIN,
      scopeType: "TENANT",
      tenantId: seed.tenant.id,
    });
    expect(byUser.get(seed.empUser.id)).toMatchObject({
      accessRoleId: SYSTEM_ROLE_IDS.EMPLOYEE,
      scopeType: "TENANT",
      tenantId: seed.tenant.id,
    });
    expect(seed.adminToken).toBeTruthy();
    expect(seed.empToken).toBeTruthy();
  });

  it("grantSystemRole is idempotent and writes no audit row; removeFixtureRoleAssignments empties the user", async () => {
    const person = await createPlainPerson("idem", "MANAGER");
    const first = await grantSystemRole(app.prisma, {
      tenantId: seed.tenant.id,
      userId: person.user.id,
      role: "MANAGER",
    });
    const second = await grantSystemRole(app.prisma, {
      tenantId: seed.tenant.id,
      userId: person.user.id,
      role: "MANAGER",
    });
    expect(second).toBe(first);
    const rows = await app.prisma.roleAssignment.findMany({ where: { userId: person.user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      accessRoleId: SYSTEM_ROLE_IDS.MANAGER,
      scopeType: "TENANT",
      salonIds: [],
      employeeIds: [],
    });
    const audits = await app.prisma.auditLog.count({
      where: { entity: "RoleAssignment", entityId: first },
    });
    expect(audits).toBe(0);

    await removeFixtureRoleAssignments(app.prisma, [person.user.id]);
    expect(await app.prisma.roleAssignment.count({ where: { userId: person.user.id } })).toBe(0);
  });

  for (const role of ROLES) {
    describe(`system role ${role}`, () => {
      it("helper-granted == created through POST /employees: keys, reach, recipients, managed salons, names", async () => {
        const granted = await createPlainPerson(`gr-${role.toLowerCase()}`, role);
        await grantSystemRole(app.prisma, {
          tenantId: seed.tenant.id,
          userId: granted.user.id,
          role,
        });
        const viaApi = await createThroughApi(role.toLowerCase(), role);

        const a = await profileOf(granted.user.id);
        const b = await profileOf(viaApi.user.id);
        expect(a).toEqual(b);
        // Non-vacuity: the profile says something about the role.
        expect(a.names).toHaveLength(1);
        if (role === "ADMIN") expect(a.keys.length).toBeGreaterThan(0);
      });

      it("login of the helper-granted user returns the same permissions as the API-created one, and a guarded request passes", async () => {
        const granted = await createPlainPerson(`lg-${role.toLowerCase()}`, role);
        await grantSystemRole(app.prisma, {
          tenantId: seed.tenant.id,
          userId: granted.user.id,
          role,
        });
        const viaApi = await createThroughApi(`lg-${role.toLowerCase()}`, role);

        const a = await login(granted.email);
        const b = await login(viaApi.email);
        expect(a.permissions).toEqual(b.permissions);
        expect(a.permissions.length).toBeGreaterThan(0);

        if (role === "EMPLOYEE") {
          const res = await app.inject({
            method: "GET",
            url: `/api/v1/time-entries?employeeId=${granted.employee.id}&from=2026-01-01&to=2026-01-31`,
            headers: { authorization: `Bearer ${a.accessToken}` },
          });
          expect(res.statusCode).toBe(200);
        } else {
          const res = await app.inject({
            method: "GET",
            url: "/api/v1/employees",
            headers: { authorization: `Bearer ${a.accessToken}` },
          });
          expect(res.statusCode).toBe(200);
        }
      });
    });
  }

  // Rewritten by #539 plan 07 together with the fallback it describes.
  describe("while the fallback exists — rewritten by #539 plan 07", () => {
    for (const role of ROLES) {
      it(`an unassigned ${role} user resolves to exactly what a helper-granted one does`, async () => {
        const granted = await createPlainPerson(`fbg-${role.toLowerCase()}`, role);
        await grantSystemRole(app.prisma, {
          tenantId: seed.tenant.id,
          userId: granted.user.id,
          role,
        });
        const unassigned = await createPlainPerson(`fbu-${role.toLowerCase()}`, role);
        expect(
          await app.prisma.roleAssignment.count({ where: { userId: unassigned.user.id } }),
        ).toBe(0);

        const a = await profileOf(granted.user.id);
        const c = await profileOf(unassigned.user.id);
        expect(c).toEqual(a);
      });
    }
  });
});
