/**
 * Phase 91b Plan 07 (Issue #91), D-10/D-13/D-14 — every report/export route in reports.ts (and the
 * activity feed's team leave submissions) narrows to Stammsalon-scoped employees BEFORE building
 * the report body. reports.ts had ZERO scope narrowing of any kind before this plan (0
 * employeeScopeFor calls in the whole file).
 *
 * No person names in fixtures (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
} from "../../__tests__/setup";
import { normalizeRolePermissions, roleNameKey } from "../../contexts/platform";

const PASSWORD = "test1234";

describe("Issue #91 (Phase 91b Plan 07) — reports.ts / activity.ts salon/person scope", () => {
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
        lastName: "ReportsScopeTest",
        hireDate: new Date("2020-01-01"),
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
        lastName: "ReportsScopeManager",
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
    const name = `ReportsScope ${crypto.randomBytes(3).toString("hex")}`;
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
    data = await seedTestData(app, "rpsc");
    salonA = await createTestSalon(app.prisma, data.tenant.id, { name: "RPSC Salon A" });
    salonB = await createTestSalon(app.prisma, data.tenant.id, { name: "RPSC Salon B" });
    // /datev and /datev/employee refuse with 409 without a configured Kanzlei.
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { datevBeraterNr: 12345, datevMandantenNr: 6789 },
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

  it("GET /monthly: a SALONS-scoped manager excludes an out-of-scope employee's row", async () => {
    const inScope = await createEmployee("inscope-monthly");
    await createHome(inScope.employee.id, salonA.id);
    const outOfScope = await createEmployee("outscope-monthly");
    await createHome(outOfScope.employee.id, salonB.id);

    const manager = await createScopedManager("mgr-monthly", ["report:read:ZUGEWIESEN"], {
      scopeType: "SALONS",
      salonIds: [salonA.id],
    });
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/reports/monthly?year=2026&month=6",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const ids = (JSON.parse(res.body) as { rows: Array<{ employeeId: string }> }).rows.map(
      (r) => r.employeeId,
    );
    expect(ids).toContain(inScope.employee.id);
    expect(ids).not.toContain(outOfScope.employee.id);
  });

  it("GET /monthly: an out-of-scope explicit ?employeeId yields an empty rows array", async () => {
    const outOfScope = await createEmployee("outscope-monex");
    await createHome(outOfScope.employee.id, salonB.id);

    const manager = await createScopedManager("mgr-monex", ["report:read:ZUGEWIESEN"], {
      scopeType: "SALONS",
      salonIds: [salonA.id],
    });
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly?year=2026&month=6&employeeId=${outOfScope.employee.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { rows: unknown[] };
    expect(body.rows).toEqual([]);
  });

  it("GET /monthly: a TENANT-scope (wholeTenant) manager is unaffected", async () => {
    const emp = await createEmployee("wholetenant-monthly");
    await createHome(emp.employee.id, salonB.id);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/reports/monthly?year=2026&month=6",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const ids = (JSON.parse(res.body) as { rows: Array<{ employeeId: string }> }).rows.map(
      (r) => r.employeeId,
    );
    expect(ids).toContain(emp.employee.id);
  });

  it("GET /leave-overview: excludes an out-of-scope employee's entitlement", async () => {
    const inScope = await createEmployee("inscope-leaveoverview");
    await createHome(inScope.employee.id, salonA.id);
    const outOfScope = await createEmployee("outscope-leaveoverview");
    await createHome(outOfScope.employee.id, salonB.id);
    await app.prisma.leaveEntitlement.createMany({
      data: [
        {
          employeeId: inScope.employee.id,
          leaveTypeId: data.vacationType.id,
          year: 2026,
          totalDays: 30,
        },
        {
          employeeId: outOfScope.employee.id,
          leaveTypeId: data.vacationType.id,
          year: 2026,
          totalDays: 30,
        },
      ],
    });

    const manager = await createScopedManager("mgr-leaveoverview", ["report:read:ZUGEWIESEN"], {
      scopeType: "SALONS",
      salonIds: [salonA.id],
    });
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/reports/leave-overview?year=2026",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const ids = (JSON.parse(res.body) as Array<{ employee: { id: string } }>).map(
      (r) => r.employee.id,
    );
    expect(ids).toContain(inScope.employee.id);
    expect(ids).not.toContain(outOfScope.employee.id);
  });

  it("GET /carryover-at-risk: excludes an out-of-scope employee's entitlement", async () => {
    const inScope = await createEmployee("inscope-carryover");
    await createHome(inScope.employee.id, salonA.id);
    const outOfScope = await createEmployee("outscope-carryover");
    await createHome(outOfScope.employee.id, salonB.id);
    const soon = new Date();
    soon.setDate(soon.getDate() + 30);
    await app.prisma.leaveEntitlement.createMany({
      data: [
        {
          employeeId: inScope.employee.id,
          leaveTypeId: data.vacationType.id,
          year: 2026,
          totalDays: 30,
          carriedOverDays: 5,
          carryOverDeadline: soon,
        },
        {
          employeeId: outOfScope.employee.id,
          leaveTypeId: data.vacationType.id,
          year: 2026,
          totalDays: 30,
          carriedOverDays: 5,
          carryOverDeadline: soon,
        },
      ],
    });

    const manager = await createScopedManager("mgr-carryover-at-risk", ["report:read:ZUGEWIESEN"], {
      scopeType: "SALONS",
      salonIds: [salonA.id],
    });
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/reports/carryover-at-risk?days=90",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const ids = (JSON.parse(res.body) as { rows: Array<{ employee: { id: string } }> }).rows.map(
      (r) => r.employee.id,
    );
    expect(ids).toContain(inScope.employee.id);
    expect(ids).not.toContain(outOfScope.employee.id);
  });

  it("POST /carryover-warn (NEW finding — single entitlement, not a list): an out-of-scope entitlement 404s with SCOPE_ACCESS_DENIED audit", async () => {
    const outOfScope = await createEmployee("outscope-carryover-warn");
    await createHome(outOfScope.employee.id, salonB.id);
    const soon = new Date();
    soon.setDate(soon.getDate() + 30);
    const ent = await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: outOfScope.employee.id,
        leaveTypeId: data.vacationType.id,
        year: 2026,
        totalDays: 30,
        carriedOverDays: 5,
        carryOverDeadline: soon,
      },
    });

    const manager = await createScopedManager("mgr-carryover-warn", ["report:notify:ZUGEWIESEN"], {
      scopeType: "SALONS",
      salonIds: [salonA.id],
    });
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/reports/carryover-warn",
      headers: { authorization: `Bearer ${token}` },
      payload: { entitlementId: ent.id },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(JSON.stringify({ error: "Anspruch nicht gefunden" }));

    const audit = await app.prisma.auditLog.findFirst({
      where: { action: "SCOPE_ACCESS_DENIED", entity: "LeaveEntitlement", entityId: ent.id },
    });
    expect(audit).not.toBeNull();
  });

  it("GET /datev: excludes an out-of-scope employee from the export", async () => {
    const inScope = await createEmployee("inscope-datev");
    await createHome(inScope.employee.id, salonA.id);
    const outOfScope = await createEmployee("outscope-datev");
    await createHome(outOfScope.employee.id, salonB.id);

    const manager = await createScopedManager("mgr-datev", ["report:export:ZUGEWIESEN"], {
      scopeType: "SALONS",
      salonIds: [salonA.id],
    });
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/reports/datev?year=2026&month=6",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body).toContain(inScope.employee.employeeNumber);
    expect(body).not.toContain(outOfScope.employee.employeeNumber);
  });

  it("GET /datev/employee (NEW finding — single employee, not a list): an out-of-scope employee 404s with SCOPE_ACCESS_DENIED audit", async () => {
    const outOfScope = await createEmployee("outscope-datev-emp");
    await createHome(outOfScope.employee.id, salonB.id);

    const manager = await createScopedManager("mgr-datev-employee", ["report:export:ZUGEWIESEN"], {
      scopeType: "SALONS",
      salonIds: [salonA.id],
    });
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/datev/employee?employeeId=${outOfScope.employee.id}&year=2026&month=6`,
      headers: { authorization: `Bearer ${token}` },
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

  it("GET /monthly/pdf: an out-of-scope employee 404s with SCOPE_ACCESS_DENIED audit", async () => {
    const outOfScope = await createEmployee("outscope-monthly-pdf");
    await createHome(outOfScope.employee.id, salonB.id);

    const manager = await createScopedManager("mgr-monthly-pdf", ["report:export:ZUGEWIESEN"], {
      scopeType: "SALONS",
      salonIds: [salonA.id],
    });
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly/pdf?employeeId=${outOfScope.employee.id}&year=2026&month=6`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);

    const audit = await app.prisma.auditLog.findFirst({
      where: {
        action: "SCOPE_ACCESS_DENIED",
        entity: "Employee",
        entityId: outOfScope.employee.id,
      },
    });
    expect(audit).not.toBeNull();
  });

  // The 4 PDF-only routes below (monthly/pdf/all, leave-list/pdf, vacation/pdf,
  // leave-overview/pdf) reuse the EXACT SAME employee/entitlement query-narrowing code already
  // proven correct end to end by the JSON-returning tests above (GET /monthly, /leave-overview,
  // /datev) — same resolveStammsalonScopedEmployeeIds call, same `where` fold. A byte-content
  // substring search on the PDF payload was tried and found VACUOUS: PDFKit's default output
  // Flate-compresses its content streams, so `rawPayload.toString("latin1")).not.toContain(...)`
  // passed identically whether or not the out-of-scope employee's data was actually excluded
  // (verified empirically — it passed against BOTH the fixed and the unfixed handler). This
  // matches this codebase's own existing convention for these routes
  // (`reports-sick-days.test.ts` Tests 4-6): only the `%PDF` header and content-type are ever
  // asserted for a PDF response, never its compressed byte content.
  it("GET /monthly/pdf/all: renders successfully for a SALONS-scoped manager with a mixed in/out-of-scope tenant", async () => {
    const inScope = await createEmployee("inscope-pdfall");
    await createHome(inScope.employee.id, salonA.id);
    const outOfScope = await createEmployee("outscope-pdfall");
    await createHome(outOfScope.employee.id, salonB.id);

    const manager = await createScopedManager("mgr-pdfall", ["report:export:ZUGEWIESEN"], {
      scopeType: "SALONS",
      salonIds: [salonA.id],
    });
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/reports/monthly/pdf/all?year=2026&month=6",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("GET /leave-list/pdf: renders successfully for a SALONS-scoped manager with a mixed in/out-of-scope tenant", async () => {
    const outOfScope = await createEmployee("outscope-llpdf");
    await createHome(outOfScope.employee.id, salonB.id);

    const manager = await createScopedManager("mgr-leavelistpdf", ["report:export:ZUGEWIESEN"], {
      scopeType: "SALONS",
      salonIds: [salonA.id],
    });
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/reports/leave-list/pdf?year=2026",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("GET /vacation/pdf: renders successfully for a SALONS-scoped manager with a mixed in/out-of-scope tenant (both datasets)", async () => {
    const outOfScope = await createEmployee("outscope-vacpdf");
    await createHome(outOfScope.employee.id, salonB.id);
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: outOfScope.employee.id,
        leaveTypeId: data.vacationType.id,
        year: 2026,
        totalDays: 30,
      },
    });

    const manager = await createScopedManager("mgr-vacationpdf", ["report:export:ZUGEWIESEN"], {
      scopeType: "SALONS",
      salonIds: [salonA.id],
    });
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/reports/vacation/pdf?year=2026",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("GET /leave-overview/pdf: renders successfully for a SALONS-scoped manager with a mixed in/out-of-scope tenant", async () => {
    const outOfScope = await createEmployee("outscope-lopdf");
    await createHome(outOfScope.employee.id, salonB.id);
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: outOfScope.employee.id,
        leaveTypeId: data.vacationType.id,
        year: 2026,
        totalDays: 30,
      },
    });

    const manager = await createScopedManager(
      "mgr-leaveoverviewpdf",
      ["report:export:ZUGEWIESEN"],
      { scopeType: "SALONS", salonIds: [salonA.id] },
    );
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/reports/leave-overview/pdf?year=2026",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 4).toString()).toBe("%PDF");
  });

  describe("activity feed — narrowing inside the query, before take: fetchLimit (D-13 under-fill proof)", () => {
    it("under-fill fixture: the ONE in-scope submission is OLDER than 12 out-of-scope ones (fetchLimit=10 for ?limit=2) — it must still appear, which only holds if scope narrows INSIDE the query, before the top-N cut", async () => {
      // If narrowing happened via a POST-filter (fetch top fetchLimit=10 most-recent tenant-wide,
      // THEN drop out-of-scope rows), the in-scope row here — the OLDEST of 13 — would never even
      // be among the fetched 10 and would silently vanish from the feed. It appears only if the
      // scope filter is inside the WHERE clause itself, fetching the in-scope row regardless of
      // how many more-recent out-of-scope rows exist.
      const inScope = await createEmployee("inscope-activity");
      await createHome(inScope.employee.id, salonA.id);
      const inScopeRequest = await app.prisma.leaveRequest.create({
        data: {
          employeeId: inScope.employee.id,
          leaveTypeId: data.vacationType.id,
          startDate: new Date("2026-06-01"),
          endDate: new Date("2026-06-01"),
          days: 1,
          status: "PENDING",
        },
      });

      // 12 out-of-scope submissions, created AFTER (so every one sorts more recent by
      // createdAt/`when`) — more than fetchLimit (10 for ?limit=2).
      for (let i = 0; i < 12; i++) {
        const outOfScope = await createEmployee(`outscope-activity-${i}`);
        await createHome(outOfScope.employee.id, salonB.id);
        await app.prisma.leaveRequest.create({
          data: {
            employeeId: outOfScope.employee.id,
            leaveTypeId: data.vacationType.id,
            startDate: new Date("2026-06-02"),
            endDate: new Date("2026-06-02"),
            days: 1,
            status: "PENDING",
          },
        });
      }

      const manager = await createScopedManager(
        "mgr-activity-underfill",
        ["team-overview:read:ZUGEWIESEN"],
        { scopeType: "SALONS", salonIds: [salonA.id] },
      );
      const token = await login(manager.user.email);

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/activity?limit=2",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { items: Array<{ id: string }> };
      expect(body.items.map((i) => i.id)).toContain(`tlr-${inScopeRequest.id}`);
    });
  });
});
