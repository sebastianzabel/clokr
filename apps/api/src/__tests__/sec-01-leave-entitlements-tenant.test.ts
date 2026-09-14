/**
 * fix(sec-01): GET /api/v1/leave/entitlements/:employeeId had no tenant guard at all.
 *
 * The route read LeaveEntitlement/Section9Credit rows by a bare employeeId and even
 * WROTE via autoCarryOver()/selfHealUsedDays() before any tenant check ran. A prior
 * `employee.findUnique({ where: { id, tenantId } })` only fed `exitDate` and never
 * rejected on `null`, so it was not a guard at all. Fixed to load the employee
 * unfiltered up front, 404 identically for "missing" and "wrong tenant", and audit
 * the cross-tenant attempt — mirroring overtime.ts. Also adds the same-tenant
 * EMPLOYEE self-scope carve-out overtime.ts already has (D-03 there).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

const GENUINELY_MISSING_EMPLOYEE_ID = "00000000-0000-4000-8000-000000000001";

describe("GET /api/v1/leave/entitlements/:employeeId — tenant isolation (sec-01)", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "sec01-a");
    tenantB = await seedTestData(app, "sec01-b");
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

  it("tenantA ADMIN reading tenantB's employee → 404, no entitlement leaked, CROSS_TENANT_ACCESS_DENIED audit", async () => {
    const beforeRows = await app.prisma.leaveEntitlement.findMany({
      where: { employeeId: tenantB.employee.id },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${tenantB.employee.id}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Mitarbeiter nicht gefunden" });

    // No side-effecting write (autoCarryOver / selfHealUsedDays) reached tenantB's rows.
    const afterRows = await app.prisma.leaveEntitlement.findMany({
      where: { employeeId: tenantB.employee.id },
    });
    expect(afterRows).toEqual(beforeRows);

    const audit = await app.prisma.auditLog.findFirst({
      where: {
        action: "CROSS_TENANT_ACCESS_DENIED",
        entity: "Employee",
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
      url: `/api/v1/leave/entitlements/${tenantB.employee.id}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    const notFoundRes = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${GENUINELY_MISSING_EMPLOYEE_ID}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    expect(crossTenantRes.statusCode).toBe(notFoundRes.statusCode);
    expect(JSON.parse(crossTenantRes.body)).toEqual(JSON.parse(notFoundRes.body));
  });

  it("the same call by tenantB's OWN ADMIN still succeeds exactly as before (no regression)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${tenantB.employee.id}`,
      headers: { authorization: `Bearer ${tenantB.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Array<{ typeCode: string; totalDays: string }>;
    const vac = body.find((r) => r.typeCode === "VACATION");
    expect(vac).toBeTruthy();
    expect(Number(vac?.totalDays)).toBe(30);
  });

  it("an EMPLOYEE reading their OWN entitlements still succeeds (self-scope carve-out, no regression)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${tenantB.employee.id}`,
      headers: { authorization: `Bearer ${tenantB.empToken}` },
    });

    expect(res.statusCode).toBe(200);
  });

  it("an EMPLOYEE reading a DIFFERENT employee's entitlements in the SAME tenant → 403 (new self-scope guard)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${tenantB.adminEmployee.id}`,
      headers: { authorization: `Bearer ${tenantB.empToken}` },
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "Forbidden" });
  });
});
