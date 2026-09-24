/**
 * Phase 73b (Issue #73) — integration tests for `POST /api/v1/roles` and `GET /api/v1/roles`.
 *
 * Two tenants (`dataA`/`dataB`) plus one system-role fixture created directly via Prisma
 * (`tenantId: null` — a global row, not reachable through `cleanupTestData`'s tenant-scoped
 * cascade, so it is deleted explicitly in `afterAll`, per CONTEXT.md's `<specifics>` section).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { PERMISSIONS, permissionKey } from "../permission-catalog";
import { roleNameKey, normalizeRolePermissions } from "../access-role";
import type { FastifyInstance } from "fastify";

const ROLE_NAME_CONFLICT_MESSAGE = "Eine Rolle mit diesem Namen existiert bereits.";

describe("Roles API (Phase 73b, Issue #73)", () => {
  let app: FastifyInstance;
  let dataA: Awaited<ReturnType<typeof seedTestData>>;
  let dataB: Awaited<ReturnType<typeof seedTestData>>;
  let systemRoleId: string;
  let systemRoleName: string;

  // Two catalog keys, referenced by position so this file never restates a permission literal —
  // PERMISSIONS[0] always sorts before PERMISSIONS[1] in catalog order (D-03).
  const keyLow = permissionKey(PERMISSIONS[0]);
  const keyHigh = permissionKey(PERMISSIONS[1]);

  const roleName = `Testrolle A ${Date.now().toString(36)}`;
  let createdRoleId: string;

  beforeAll(async () => {
    app = await getTestApp();
    dataA = await seedTestData(app, "73b-roles-a");
    dataB = await seedTestData(app, "73b-roles-b");

    systemRoleName = `System-Testrolle ${Date.now().toString(36)}`;
    const systemRole = await app.prisma.accessRole.create({
      data: {
        tenantId: null,
        name: systemRoleName,
        nameKey: roleNameKey(systemRoleName),
        permissions: normalizeRolePermissions([keyLow, keyHigh]),
      },
    });
    systemRoleId = systemRole.id;
  });

  afterAll(async () => {
    try {
      await app.prisma.accessRole.delete({ where: { id: systemRoleId } });
    } catch (err) {
      console.error("System role fixture cleanup failed:", err);
    }
    try {
      await cleanupTestData(app, dataA.tenant.id);
      await cleanupTestData(app, dataB.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function countCreateAudits(): Promise<number> {
    return app.prisma.auditLog.count({ where: { entity: "AccessRole", action: "CREATE" } });
  }

  it("(a) creates a customer role with deduped, catalog-ordered permissions and lists it", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/roles",
      headers: { authorization: `Bearer ${dataA.adminToken}` },
      payload: { name: roleName, permissions: [keyHigh, keyLow, keyHigh] },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.isSystem).toBe(false);
    expect(body.permissions).toEqual([keyLow, keyHigh]);
    createdRoleId = body.id;

    const row = await app.prisma.accessRole.findUniqueOrThrow({ where: { id: createdRoleId } });
    expect(row.tenantId).toBe(dataA.tenant.id);
    expect(row.nameKey).toBe(roleName.trim().toLowerCase());

    const listRes = await app.inject({
      method: "GET",
      url: "/api/v1/roles",
      headers: { authorization: `Bearer ${dataA.adminToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    const list = JSON.parse(listRes.body) as { id: string }[];
    expect(list.map((r) => r.id)).toContain(createdRoleId);
  });

  it("(b) lists exactly all system roles plus the caller's own customer roles, system first", async () => {
    const foreignRes = await app.inject({
      method: "POST",
      url: "/api/v1/roles",
      headers: { authorization: `Bearer ${dataB.adminToken}` },
      payload: { name: `Fremdrolle B ${Date.now().toString(36)}`, permissions: [] },
    });
    expect(foreignRes.statusCode).toBe(201);
    const foreignId = JSON.parse(foreignRes.body).id;

    const listRes = await app.inject({
      method: "GET",
      url: "/api/v1/roles",
      headers: { authorization: `Bearer ${dataA.adminToken}` },
    });
    const list = JSON.parse(listRes.body) as { id: string; isSystem: boolean }[];

    const expectedSystemIds = (
      await app.prisma.accessRole.findMany({ where: { tenantId: null }, select: { id: true } })
    ).map((r) => r.id);
    const expectedOwnIds = (
      await app.prisma.accessRole.findMany({
        where: { tenantId: dataA.tenant.id },
        select: { id: true },
      })
    ).map((r) => r.id);

    const actualSystemIds = list.filter((r) => r.isSystem).map((r) => r.id);
    const actualOwnIds = list.filter((r) => !r.isSystem).map((r) => r.id);

    expect(expectedSystemIds.length).toBeGreaterThan(0);
    expect(new Set(actualSystemIds)).toEqual(new Set(expectedSystemIds));
    expect(new Set(actualOwnIds)).toEqual(new Set(expectedOwnIds));
    expect(actualOwnIds).not.toContain(foreignId);

    // Every system item precedes every customer item: once a non-system item appears, no
    // system item may appear after it.
    const isSystemFlags = list.map((r) => r.isSystem);
    const firstCustomerIndex = isSystemFlags.indexOf(false);
    if (firstCustomerIndex !== -1) {
      expect(isSystemFlags.slice(firstCustomerIndex)).not.toContain(true);
    }
  });

  it("(c) rejects an unknown permission key with 400 and writes nothing", async () => {
    const before = await countCreateAudits();
    const name = `Unbekannt ${Date.now().toString(36)}`;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/roles",
      headers: { authorization: `Bearer ${dataA.adminToken}` },
      payload: { name, permissions: ["role:fly:ZUGEWIESEN"] },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Validierungsfehler");
    expect(body.message).toContain("role:fly:ZUGEWIESEN");

    const row = await app.prisma.accessRole.findFirst({
      where: { tenantId: dataA.tenant.id, nameKey: roleNameKey(name) },
    });
    expect(row).toBeNull();
    expect(await countCreateAudits()).toBe(before);
  });

  it("(d) allows an empty permission set", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/roles",
      headers: { authorization: `Bearer ${dataA.adminToken}` },
      payload: { name: `Leer ${Date.now().toString(36)}`, permissions: [] },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).permissions).toEqual([]);
  });

  it("(e) rejects case/whitespace-insensitive name conflicts, allows the same name in another tenant", async () => {
    const upperRes = await app.inject({
      method: "POST",
      url: "/api/v1/roles",
      headers: { authorization: `Bearer ${dataA.adminToken}` },
      payload: { name: roleName.toUpperCase(), permissions: [] },
    });
    expect(upperRes.statusCode).toBe(409);
    expect(JSON.parse(upperRes.body).error).toBe(ROLE_NAME_CONFLICT_MESSAGE);

    const spacedRes = await app.inject({
      method: "POST",
      url: "/api/v1/roles",
      headers: { authorization: `Bearer ${dataA.adminToken}` },
      payload: { name: `  ${roleName}  `, permissions: [] },
    });
    expect(spacedRes.statusCode).toBe(409);

    const systemNameRes = await app.inject({
      method: "POST",
      url: "/api/v1/roles",
      headers: { authorization: `Bearer ${dataA.adminToken}` },
      payload: { name: systemRoleName.toUpperCase(), permissions: [] },
    });
    expect(systemNameRes.statusCode).toBe(409);

    const otherTenantRes = await app.inject({
      method: "POST",
      url: "/api/v1/roles",
      headers: { authorization: `Bearer ${dataB.adminToken}` },
      payload: { name: roleName, permissions: [] },
    });
    expect(otherTenantRes.statusCode).toBe(201);
  });

  it("(f) resolves a concurrent duplicate-name race to exactly one 201 and one 409", async () => {
    const name = `Rennen ${Date.now().toString(36)}`;
    const [r1, r2] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/v1/roles",
        headers: { authorization: `Bearer ${dataA.adminToken}` },
        payload: { name, permissions: [] },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/roles",
        headers: { authorization: `Bearer ${dataA.adminToken}` },
        payload: { name, permissions: [] },
      }),
    ]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([201, 409]);
  });

  it("(g) writes exactly one CREATE audit row per successful create and none for a 409", async () => {
    const auditForA = await app.prisma.auditLog.findFirst({
      where: { entity: "AccessRole", action: "CREATE", entityId: createdRoleId },
    });
    expect(auditForA).not.toBeNull();
    expect(auditForA?.newValue).toEqual({
      name: roleName,
      permissions: [keyLow, keyHigh],
      tenantId: dataA.tenant.id,
    });
    const countForA = await app.prisma.auditLog.count({
      where: { entity: "AccessRole", action: "CREATE", entityId: createdRoleId },
    });
    expect(countForA).toBe(1);

    const before = await countCreateAudits();
    const conflictRes = await app.inject({
      method: "POST",
      url: "/api/v1/roles",
      headers: { authorization: `Bearer ${dataA.adminToken}` },
      payload: { name: roleName, permissions: [] },
    });
    expect(conflictRes.statusCode).toBe(409);
    expect(await countCreateAudits()).toBe(before);
  });

  it("(h) ignores a client-supplied tenantId in the body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/roles",
      headers: { authorization: `Bearer ${dataA.adminToken}` },
      payload: {
        name: `Fremd-Tenant ${Date.now().toString(36)}`,
        permissions: [],
        tenantId: dataB.tenant.id,
      },
    });
    expect(res.statusCode).toBe(201);
    const row = await app.prisma.accessRole.findUniqueOrThrow({
      where: { id: JSON.parse(res.body).id },
    });
    expect(row.tenantId).toBe(dataA.tenant.id);
  });

  it("(i) rejects an EMPLOYEE token with 403 on both routes", async () => {
    const getRes = await app.inject({
      method: "GET",
      url: "/api/v1/roles",
      headers: { authorization: `Bearer ${dataA.empToken}` },
    });
    expect(getRes.statusCode).toBe(403);

    const postRes = await app.inject({
      method: "POST",
      url: "/api/v1/roles",
      headers: { authorization: `Bearer ${dataA.empToken}` },
      payload: { name: "irrelevant", permissions: [] },
    });
    expect(postRes.statusCode).toBe(403);
  });
});
