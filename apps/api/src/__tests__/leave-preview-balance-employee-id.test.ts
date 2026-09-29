/**
 * Phase 415 (#415) — GET /leave/hours-preview and GET /leave/overtime-balance used to always
 * answer for `req.user.employeeId` (the caller's own). The unified leave-request dialog
 * (`LeaveRequestForm.svelte`) needs both to answer for a manager's SELECTED employee too, so both
 * routes now accept an optional `?employeeId=` query param.
 *
 * Authorization mirrors `GET /leave/entitlements/:employeeId` exactly (Phase 91b Plan 04,
 * D-10/D-14 — see `sec-01-leave-entitlements-tenant.test.ts` for that route's own version of these
 * same cases): `leave-entitlement:read:ZUGEWIESEN` reach required to read someone else, a
 * cross-tenant or unknown id gets the SAME 404 status+body (no existence oracle), and the
 * omitted/self path is untouched (byte-identical to the pre-Phase-415 code, proven directly below).
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";

const GENUINELY_MISSING_EMPLOYEE_ID = "00000000-0000-4000-8000-000000000002";
const START = "2026-06-01";
const END = "2026-06-05";

describe("GET /leave/hours-preview and GET /leave/overtime-balance — optional employeeId (Phase 415, #415)", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "p415-a");
    tenantB = await seedTestData(app, "p415-b");
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

  describe("GET /leave/hours-preview", () => {
    it("omitted employeeId still answers for the caller's own profile — byte-identical to before Phase 415", async () => {
      const withoutParam = await app.inject({
        method: "GET",
        url: `/api/v1/leave/hours-preview?startDate=${START}&endDate=${END}`,
        headers: { authorization: `Bearer ${tenantB.empToken}` },
      });
      const withSelfParam = await app.inject({
        method: "GET",
        url: `/api/v1/leave/hours-preview?startDate=${START}&endDate=${END}&employeeId=${tenantB.employee.id}`,
        headers: { authorization: `Bearer ${tenantB.empToken}` },
      });

      expect(withoutParam.statusCode).toBe(200);
      expect(withSelfParam.statusCode).toBe(200);
      expect(JSON.parse(withSelfParam.body)).toEqual(JSON.parse(withoutParam.body));
    });

    it("tenantB ADMIN reading a DIFFERENT employee in the SAME tenant → 200 (ZUGEWIESEN reach)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/leave/hours-preview?startDate=${START}&endDate=${END}&employeeId=${tenantB.employee.id}`,
        headers: { authorization: `Bearer ${tenantB.adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { hours: number; days: number };
      expect(typeof body.hours).toBe("number");
      expect(typeof body.days).toBe("number");
    });

    it("an EMPLOYEE reading a DIFFERENT employee's preview in the SAME tenant → 403", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/leave/hours-preview?startDate=${START}&endDate=${END}&employeeId=${tenantB.adminEmployee.id}`,
        headers: { authorization: `Bearer ${tenantB.empToken}` },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: "Forbidden" });
    });

    it("tenantA ADMIN reading tenantB's employee → 404, byte-identical to a genuinely unknown id (T-100-09)", async () => {
      const crossTenantRes = await app.inject({
        method: "GET",
        url: `/api/v1/leave/hours-preview?startDate=${START}&endDate=${END}&employeeId=${tenantB.employee.id}`,
        headers: { authorization: `Bearer ${tenantA.adminToken}` },
      });
      const notFoundRes = await app.inject({
        method: "GET",
        url: `/api/v1/leave/hours-preview?startDate=${START}&endDate=${END}&employeeId=${GENUINELY_MISSING_EMPLOYEE_ID}`,
        headers: { authorization: `Bearer ${tenantA.adminToken}` },
      });

      expect(crossTenantRes.statusCode).toBe(404);
      expect(crossTenantRes.statusCode).toBe(notFoundRes.statusCode);
      expect(JSON.parse(crossTenantRes.body)).toEqual(JSON.parse(notFoundRes.body));
      expect(JSON.parse(crossTenantRes.body)).toEqual({ error: "Mitarbeiter nicht gefunden" });

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
  });

  describe("GET /leave/overtime-balance", () => {
    it("omitted employeeId still answers for the caller's own profile — byte-identical to before Phase 415", async () => {
      const withoutParam = await app.inject({
        method: "GET",
        url: "/api/v1/leave/overtime-balance",
        headers: { authorization: `Bearer ${tenantB.empToken}` },
      });
      const withSelfParam = await app.inject({
        method: "GET",
        url: `/api/v1/leave/overtime-balance?employeeId=${tenantB.employee.id}`,
        headers: { authorization: `Bearer ${tenantB.empToken}` },
      });

      expect(withoutParam.statusCode).toBe(200);
      expect(withSelfParam.statusCode).toBe(200);
      expect(JSON.parse(withSelfParam.body)).toEqual(JSON.parse(withoutParam.body));
    });

    it("tenantB ADMIN reading a DIFFERENT employee in the SAME tenant → 200 (ZUGEWIESEN reach)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/leave/overtime-balance?employeeId=${tenantB.employee.id}`,
        headers: { authorization: `Bearer ${tenantB.adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { balanceHours: number };
      expect(typeof body.balanceHours).toBe("number");
    });

    it("an EMPLOYEE reading a DIFFERENT employee's balance in the SAME tenant → 403", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/leave/overtime-balance?employeeId=${tenantB.adminEmployee.id}`,
        headers: { authorization: `Bearer ${tenantB.empToken}` },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: "Forbidden" });
    });

    it("tenantA ADMIN reading tenantB's employee → 404, byte-identical to a genuinely unknown id (T-100-09)", async () => {
      const crossTenantRes = await app.inject({
        method: "GET",
        url: `/api/v1/leave/overtime-balance?employeeId=${tenantB.employee.id}`,
        headers: { authorization: `Bearer ${tenantA.adminToken}` },
      });
      const notFoundRes = await app.inject({
        method: "GET",
        url: `/api/v1/leave/overtime-balance?employeeId=${GENUINELY_MISSING_EMPLOYEE_ID}`,
        headers: { authorization: `Bearer ${tenantA.adminToken}` },
      });

      expect(crossTenantRes.statusCode).toBe(404);
      expect(crossTenantRes.statusCode).toBe(notFoundRes.statusCode);
      expect(JSON.parse(crossTenantRes.body)).toEqual(JSON.parse(notFoundRes.body));
      expect(JSON.parse(crossTenantRes.body)).toEqual({ error: "Mitarbeiter nicht gefunden" });

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
  });
});
