/**
 * Issue #83 (D-02, D-03) — `GET /api/v1/roles/permission-catalog` serves the permission catalog
 * with its German labels for the role editor: every catalog key exactly once, in catalog order,
 * grouped by resource, each with its reach and relation (a MANDANT permission takes effect only
 * through a TENANT-scope assignment). The labels come from ONE module
 * (`contexts/platform/permission-labels.ts`); the web never names a permission itself.
 *
 * No person names in fixtures.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { normalizeRolePermissions, roleNameKey } from "../contexts/platform";
import {
  PERMISSIONS,
  PERMISSION_RESOURCES,
  permissionKey,
  type PermissionResource,
} from "../contexts/platform/permission-catalog";
import {
  PERMISSION_LABELS,
  PERMISSION_RESOURCE_LABELS,
} from "../contexts/platform/permission-labels";

const PASSWORD = "test1234";
const byText = (a: string, b: string) => a.localeCompare(b);

type CatalogGroup = {
  resource: PermissionResource;
  label: string;
  permissions: { key: string; label: string; reach: string; relation: string }[];
};

describe("Issue #83 — GET /api/v1/roles/permission-catalog", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  function uniqueSuffix(label: string): string {
    return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  async function createUser(label: string) {
    const s = uniqueSuffix(label);
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await app.prisma.user.create({
      data: { email: `${s}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: label,
        lastName: "Rui83",
        hireDate: new Date("2024-01-01"),
      },
    });
    return user;
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

  function catalog(token?: string) {
    return app.inject({
      method: "GET",
      url: "/api/v1/roles/permission-catalog",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "rui83-cat");
  });

  afterAll(async () => {
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: data.tenant.id } });
      await app.prisma.accessRole.deleteMany({ where: { tenantId: data.tenant.id } });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("roles-permission-catalog-83 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("tracer: every catalog key exactly once, grouped by resource in catalog order", async () => {
    const res = await catalog(data.adminToken);
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as CatalogGroup[];
    const resourcesInOrder = [...new Set(PERMISSIONS.map((p) => p.resource))];
    expect(body.map((g) => g.resource)).toEqual(resourcesInOrder);
    expect(body).toHaveLength(Object.keys(PERMISSION_RESOURCES).length);
    expect(body.flatMap((g) => g.permissions.map((p) => p.key))).toEqual(
      PERMISSIONS.map(permissionKey),
    );
  });

  it("every group and entry carries its German label, reach and relation — nothing else", async () => {
    const body = JSON.parse((await catalog(data.adminToken)).body) as CatalogGroup[];
    const reachByKey = new Map(PERMISSIONS.map((p) => [permissionKey(p) as string, p.reach]));
    for (const group of body) {
      expect(Object.keys(group).sort(byText)).toEqual(["label", "permissions", "resource"]);
      expect(group.label).toBe(PERMISSION_RESOURCE_LABELS[group.resource]);
      for (const entry of group.permissions) {
        expect(Object.keys(entry).sort(byText)).toEqual(["key", "label", "reach", "relation"]);
        expect(entry.label).toBe(PERMISSION_LABELS[entry.key as keyof typeof PERMISSION_LABELS]);
        expect(entry.reach).toBe(reachByKey.get(entry.key));
        expect(entry.relation).toBe(PERMISSION_RESOURCES[group.resource].relation);
      }
    }
  });

  it("role:read at TENANT scope reaches the catalog; the same role at SALONS scope does not (D-03)", async () => {
    const name = `Rui83 ${crypto.randomBytes(3).toString("hex")}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId: data.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions(["role:read:ZUGEWIESEN"]),
      },
    });
    const tenantWide = await createUser("catTenant");
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: tenantWide.id,
        accessRoleId: role.id,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
    expect((await catalog(await login(tenantWide.email))).statusCode).toBe(200);

    const salonScoped = await createUser("catSalons");
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: salonScoped.id,
        accessRoleId: role.id,
        scopeType: "SALONS",
        salonIds: [data.salonId],
        employeeIds: [],
      },
    });
    expect((await catalog(await login(salonScoped.email))).statusCode).toBe(403);
  });

  it("an employee without role:read gets 403, no token 401", async () => {
    expect((await catalog(data.empToken)).statusCode).toBe(403);
    expect((await catalog()).statusCode).toBe(401);
  });
});
