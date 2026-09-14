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

  it("tenantA ADMIN deleting tenantB's employee's avatar → 403, avatarPath untouched", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/avatars/${tenantB.employee.id}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "Keine Berechtigung" });

    const victimAfter = await app.prisma.employee.findUnique({
      where: { id: tenantB.employee.id },
    });
    expect(victimAfter?.avatarPath).toBe(
      `avatars/${tenantB.tenant.id}/${tenantB.employee.id}.webp`,
    );
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
});
