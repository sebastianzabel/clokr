/**
 * Phase 91b Plan 04 (Issue #91), D-10/D-14 — every single-`LeaveRequest` ZUGEWIESEN decision route
 * (review/correct/attest), the team iCal feed, and the Section9 decide routes 404 an
 * out-of-scope-but-real row byte-identically to a nonexistent one, with a SCOPE_ACCESS_DENIED audit
 * entry. Scoping is Stammsalon-only (D-10) — LeaveRequest/Section9Credit have no salonId column.
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
import { leaveTypeFields } from "../contexts/absence/leave-type";

const PASSWORD = "test1234";

describe("Issue #91 (Phase 91b Plan 04) — LeaveRequest/Section9Credit decision-route scope", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  let sickType: { id: string };

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
        lastName: "LeaveDecisionScopeTest",
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

  function createLeaveRequest(
    employeeId: string,
    startDate: string,
    endDate: string,
    status: "PENDING" | "APPROVED" = "PENDING",
    leaveTypeId?: string,
  ) {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: leaveTypeId ?? data.vacationType.id,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        days: 1,
        status,
      },
    });
  }

  async function createScopedManager(
    label: string,
    permissions: string[],
    scope: { scopeType: "SALONS" | "PERSONS"; salonIds?: string[]; employeeIds?: string[] },
  ) {
    const { user } = await createEmployee(label);
    const name = `LeaveDecisionScope ${crypto.randomBytes(3).toString("hex")}`;
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
    data = await seedTestData(app, "ldsc");
    salonA = await app.prisma.salon.create({
      data: {
        tenantId: data.tenant.id,
        name: "LDSC Salon A",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
      },
    });
    salonB = await app.prisma.salon.create({
      data: {
        tenantId: data.tenant.id,
        name: "LDSC Salon B",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
      },
    });
    sickType = await app.prisma.leaveType.create({
      data: { tenantId: data.tenant.id, ...leaveTypeFields("SICK"), color: "#EF4444" },
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

  it("PATCH /requests/:id/review: an out-of-scope request 404s byte-identically to a nonexistent one, with SCOPE_ACCESS_DENIED audit", async () => {
    const outOfScopeEmp = await createEmployee("outscope-review");
    await createHome(outOfScopeEmp.employee.id, salonB.id);
    const request = await createLeaveRequest(outOfScopeEmp.employee.id, "2026-07-01", "2026-07-01");

    const manager = await createScopedManager(
      "mgr-review-salons",
      ["leave-request:approve:ZUGEWIESEN"],
      { scopeType: "SALONS", salonIds: [salonA.id] },
    );
    const token = await login(manager.user.email);

    const nonExistentRes = await app.inject({
      method: "PATCH",
      url: "/api/v1/leave/requests/00000000-0000-0000-0000-000000000000/review",
      headers: { authorization: `Bearer ${token}` },
      payload: { status: "APPROVED" },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${request.id}/review`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: "APPROVED" },
    });

    expect(res.statusCode).toBe(nonExistentRes.statusCode);
    expect(res.body).toBe(nonExistentRes.body);
    expect(res.statusCode).toBe(404);

    const audit = await app.prisma.auditLog.findFirst({
      where: { action: "SCOPE_ACCESS_DENIED", entity: "LeaveRequest", entityId: request.id },
    });
    expect(audit).not.toBeNull();
  });

  it("PATCH /requests/:id/review: an in-scope request still succeeds (no regression)", async () => {
    const inScopeEmp = await createEmployee("inscope-review");
    await createHome(inScopeEmp.employee.id, salonA.id);
    const request = await createLeaveRequest(inScopeEmp.employee.id, "2026-07-02", "2026-07-02");

    const manager = await createScopedManager(
      "mgr-review-inscope",
      ["leave-request:approve:ZUGEWIESEN"],
      { scopeType: "SALONS", salonIds: [salonA.id] },
    );
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${request.id}/review`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: "APPROVED" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("PATCH /requests/:id/correct: an out-of-scope APPROVED request 404s with SCOPE_ACCESS_DENIED audit", async () => {
    const outOfScopeEmp = await createEmployee("outscope-correct");
    await createHome(outOfScopeEmp.employee.id, salonB.id);
    const request = await createLeaveRequest(
      outOfScopeEmp.employee.id,
      "2026-07-03",
      "2026-07-03",
      "APPROVED",
    );

    const manager = await createScopedManager(
      "mgr-correct-salons",
      ["leave-request:correct:ZUGEWIESEN"],
      { scopeType: "SALONS", salonIds: [salonA.id] },
    );
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${request.id}/correct`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        startDate: "2026-07-03",
        endDate: "2026-07-04",
        reason: "Testfall 91b-04 Korrektur",
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(JSON.stringify({ error: "Antrag nicht gefunden" }));

    const audit = await app.prisma.auditLog.findFirst({
      where: { action: "SCOPE_ACCESS_DENIED", entity: "LeaveRequest", entityId: request.id },
    });
    expect(audit).not.toBeNull();
  });

  it("PATCH /requests/:id/attest: an out-of-scope SICK request 404s with SCOPE_ACCESS_DENIED audit", async () => {
    const outOfScopeEmp = await createEmployee("outscope-attest");
    await createHome(outOfScopeEmp.employee.id, salonB.id);
    const request = await createLeaveRequest(
      outOfScopeEmp.employee.id,
      "2026-07-05",
      "2026-07-05",
      "APPROVED",
      sickType.id,
    );

    const manager = await createScopedManager(
      "mgr-attest-salons",
      ["leave-request:attest:ZUGEWIESEN"],
      { scopeType: "SALONS", salonIds: [salonA.id] },
    );
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${request.id}/attest`,
      headers: { authorization: `Bearer ${token}` },
      payload: { attestPresent: true },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(JSON.stringify({ error: "Antrag nicht gefunden" }));

    const audit = await app.prisma.auditLog.findFirst({
      where: { action: "SCOPE_ACCESS_DENIED", entity: "LeaveRequest", entityId: request.id },
    });
    expect(audit).not.toBeNull();
  });

  it("GET /ical/team: excludes an out-of-scope employee's APPROVED request, includes an in-scope one", async () => {
    const inScopeEmp = await createEmployee("inscope-ical");
    await createHome(inScopeEmp.employee.id, salonA.id);
    const inScopeRequest = await createLeaveRequest(
      inScopeEmp.employee.id,
      "2026-07-06",
      "2026-07-06",
      "APPROVED",
    );

    const outOfScopeEmp = await createEmployee("outscope-ical");
    await createHome(outOfScopeEmp.employee.id, salonB.id);
    const outOfScopeRequest = await createLeaveRequest(
      outOfScopeEmp.employee.id,
      "2026-07-06",
      "2026-07-06",
      "APPROVED",
    );

    const manager = await createScopedManager(
      "mgr-ical-salons",
      ["leave-request:read:ZUGEWIESEN"],
      {
        scopeType: "SALONS",
        salonIds: [salonA.id],
      },
    );
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/leave/ical/team",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`leave-${inScopeRequest.id}@clokr`);
    expect(res.body).not.toContain(`leave-${outOfScopeRequest.id}@clokr`);
  });

  it("POST /section9/:id/confirm: an out-of-scope credit 404s with SCOPE_ACCESS_DENIED audit", async () => {
    const outOfScopeEmp = await createEmployee("outscope-section9");
    await createHome(outOfScopeEmp.employee.id, salonB.id);
    const vac = await createLeaveRequest(
      outOfScopeEmp.employee.id,
      "2026-07-07",
      "2026-07-07",
      "APPROVED",
    );
    const sick = await createLeaveRequest(
      outOfScopeEmp.employee.id,
      "2026-07-07",
      "2026-07-07",
      "APPROVED",
      sickType.id,
    );
    const credit = await app.prisma.section9Credit.create({
      data: {
        employeeId: outOfScopeEmp.employee.id,
        sickRequestId: sick.id,
        vacationRequestId: vac.id,
        overlapStart: new Date("2026-07-07"),
        overlapEnd: new Date("2026-07-07"),
      },
    });

    const manager = await createScopedManager(
      "mgr-section9-salons",
      ["section9:decide:ZUGEWIESEN"],
      { scopeType: "SALONS", salonIds: [salonA.id] },
    );
    const token = await login(manager.user.email);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/leave/section9/${credit.id}/confirm`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        attestSource: "PAPIER",
        attestValidFrom: "2026-07-07",
        attestValidTo: "2026-07-07",
        reason: "Testfall 91b-04",
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(JSON.stringify({ error: "§-9-Vorgang nicht gefunden" }));

    const audit = await app.prisma.auditLog.findFirst({
      where: { action: "SCOPE_ACCESS_DENIED", entity: "Section9Credit", entityId: credit.id },
    });
    expect(audit).not.toBeNull();
  });

  it("a TENANT-scope (wholeTenant) manager is unaffected by any of the above scope checks", async () => {
    const emp = await createEmployee("wholetenant-decisions");
    await createHome(emp.employee.id, salonB.id);
    const request = await createLeaveRequest(emp.employee.id, "2026-07-08", "2026-07-08");

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${request.id}/review`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { status: "APPROVED" },
    });
    expect(res.statusCode).toBe(200);
  });
});
