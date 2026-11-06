/**
 * Issue #836 (T-836-06) — `accessRoleIdsByUserId`: the stored role ids of many users in ONE query,
 * the read the leave-limit group membership uses (D-836-05, D-836-22).
 *
 * Fixture: two tenants (own seeds). User X of tenant 1 holds the system role EMPLOYEE (seeded) and a
 * customer role of tenant 1; user Y of tenant 2 holds the system role EMPLOYEE. A customer role of
 * tenant 2 is assigned (by direct row) to a tenant 1 user to prove the tenant-or-system filter.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { SYSTEM_ROLE_IDS } from "..";
import { accessRoleIdsByUserId } from "../facade/role-assignments";
import { roleNameKey } from "../access-role";

describe("accessRoleIdsByUserId (Issue #836)", () => {
  let app: FastifyInstance;
  let one: Awaited<ReturnType<typeof seedTestData>>;
  let two: Awaited<ReturnType<typeof seedTestData>>;
  let customRoleOne: string;
  let customRoleTwo: string;

  async function customRole(tenantId: string, name: string): Promise<string> {
    const role = await app.prisma.accessRole.create({
      data: { tenantId, name, nameKey: roleNameKey(name), permissions: [] },
    });
    return role.id;
  }

  beforeAll(async () => {
    app = await getTestApp();
    one = await seedTestData(app, "ar836a");
    two = await seedTestData(app, "ar836b");
    customRoleOne = await customRole(one.tenant.id, `Role836 ${Date.now().toString(36)}`);
    customRoleTwo = await customRole(two.tenant.id, `Role836 ${Date.now().toString(36)}x`);
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: one.tenant.id,
        userId: one.empUser.id,
        accessRoleId: customRoleOne,
        scopeType: "SALONS",
        salonIds: [one.salonId],
        employeeIds: [],
      },
    });
    // A foreign tenant's role on a tenant 1 user: must never be returned for tenant 1.
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: one.tenant.id,
        userId: one.adminUser.id,
        accessRoleId: customRoleTwo,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
  });

  afterAll(async () => {
    await app.prisma.roleAssignment.deleteMany({
      where: { accessRoleId: { in: [customRoleOne, customRoleTwo] } },
    });
    await app.prisma.accessRole.deleteMany({
      where: { id: { in: [customRoleOne, customRoleTwo] } },
    });
    await cleanupTestData(app, one.tenant.id);
    await cleanupTestData(app, two.tenant.id);
  });

  it("returns the system role and the tenant role of a user, any scope", async () => {
    const result = await accessRoleIdsByUserId(app.prisma, one.tenant.id, [one.empUser.id]);
    expect(result.get(one.empUser.id)).toEqual(new Set([SYSTEM_ROLE_IDS.EMPLOYEE, customRoleOne]));
  });

  it("never returns a role of another tenant", async () => {
    const result = await accessRoleIdsByUserId(app.prisma, one.tenant.id, [one.adminUser.id]);
    const ids = result.get(one.adminUser.id) ?? new Set<string>();
    expect(ids.has(customRoleTwo)).toBe(false);
    expect(ids.has(SYSTEM_ROLE_IDS.ADMIN)).toBe(true);
  });

  it("a user of another tenant gets an empty set, an unknown id too", async () => {
    const result = await accessRoleIdsByUserId(app.prisma, one.tenant.id, [
      two.empUser.id,
      "00000000-0000-0000-0000-000000000000",
    ]);
    expect(result.get(two.empUser.id)).toEqual(new Set());
    expect(result.get("00000000-0000-0000-0000-000000000000")).toEqual(new Set());
  });

  it("an empty input returns an empty map with zero queries", async () => {
    const spy = vi.spyOn(app.prisma.roleAssignment, "findMany");
    const result = await accessRoleIdsByUserId(app.prisma, one.tenant.id, []);
    expect(result.size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("reads once for any number of users", async () => {
    const spy = vi.spyOn(app.prisma.roleAssignment, "findMany");
    await accessRoleIdsByUserId(app.prisma, one.tenant.id, [
      one.empUser.id,
      one.adminUser.id,
      two.empUser.id,
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
