/**
 * Phase 91b Plan 03 (Issue #91), D-09/D-14 — closes the confirmed `GET /api/v1/time-entries`
 * unscoped-list bug (RESEARCH.md §1) and proves every single-`TimeEntry` ZUGEWIESEN route
 * (clock-out, PUT/:id, DELETE/:id) is scope-checked and 404-indistinguishable from a non-existent
 * id, with a `SCOPE_ACCESS_DENIED` audit entry.
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

describe("Issue #91 (Phase 91b Plan 03) — TimeEntry salon/person scope", () => {
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
        lastName: "ScopeTest",
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

  function createEntry(employeeId: string, salonId: string, date: string) {
    return app.prisma.timeEntry.create({
      data: {
        employeeId,
        salonId,
        date: new Date(date),
        startTime: new Date(`${date}T08:00:00Z`),
        endTime: new Date(`${date}T16:00:00Z`),
        source: "MANUAL",
      },
    });
  }

  /**
   * A manager holding `permissions` scoped to `salonIds`/`employeeIds` (SALONS or PERSONS).
   *
   * Finding (recorded in 91b-03-SUMMARY.md): every real logged-in `User` MUST have a linked
   * `Employee` — `POST /auth/login` derives the JWT's `tenantId` from `user.employee?.tenantId`
   * (`auth.ts`), so a `User` with no `Employee` can never obtain a real tenant at all
   * (`accessContextFromRequest` throws "missing tenant"). RESEARCH.md §1's literal quote
   * (`employeeId: isManager && employeeId ? employeeId : (user.employeeId ?? undefined)`
   * degenerating to "no constraint" when the caller's OWN `employeeId` is falsy) therefore can
   * only fire for a non-`"user"` actor (an API key) — and `resolveAccessReach` gives every
   * non-`"user"` actor `wholeTenant` unconditionally (Plan 91b-01's own documented choice), so
   * that literal branch is unreachable for a genuinely SALONS/PERSONS-scoped caller. The ACTUAL
   * exploitable path this fix closes is the one this file tests: a manager passing an EXPLICIT
   * out-of-scope `employeeId` query param got that employee's full history with zero scope check
   * — `scopedTimeEntryIds` folded into `where.id` now empties that result instead.
   */
  async function createScopedManager(
    label: string,
    permissions: string[],
    scope: { scopeType: "SALONS" | "PERSONS"; salonIds?: string[]; employeeIds?: string[] },
  ) {
    const { user } = await createEmployee(label);
    const name = `Scope ${crypto.randomBytes(3).toString("hex")}`;
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
    data = await seedTestData(app, "tesc");
    salonA = await app.prisma.salon.create({
      data: {
        tenantId: data.tenant.id,
        name: "TESC Salon A",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
        federalState: "NIEDERSACHSEN", // Phase 71b (issue #71) — required since the merge; irrelevant to this test's own assertions
      },
    });
    salonB = await app.prisma.salon.create({
      data: {
        tenantId: data.tenant.id,
        name: "TESC Salon B",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
        federalState: "NIEDERSACHSEN", // Phase 71b (issue #71) — required since the merge; irrelevant to this test's own assertions
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("GET /api/v1/time-entries — scoped list (Task 1)", () => {
    it("a SALONS-scoped manager naming an out-of-scope employeeId gets an EMPTY result, not that employee's history", async () => {
      const outOfScopeEmp = await createEmployee("outscope-list");
      await createHome(outOfScopeEmp.employee.id, salonB.id);
      await createEntry(outOfScopeEmp.employee.id, salonB.id, "2026-05-04");

      const manager = await createScopedManager("mgr-list-salons", ["time-entry:read:ZUGEWIESEN"], {
        scopeType: "SALONS",
        salonIds: [salonA.id],
      });
      const token = await login(manager.user.email);

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/time-entries?from=2026-05-01&to=2026-05-10&employeeId=${outOfScopeEmp.employee.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual([]);
    });

    it("a SALONS-scoped manager naming an in-scope employeeId still gets that employee's entries (no regression)", async () => {
      const inScopeEmp = await createEmployee("inscope-list");
      await createHome(inScopeEmp.employee.id, salonA.id);
      const inScopeEntry = await createEntry(inScopeEmp.employee.id, salonA.id, "2026-05-04");

      const manager = await createScopedManager(
        "mgr-list-salons-inscope",
        ["time-entry:read:ZUGEWIESEN"],
        { scopeType: "SALONS", salonIds: [salonA.id] },
      );
      const token = await login(manager.user.email);

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/time-entries?from=2026-05-01&to=2026-05-10&employeeId=${inScopeEmp.employee.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const ids = (JSON.parse(res.body) as Array<{ id: string }>).map((e) => e.id);
      expect(ids).toContain(inScopeEntry.id);
    });

    it("a PERSONS-scoped manager naming an unlisted employeeId gets an EMPTY result", async () => {
      const unlistedEmp = await createEmployee("unlisted-person");
      await createEntry(unlistedEmp.employee.id, salonA.id, "2026-05-05");
      const listedEmp = await createEmployee("listed-person");

      const manager = await createScopedManager(
        "mgr-list-persons",
        ["time-entry:read:ZUGEWIESEN"],
        { scopeType: "PERSONS", employeeIds: [listedEmp.employee.id] },
      );
      const token = await login(manager.user.email);

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/time-entries?from=2026-05-01&to=2026-05-10&employeeId=${unlistedEmp.employee.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual([]);
    });

    it("a PERSONS-scoped manager naming a listed employeeId still gets that employee's entries", async () => {
      const listedEmp = await createEmployee("listed-person-2");
      const listedEntry = await createEntry(listedEmp.employee.id, salonA.id, "2026-05-05");

      const manager = await createScopedManager(
        "mgr-list-persons-inscope",
        ["time-entry:read:ZUGEWIESEN"],
        { scopeType: "PERSONS", employeeIds: [listedEmp.employee.id] },
      );
      const token = await login(manager.user.email);

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/time-entries?from=2026-05-01&to=2026-05-10&employeeId=${listedEmp.employee.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const ids = (JSON.parse(res.body) as Array<{ id: string }>).map((e) => e.id);
      expect(ids).toContain(listedEntry.id);
    });

    it("a SALONS/PERSONS manager with an EMPTY reach gets an empty result for any named employeeId", async () => {
      const someEmp = await createEmployee("empty-reach");
      await createEntry(someEmp.employee.id, salonA.id, "2026-05-06");

      const manager = await createScopedManager("mgr-empty-reach", ["time-entry:read:ZUGEWIESEN"], {
        scopeType: "SALONS",
        salonIds: [],
      });
      const token = await login(manager.user.email);

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/time-entries?from=2026-05-01&to=2026-05-10&employeeId=${someEmp.employee.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual([]);
    });

    it("a TENANT-scope (wholeTenant) manager's response is unchanged — naming any employeeId still works", async () => {
      const emp = await createEmployee("wholetenant-list");
      const entry = await createEntry(emp.employee.id, salonB.id, "2026-05-07");

      const manager = await createScopedManager(
        "mgr-wholetenant-list",
        ["time-entry:read:ZUGEWIESEN"],
        {
          scopeType: "SALONS", // overwritten to TENANT below
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
        url: `/api/v1/time-entries?from=2026-05-01&to=2026-05-10&employeeId=${emp.employee.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const ids = (JSON.parse(res.body) as Array<{ id: string }>).map((e) => e.id);
      expect(ids).toContain(entry.id);
    });

    it("the EIGENE (employee, non-manager) branch is unaffected — sees only their own entries", async () => {
      const entry = await createEntry(data.employee.id, salonA.id, "2026-05-08");
      const other = await createEmployee("eigene-other");
      await createEntry(other.employee.id, salonA.id, "2026-05-08");

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/time-entries?from=2026-05-01&to=2026-05-10",
        headers: { authorization: `Bearer ${data.empToken}` },
      });
      expect(res.statusCode).toBe(200);
      const ids = (JSON.parse(res.body) as Array<{ id: string }>).map((e) => e.id);
      expect(ids).toEqual([entry.id]);
    });
  });

  describe("Single-TimeEntry ZUGEWIESEN routes scope-checked (Task 2)", () => {
    it("clock-out on an out-of-scope entry 404s byte-identically to a non-existent id, with SCOPE_ACCESS_DENIED audit", async () => {
      const outOfScopeEmp = await createEmployee("outscope-clockout");
      await createHome(outOfScopeEmp.employee.id, salonB.id);
      const openEntry = await app.prisma.timeEntry.create({
        data: {
          employeeId: outOfScopeEmp.employee.id,
          date: new Date("2026-05-09"),
          startTime: new Date("2026-05-09T08:00:00Z"),
          source: "MANUAL",
          salonId: salonB.id,
        },
      });

      const manager = await createScopedManager(
        "mgr-clockout-salons",
        ["time-entry:update:ZUGEWIESEN"],
        { scopeType: "SALONS", salonIds: [salonA.id] },
      );
      const token = await login(manager.user.email);

      const nonExistentRes = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/00000000-0000-0000-0000-000000000000/clock-out",
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/time-entries/${openEntry.id}/clock-out`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });

      expect(res.statusCode).toBe(nonExistentRes.statusCode);
      expect(res.body).toBe(nonExistentRes.body);
      expect(res.statusCode).toBe(404);

      const audit = await app.prisma.auditLog.findFirst({
        where: { action: "SCOPE_ACCESS_DENIED", entity: "TimeEntry", entityId: openEntry.id },
        orderBy: { createdAt: "desc" },
      });
      expect(audit).not.toBeNull();
    });

    it("clock-out on an in-scope entry still succeeds (no regression)", async () => {
      const inScopeEmp = await createEmployee("inscope-clockout");
      await createHome(inScopeEmp.employee.id, salonA.id);
      const openEntry = await app.prisma.timeEntry.create({
        data: {
          employeeId: inScopeEmp.employee.id,
          date: new Date("2026-05-10"),
          startTime: new Date("2026-05-10T08:00:00Z"),
          source: "MANUAL",
          salonId: salonA.id,
        },
      });

      const manager = await createScopedManager(
        "mgr-clockout-inscope",
        ["time-entry:update:ZUGEWIESEN"],
        { scopeType: "SALONS", salonIds: [salonA.id] },
      );
      const token = await login(manager.user.email);

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/time-entries/${openEntry.id}/clock-out`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
    });

    it("PUT /:id on an out-of-scope entry 404s byte-identically to a non-existent id, with SCOPE_ACCESS_DENIED audit", async () => {
      const outOfScopeEmp = await createEmployee("outscope-put");
      await createHome(outOfScopeEmp.employee.id, salonB.id);
      const entry = await createEntry(outOfScopeEmp.employee.id, salonB.id, "2026-05-11");

      const manager = await createScopedManager(
        "mgr-put-salons",
        ["time-entry:update:ZUGEWIESEN"],
        { scopeType: "SALONS", salonIds: [salonA.id] },
      );
      const token = await login(manager.user.email);

      const nonExistentRes = await app.inject({
        method: "PUT",
        url: "/api/v1/time-entries/00000000-0000-0000-0000-000000000000",
        headers: { authorization: `Bearer ${token}` },
        payload: { breakMinutes: 30 },
      });
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/time-entries/${entry.id}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { breakMinutes: 30 },
      });

      expect(res.statusCode).toBe(nonExistentRes.statusCode);
      expect(res.body).toBe(nonExistentRes.body);
      expect(res.statusCode).toBe(404);

      const audit = await app.prisma.auditLog.findFirst({
        where: { action: "SCOPE_ACCESS_DENIED", entity: "TimeEntry", entityId: entry.id },
        orderBy: { createdAt: "desc" },
      });
      expect(audit).not.toBeNull();
    });

    it("DELETE /:id on an out-of-scope entry 404s byte-identically to a non-existent id, with SCOPE_ACCESS_DENIED audit", async () => {
      const outOfScopeEmp = await createEmployee("outscope-delete");
      await createHome(outOfScopeEmp.employee.id, salonB.id);
      const entry = await createEntry(outOfScopeEmp.employee.id, salonB.id, "2026-05-12");

      const manager = await createScopedManager(
        "mgr-delete-salons",
        ["time-entry:delete:ZUGEWIESEN"],
        { scopeType: "SALONS", salonIds: [salonA.id] },
      );
      const token = await login(manager.user.email);

      const nonExistentRes = await app.inject({
        method: "DELETE",
        url: "/api/v1/time-entries/00000000-0000-0000-0000-000000000000",
        headers: { authorization: `Bearer ${token}` },
      });
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/time-entries/${entry.id}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(nonExistentRes.statusCode);
      expect(res.body).toBe(nonExistentRes.body);
      expect(res.statusCode).toBe(404);

      const audit = await app.prisma.auditLog.findFirst({
        where: { action: "SCOPE_ACCESS_DENIED", entity: "TimeEntry", entityId: entry.id },
        orderBy: { createdAt: "desc" },
      });
      expect(audit).not.toBeNull();
    });

    it("a TENANT-scope (wholeTenant) manager is unaffected for PUT — no scope check blocks it", async () => {
      const emp = await createEmployee("wholetenant-put");
      const entry = await createEntry(emp.employee.id, salonB.id, "2026-05-13");

      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/time-entries/${entry.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { breakMinutes: 15, reason: "Korrektur Testfall 91b-03" },
      });
      expect(res.statusCode).toBe(200);
    });
  });
});
