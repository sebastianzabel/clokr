/**
 * fix(sec-09): DELETE /api/v1/avatars/:employeeId only guarded the self-delete path
 * (`isSelf`) — an ADMIN/MANAGER of any tenant could remove a foreign tenant's
 * employee's avatar, since the `isManager` branch never compared tenantId. Fixed by
 * copying the tenant check already established on the sibling GET /:employeeId
 * verbatim.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("DELETE /api/v1/avatars/:employeeId — tenant isolation (sec-09)", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "sec09-a");
    tenantB = await seedTestData(app, "sec09-b");

    // Give tenantB's employee a known avatarPath (bypassing storage/sharp — the
    // guard sits before any storage.delete() call, so the object itself never
    // needs to exist in MinIO for this test).
    await app.prisma.employee.update({
      where: { id: tenantB.employee.id },
      data: { avatarPath: `avatars/${tenantB.tenant.id}/${tenantB.employee.id}.webp` },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantA.tenant.id);
    } catch (err) {
      console.error("Cleanup tenantA failed:", err);
    }
    try {
      await cleanupTestData(app, tenantB.tenant.id);
    } catch (err) {
      console.error("Cleanup tenantB failed:", err);
    }
  });

  // BEFORE (phase 258): this case asserted 403 `{ error: "Keine Berechtigung" }` — which IS
  // the tenant-membership oracle, since it tells the caller "this id exists, just not here".
  // AFTER: the same T-100-09 guard as GET now applies here too, so the cross-tenant caller
  // gets the byte-identical 404 an unknown id would produce. Renamed accordingly.
  it("tenantA ADMIN deleting tenantB's employee's avatar → the byte-identical 404 as an unknown id (T-100-09, was 403), avatarPath untouched", async () => {
    const notFound = await app.inject({
      method: "DELETE",
      url: "/api/v1/avatars/00000000-0000-0000-0000-000000000000",
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/avatars/${tenantB.employee.id}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    // Compared against the captured unknown-id response, not a string literal: the invariant
    // is "indistinguishable", not "equals this particular German sentence" (T-100-09).
    expect(res.statusCode).toBe(notFound.statusCode);
    expect(res.body).toBe(notFound.body);

    const victimAfter = await app.prisma.employee.findUnique({
      where: { id: tenantB.employee.id },
    });
    expect(victimAfter?.avatarPath).toBe(
      `avatars/${tenantB.tenant.id}/${tenantB.employee.id}.webp`,
    );

    const audit = await app.prisma.auditLog.findFirst({
      where: { action: "CROSS_TENANT_ACCESS_DENIED", entityId: tenantB.employee.id },
    });
    expect(audit).not.toBeNull();
  });

  it("the same delete by tenantB's OWN ADMIN still succeeds exactly as before (no regression)", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/avatars/${tenantB.employee.id}`,
      headers: { authorization: `Bearer ${tenantB.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });

    const victimAfter = await app.prisma.employee.findUnique({
      where: { id: tenantB.employee.id },
    });
    expect(victimAfter?.avatarPath).toBeNull();
  });

  it("DELETE, unknown employee id → 404", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/v1/avatars/00000000-0000-0000-0000-000000000000",
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Mitarbeiter nicht gefunden" });
  });

  it("foreign tenant, employee WITHOUT an avatar → the byte-identical 404 as an unknown id (T-100-09)", async () => {
    // Explicit state setup — not relying on the delete two cases above having left
    // avatarPath null, which is exactly the implicit test-ordering coupling this phase
    // is cleaning up elsewhere.
    await app.prisma.employee.update({
      where: { id: tenantB.employee.id },
      data: { avatarPath: null },
    });

    const notFound = await app.inject({
      method: "DELETE",
      url: "/api/v1/avatars/00000000-0000-0000-0000-000000000000",
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/avatars/${tenantB.employee.id}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    expect(res.statusCode).toBe(notFound.statusCode);
    expect(res.body).toBe(notFound.body);
  });

  it("CROSS_TENANT_ACCESS_DENIED is audited for a real foreign employee, and NOT for an unknown id", async () => {
    await app.prisma.employee.update({
      where: { id: tenantB.employee.id },
      data: { avatarPath: `avatars/${tenantB.tenant.id}/${tenantB.employee.id}.webp` },
    });

    await app.inject({
      method: "DELETE",
      url: `/api/v1/avatars/${tenantB.employee.id}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    const auditForRealEmployee = await app.prisma.auditLog.findFirst({
      where: { action: "CROSS_TENANT_ACCESS_DENIED", entityId: tenantB.employee.id },
    });
    expect(auditForRealEmployee).not.toBeNull();

    const unknownId = "00000000-0000-0000-0000-000000000002";
    await app.inject({
      method: "DELETE",
      url: `/api/v1/avatars/${unknownId}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    const auditForUnknownId = await app.prisma.auditLog.findFirst({
      where: { action: "CROSS_TENANT_ACCESS_DENIED", entityId: unknownId },
    });
    expect(auditForUnknownId).toBeNull();
  });
});
