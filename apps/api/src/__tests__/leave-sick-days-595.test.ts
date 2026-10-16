/**
 * Issue #595 (D-04), Plan 595-04 - GET /api/v1/leave/sick-days?year=
 *
 * The /leave page used to sum the stored, workday-priced `days` of the approved sick requests in
 * the browser, while the monthly report and both PDFs count CALENDAR days through
 * `sickLeaveDayCounts()`. The route answers the caller's own figure for a year from that same
 * kernel, so "Krankheitstage" has one meaning on the page, in the JSON and in the PDFs.
 *
 * Covered: the kernel semantics over real rows (effective statuses, soft delete, non-sick types,
 * year-edge clipping, weekends), self-reference only (an employeeId query is ignored), equality
 * with the sum of the twelve GET /reports/monthly rows, the #368 refusal, a user without an
 * employee, and input validation. Absolute dates are fine here: the year is an explicit
 * parameter and nothing depends on "now".
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, grantSystemRole } from "./setup";
import type { JwtPayload } from "../middleware/auth";
import { leaveTypeFields } from "../contexts/absence/leave-type";
import { normalizeRolePermissions, roleNameKey } from "../contexts/platform";

const PASSWORD = "test1234";

describe("Issue #595 (D-04) - GET /leave/sick-days", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let sickType: { id: string };
  let sickChildType: { id: string };
  let otherEmployeeId: string;
  // cleanupTestData removes the users of the tenant's employees; a user without an employee and
  // its role assignment are removed here
  const employeelessUserIds: string[] = [];

  function uniqueSuffix(label: string): string {
    return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
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

  async function createUser(label: string, withEmployee: boolean, grantEmployeeRole = true) {
    const s = uniqueSuffix(label);
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await app.prisma.user.create({
      data: { email: `${s}@example.invalid`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const employee = withEmployee
      ? await app.prisma.employee.create({
          data: {
            tenantId: data.tenant.id,
            userId: user.id,
            employeeNumber: s.toUpperCase().slice(0, 20),
            firstName: label,
            lastName: "SickDays595",
            hireDate: new Date("2020-01-01"),
          },
        })
      : null;
    if (grantEmployeeRole) {
      await grantSystemRole(app.prisma, {
        tenantId: data.tenant.id,
        userId: user.id,
        role: "EMPLOYEE",
      });
    }
    if (!employee) employeelessUserIds.push(user.id);
    return { user, employee };
  }

  function sick(
    employeeId: string,
    typeId: string,
    start: string,
    end: string,
    extra: Record<string, unknown> = {},
  ) {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: typeId,
        startDate: new Date(`${start}T00:00:00Z`),
        endDate: new Date(`${end}T00:00:00Z`),
        // the stored count is a workday price - deliberately NOT the calendar-day count
        days: 1,
        status: "APPROVED",
        ...extra,
      },
    });
  }

  async function sickDaysOf(token: string, year: number | string, extraQuery = "") {
    return app.inject({
      method: "GET",
      url: `/api/v1/leave/sick-days?year=${year}${extraQuery}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "sick595");
    sickType = await app.prisma.leaveType.create({
      data: { tenantId: data.tenant.id, ...leaveTypeFields("SICK"), color: "#EF4444" },
    });
    sickChildType = await app.prisma.leaveType.create({
      data: { tenantId: data.tenant.id, ...leaveTypeFields("SICK_CHILD"), color: "#F97316" },
    });
    otherEmployeeId = data.adminEmployee.id;
  });

  afterAll(async () => {
    try {
      await app.prisma.roleAssignment.deleteMany({
        where: { userId: { in: employeelessUserIds } },
      });
      await app.prisma.user.deleteMany({ where: { id: { in: employeelessUserIds } } });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("cleanup failed", err);
    }
    await closeTestApp();
  });

  it("counts calendar days of effective sick requests only, clipped at the year edges", async () => {
    const { employee, user } = await createUser("own", true);
    const empId = employee!.id;
    // Fri 2026-03-06 .. Mon 2026-03-09: weekend included -> 4 calendar days (stored days = 1)
    await sick(empId, sickType.id, "2026-03-06", "2026-03-09");
    // one weekday SICK_CHILD -> 1
    await sick(empId, sickChildType.id, "2026-04-15", "2026-04-15");
    // CANCELLATION_REQUESTED stays effective -> 2
    await sick(empId, sickType.id, "2026-05-04", "2026-05-05", {
      status: "CANCELLATION_REQUESTED",
    });
    // not effective -> 0
    await sick(empId, sickType.id, "2026-06-01", "2026-06-05", { status: "PENDING" });
    await sick(empId, sickType.id, "2026-06-08", "2026-06-12", { status: "REJECTED" });
    await sick(empId, sickType.id, "2026-06-15", "2026-06-19", { status: "CANCELLED" });
    // soft-deleted -> 0
    await sick(empId, sickType.id, "2026-07-01", "2026-07-10", { deletedAt: new Date() });
    // another type -> 0
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: empId,
        leaveTypeId: data.vacationType.id,
        startDate: new Date("2026-08-03T00:00:00Z"),
        endDate: new Date("2026-08-07T00:00:00Z"),
        days: 5,
        status: "APPROVED",
      },
    });
    // spans the year edge: 30.12. .. 02.01. -> 2 days in 2026, 2 in 2027
    await sick(empId, sickType.id, "2026-12-30", "2027-01-02");
    // another employee of the tenant never counts
    await sick(otherEmployeeId, sickType.id, "2026-03-02", "2026-03-06");

    const token = await login(user.email);

    const y2026 = await sickDaysOf(token, 2026);
    expect(y2026.statusCode).toBe(200);
    expect(y2026.json()).toEqual({ year: 2026, sickDays: 4 + 1 + 2 + 2 });

    const y2027 = await sickDaysOf(token, 2027);
    expect(y2027.statusCode).toBe(200);
    expect(y2027.json()).toEqual({ year: 2027, sickDays: 2 });
  });

  it("ignores an employeeId query: the figure is always the caller's own", async () => {
    const { employee, user } = await createUser("self", true);
    await sick(employee!.id, sickType.id, "2025-02-03", "2025-02-04");
    await sick(otherEmployeeId, sickType.id, "2025-02-03", "2025-02-14");
    const token = await login(user.email);
    const res = await sickDaysOf(token, 2025, `&employeeId=${otherEmployeeId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ year: 2025, sickDays: 2 });
  });

  it("equals the sum of the twelve GET /reports/monthly rows of the year", async () => {
    const { employee, user } = await createUser("equal", true);
    const empId = employee!.id;
    await sick(empId, sickType.id, "2024-01-29", "2024-02-02"); // crosses a month edge
    await sick(empId, sickType.id, "2024-03-08", "2024-03-10"); // Fri..Sun
    await sick(empId, sickChildType.id, "2024-06-12", "2024-06-12", { halfDay: true });
    await sick(empId, sickType.id, "2024-12-30", "2025-01-03"); // crosses the year edge
    await sick(empId, sickType.id, "2024-09-02", "2024-09-06", {
      attestPresent: true,
      attestValidFrom: new Date("2024-09-04T00:00:00Z"),
      attestValidTo: new Date("2024-09-06T00:00:00Z"),
    });

    const token = await login(user.email);
    const res = await sickDaysOf(token, 2024);
    expect(res.statusCode).toBe(200);
    const routeFigure = (res.json() as { sickDays: number }).sickDays;

    let reportSum = 0;
    for (let month = 1; month <= 12; month++) {
      const monthly = await app.inject({
        method: "GET",
        url: `/api/v1/reports/monthly?employeeId=${empId}&year=2024&month=${month}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(monthly.statusCode).toBe(200);
      const body = monthly.json() as { rows: Array<{ employeeId: string; sickDays: number }> };
      const row = body.rows.find((r) => r.employeeId === empId);
      expect(row).toBeDefined();
      reportSum += row!.sickDays;
    }
    // 5 (29.01.-02.02.) + 3 (08.-10.03.) + 0.5 (half day) + 2 (30.-31.12.) + 5 (02.-06.09.)
    expect(routeFigure).toBe(15.5);
    expect(routeFigure).toBe(reportSum);
  });

  it("answers 403 like GET /leave/requests for a caller without any leave-request:read reach (#368)", async () => {
    const { user } = await createUser("noreach", true, false);
    const name = `SickDays595 ${crypto.randomBytes(3).toString("hex")}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId: data.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions(["shift:read:ZUGEWIESEN"]),
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        accessRoleId: role.id,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
    const token = await login(user.email);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${token}` },
    });
    const res = await sickDaysOf(token, 2026);
    expect(res.statusCode).toBe(403);
    expect(res.statusCode).toBe(list.statusCode);
    expect(res.body).toBe(list.body);
  });

  it("answers sickDays 0 for a user without an employee", async () => {
    const { user } = await createUser("noemp", false);
    // a user without an employee cannot sign in (the tenant comes from the employee), so the
    // token carries exactly the claims a login would have issued minus the employee
    const token = app.jwt.sign({ sub: user.id, tenantId: data.tenant.id } as JwtPayload);
    const res = await sickDaysOf(token, 2026);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ year: 2026, sickDays: 0 });
  });

  it("rejects an invalid or missing year with 400", async () => {
    const { user } = await createUser("badyear", true);
    const token = await login(user.email);
    for (const year of ["abc", "1999", "2101", "2026.5"]) {
      const res = await sickDaysOf(token, year);
      expect(res.statusCode, year).toBe(400);
    }
    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/leave/sick-days",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(missing.statusCode).toBe(400);
  });

  it("requires authentication", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/leave/sick-days?year=2026" });
    expect(res.statusCode).toBe(401);
  });
});
