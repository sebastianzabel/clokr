/**
 * Phase 91b Plan 08 (Issue #91), D-11/D-12/D-13/D-14 — every ZUGEWIESEN shift route enforces the
 * shift resource's own rule: the shift's OWN salon, or its assigned employee directly listed via
 * PERSONS scope — NEVER a Stammsalon fallback (unlike TimeEntry/D-09).
 *
 * No person names in fixtures (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { normalizeRolePermissions, roleNameKey } from "../contexts/platform";
import { futureDateStr, nextWeekdayStr } from "./test-dates";

const PASSWORD = "test1234";

function nextOpenDayIso(): string {
  return nextWeekdayStr(futureDateStr(1));
}

describe("Issue #91 (Phase 91b Plan 08) — shifts.ts salon/person scope", () => {
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
        lastName: "ShiftScopeTest",
        hireDate: new Date("2020-01-01"),
      },
    });
    return { user, employee };
  }

  async function makeShiftEligible(employeeId: string) {
    await app.prisma.workSchedule.create({
      data: {
        employeeId,
        type: "SHIFT_BASED",
        weeklyHours: 40,
        validFrom: new Date("2024-06-01"),
      },
    });
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

  function createShift(employeeId: string, salonId: string, date: string) {
    return app.prisma.shift.create({
      data: {
        employeeId,
        salonId,
        date: new Date(date),
        startTime: "08:00",
        endTime: "16:00",
      },
    });
  }

  async function createManagerEmployee(label: string) {
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
        lastName: "ShiftScopeManager",
        hireDate: new Date("2020-01-01"),
      },
    });
    return { user, employee };
  }

  async function createScopedManager(
    label: string,
    permissions: string[],
    scope: { scopeType: "SALONS" | "PERSONS"; salonIds?: string[]; employeeIds?: string[] },
  ) {
    const { user } = await createManagerEmployee(label);
    const name = `ShiftScope ${crypto.randomBytes(3).toString("hex")}`;
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
    data = await seedTestData(app, "shsc");
    salonA = await createTestSalon(app.prisma, data.tenant.id, { name: "SHSC Salon A" });
    salonB = await createTestSalon(app.prisma, data.tenant.id, { name: "SHSC Salon B" });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("Task 1 — GET /range", () => {
    it("a SALONS-scoped manager naming an employee with shifts at BOTH salons sees only the in-scope-salon shift", async () => {
      const emp = await createEmployee("multisalon-range");
      const shiftInScope = await createShift(emp.employee.id, salonA.id, "2026-06-01");
      const shiftOutOfScope = await createShift(emp.employee.id, salonB.id, "2026-06-02");

      const manager = await createScopedManager("mgr-range-salons", ["shift:read:ZUGEWIESEN"], {
        scopeType: "SALONS",
        salonIds: [salonA.id],
      });
      const token = await login(manager.user.email);

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/shifts/range?from=2026-06-01&to=2026-06-02&employeeId=${emp.employee.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const dates = (JSON.parse(res.body) as Array<{ date: string }>).map((r) => r.date);
      expect(dates).toContain("2026-06-01");
      expect(dates).not.toContain("2026-06-02");
      void shiftInScope;
      void shiftOutOfScope;
    });

    it("a PERSONS-scoped manager naming a listed employee sees ALL their shifts regardless of salon", async () => {
      const emp = await createEmployee("multisalon-persons-range");
      await createShift(emp.employee.id, salonA.id, "2026-06-03");
      await createShift(emp.employee.id, salonB.id, "2026-06-04");

      const manager = await createScopedManager("mgr-range-persons", ["shift:read:ZUGEWIESEN"], {
        scopeType: "PERSONS",
        employeeIds: [emp.employee.id],
      });
      const token = await login(manager.user.email);

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/shifts/range?from=2026-06-03&to=2026-06-04&employeeId=${emp.employee.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const dates = (JSON.parse(res.body) as Array<{ date: string }>).map((r) => r.date);
      expect(dates).toContain("2026-06-03");
      expect(dates).toContain("2026-06-04");
    });

    it("a TENANT-scope (wholeTenant) manager is unaffected", async () => {
      const emp = await createEmployee("wholetenant-range");
      await createShift(emp.employee.id, salonB.id, "2026-06-05");

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/shifts/range?from=2026-06-05&to=2026-06-05&employeeId=${emp.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const dates = (JSON.parse(res.body) as Array<{ date: string }>).map((r) => r.date);
      expect(dates).toContain("2026-06-05");
    });
  });

  describe("Task 2 — single-shift ZUGEWIESEN mutation routes", () => {
    it("POST /: an out-of-scope target employee 404s byte-identically to a nonexistent employee, with SCOPE_ACCESS_DENIED audit", async () => {
      const outOfScope = await createEmployee("outscope-post");
      await makeShiftEligible(outOfScope.employee.id);
      await createHome(outOfScope.employee.id, salonB.id);

      const manager = await createScopedManager("mgr-post-salons", ["shift:plan:ZUGEWIESEN"], {
        scopeType: "SALONS",
        salonIds: [salonA.id],
      });
      const token = await login(manager.user.email);
      const day = nextOpenDayIso();

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          employeeId: outOfScope.employee.id,
          salonId: salonB.id,
          date: day,
          startTime: "08:00",
          endTime: "16:00",
        },
      });
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(JSON.stringify({ error: "Mitarbeiter nicht gefunden" }));

      const audit = await app.prisma.auditLog.findFirst({
        where: {
          action: "SCOPE_ACCESS_DENIED",
          entity: "Employee",
          entityId: outOfScope.employee.id,
        },
      });
      expect(audit).not.toBeNull();
    });

    it("POST /: an in-scope target employee still succeeds (no regression)", async () => {
      const inScope = await createEmployee("inscope-post");
      await makeShiftEligible(inScope.employee.id);
      await createHome(inScope.employee.id, salonA.id);

      const manager = await createScopedManager("mgr-post-inscope", ["shift:plan:ZUGEWIESEN"], {
        scopeType: "SALONS",
        salonIds: [salonA.id],
      });
      const token = await login(manager.user.email);
      const day = nextOpenDayIso();

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          employeeId: inScope.employee.id,
          salonId: salonA.id,
          date: day,
          startTime: "08:00",
          endTime: "16:00",
        },
      });
      expect(res.statusCode).toBe(201);
    });

    it("PUT /:id: an out-of-scope shift 404s with SCOPE_ACCESS_DENIED audit", async () => {
      const outOfScope = await createEmployee("outscope-put");
      await makeShiftEligible(outOfScope.employee.id);
      const shift = await createShift(outOfScope.employee.id, salonB.id, nextOpenDayIso());

      const manager = await createScopedManager("mgr-put-salons", ["shift:plan:ZUGEWIESEN"], {
        scopeType: "SALONS",
        salonIds: [salonA.id],
      });
      const token = await login(manager.user.email);

      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/shifts/${shift.id}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { startTime: "09:00" },
      });
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(JSON.stringify({ error: "Schicht nicht gefunden" }));

      const audit = await app.prisma.auditLog.findFirst({
        where: { action: "SCOPE_ACCESS_DENIED", entity: "Shift", entityId: shift.id },
      });
      expect(audit).not.toBeNull();
    });

    it("DELETE /:id: an out-of-scope shift 404s with SCOPE_ACCESS_DENIED audit", async () => {
      const outOfScope = await createEmployee("outscope-delete");
      const shift = await createShift(outOfScope.employee.id, salonB.id, nextOpenDayIso());

      const manager = await createScopedManager("mgr-delete-salons", ["shift:plan:ZUGEWIESEN"], {
        scopeType: "SALONS",
        salonIds: [salonA.id],
      });
      const token = await login(manager.user.email);

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/shifts/${shift.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(JSON.stringify({ error: "Schicht nicht gefunden" }));

      const audit = await app.prisma.auditLog.findFirst({
        where: { action: "SCOPE_ACCESS_DENIED", entity: "Shift", entityId: shift.id },
      });
      expect(audit).not.toBeNull();
    });

    it("POST /:id/restore: an out-of-scope shift 404s with SCOPE_ACCESS_DENIED audit", async () => {
      const outOfScope = await createEmployee("outscope-restore");
      const shift = await createShift(outOfScope.employee.id, salonB.id, nextOpenDayIso());
      await app.prisma.shift.update({
        where: { id: shift.id },
        data: { deletedAt: new Date(), deletedReason: "AUTO_BS_DAY_CLEANUP" },
      });

      const manager = await createScopedManager("mgr-restore-salons", ["shift:plan:ZUGEWIESEN"], {
        scopeType: "SALONS",
        salonIds: [salonA.id],
      });
      const token = await login(manager.user.email);

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/shifts/${shift.id}/restore`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(JSON.stringify({ error: "Schicht nicht gefunden" }));

      const audit = await app.prisma.auditLog.findFirst({
        where: { action: "SCOPE_ACCESS_DENIED", entity: "Shift", entityId: shift.id },
      });
      expect(audit).not.toBeNull();
    });

    it("shift-config:manage:ZUGEWIESEN (MANDANT relation) REGRESSION: a SALONS-scope holder still gets 403 (D-05 boundary unchanged by this whole phase)", async () => {
      const manager = await createScopedManager(
        "mgr-config-salons",
        ["shift-config:manage:ZUGEWIESEN"],
        { scopeType: "SALONS", salonIds: [salonA.id] },
      );
      const token = await login(manager.user.email);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts/templates",
        headers: { authorization: `Bearer ${token}` },
        payload: { name: "Regression-Template", startTime: "08:00", endTime: "16:00" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("shift-config:manage:ZUGEWIESEN (MANDANT relation) REGRESSION: a PERSONS-scope holder still gets 403", async () => {
      const emp = await createEmployee("persons-config-target");
      const manager = await createScopedManager(
        "mgr-config-persons",
        ["shift-config:manage:ZUGEWIESEN"],
        { scopeType: "PERSONS", employeeIds: [emp.employee.id] },
      );
      const token = await login(manager.user.email);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts/templates",
        headers: { authorization: `Bearer ${token}` },
        payload: { name: "Regression-Template-2", startTime: "08:00", endTime: "16:00" },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("Task 3 — GET /week, POST /generate-week, POST /copy-week", () => {
    it("GET /week: a SALONS-scoped manager's response excludes an out-of-scope employee's shift and the employee itself from the plannable-staff list", async () => {
      const inScope = await createEmployee("inscope-week");
      await createHome(inScope.employee.id, salonA.id);
      const inScopeShift = await createShift(inScope.employee.id, salonA.id, "2026-06-08"); // Monday
      const outOfScope = await createEmployee("outscope-week");
      await createHome(outOfScope.employee.id, salonB.id);
      const outOfScopeShift = await createShift(outOfScope.employee.id, salonB.id, "2026-06-09");

      const manager = await createScopedManager("mgr-week-salons", ["shift:read:ZUGEWIESEN"], {
        scopeType: "SALONS",
        salonIds: [salonA.id],
      });
      const token = await login(manager.user.email);

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/shifts/week?date=2026-06-08",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        shifts: Array<{ id: string }>;
        employees: Array<{ id: string }>;
      };
      const shiftIds = body.shifts.map((s) => s.id);
      const employeeIds = body.employees.map((e) => e.id);
      expect(shiftIds).toContain(inScopeShift.id);
      expect(shiftIds).not.toContain(outOfScopeShift.id);
      expect(employeeIds).toContain(inScope.employee.id);
      expect(employeeIds).not.toContain(outOfScope.employee.id);
    });

    it("POST /generate-week: an out-of-scope employee's pattern never generates a shift for a SALONS-scoped manager", async () => {
      const outOfScope = await createEmployee("outscope-genweek");
      await createHome(outOfScope.employee.id, salonB.id);
      // Monday-only pattern for the target week
      const template = await app.prisma.shiftTemplate.create({
        data: {
          tenantId: data.tenant.id,
          name: "Genweek-Template",
          startTime: "08:00",
          endTime: "16:00",
        },
      });
      await app.prisma.employeeShiftPattern.create({
        data: {
          employeeId: outOfScope.employee.id,
          dayOfWeek: 0, // Monday
          templateId: template.id,
          isActive: true,
          validFrom: new Date("2026-01-01"),
        },
      });

      const manager = await createScopedManager("mgr-genweek-salons", ["shift:plan:ZUGEWIESEN"], {
        scopeType: "SALONS",
        salonIds: [salonA.id],
      });
      const token = await login(manager.user.email);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts/generate-week",
        headers: { authorization: `Bearer ${token}` },
        payload: { weekStart: "2026-06-15", commit: false }, // Monday, preview only
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        create: Array<{ employeeId: string }>;
      };
      expect(body.create.map((c) => c.employeeId)).not.toContain(outOfScope.employee.id);
    });

    it("POST /copy-week: an out-of-scope employee's source shift is never copied for a SALONS-scoped manager", async () => {
      const outOfScope = await createEmployee("outscope-copyweek");
      await createHome(outOfScope.employee.id, salonB.id);
      await createShift(outOfScope.employee.id, salonB.id, "2026-06-22"); // Monday source week

      const manager = await createScopedManager("mgr-copyweek-salons", ["shift:plan:ZUGEWIESEN"], {
        scopeType: "SALONS",
        salonIds: [salonA.id],
      });
      const token = await login(manager.user.email);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts/copy-week",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          sourceWeekStart: "2026-06-22",
          targetWeekStart: "2026-06-29",
          commit: false,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        create: Array<{ employeeId: string }>;
      };
      expect(body.create.map((c) => c.employeeId)).not.toContain(outOfScope.employee.id);
    });
  });
});
