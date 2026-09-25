/**
 * Phase 91b Plan 03 (Issue #91), D-09/D-10/D-14 — Zeitnachtrag (`RetroEntryRequest`) scoped the
 * same way the underlying resource it requests a `TimeEntry` for is scoped. `RetroEntryRequest`
 * has NO `salonId` column (schema.prisma:834-858) — only `employeeId` + `targetDate` — so this
 * uses the Stammsalon-only rule (D-10: `resolveStammsalonScopedEmployeeIds`/
 * `isStammsalonScopeMatch`), never the TimeEntry entry-salon fallback (D-09), even for a request
 * later coupled to a TimeEntry.
 *
 * No person names in fixtures (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { DEFAULT_SALON_OPENING_HOURS } from "../contexts/platform/facade/salons";
import { normalizeRolePermissions, roleNameKey } from "../contexts/platform";

const PASSWORD = "test1234";

describe("Issue #91 (Phase 91b Plan 03) — RetroEntryRequest salon/person scope", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };

  function uniqueSuffix(label: string): string {
    return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  async function createEmployee(label: string) {
    const s = uniqueSuffix(label);
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await app.prisma.user.create({
      data: { email: `${s}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: label,
        lastName: "RetroScopeTest",
        hireDate: new Date("2024-01-01"),
      },
    });
    return { user, employee };
  }

  function createHome(employeeId: string, salonId: string) {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId,
        salonId,
        kind: "HOME",
        validFrom: new Date("2020-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });
  }

  function createRetroRequest(employeeId: string, targetDate: string) {
    return app.prisma.retroEntryRequest.create({
      data: {
        employeeId,
        targetDate: new Date(targetDate),
        reason: "Testfall 91b-03",
        startTime: "08:00",
        endTime: "16:00",
        breakMinutes: 30,
        status: "PENDING",
      },
    });
  }

  async function createScopedManager(
    label: string,
    permissions: string[],
    scope: { scopeType: "SALONS" | "PERSONS"; salonIds?: string[]; employeeIds?: string[] },
  ) {
    const { user } = await createEmployee(label);
    const name = `RetroScope ${crypto.randomBytes(3).toString("hex")}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId: data.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions(permissions),
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        accessRoleId: role.id,
        scopeType: scope.scopeType,
        salonIds: scope.salonIds ?? [],
        employeeIds: scope.employeeIds ?? [],
      },
    });
    return { user };
  }

  async function login(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return (JSON.parse(res.body) as { accessToken: string }).accessToken;
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "resc");
    salonA = await app.prisma.salon.create({
      data: {
        tenantId: data.tenant.id,
        name: "RESC Salon A",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
      },
    });
    salonB = await app.prisma.salon.create({
      data: {
        tenantId: data.tenant.id,
        name: "RESC Salon B",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
      },
    });
  });

  afterAll(async () => {
    try {
      // RetroEntryRequest.employee is onDelete: Restrict — must be cleared before
      // cleanupTestData's employee.deleteMany, mirroring this file's own fixtures.
      await app.prisma.retroEntryRequest.deleteMany({
        where: { employee: { tenantId: data.tenant.id } },
      });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("GET / — list narrowed to Stammsalon-at-targetDate (D-10)", () => {
    it("a SALONS-scoped manager sees only in-scope employees' requests, never an out-of-scope one", async () => {
      const inScopeEmp = await createEmployee("inscope-retro-list");
      await createHome(inScopeEmp.employee.id, salonA.id);
      const inScopeRequest = await createRetroRequest(inScopeEmp.employee.id, "2026-06-01");

      const outOfScopeEmp = await createEmployee("outscope-retro-list");
      await createHome(outOfScopeEmp.employee.id, salonB.id);
      const outOfScopeRequest = await createRetroRequest(outOfScopeEmp.employee.id, "2026-06-01");

      const manager = await createScopedManager(
        "mgr-retro-list",
        ["retro-request:read:ZUGEWIESEN"],
        { scopeType: "SALONS", salonIds: [salonA.id] },
      );
      const token = await login(manager.user.email);

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/retro-entry-requests",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const ids = (JSON.parse(res.body) as Array<{ id: string }>).map((r) => r.id);
      expect(ids).toContain(inScopeRequest.id);
      expect(ids).not.toContain(outOfScopeRequest.id);
    });

    it("a TENANT-scope (wholeTenant) manager's response is unchanged — sees every request", async () => {
      const emp = await createEmployee("wholetenant-retro-list");
      await createHome(emp.employee.id, salonB.id);
      const request = await createRetroRequest(emp.employee.id, "2026-06-02");

      const manager = await createScopedManager(
        "mgr-retro-wholetenant",
        ["retro-request:read:ZUGEWIESEN"],
        {
          scopeType: "SALONS",
          salonIds: [],
        },
      );
      await app.prisma.roleAssignment.updateMany({
        where: { userId: manager.user.id },
        data: { scopeType: "TENANT", salonIds: [], employeeIds: [] },
      });
      const token = await login(manager.user.email);

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/retro-entry-requests",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const ids = (JSON.parse(res.body) as Array<{ id: string }>).map((r) => r.id);
      expect(ids).toContain(request.id);
    });
  });

  describe("PATCH /:id/review — scope-checked decision (D-10/D-14)", () => {
    it("an out-of-scope request 404s byte-identically to a non-existent id, with SCOPE_ACCESS_DENIED audit", async () => {
      const outOfScopeEmp = await createEmployee("outscope-retro-review");
      await createHome(outOfScopeEmp.employee.id, salonB.id);
      const request = await createRetroRequest(outOfScopeEmp.employee.id, "2026-06-03");

      const manager = await createScopedManager(
        "mgr-retro-review-salons",
        ["retro-request:approve:ZUGEWIESEN"],
        { scopeType: "SALONS", salonIds: [salonA.id] },
      );
      const token = await login(manager.user.email);

      const nonExistentRes = await app.inject({
        method: "PATCH",
        url: "/api/v1/retro-entry-requests/00000000-0000-0000-0000-000000000000/review",
        headers: { authorization: `Bearer ${token}` },
        payload: { status: "APPROVED" },
      });
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/retro-entry-requests/${request.id}/review`,
        headers: { authorization: `Bearer ${token}` },
        payload: { status: "APPROVED" },
      });

      expect(res.statusCode).toBe(nonExistentRes.statusCode);
      expect(res.body).toBe(nonExistentRes.body);
      expect(res.statusCode).toBe(404);

      const audit = await app.prisma.auditLog.findFirst({
        where: { action: "SCOPE_ACCESS_DENIED", entity: "RetroEntryRequest", entityId: request.id },
        orderBy: { createdAt: "desc" },
      });
      expect(audit).not.toBeNull();
    });

    it("an in-scope request still succeeds (no regression)", async () => {
      const inScopeEmp = await createEmployee("inscope-retro-review");
      await createHome(inScopeEmp.employee.id, salonA.id);
      const request = await createRetroRequest(inScopeEmp.employee.id, "2026-06-04");

      const manager = await createScopedManager(
        "mgr-retro-review-inscope",
        ["retro-request:approve:ZUGEWIESEN"],
        { scopeType: "SALONS", salonIds: [salonA.id] },
      );
      const token = await login(manager.user.email);

      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/retro-entry-requests/${request.id}/review`,
        headers: { authorization: `Bearer ${token}` },
        payload: { status: "APPROVED" },
      });
      expect(res.statusCode).toBe(200);
    });

    it("a TENANT-scope (wholeTenant) manager is unaffected — no scope check blocks it", async () => {
      const emp = await createEmployee("wholetenant-retro-review");
      await createHome(emp.employee.id, salonB.id);
      const request = await createRetroRequest(emp.employee.id, "2026-06-05");

      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/retro-entry-requests/${request.id}/review`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { status: "APPROVED" },
      });
      expect(res.statusCode).toBe(200);
    });
  });
});
