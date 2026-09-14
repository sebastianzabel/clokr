/**
 * fix(sec-07): GET /api/v1/settings/work/:employeeId/history had no tenant check at
 * all — any ADMIN/MANAGER of any tenant could read a foreign employee's full
 * WorkSchedule version history. Fixed by copying the guard already established on
 * the sibling GET /work/:employeeId (Phase 100 CR-01, pinned in
 * settings-work-tenant-isolation.test.ts) verbatim.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

const GENUINELY_MISSING_EMPLOYEE_ID = "00000000-0000-4000-8000-000000000007";

describe("GET /api/v1/settings/work/:employeeId/history — tenant isolation (sec-07)", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "sec07-a");
    tenantB = await seedTestData(app, "sec07-b");
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

  it("tenantA ADMIN reading tenantB's schedule history → 404, no history leaked, CROSS_TENANT_ACCESS_DENIED audit", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/settings/work/${tenantB.employee.id}/history`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ error: "Kein Arbeitszeitmodell gefunden" });
    expect(Array.isArray(body)).toBe(false);

    const audit = await app.prisma.auditLog.findFirst({
      where: {
        action: "CROSS_TENANT_ACCESS_DENIED",
        entity: "WorkSchedule",
        entityId: tenantB.employee.id,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.userId).toBe(tenantA.adminUser.id);
  });

  it("the cross-tenant 404 is byte-identical to a genuine not-found 404 (no existence oracle)", async () => {
    const crossTenantRes = await app.inject({
      method: "GET",
      url: `/api/v1/settings/work/${tenantB.employee.id}/history`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    const notFoundRes = await app.inject({
      method: "GET",
      url: `/api/v1/settings/work/${GENUINELY_MISSING_EMPLOYEE_ID}/history`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    expect(crossTenantRes.statusCode).toBe(notFoundRes.statusCode);
    expect(JSON.parse(crossTenantRes.body)).toEqual(JSON.parse(notFoundRes.body));
  });

  it("the same call by tenantB's OWN ADMIN still succeeds exactly as before (no regression)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/settings/work/${tenantB.employee.id}/history`,
      headers: { authorization: `Bearer ${tenantB.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0].employeeId).toBe(tenantB.employee.id);
  });
});
