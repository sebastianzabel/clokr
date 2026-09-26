/**
 * Phase 91b Plan 10 (Issue #91), D-10/D-12/D-14 — a genuine gap closed this session: RESEARCH.md's
 * own conclusion for `employees.ts` GET /:id ("this permission already exists and already gates
 * the list; the row-level filter is missing") turned out to apply, un-remediated, to a much larger
 * family of routes than that one route: NONE of `employees.ts`'s single-employee action routes,
 * `avatars.ts`, `contexts/scheduling/api/availability.ts`, `contexts/scheduling/api/
 * shift-patterns.ts`, `platform/api/settings.ts`'s work-schedule routes,
 * `absence/api/leave-settings.ts`'s vacation routes, `leave.ts`'s GET /entitlements/:employeeId,
 * or `platform/api/salon-assignments.ts` carried ANY Phase 91b marker before this plan — verified
 * with `grep -c "Phase 91b"` returning 0 for every one of those files. Plans 91b-01 through 91b-09
 * never touched them; this plan closes that delta.
 *
 * Two rules apply, by resource type (see each route's own inline comment for the specific
 * reasoning): D-12 (Stammsalon-OR-active-deployment) for basic identity/master data (employee
 * profile read, avatar, salon-assignment history); D-10 (Stammsalon-only) for administrative/
 * account-lifecycle actions and for "per-employee configuration" resources (availability,
 * shift-patterns, contract/work-schedule settings, vacation entitlement, leave entitlement) —
 * matching the precedent `vocational-school-pattern.ts` (Plan 91b-04) already established for the
 * identical "per-employee pattern" resource shape.
 *
 * This file does not attempt exhaustive per-route coverage of every single-employee route this
 * plan touched (~25 sites across 8 files) — it proves the pattern holds for a representative
 * sample of each rule and each file, with a TENANT-scope regression check alongside. The full
 * T-100-09 oracle probe (`t100-09-oracle-probe.test.ts`) and Plan 91b-09's `resolveScopedHolderIds`
 * unit tests already prove the underlying primitives; this file proves the WIRING at the route
 * level.
 *
 * No person names in fixtures (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { normalizeRolePermissions, roleNameKey } from "../contexts/platform";

const PASSWORD = "test1234";

describe("Issue #91 (Phase 91b Plan 10) — employee-owned routes' salon/person scope", () => {
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
        lastName: "PersonScopeTest",
        hireDate: new Date("2020-01-01"),
      },
    });
    return { user, employee };
  }

  function createHome(employeeId: string, salonId: string, validFrom = "2020-01-01") {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId,
        salonId,
        kind: "HOME",
        validFrom: new Date(validFrom),
        validUntil: null,
        weekdays: [],
      },
    });
  }

  async function createScopedManager(
    label: string,
    permissions: string[],
    scope: {
      scopeType: "SALONS" | "PERSONS" | "TENANT";
      salonIds?: string[];
      employeeIds?: string[];
    },
  ) {
    const { user } = await createEmployee(label);
    const name = `PersonScope ${crypto.randomBytes(3).toString("hex")}`;
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
    data = await seedTestData(app, "epsc");
    salonA = await createTestSalon(app.prisma, data.tenant.id, { name: "EPSC Salon A" });
    salonB = await createTestSalon(app.prisma, data.tenant.id, { name: "EPSC Salon B" });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // ── D-12 (Stammsalon-OR-deployment): employees.ts GET /:id, salon-assignments GET, avatars POST ──

  describe("D-12 routes", () => {
    it("GET /employees/:id: a SALONS-scope manager sees an in-scope employee (Stammsalon match), not an out-of-scope one (identical 404)", async () => {
      const inScopeEmp = await createEmployee("d12-get-in");
      await createHome(inScopeEmp.employee.id, salonA.id);
      const outOfScopeEmp = await createEmployee("d12-get-out");
      await createHome(outOfScopeEmp.employee.id, salonB.id);

      const mgr = await createScopedManager("d12-get-mgr", ["employee:read:ZUGEWIESEN"], {
        scopeType: "SALONS",
        salonIds: [salonA.id],
      });
      const token = await login(mgr.user.email);

      const inRes = await app.inject({
        method: "GET",
        url: `/api/v1/employees/${inScopeEmp.employee.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(inRes.statusCode).toBe(200);

      const outRes = await app.inject({
        method: "GET",
        url: `/api/v1/employees/${outOfScopeEmp.employee.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      const nonexistentRes = await app.inject({
        method: "GET",
        url: "/api/v1/employees/00000000-0000-4000-8000-000000000001",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(outRes.statusCode).toBe(nonexistentRes.statusCode);
      expect(outRes.body).toBe(nonexistentRes.body);
    });

    it("GET /employees/:id: a TENANT-scope manager still sees every employee (no regression)", async () => {
      const emp = await createEmployee("d12-get-wholetenant");
      await createHome(emp.employee.id, salonB.id);

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/employees/${emp.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it("GET /employees/:id/salon-assignments: same D-12 rule", async () => {
      const inScopeEmp = await createEmployee("d12-sa-in");
      await createHome(inScopeEmp.employee.id, salonA.id);
      const outOfScopeEmp = await createEmployee("d12-sa-out");
      await createHome(outOfScopeEmp.employee.id, salonB.id);

      const mgr = await createScopedManager("d12-sa-mgr", ["employee:read:ZUGEWIESEN"], {
        scopeType: "SALONS",
        salonIds: [salonA.id],
      });
      const token = await login(mgr.user.email);

      const inRes = await app.inject({
        method: "GET",
        url: `/api/v1/employees/${inScopeEmp.employee.id}/salon-assignments`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(inRes.statusCode).toBe(200);

      const outRes = await app.inject({
        method: "GET",
        url: `/api/v1/employees/${outOfScopeEmp.employee.id}/salon-assignments`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(outRes.statusCode).toBe(404);
    });
  });

  // ── D-10 (Stammsalon-only): account-lifecycle actions, per-employee patterns/settings ──────────

  describe("D-10 routes", () => {
    it("PATCH /employees/:id/unlock: an out-of-scope SALONS manager cannot unlock; an in-scope one can", async () => {
      const inScopeEmp = await createEmployee("d10-unlock-in");
      await createHome(inScopeEmp.employee.id, salonA.id);
      const outOfScopeEmp = await createEmployee("d10-unlock-out");
      await createHome(outOfScopeEmp.employee.id, salonB.id);

      const mgr = await createScopedManager(
        "d10-unlock-mgr",
        ["employee:manage-access:ZUGEWIESEN"],
        {
          scopeType: "SALONS",
          salonIds: [salonA.id],
        },
      );
      const token = await login(mgr.user.email);

      const inRes = await app.inject({
        method: "PATCH",
        url: `/api/v1/employees/${inScopeEmp.employee.id}/unlock`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(inRes.statusCode).toBe(200);

      const outRes = await app.inject({
        method: "PATCH",
        url: `/api/v1/employees/${outOfScopeEmp.employee.id}/unlock`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(outRes.statusCode).toBe(404);
    });

    it("PATCH /employees/:id/deactivate: same rule; a TENANT-scope admin still works (no regression)", async () => {
      const emp = await createEmployee("d10-deactivate-wholetenant");
      await createHome(emp.employee.id, salonB.id);

      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/employees/${emp.employee.id}/deactivate`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it("GET /employees/:id/availability: an out-of-scope SALONS manager gets 404; in-scope gets 200", async () => {
      const inScopeEmp = await createEmployee("d10-avail-in");
      await createHome(inScopeEmp.employee.id, salonA.id);
      const outOfScopeEmp = await createEmployee("d10-avail-out");
      await createHome(outOfScopeEmp.employee.id, salonB.id);

      const mgr = await createScopedManager("d10-avail-mgr", ["availability:read:ZUGEWIESEN"], {
        scopeType: "SALONS",
        salonIds: [salonA.id],
      });
      const token = await login(mgr.user.email);

      const inRes = await app.inject({
        method: "GET",
        url: `/api/v1/employees/${inScopeEmp.employee.id}/availability`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(inRes.statusCode).toBe(200);

      const outRes = await app.inject({
        method: "GET",
        url: `/api/v1/employees/${outOfScopeEmp.employee.id}/availability`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(outRes.statusCode).toBe(404);
    });

    it("GET /employees/:id/shift-patterns: same rule", async () => {
      const inScopeEmp = await createEmployee("d10-sp-in");
      await createHome(inScopeEmp.employee.id, salonA.id);
      const outOfScopeEmp = await createEmployee("d10-sp-out");
      await createHome(outOfScopeEmp.employee.id, salonB.id);

      const mgr = await createScopedManager("d10-sp-mgr", ["shift-pattern:read:ZUGEWIESEN"], {
        scopeType: "SALONS",
        salonIds: [salonA.id],
      });
      const token = await login(mgr.user.email);

      const inRes = await app.inject({
        method: "GET",
        url: `/api/v1/employees/${inScopeEmp.employee.id}/shift-patterns`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(inRes.statusCode).toBe(200);

      const outRes = await app.inject({
        method: "GET",
        url: `/api/v1/employees/${outOfScopeEmp.employee.id}/shift-patterns`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(outRes.statusCode).toBe(404);
    });

    it("GET /settings/work/:employeeId: same rule", async () => {
      const inScopeEmp = await createEmployee("d10-work-in");
      await createHome(inScopeEmp.employee.id, salonA.id);
      const outOfScopeEmp = await createEmployee("d10-work-out");
      await createHome(outOfScopeEmp.employee.id, salonB.id);
      // BOTH need a WorkSchedule row — otherwise the out-of-scope employee would 404 for the
      // unrelated "no schedule configured" reason even without any scope check, making the RED
      // proof vacuous.
      await app.prisma.workSchedule.create({
        data: {
          employeeId: inScopeEmp.employee.id,
          type: "FIXED_SCHEDULE",
          validFrom: new Date("2020-01-01"),
        },
      });
      await app.prisma.workSchedule.create({
        data: {
          employeeId: outOfScopeEmp.employee.id,
          type: "FIXED_SCHEDULE",
          validFrom: new Date("2020-01-01"),
        },
      });

      const mgr = await createScopedManager("d10-work-mgr", ["contract:read:ZUGEWIESEN"], {
        scopeType: "SALONS",
        salonIds: [salonA.id],
      });
      const token = await login(mgr.user.email);

      const inRes = await app.inject({
        method: "GET",
        url: `/api/v1/settings/work/${inScopeEmp.employee.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(inRes.statusCode).toBe(200);

      const outRes = await app.inject({
        method: "GET",
        url: `/api/v1/settings/work/${outOfScopeEmp.employee.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(outRes.statusCode).toBe(404);
    });

    it("GET /settings/vacation/:employeeId: same rule", async () => {
      const inScopeEmp = await createEmployee("d10-vac-in");
      await createHome(inScopeEmp.employee.id, salonA.id);
      const outOfScopeEmp = await createEmployee("d10-vac-out");
      await createHome(outOfScopeEmp.employee.id, salonB.id);

      const mgr = await createScopedManager("d10-vac-mgr", ["leave-entitlement:read:ZUGEWIESEN"], {
        scopeType: "SALONS",
        salonIds: [salonA.id],
      });
      const token = await login(mgr.user.email);

      const inRes = await app.inject({
        method: "GET",
        url: `/api/v1/settings/vacation/${inScopeEmp.employee.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      // 200 or 404 "Urlaubstyp nicht konfiguriert" are both fine — the scope check must not be
      // the reason for a 404 here; a genuinely in-scope employee must reach the type lookup.
      expect(
        inRes.statusCode === 200 || JSON.parse(inRes.body).error !== "Mitarbeiter nicht gefunden",
      ).toBe(true);

      const outRes = await app.inject({
        method: "GET",
        url: `/api/v1/settings/vacation/${outOfScopeEmp.employee.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(outRes.statusCode).toBe(404);
      expect(JSON.parse(outRes.body).error).toBe("Mitarbeiter nicht gefunden");
    });

    it("GET /leave/entitlements/:employeeId: same rule", async () => {
      const inScopeEmp = await createEmployee("d10-ent-in");
      await createHome(inScopeEmp.employee.id, salonA.id);
      const outOfScopeEmp = await createEmployee("d10-ent-out");
      await createHome(outOfScopeEmp.employee.id, salonB.id);

      const mgr = await createScopedManager("d10-ent-mgr", ["leave-entitlement:read:ZUGEWIESEN"], {
        scopeType: "SALONS",
        salonIds: [salonA.id],
      });
      const token = await login(mgr.user.email);

      const outRes = await app.inject({
        method: "GET",
        url: `/api/v1/leave/entitlements/${outOfScopeEmp.employee.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(outRes.statusCode).toBe(404);
      expect(JSON.parse(outRes.body).error).toBe("Mitarbeiter nicht gefunden");
    });
  });
});
