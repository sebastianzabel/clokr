/**
 * Phase 76b Plan 04 (Issue #76), AK-76b-4 — proves the SHIPPED Personalabteilung template bundle
 * (`SYSTEM_ROLE_IDS.HR`, migrated in Plan 76b-01) against real routes: 403 on daily time data
 * (time entries/breaks, monthly report with daily rows) regardless of the id passed, 200 on
 * account/contract-shaped data (saldo, month-close status, leave requests, Berufsschule absences,
 * Stammdaten, WorkSchedule) for ANY employee of the tenant, and 403 on every approval.
 *
 * D-12/RESEARCH.md anti-pattern: the role assignment below points at the REAL
 * `SYSTEM_ROLE_IDS.HR` row, never an ad-hoc custom `AccessRole` — the point is proving the shipped
 * bundle, not a hand-picked permission set.
 *
 * No person names in fixtures (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { SYSTEM_ROLE_IDS, type SystemRoleSlot } from "../contexts/platform";
import { pastDateStr, todayStr, futureDateStr } from "./test-dates";

const PASSWORD = "test1234";

// P-02 mutation-proof lever (Task 1 <action>): flipping this single constant to "ADMIN"
// must make the corresponding cases below fail — that is the mutation proof itself, run and
// restored during execution, quoted in the SUMMARY, never left flipped in the committed file.
const TEMPLATE_SLOT: SystemRoleSlot = "HR";

describe("Issue #76 (Phase 76b Plan 04), AK-76b-4 — Personalabteilung behavioural matrix", () => {
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
        lastName: "SystemRoleTemplateTest",
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
   * Assigns a REAL system-role slot (never an ad-hoc AccessRole) to `userId`. Defaults to TENANT
   * scope with no salon/employee narrowing (D-07's own intended scope for Personalabteilung).
   */
  function assignSystemRole(
    userId: string,
    slot: SystemRoleSlot,
    scope: {
      scopeType?: "TENANT" | "SALONS" | "PERSONS";
      salonIds?: string[];
      employeeIds?: string[];
    } = {},
  ) {
    return app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId,
        accessRoleId: SYSTEM_ROLE_IDS[slot],
        scopeType: scope.scopeType ?? "TENANT",
        salonIds: scope.salonIds ?? [],
        employeeIds: scope.employeeIds ?? [],
      },
    });
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

  let x: Awaited<ReturnType<typeof createEmployee>>;
  let y: Awaited<ReturnType<typeof createEmployee>>;
  let hr: Awaited<ReturnType<typeof createEmployee>>;
  let hrToken: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "sprt");
    salonA = await createTestSalon(app.prisma, data.tenant.id, { name: "SPRT Salon A" });
    salonB = await createTestSalon(app.prisma, data.tenant.id, { name: "SPRT Salon B" });

    x = await createEmployee("template-x");
    await createHome(x.employee.id, salonA.id);
    await createEntry(x.employee.id, salonA.id, pastDateStr(5));

    y = await createEmployee("template-y");
    await createHome(y.employee.id, salonB.id);
    await createEntry(y.employee.id, salonB.id, pastDateStr(4));

    hr = await createEmployee("template-hr");
    await createEntry(hr.employee.id, salonA.id, pastDateStr(3));
    await assignSystemRole(hr.user.id, TEMPLATE_SLOT, { scopeType: "TENANT" });

    hrToken = await login(hr.user.email);
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  const from = pastDateStr(90);
  const to = todayStr();
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1);

  describe("Task 1 (P-02): GET /time-entries is 403 for the HR bundle, regardless of id", () => {
    it("employeeId=<X, in-tenant> → 403 Forbidden", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/time-entries?employeeId=${x.employee.id}&from=${from}&to=${to}`,
        headers: { authorization: `Bearer ${hrToken}` },
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: "Forbidden" });
    });

    it("employeeId=<Y, in-tenant, other salon> → 403 Forbidden", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/time-entries?employeeId=${y.employee.id}&from=${from}&to=${to}`,
        headers: { authorization: `Bearer ${hrToken}` },
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: "Forbidden" });
    });

    it("employeeId=<nonexistent> → 403 Forbidden", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/time-entries?employeeId=00000000-0000-4000-8000-000000000001&from=${from}&to=${to}`,
        headers: { authorization: `Bearer ${hrToken}` },
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: "Forbidden" });
    });

    it("employeeId=<HR's own employee id> → 403 Forbidden", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/time-entries?employeeId=${hr.employee.id}&from=${from}&to=${to}`,
        headers: { authorization: `Bearer ${hrToken}` },
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: "Forbidden" });
    });

    it("no employeeId param → 403 Forbidden", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/time-entries?from=${from}&to=${to}`,
        headers: { authorization: `Bearer ${hrToken}` },
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: "Forbidden" });
    });

    it("control: the tenant admin's identical request still answers 200 with X's entry", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/time-entries?employeeId=${x.employee.id}&from=${from}&to=${to}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const ids = (JSON.parse(res.body) as Array<{ employeeId: string }>).map((r) => r.employeeId);
      expect(ids).toContain(x.employee.id);
    });
  });

  describe("Task 1: monthly report routes are 403 for the HR bundle (report:* excluded, D-07)", () => {
    it("GET /reports/monthly?employeeId=<X> → 403", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/reports/monthly?employeeId=${x.employee.id}&year=${year}&month=${month}`,
        headers: { authorization: `Bearer ${hrToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("GET /reports/monthly/pdf?employeeId=<X> → 403", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/reports/monthly/pdf?employeeId=${x.employee.id}&year=${year}&month=${month}`,
        headers: { authorization: `Bearer ${hrToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("GET /reports/monthly/pdf/all?year&month → 403", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/reports/monthly/pdf/all?year=${year}&month=${month}`,
        headers: { authorization: `Bearer ${hrToken}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("Task 2: HR reads saldo, month-close, leave and Berufsschule absences of ANY employee (D-07)", () => {
    let overtimeAccount: { id: string; employeeId: string };
    let pendingLeaveRequest: { id: string };
    let bsAbsence: { id: string };
    const bsDate = futureDateStr(20);

    beforeAll(async () => {
      overtimeAccount = await app.prisma.overtimeAccount.create({
        data: { employeeId: y.employee.id, balanceHours: 3.5 },
      });
      pendingLeaveRequest = await app.prisma.leaveRequest.create({
        data: {
          employeeId: y.employee.id,
          leaveTypeId: data.vacationType.id,
          startDate: new Date(futureDateStr(30)),
          endDate: new Date(futureDateStr(30)),
          days: 1,
          status: "PENDING",
        },
      });
      bsAbsence = await app.prisma.absence.create({
        data: {
          employeeId: y.employee.id,
          type: "VOCATIONAL_SCHOOL",
          source: "PATTERN",
          startDate: new Date(bsDate),
          endDate: new Date(bsDate),
          days: 1,
          createdBy: "SYSTEM",
        },
      });
    });

    it("GET /overtime/<Y> → 200 with Y's account (identity field, not a live-computed balance)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/${y.employee.id}`,
        headers: { authorization: `Bearer ${hrToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { id: string; employeeId: string };
      expect(body.id).toBe(overtimeAccount.id);
      expect(body.employeeId).toBe(y.employee.id);
    });

    it("GET /overtime/close-month/status?year&month → 200", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/close-month/status?year=${year}&month=${month}`,
        headers: { authorization: `Bearer ${hrToken}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it("GET /leave/requests?employeeId=<Y> → 200 containing Y's PENDING request", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/leave/requests?employeeId=${y.employee.id}`,
        headers: { authorization: `Bearer ${hrToken}` },
      });
      expect(res.statusCode).toBe(200);
      const ids = (JSON.parse(res.body) as Array<{ id: string }>).map((r) => r.id);
      expect(ids).toContain(pendingLeaveRequest.id);
    });

    it("GET /vocational-school/upcoming?employeeId=<Y> → 200 containing Y's absence", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/vocational-school/upcoming?from=${pastDateStr(1)}&to=${futureDateStr(60)}&employeeId=${y.employee.id}`,
        headers: { authorization: `Bearer ${hrToken}` },
      });
      expect(res.statusCode).toBe(200);
      const ids = (JSON.parse(res.body) as Array<{ id: string }>).map((r) => r.id);
      expect(ids).toContain(bsAbsence.id);
    });

    it("no approval: PATCH /leave/requests/<Y's pending id>/review → 403, status stays PENDING", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/requests/${pendingLeaveRequest.id}/review`,
        headers: { authorization: `Bearer ${hrToken}` },
        payload: { status: "APPROVED" },
      });
      expect(res.statusCode).toBe(403);
      const stored = await app.prisma.leaveRequest.findUniqueOrThrow({
        where: { id: pendingLeaveRequest.id },
      });
      expect(stored.status).toBe("PENDING");
    });
  });

  describe("Task 2: HR maintains Stammdaten and WorkSchedule for ANY employee, with audit (D-07)", () => {
    beforeAll(async () => {
      // GET/PUT /settings/work/:employeeId 404 without a stored WorkSchedule row — createEmployee()
      // deliberately mirrors the *-salon-scope.test.ts fixtures (no WorkSchedule), so this describe
      // block provisions Y's own contract row, same shape as seedTenantFixture's own employees.
      await app.prisma.workSchedule.create({
        data: {
          employeeId: y.employee.id,
          weeklyHours: 40,
          mondayHours: 8,
          tuesdayHours: 8,
          wednesdayHours: 8,
          thursdayHours: 8,
          fridayHours: 8,
          saturdayHours: 0,
          sundayHours: 0,
          validFrom: new Date("2024-01-01"),
        },
      });
    });

    it("GET /employees/<Y> → 200", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/employees/${y.employee.id}`,
        headers: { authorization: `Bearer ${hrToken}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it("PATCH /employees/<Y> {employeeNumber} (no role) → 200, exactly one new Employee audit row by HR", async () => {
      const newNumber = uniqueSuffix("upd").toUpperCase().slice(0, 20);
      const before = await app.prisma.auditLog.count({
        where: { entity: "Employee", entityId: y.employee.id },
      });

      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/employees/${y.employee.id}`,
        headers: { authorization: `Bearer ${hrToken}` },
        payload: { employeeNumber: newNumber },
      });
      expect(res.statusCode).toBe(200);

      const after = await app.prisma.auditLog.count({
        where: { entity: "Employee", entityId: y.employee.id },
      });
      expect(after - before).toBe(1);
      const rows = await app.prisma.auditLog.findMany({
        where: { entity: "Employee", entityId: y.employee.id },
        orderBy: { createdAt: "desc" },
        take: 1,
      });
      expect(rows[0].userId).toBe(hr.user.id);
    });

    it("GET /settings/work/<Y> → 200", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/settings/work/${y.employee.id}`,
        headers: { authorization: `Bearer ${hrToken}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it("PUT /settings/work/<Y> with validFrom = 1st of next month → 200, new WorkSchedule audit row by HR", async () => {
      const d = new Date();
      const nextMonthFirst = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
      const validFrom = nextMonthFirst.toISOString().slice(0, 10);

      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/settings/work/${y.employee.id}`,
        headers: { authorization: `Bearer ${hrToken}` },
        payload: {
          type: "FIXED_SCHEDULE",
          weeklyHours: 40,
          validFrom,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { id: string };

      // The audit row's entityId is the WorkSchedule row's own id (settings.ts:1322), never the
      // employeeId — a validFrom with no exact-match existing row creates a NEW row (CREATE),
      // never an update-in-place, so there is exactly one audit row for this new id.
      const rows = await app.prisma.auditLog.findMany({
        where: { entity: "WorkSchedule", entityId: body.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(hr.user.id);
      expect(rows[0].action).toBe("CREATE");
    });
  });

  describe("Task 2: Personalabteilung + Mitarbeiter (working HR person) never sees another employee's entries", () => {
    it("GET /time-entries?employeeId=<X> → 200 with only HR2's own entries", async () => {
      const hr2 = await createEmployee("template-hr2");
      await createEntry(hr2.employee.id, salonA.id, pastDateStr(2));
      await assignSystemRole(hr2.user.id, "HR", { scopeType: "TENANT" });
      await assignSystemRole(hr2.user.id, "EMPLOYEE", { scopeType: "TENANT" });
      const hr2Token = await login(hr2.user.email);

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/time-entries?employeeId=${x.employee.id}&from=${from}&to=${to}`,
        headers: { authorization: `Bearer ${hr2Token}` },
      });
      expect(res.statusCode).toBe(200);
      const rows = JSON.parse(res.body) as Array<{ employeeId: string }>;
      for (const row of rows) {
        expect(row.employeeId).toBe(hr2.employee.id);
      }
      expect(rows.map((r) => r.employeeId)).not.toContain(x.employee.id);
    });
  });
});
