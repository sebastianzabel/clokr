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
// AK-73-7/D-11 (test (w)): `roleGrants` pulled from the Unterbau's public surface (`..`), not
// from `access-role.ts` directly — this is the exact import path #74 will use.
import { roleGrants } from "..";
import type { FastifyInstance } from "fastify";

const ROLE_NAME_CONFLICT_MESSAGE = "Eine Rolle mit diesem Namen existiert bereits.";

describe("Roles API (Phase 73b, Issue #73)", () => {
  let app: FastifyInstance;
  let dataA: Awaited<ReturnType<typeof seedTestData>>;
  let dataB: Awaited<ReturnType<typeof seedTestData>>;
  let systemRoleId: string;
  let systemRoleName: string;
  // A second, GLOBAL system fixture with a 100-character name — the copy-truncation edge case
  // (test (y)) needs a source name that is already at `ROLE_NAME_MAX_LENGTH`.
  let longSystemRoleId: string;
  let longSystemRoleName: string;
  // Copies made from the first system fixture in tests (t)/(u), reused by (v).
  let firstCopyId: string;
  let secondCopyId: string;

  // Two catalog keys, referenced by position so this file never restates a permission literal —
  // PERMISSIONS[0] always sorts before PERMISSIONS[1] in catalog order (D-03).
  const keyLow = permissionKey(PERMISSIONS[0]);
  const keyHigh = permissionKey(PERMISSIONS[1]);

  const roleName = `Testrolle A ${Date.now().toString(36)}`;
  let createdRoleId: string;
  let patchTargetId: string;

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

    // Exactly 100 characters: a fixed, unique-enough base padded with a filler character so the
    // length is precise regardless of the timestamp token's own length.
    longSystemRoleName = `System-Lang-Testrolle ${Date.now().toString(36)} `.padEnd(100, "X");
    const longSystemRole = await app.prisma.accessRole.create({
      data: {
        tenantId: null,
        name: longSystemRoleName,
        nameKey: roleNameKey(longSystemRoleName),
        permissions: normalizeRolePermissions([keyLow]),
      },
    });
    longSystemRoleId = longSystemRole.id;
  });

  afterAll(async () => {
    try {
      await app.prisma.accessRole.delete({ where: { id: systemRoleId } });
    } catch (err) {
      console.error("System role fixture cleanup failed:", err);
    }
    try {
      await app.prisma.accessRole.delete({ where: { id: longSystemRoleId } });
    } catch (err) {
      console.error("Long system role fixture cleanup failed:", err);
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

  it("(j) GET /:id: 200 for an own role equal to its list item; 200 isSystem=true for the system fixture", async () => {
    const ownRes = await app.inject({
      method: "GET",
      url: `/api/v1/roles/${createdRoleId}`,
      headers: { authorization: `Bearer ${dataA.adminToken}` },
    });
    expect(ownRes.statusCode).toBe(200);
    const ownBody = JSON.parse(ownRes.body);
    expect(ownBody.id).toBe(createdRoleId);
    expect(ownBody.isSystem).toBe(false);

    const listRes = await app.inject({
      method: "GET",
      url: "/api/v1/roles",
      headers: { authorization: `Bearer ${dataA.adminToken}` },
    });
    const listItem = (JSON.parse(listRes.body) as { id: string }[]).find(
      (r) => r.id === createdRoleId,
    );
    expect(ownBody).toEqual(listItem);

    const systemRes = await app.inject({
      method: "GET",
      url: `/api/v1/roles/${systemRoleId}`,
      headers: { authorization: `Bearer ${dataA.adminToken}` },
    });
    expect(systemRes.statusCode).toBe(200);
    expect(JSON.parse(systemRes.body).isSystem).toBe(true);
  });

  it("(k) PATCH own role: new name + unordered list with a duplicate -> 200, normalised, exactly one UPDATE audit with the full before/after", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/roles",
      headers: { authorization: `Bearer ${dataA.adminToken}` },
      payload: { name: `Patch-Quelle ${Date.now().toString(36)}`, permissions: [keyLow] },
    });
    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.body);
    const oldName: string = created.name;
    const oldPermissions: string[] = created.permissions;

    const newName = `Patch-Ziel ${Date.now().toString(36)}`;
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/roles/${created.id}`,
      headers: { authorization: `Bearer ${dataA.adminToken}` },
      payload: { name: newName, permissions: [keyHigh, keyLow, keyHigh] },
    });
    expect(patchRes.statusCode).toBe(200);
    const patched = JSON.parse(patchRes.body);
    expect(patched.name).toBe(newName);
    expect(patched.permissions).toEqual([keyLow, keyHigh]);

    const row = await app.prisma.accessRole.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.name).toBe(newName);
    expect(row.nameKey).toBe(newName.trim().toLowerCase());
    expect(row.permissions).toEqual([keyLow, keyHigh]);

    const audits = await app.prisma.auditLog.findMany({
      where: { entity: "AccessRole", action: "UPDATE", entityId: created.id },
    });
    expect(audits.length).toBe(1);
    expect(audits[0].oldValue).toEqual({ name: oldName, permissions: oldPermissions });
    expect(audits[0].newValue).toEqual({ name: newName, permissions: [keyLow, keyHigh] });

    patchTargetId = created.id;
  });

  it("(l) AK-73-1: PATCH with an unknown permission key -> 400, row unchanged", async () => {
    const before = await app.prisma.accessRole.findUniqueOrThrow({ where: { id: patchTargetId } });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/roles/${patchTargetId}`,
      headers: { authorization: `Bearer ${dataA.adminToken}` },
      payload: { permissions: ["role:fly:ZUGEWIESEN"] },
    });
    expect(res.statusCode).toBe(400);
    const after = await app.prisma.accessRole.findUniqueOrThrow({ where: { id: patchTargetId } });
    expect(after).toEqual(before);
  });

  it("(m) AK-73-8: rename to another own role's name (case-insensitive) -> 409; to the system fixture's name -> 409; to its own name in different casing -> 200 with unchanged nameKey", async () => {
    const upperConflict = await app.inject({
      method: "PATCH",
      url: `/api/v1/roles/${patchTargetId}`,
      headers: { authorization: `Bearer ${dataA.adminToken}` },
      payload: { name: roleName.toUpperCase() },
    });
    expect(upperConflict.statusCode).toBe(409);
    expect(JSON.parse(upperConflict.body).error).toBe(ROLE_NAME_CONFLICT_MESSAGE);

    const systemConflict = await app.inject({
      method: "PATCH",
      url: `/api/v1/roles/${patchTargetId}`,
      headers: { authorization: `Bearer ${dataA.adminToken}` },
      payload: { name: systemRoleName.toUpperCase() },
    });
    expect(systemConflict.statusCode).toBe(409);
    expect(JSON.parse(systemConflict.body).error).toBe(ROLE_NAME_CONFLICT_MESSAGE);

    const before = await app.prisma.accessRole.findUniqueOrThrow({ where: { id: patchTargetId } });
    const casingRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/roles/${patchTargetId}`,
      headers: { authorization: `Bearer ${dataA.adminToken}` },
      payload: { name: before.name.toUpperCase() },
    });
    expect(casingRes.statusCode).toBe(200);
    const after = await app.prisma.accessRole.findUniqueOrThrow({ where: { id: patchTargetId } });
    expect(after.nameKey).toBe(before.nameKey);
    expect(after.name).toBe(before.name.toUpperCase());
  });

  it("(n) no-op: PATCH {} and PATCH with the identical name -> 200, updatedAt unchanged, no new UPDATE audit", async () => {
    const before = await app.prisma.accessRole.findUniqueOrThrow({ where: { id: patchTargetId } });
    const auditsBefore = await app.prisma.auditLog.count({
      where: { entity: "AccessRole", action: "UPDATE", entityId: patchTargetId },
    });

    const emptyRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/roles/${patchTargetId}`,
      headers: { authorization: `Bearer ${dataA.adminToken}` },
      payload: {},
    });
    expect(emptyRes.statusCode).toBe(200);

    const sameNameRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/roles/${patchTargetId}`,
      headers: { authorization: `Bearer ${dataA.adminToken}` },
      payload: { name: before.name },
    });
    expect(sameNameRes.statusCode).toBe(200);

    const after = await app.prisma.accessRole.findUniqueOrThrow({ where: { id: patchTargetId } });
    expect(after.updatedAt).toEqual(before.updatedAt);

    const auditsAfter = await app.prisma.auditLog.count({
      where: { entity: "AccessRole", action: "UPDATE", entityId: patchTargetId },
    });
    expect(auditsAfter).toBe(auditsBefore);
  });

  it("(o) AK-73-4: PATCH the system fixture with { name } and with { permissions } -> 409 with the exact message each time; row unchanged; zero audit rows", async () => {
    const before = await app.prisma.accessRole.findUniqueOrThrow({ where: { id: systemRoleId } });
    const SYSTEM_UPDATE_MESSAGE =
      "Systemrollen können nicht geändert werden. Kopieren Sie die Rolle, um sie anzupassen.";

    const nameRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/roles/${systemRoleId}`,
      headers: { authorization: `Bearer ${dataA.adminToken}` },
      payload: { name: `${systemRoleName} geändert` },
    });
    expect(nameRes.statusCode).toBe(409);
    expect(JSON.parse(nameRes.body).error).toBe(SYSTEM_UPDATE_MESSAGE);

    const permsRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/roles/${systemRoleId}`,
      headers: { authorization: `Bearer ${dataA.adminToken}` },
      payload: { permissions: [] },
    });
    expect(permsRes.statusCode).toBe(409);
    expect(JSON.parse(permsRes.body).error).toBe(SYSTEM_UPDATE_MESSAGE);

    const after = await app.prisma.accessRole.findUniqueOrThrow({ where: { id: systemRoleId } });
    expect(after).toEqual(before);

    const audits = await app.prisma.auditLog.count({
      where: { entity: "AccessRole", entityId: systemRoleId },
    });
    expect(audits).toBe(0);
  });

  it("(p) AK-73-2/AK-73-10: DELETE own role -> 204 empty body; row gone; exactly one DELETE audit; GET afterwards -> 404", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/roles",
      headers: { authorization: `Bearer ${dataA.adminToken}` },
      payload: { name: `Lösch-Rolle ${Date.now().toString(36)}`, permissions: [keyLow] },
    });
    const created = JSON.parse(createRes.body);

    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/roles/${created.id}`,
      headers: { authorization: `Bearer ${dataA.adminToken}` },
    });
    expect(deleteRes.statusCode).toBe(204);
    expect(deleteRes.body).toBe("");

    const row = await app.prisma.accessRole.findUnique({ where: { id: created.id } });
    expect(row).toBeNull();

    const audits = await app.prisma.auditLog.findMany({
      where: { entity: "AccessRole", action: "DELETE", entityId: created.id },
    });
    expect(audits.length).toBe(1);
    expect(audits[0].oldValue).toEqual({
      name: created.name,
      permissions: created.permissions,
      tenantId: dataA.tenant.id,
    });

    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/roles/${created.id}`,
      headers: { authorization: `Bearer ${dataA.adminToken}` },
    });
    expect(getRes.statusCode).toBe(404);
  });

  it("(q) AK-73-5: DELETE the system fixture -> 409 with the exact message; row unchanged; zero audit rows", async () => {
    const before = await app.prisma.accessRole.findUniqueOrThrow({ where: { id: systemRoleId } });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/roles/${systemRoleId}`,
      headers: { authorization: `Bearer ${dataA.adminToken}` },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe("Systemrollen können nicht gelöscht werden.");

    const after = await app.prisma.accessRole.findUniqueOrThrow({ where: { id: systemRoleId } });
    expect(after).toEqual(before);

    const audits = await app.prisma.auditLog.count({
      where: { entity: "AccessRole", entityId: systemRoleId },
    });
    expect(audits).toBe(0);
  });

  it("(r) AK-73-9: GET, PATCH({}) and DELETE on tenant B's customer role vs. an unknown id are byte-identical 404; tenant B's role unchanged, zero mutating audit rows for it", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/roles",
      headers: { authorization: `Bearer ${dataB.adminToken}` },
      payload: { name: `T-100-09-Rolle ${Date.now().toString(36)}`, permissions: [keyLow] },
    });
    const foreignRole = JSON.parse(createRes.body);
    const unknownId = "00000000-0000-4000-8000-000000000073";

    for (const method of ["GET", "PATCH", "DELETE"] as const) {
      const injectExtra = method === "PATCH" ? { payload: {} } : {};
      const foreignRes = await app.inject({
        method,
        url: `/api/v1/roles/${foreignRole.id}`,
        headers: { authorization: `Bearer ${dataA.adminToken}` },
        ...injectExtra,
      });
      const unknownRes = await app.inject({
        method,
        url: `/api/v1/roles/${unknownId}`,
        headers: { authorization: `Bearer ${dataA.adminToken}` },
        ...injectExtra,
      });
      expect(foreignRes.statusCode).toBe(404);
      expect(unknownRes.statusCode).toBe(404);
      expect(foreignRes.body).toBe(unknownRes.body);
    }

    const after = await app.prisma.accessRole.findUniqueOrThrow({ where: { id: foreignRole.id } });
    expect(after.name).toBe(foreignRole.name);
    expect(after.permissions).toEqual(foreignRole.permissions);

    // Only the CREATE audit from this test's own setup POST — none of the three 404'd attempts
    // above wrote a mutating (UPDATE/DELETE) audit row for tenant B's role.
    const mutatingAudits = await app.prisma.auditLog.count({
      where: {
        entity: "AccessRole",
        entityId: foreignRole.id,
        action: { in: ["UPDATE", "DELETE"] },
      },
    });
    expect(mutatingAudits).toBe(0);
  });

  it("(s) AK-73-11: rejects an EMPLOYEE token with 403 on GET/PATCH/DELETE /:id", async () => {
    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/roles/${createdRoleId}`,
      headers: { authorization: `Bearer ${dataA.empToken}` },
    });
    expect(getRes.statusCode).toBe(403);

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/roles/${createdRoleId}`,
      headers: { authorization: `Bearer ${dataA.empToken}` },
      payload: {},
    });
    expect(patchRes.statusCode).toBe(403);

    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/roles/${createdRoleId}`,
      headers: { authorization: `Bearer ${dataA.empToken}` },
    });
    expect(deleteRes.statusCode).toBe(403);
  });

  it("(t) AK-73-6: copies the system fixture without a body -> 201, generated name, source unchanged", async () => {
    const beforeSystem = await app.prisma.accessRole.findUniqueOrThrow({
      where: { id: systemRoleId },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/roles/${systemRoleId}/copy`,
      headers: { authorization: `Bearer ${dataA.adminToken}` },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.name).toBe(`${systemRoleName} (Kopie)`);
    expect(body.isSystem).toBe(false);
    expect(body.permissions).toEqual(beforeSystem.permissions);
    firstCopyId = body.id;

    const row = await app.prisma.accessRole.findUniqueOrThrow({ where: { id: firstCopyId } });
    expect(row.tenantId).toBe(dataA.tenant.id);
    expect(row.permissions).toEqual(beforeSystem.permissions);

    const afterSystem = await app.prisma.accessRole.findUniqueOrThrow({
      where: { id: systemRoleId },
    });
    expect(afterSystem).toEqual(beforeSystem);
  });

  it("(u) AK-73-6/AK-73-8: repeated copies generate '(Kopie n)'; an explicit name is honored; a colliding name -> 409", async () => {
    const secondRes = await app.inject({
      method: "POST",
      url: `/api/v1/roles/${systemRoleId}/copy`,
      headers: { authorization: `Bearer ${dataA.adminToken}` },
      payload: {},
    });
    expect(secondRes.statusCode).toBe(201);
    const secondBody = JSON.parse(secondRes.body);
    expect(secondBody.name).toBe(`${systemRoleName} (Kopie 2)`);
    secondCopyId = secondBody.id;

    const explicitName = `Eigene Leitung ${Date.now().toString(36)}`;
    const explicitRes = await app.inject({
      method: "POST",
      url: `/api/v1/roles/${systemRoleId}/copy`,
      headers: { authorization: `Bearer ${dataA.adminToken}` },
      payload: { name: explicitName },
    });
    expect(explicitRes.statusCode).toBe(201);
    expect(JSON.parse(explicitRes.body).name).toBe(explicitName);

    const nullNameRes = await app.inject({
      method: "POST",
      url: `/api/v1/roles/${systemRoleId}/copy`,
      headers: { authorization: `Bearer ${dataA.adminToken}` },
      payload: { name: null },
    });
    expect(nullNameRes.statusCode).toBe(201);
    expect(JSON.parse(nullNameRes.body).name).toBe(`${systemRoleName} (Kopie 3)`);

    const conflictRes = await app.inject({
      method: "POST",
      url: `/api/v1/roles/${systemRoleId}/copy`,
      headers: { authorization: `Bearer ${dataA.adminToken}` },
      payload: { name: systemRoleName.toUpperCase() },
    });
    expect(conflictRes.statusCode).toBe(409);
    expect(JSON.parse(conflictRes.body).error).toBe(ROLE_NAME_CONFLICT_MESSAGE);
  });

  it("(v) AK-73-6: a copy is freely editable and deletable; the system fixture stays untouched", async () => {
    const beforeSystem = await app.prisma.accessRole.findUniqueOrThrow({
      where: { id: systemRoleId },
    });

    const newCopyName = `Kopie geändert ${Date.now().toString(36)}`;
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/roles/${firstCopyId}`,
      headers: { authorization: `Bearer ${dataA.adminToken}` },
      payload: { name: newCopyName, permissions: [keyLow] },
    });
    expect(patchRes.statusCode).toBe(200);
    const patched = JSON.parse(patchRes.body);
    expect(patched.name).toBe(newCopyName);
    expect(patched.permissions).toEqual([keyLow]);

    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/roles/${secondCopyId}`,
      headers: { authorization: `Bearer ${dataA.adminToken}` },
    });
    expect(deleteRes.statusCode).toBe(204);
    const deletedRow = await app.prisma.accessRole.findUnique({ where: { id: secondCopyId } });
    expect(deletedRow).toBeNull();

    const afterSystem = await app.prisma.accessRole.findUniqueOrThrow({
      where: { id: systemRoleId },
    });
    expect(afterSystem).toEqual(beforeSystem);
  });

  it("(w) AK-73-7/D-11: an unchanged copy of the system fixture resolves identically for every catalog key, non-vacuously", async () => {
    const copyRes = await app.inject({
      method: "POST",
      url: `/api/v1/roles/${systemRoleId}/copy`,
      headers: { authorization: `Bearer ${dataA.adminToken}` },
      payload: { name: `AK-73-7-Kopie ${Date.now().toString(36)}` },
    });
    expect(copyRes.statusCode).toBe(201);
    const copyId = JSON.parse(copyRes.body).id;

    const systemRow = await app.prisma.accessRole.findUniqueOrThrow({
      where: { id: systemRoleId },
    });
    const copyRow = await app.prisma.accessRole.findUniqueOrThrow({ where: { id: copyId } });
    expect(copyRow.permissions).toEqual(systemRow.permissions);

    let trueCount = 0;
    let falseCount = 0;
    for (const permission of PERMISSIONS) {
      const key = permissionKey(permission);
      const systemResult = roleGrants(systemRow, key);
      const copyResult = roleGrants(copyRow, key);
      expect(copyResult).toBe(systemResult);
      if (systemResult) trueCount++;
      else falseCount++;
    }
    expect(trueCount).toBe(systemRow.permissions.length);
    expect(trueCount).toBeGreaterThanOrEqual(1);
    expect(falseCount).toBeGreaterThanOrEqual(1);
  });

  it("(x) copies an own customer role through the same route", async () => {
    const ownName = `Eigene Quelle ${Date.now().toString(36)}`;
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/roles",
      headers: { authorization: `Bearer ${dataA.adminToken}` },
      payload: { name: ownName, permissions: [keyHigh] },
    });
    const own = JSON.parse(createRes.body);

    const copyRes = await app.inject({
      method: "POST",
      url: `/api/v1/roles/${own.id}/copy`,
      headers: { authorization: `Bearer ${dataA.adminToken}` },
    });
    expect(copyRes.statusCode).toBe(201);
    const copy = JSON.parse(copyRes.body);
    expect(copy.name).toBe(`${ownName} (Kopie)`);
    expect(copy.permissions).toEqual([keyHigh]);

    const row = await app.prisma.accessRole.findUniqueOrThrow({ where: { id: copy.id } });
    expect(row.tenantId).toBe(dataA.tenant.id);
  });

  it("(y) copying a 100-character source name truncates the base so the result stays <= 100 characters", async () => {
    expect(longSystemRoleName.length).toBe(100);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/roles/${longSystemRoleId}/copy`,
      headers: { authorization: `Bearer ${dataA.adminToken}` },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.name.length).toBeLessThanOrEqual(100);
    expect(body.name.endsWith(" (Kopie)")).toBe(true);
  });

  it("(z) AK-73-10: exactly one COPY audit with the full lineage", async () => {
    const explicitName = `Audit-Kopie ${Date.now().toString(36)}`;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/roles/${systemRoleId}/copy`,
      headers: { authorization: `Bearer ${dataA.adminToken}` },
      payload: { name: explicitName },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);

    const audits = await app.prisma.auditLog.findMany({
      where: { entity: "AccessRole", action: "COPY", entityId: body.id },
    });
    expect(audits.length).toBe(1);
    expect(audits[0].newValue).toEqual({
      name: body.name,
      permissions: body.permissions,
      tenantId: dataA.tenant.id,
      copiedFromId: systemRoleId,
      copiedFromName: systemRoleName,
    });
  });

  it("(aa) AK-73-9: copying tenant B's customer role vs. an unknown id are byte-identical 404; nothing created, no audit", async () => {
    const foreignCreateRes = await app.inject({
      method: "POST",
      url: "/api/v1/roles",
      headers: { authorization: `Bearer ${dataB.adminToken}` },
      payload: { name: `T-100-09-Copy-Quelle ${Date.now().toString(36)}`, permissions: [keyLow] },
    });
    const foreignRole = JSON.parse(foreignCreateRes.body);
    const unknownId = "00000000-0000-4000-8000-000000000074";

    const countBefore = await app.prisma.accessRole.count({ where: { tenantId: dataA.tenant.id } });

    const foreignRes = await app.inject({
      method: "POST",
      url: `/api/v1/roles/${foreignRole.id}/copy`,
      headers: { authorization: `Bearer ${dataA.adminToken}` },
    });
    const unknownRes = await app.inject({
      method: "POST",
      url: `/api/v1/roles/${unknownId}/copy`,
      headers: { authorization: `Bearer ${dataA.adminToken}` },
    });

    expect(foreignRes.statusCode).toBe(404);
    expect(unknownRes.statusCode).toBe(404);
    expect(foreignRes.body).toBe(unknownRes.body);

    const countAfter = await app.prisma.accessRole.count({ where: { tenantId: dataA.tenant.id } });
    expect(countAfter).toBe(countBefore);

    const audits = await app.prisma.auditLog.findMany({
      where: { entity: "AccessRole", action: "COPY" },
    });
    const leaksSourceId = audits.some(
      (a) => (a.newValue as { copiedFromId?: string } | null)?.copiedFromId === foreignRole.id,
    );
    expect(leaksSourceId).toBe(false);
  });

  it("(ab) AK-73-11: rejects an EMPLOYEE token with 403 on the copy route", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/roles/${systemRoleId}/copy`,
      headers: { authorization: `Bearer ${dataA.empToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });
});
