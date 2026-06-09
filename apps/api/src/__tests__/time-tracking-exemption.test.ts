/**
 * Phase 76.7 — § 18 ArbZG Tracking Exemption (Plan 01).
 *
 * Covers D-23 Tests 1-6 + Test 9 (regression):
 *   1. updateOvertimeAccount is a no-op for exempt — balanceHours unchanged
 *   2. checkArbZG returns [] for exempt employees with a 12h day
 *   3. GET /overtime/close-month/status excludes exempt from result list
 *   4. GET /overtime/close-month/year-status excludes exempt from totalCount
 *   5. POST /overtime/close-month for exempt → 200 {skipped:true}, no SaldoSnapshot
 *   6. recalculateSnapshots skips exempt (snapshot unchanged)
 *   9. Non-exempt regression — updateOvertimeAccount + checkArbZG still fire
 *
 * Pattern mirrors overtime-monthly-hours-and-shift-saldo.test.ts:
 * shared singleton Fastify app, fresh tenant per suite, no Date mocking,
 * try/catch cleanup in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, cleanupTestData } from "./setup";
import { updateOvertimeAccount } from "../routes/time-entries";
import { checkArbZG } from "../utils/arbzg";
import { recalculateSnapshots } from "../utils/recalculate-snapshots";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";

const TZ = "Europe/Berlin";

describe("Phase 76.7 — § 18 ArbZG tracking exemption", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let exemptEmpId: string;
  let nonExemptEmpId: string;
  let adminToken: string;

  // Use a stable past month for close-month tests (must be in the past so the
  // endpoint accepts "monatsabschluss"; far enough back that hire date predates).
  const TEST_YEAR = 2025;
  const TEST_MONTH = 3; // March 2025

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const s = "tte-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    // ── Tenant ──────────────────────────────────────────────────────────────
    const tenant = await prisma.tenant.create({
      data: {
        name: `TimeTrackingExemption Test ${s}`,
        slug: `tte-${s}`,
        federalState: "NIEDERSACHSEN",
      },
    });
    tenantId = tenant.id;
    await prisma.tenantConfig.create({
      data: { tenantId: tenant.id, defaultVacationDays: 30, timezone: TZ },
    });

    // ── Admin user (token for HTTP endpoint tests) ──────────────────────────
    const adminUser = await prisma.user.create({
      data: {
        email: `admin-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "ADMIN",
        isActive: true,
      },
    });
    const adminEmp = await prisma.employee.create({
      data: {
        tenantId: tenant.id,
        userId: adminUser.id,
        employeeNumber: `ADM-${s}`,
        firstName: "Admin",
        lastName: "TTE",
        hireDate: new Date("2024-01-01"),
      },
    });
    await prisma.workSchedule.create({
      data: {
        employeeId: adminEmp.id,
        type: "FIXED_SCHEDULE",
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
    await prisma.overtimeAccount.create({ data: { employeeId: adminEmp.id, balanceHours: 0 } });

    // Login as admin to get token
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `admin-${s}@test.de`, password: "test1234" },
    });
    adminToken = JSON.parse(loginRes.body).accessToken;

    // ── Exempt employee (Inhaberin-style — § 18 ArbZG) ──────────────────────
    const exemptUser = await prisma.user.create({
      data: {
        email: `exempt-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const exemptEmp = await prisma.employee.create({
      data: {
        tenantId: tenant.id,
        userId: exemptUser.id,
        employeeNumber: `EX-${s}`,
        firstName: "Inhaberin",
        lastName: "Exempt",
        hireDate: new Date("2024-01-01"),
        isTimeTrackingExempt: true, // Phase 76.7 (D-01)
      },
    });
    exemptEmpId = exemptEmp.id;
    await prisma.workSchedule.create({
      data: {
        employeeId: exemptEmp.id,
        type: "FIXED_SCHEDULE",
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
    // Pre-seed balanceHours = 5 so Test 1 can assert it stays unchanged after the
    // updateOvertimeAccount call (proves D-04/D-10 — no reset).
    await prisma.overtimeAccount.create({
      data: { employeeId: exemptEmp.id, balanceHours: 5 },
    });

    // ── Non-exempt employee (regression coverage) ───────────────────────────
    const nonExemptUser = await prisma.user.create({
      data: {
        email: `non-exempt-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const nonExemptEmp = await prisma.employee.create({
      data: {
        tenantId: tenant.id,
        userId: nonExemptUser.id,
        employeeNumber: `NE-${s}`,
        firstName: "Regular",
        lastName: "Employee",
        hireDate: new Date("2024-01-01"),
        isTimeTrackingExempt: false, // explicit for clarity
      },
    });
    nonExemptEmpId = nonExemptEmp.id;
    await prisma.workSchedule.create({
      data: {
        employeeId: nonExemptEmp.id,
        type: "FIXED_SCHEDULE",
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
    await prisma.overtimeAccount.create({
      data: { employeeId: nonExemptEmp.id, balanceHours: 0 },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // ── D-23 Test 1 ────────────────────────────────────────────────────────────
  it("updateOvertimeAccount is a no-op for exempt employees (balanceHours unchanged)", async () => {
    // Seed 5 weekday TimeEntries totaling 40h that would normally swing the saldo
    // for a non-exempt employee. For the exempt one, balanceHours must stay at 5.
    const baseDay = new Date("2025-03-03T00:00:00Z"); // Monday
    for (let i = 0; i < 5; i++) {
      const date = new Date(baseDay.getTime() + i * 86400000);
      const start = new Date(date.getTime() + 8 * 3600 * 1000); // 08:00 UTC
      const end = new Date(date.getTime() + 16 * 3600 * 1000); // 16:00 UTC (8h)
      await app.prisma.timeEntry.create({
        data: {
          employeeId: exemptEmpId,
          date,
          startTime: start,
          endTime: end,
          breakMinutes: 0,
          type: "WORK",
        },
      });
    }

    const before = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: exemptEmpId },
    });
    expect(Number(before?.balanceHours)).toBe(5);

    await updateOvertimeAccount(app, exemptEmpId);

    const after = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: exemptEmpId },
    });
    // D-04 + D-10: NOT reset to 0, NOT recomputed → still 5
    expect(Number(after?.balanceHours)).toBe(5);
  });

  // ── D-23 Test 2 ────────────────────────────────────────────────────────────
  it("checkArbZG returns [] for exempt employees with 12h TimeEntry", async () => {
    const date = new Date("2025-03-10T00:00:00Z"); // Monday
    await app.prisma.timeEntry.create({
      data: {
        employeeId: exemptEmpId,
        date,
        startTime: new Date("2025-03-10T07:00:00Z"),
        endTime: new Date("2025-03-10T19:00:00Z"), // 12h
        breakMinutes: 0,
        type: "WORK",
      },
    });

    const warnings = await checkArbZG(app.prisma, exemptEmpId, date);
    // D-05: exempt employees skip § 3 / § 4 / § 5 — zero warnings.
    expect(warnings).toEqual([]);
  });

  // ── D-23 Test 3 ────────────────────────────────────────────────────────────
  it("GET /overtime/close-month/status excludes exempt employees", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/close-month/status?year=${TEST_YEAR}&month=${TEST_MONTH}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const ids: string[] = body.employees.map((e: { employeeId: string }) => e.employeeId);
    // D-07: exempt employee MUST NOT appear in close-month/status.
    expect(ids).not.toContain(exemptEmpId);
    // Non-exempt employee IS in the list.
    expect(ids).toContain(nonExemptEmpId);
  });

  // ── D-23 Test 4 ────────────────────────────────────────────────────────────
  it("GET /overtime/close-month/year-status excludes exempt employees from totalCount", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/close-month/year-status?year=${TEST_YEAR}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Past months should have totalCount counting only admin + nonExempt (=2),
    // NOT the exempt employee (=3 would be wrong). Future months are skipped.
    // We only assert the upper bound — the exempt employee is filtered out by
    // EXCLUDE_EXEMPT_EMPLOYEE_FILTER, so any month with status !== "future"
    // / !== "no_data" should have totalCount === 2.
    const pastMonths = body.months.filter(
      (m: { status: string }) => m.status !== "future" && m.status !== "no_data",
    );
    expect(pastMonths.length).toBeGreaterThan(0);
    for (const m of pastMonths) {
      expect(m.totalCount).toBe(2); // admin + nonExempt, exempt filtered out
    }
  });

  // ── D-23 Test 5 ────────────────────────────────────────────────────────────
  it("POST /overtime/close-month for exempt → 200 {skipped:true}, no SaldoSnapshot", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/overtime/close-month`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { employeeId: exemptEmpId, year: TEST_YEAR, month: TEST_MONTH },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.skipped).toBe(true);
    expect(body.reason).toBe("isTimeTrackingExempt");

    // D-07: no SaldoSnapshot row created for the exempt employee.
    const snapshots = await app.prisma.saldoSnapshot.findMany({
      where: { employeeId: exemptEmpId, periodType: "MONTHLY" },
    });
    expect(snapshots).toEqual([]);
  });

  // ── D-23 Test 6 ────────────────────────────────────────────────────────────
  it("recalculateSnapshots skips exempt employees (snapshot row unchanged)", async () => {
    // Pre-seed a snapshot (e.g. from before the employee was flagged exempt)
    const seeded = await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: exemptEmpId,
        periodType: "MONTHLY",
        periodStart: new Date("2025-02-01T00:00:00Z"),
        periodEnd: new Date("2025-02-28T00:00:00Z"),
        workedMinutes: 9600,
        expectedMinutes: 9600,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date("2025-03-01T00:00:00Z"),
      },
    });

    // Wait at least 10ms so updatedAt would differ if recalc actually fired.
    await new Promise((r) => setTimeout(r, 50));

    await recalculateSnapshots(app, exemptEmpId, new Date("2025-02-01T00:00:00Z"));

    const after = await app.prisma.saldoSnapshot.findUnique({ where: { id: seeded.id } });
    // D-06: exempt → early return → snapshot untouched (workedMinutes preserved).
    expect(after?.workedMinutes).toBe(9600);
    expect(after?.expectedMinutes).toBe(9600);
    expect(after?.balanceMinutes).toBe(0);
    expect(after?.carryOver).toBe(0);
  });

  // ── D-23 Test 9 — Regression for non-exempt employees ─────────────────────
  describe("Non-exempt regression", () => {
    it("updateOvertimeAccount still computes balanceHours for non-exempt employee", async () => {
      // Seed a TimeEntry so updateOvertimeAccount has something to compute on
      const date = new Date("2025-03-04T00:00:00Z"); // Tuesday
      await app.prisma.timeEntry.create({
        data: {
          employeeId: nonExemptEmpId,
          date,
          startTime: new Date("2025-03-04T08:00:00Z"),
          endTime: new Date("2025-03-04T16:00:00Z"), // 8h
          breakMinutes: 0,
          type: "WORK",
        },
      });

      // updateOvertimeAccount writes to OvertimeAccount via upsert — proves it
      // did NOT early-return. We assert the account row exists and updatedAt is
      // fresh (within last few seconds).
      const before = await app.prisma.overtimeAccount.findUnique({
        where: { employeeId: nonExemptEmpId },
      });
      expect(before).not.toBeNull();

      const beforeUpdatedAt = before!.updatedAt.getTime();
      await new Promise((r) => setTimeout(r, 50));
      await updateOvertimeAccount(app, nonExemptEmpId);

      const after = await app.prisma.overtimeAccount.findUnique({
        where: { employeeId: nonExemptEmpId },
      });
      expect(after).not.toBeNull();
      // Either updatedAt advanced (upsert fired) or the balance is no longer 0
      // (recompute touched it). Both prove the function didn't early-return.
      const wasTouched =
        after!.updatedAt.getTime() > beforeUpdatedAt || Number(after!.balanceHours) !== 0;
      expect(wasTouched).toBe(true);
    });

    it("checkArbZG still fires warnings for non-exempt employee with 12h entry", async () => {
      const date = new Date("2025-03-11T00:00:00Z"); // Tuesday
      await app.prisma.timeEntry.create({
        data: {
          employeeId: nonExemptEmpId,
          date,
          startTime: new Date("2025-03-11T07:00:00Z"),
          endTime: new Date("2025-03-11T19:00:00Z"), // 12h
          breakMinutes: 0,
          type: "WORK",
        },
      });

      const warnings = await checkArbZG(app.prisma, nonExemptEmpId, date);
      // 12h exceeds § 3 daily max (10h hard cap) — at least one warning fires.
      expect(warnings.length).toBeGreaterThanOrEqual(1);
    });
  });
});

/**
 * Phase 76.7 Plan 02 — PATCH /api/v1/employees/:id exemption toggle.
 *
 * Covers D-23 Tests 7 + 8:
 *   7.  ADMIN PATCH writes SET_TIME_TRACKING_EXEMPT audit row with correct shape
 *   7b. ADMIN PATCH with unchanged value → no duplicate audit row (no-op suppression)
 *   8.  MANAGER PATCH → 403 (existing requireRole("ADMIN") gate)
 *   8b. EMPLOYEE PATCH → 403 (existing requireRole("ADMIN") gate)
 *   D-14. GET /api/v1/employees/:id payload includes isTimeTrackingExempt
 *
 * Self-contained suite — uses its own tenant + employees + JWT tokens so the
 * AuditLog/Employee state of the Plan 01 suite above is not perturbed.
 */
describe("Phase 76.7 — PATCH /employees/:id exemption toggle", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let empId: string;
  let adminToken: string;
  let managerToken: string;
  let employeeToken: string;
  let adminUserId: string;

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const s = "tte02-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    // ── Tenant ──────────────────────────────────────────────────────────────
    const tenant = await prisma.tenant.create({
      data: {
        name: `TimeTrackingExemption Plan02 ${s}`,
        slug: `tte02-${s}`,
        federalState: "NIEDERSACHSEN",
      },
    });
    tenantId = tenant.id;
    await prisma.tenantConfig.create({
      data: { tenantId: tenant.id, defaultVacationDays: 30, timezone: TZ },
    });

    // ── Admin user ──────────────────────────────────────────────────────────
    const adminUser = await prisma.user.create({
      data: {
        email: `admin-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "ADMIN",
        isActive: true,
      },
    });
    adminUserId = adminUser.id;
    const adminEmp = await prisma.employee.create({
      data: {
        tenantId: tenant.id,
        userId: adminUser.id,
        employeeNumber: `ADM-${s}`,
        firstName: "Admin",
        lastName: "Toggle",
        hireDate: new Date("2024-01-01"),
      },
    });
    await prisma.workSchedule.create({
      data: {
        employeeId: adminEmp.id,
        type: "FIXED_SCHEDULE",
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
    await prisma.overtimeAccount.create({ data: { employeeId: adminEmp.id, balanceHours: 0 } });

    // ── Manager user ────────────────────────────────────────────────────────
    const managerUser = await prisma.user.create({
      data: {
        email: `manager-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "MANAGER",
        isActive: true,
      },
    });
    const managerEmp = await prisma.employee.create({
      data: {
        tenantId: tenant.id,
        userId: managerUser.id,
        employeeNumber: `MGR-${s}`,
        firstName: "Manager",
        lastName: "Toggle",
        hireDate: new Date("2024-01-01"),
      },
    });
    await prisma.workSchedule.create({
      data: {
        employeeId: managerEmp.id,
        type: "FIXED_SCHEDULE",
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
    await prisma.overtimeAccount.create({ data: { employeeId: managerEmp.id, balanceHours: 0 } });

    // ── Plain employee user (also serves as the PATCH target) ───────────────
    const empUser = await prisma.user.create({
      data: {
        email: `emp-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const emp = await prisma.employee.create({
      data: {
        tenantId: tenant.id,
        userId: empUser.id,
        employeeNumber: `EMP-${s}`,
        firstName: "Target",
        lastName: "Employee",
        hireDate: new Date("2024-01-01"),
        isTimeTrackingExempt: false, // explicit starting state
      },
    });
    empId = emp.id;
    await prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
        type: "FIXED_SCHEDULE",
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
    await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });

    // ── Login: ADMIN ────────────────────────────────────────────────────────
    const adminLoginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `admin-${s}@test.de`, password: "test1234" },
    });
    adminToken = JSON.parse(adminLoginRes.body).accessToken;

    // ── Login: MANAGER ──────────────────────────────────────────────────────
    const managerLoginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `manager-${s}@test.de`, password: "test1234" },
    });
    managerToken = JSON.parse(managerLoginRes.body).accessToken;

    // ── Login: EMPLOYEE ─────────────────────────────────────────────────────
    const empLoginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `emp-${s}@test.de`, password: "test1234" },
    });
    employeeToken = JSON.parse(empLoginRes.body).accessToken;
  });

  afterAll(async () => {
    try {
      // Clean up audit rows referencing our test employee to keep the table tidy.
      await app.prisma.auditLog.deleteMany({
        where: { entity: "Employee", entityId: empId },
      });
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // ── D-23 Test 7 ──────────────────────────────────────────────────────────
  it("ADMIN PATCH writes SET_TIME_TRACKING_EXEMPT audit row with correct shape", async () => {
    const before = await app.prisma.auditLog.count({
      where: { action: "SET_TIME_TRACKING_EXEMPT", entityId: empId },
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${empId}`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-forwarded-for": "10.1.2.3",
      },
      payload: { isTimeTrackingExempt: true },
    });
    expect(res.statusCode).toBe(200);

    const emp = await app.prisma.employee.findUnique({ where: { id: empId } });
    expect(emp?.isTimeTrackingExempt).toBe(true);

    const audits = await app.prisma.auditLog.findMany({
      where: { action: "SET_TIME_TRACKING_EXEMPT", entityId: empId },
      orderBy: { createdAt: "desc" },
    });
    expect(audits.length).toBe(before + 1);
    const audit = audits[0];
    expect(audit.action).toBe("SET_TIME_TRACKING_EXEMPT");
    expect(audit.entity).toBe("Employee");
    expect(audit.userId).toBe(adminUserId);
    expect(audit.oldValue).toMatchObject({ isTimeTrackingExempt: false });
    expect(audit.newValue).toMatchObject({ isTimeTrackingExempt: true });
    expect(audit.ipAddress).toBeTruthy();
  });

  // ── D-23 Test 7b — no-op suppression (unchanged value = no duplicate audit) ─
  it("ADMIN PATCH with unchanged value does NOT write a duplicate audit row", async () => {
    // Pre-state: empId.isTimeTrackingExempt is already `true` from Test 7.
    const before = await app.prisma.auditLog.count({
      where: { action: "SET_TIME_TRACKING_EXEMPT", entityId: empId },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${empId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { isTimeTrackingExempt: true },
    });
    expect(res.statusCode).toBe(200);
    const after = await app.prisma.auditLog.count({
      where: { action: "SET_TIME_TRACKING_EXEMPT", entityId: empId },
    });
    expect(after).toBe(before);
  });

  // ── D-23 Test 8 ──────────────────────────────────────────────────────────
  it("MANAGER PATCH receives 403 (ADMIN-only route)", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${empId}`,
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { isTimeTrackingExempt: false },
    });
    expect(res.statusCode).toBe(403);
  });

  it("EMPLOYEE PATCH receives 403 (ADMIN-only route)", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${empId}`,
      headers: { authorization: `Bearer ${employeeToken}` },
      payload: { isTimeTrackingExempt: false },
    });
    expect(res.statusCode).toBe(403);
  });

  // ── D-14 Response payload check ──────────────────────────────────────────
  it("GET /api/v1/employees/:id includes isTimeTrackingExempt", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/employees/${empId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("isTimeTrackingExempt");
    expect(typeof body.isTimeTrackingExempt).toBe("boolean");
  });
});
