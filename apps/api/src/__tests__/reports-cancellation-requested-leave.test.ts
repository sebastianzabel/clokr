/**
 * Issue #446 (D-04) — reports and DATEV must count a leave under requested cancellation
 * exactly like the saldo does. Every Arbeitszeitkonto saldo path already reads leave via
 * `EFFECTIVE_LEAVE_STATUSES` (Issue #446 D-01/D-02/D-03); before this plan the five
 * `composition/reports.ts` leave filters (Monatsbericht, DATEV, DATEV employee, Urlaubsliste
 * PDF, Urlaubs-PDF) still read `status: "APPROVED"` only, so a CANCELLATION_REQUESTED week
 * disappeared from the report and from the payroll export even though it still blocks time
 * tracking and still reduces Soll (CLAUDE.md § Leave Cancellation Flow).
 *
 * Fixture shape copied from leave-cancellation-saldo.test.ts: two FIXED_SCHEDULE 40h
 * employees, a direct `leaveRequest.create` for the fixture leave (A = APPROVED,
 * C = CANCELLATION_REQUESTED), same week.
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import iconv from "iconv-lite";
import {
  getTestApp,
  seedTestData,
  cleanupTestData,
  closeTestApp,
  configureDatevKanzlei,
} from "./setup";

// Issue #256 (Befund 1) field offsets — copied from datev-export.test.ts.
const F_LOHNART = 5;
const F_TAGE = 7;

describe("Issue #446 (D-04) — Monatsbericht + DATEV count CANCELLATION_REQUESTED leave like APPROVED", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let employeeA: string; // VACATION 2026-06-08..12 APPROVED
  let employeeC: string; // same week, CANCELLATION_REQUESTED

  async function createFixedEmployee(label: string) {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const passwordHash = await bcrypt.hash("test1234", 10);
    const user = await app.prisma.user.create({
      data: {
        email: `rcr446-${label}-${suffix}@test.de`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `RCR446-${label}-${suffix}`,
        firstName: label,
        lastName: "ReportsCancellation",
        hireDate: new Date("2026-06-01"),
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        type: "FIXED_SCHEDULE",
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2026-06-01"),
      },
    });
    await app.prisma.overtimeAccount.create({
      data: { employeeId: employee.id, balanceHours: 0 },
    });
    return employee;
  }

  async function createLeave(employeeId: string, status: "APPROVED" | "CANCELLATION_REQUESTED") {
    await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        startDate: new Date("2026-06-08T00:00:00Z"),
        endDate: new Date("2026-06-12T00:00:00Z"),
        days: 5,
        halfDay: false,
        status,
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "rcr446");
    await configureDatevKanzlei(app, data.tenant.id);

    const a = await createFixedEmployee("A");
    employeeA = a.id;
    const c = await createFixedEmployee("C");
    employeeC = c.id;

    await createLeave(employeeA, "APPROVED");
    await createLeave(employeeC, "CANCELLATION_REQUESTED");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("reports-cancellation-requested-leave cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("Monatsbericht: C's vacationDays = 5 and shouldHours equals A's (not zero, not inflated)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly?year=2026&month=6&employeeId=${employeeC}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const rows: Array<{ employeeId: string; vacationDays: number; shouldHours: number }> =
      body.rows;
    const c = rows.find((r) => r.employeeId === employeeC);
    expect(c).toBeDefined();

    const resA = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly?year=2026&month=6&employeeId=${employeeA}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(resA.statusCode).toBe(200);
    const bodyA = JSON.parse(resA.body);
    const rowsA: Array<{ employeeId: string; vacationDays: number; shouldHours: number }> =
      bodyA.rows;
    const a = rowsA.find((r) => r.employeeId === employeeA);
    expect(a).toBeDefined();

    expect(c!.vacationDays).toBe(5);
    expect(c!.shouldHours).toBe(a!.shouldHours);
  });

  it("DATEV employee export: C's Urlaub row (;U;, Lohnart 300) exists with Tage 5, identical to A's export", async () => {
    const resC = await app.inject({
      method: "GET",
      url: `/api/v1/reports/datev/employee?employeeId=${employeeC}&year=2026&month=6`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(resC.statusCode).toBe(200);
    const bodyC = iconv.decode(resC.rawPayload, "win1252");
    const rowsC = bodyC
      .split("[Bewegungsdaten]")[1]
      .split("\r\n")
      .filter((l) => l.trim().length > 0);
    const urlaubRowC = rowsC.find((r) => r.includes(";U;") && r.split(";")[F_LOHNART] === "300");

    const resA = await app.inject({
      method: "GET",
      url: `/api/v1/reports/datev/employee?employeeId=${employeeA}&year=2026&month=6`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(resA.statusCode).toBe(200);
    const bodyA = iconv.decode(resA.rawPayload, "win1252");
    const rowsA = bodyA
      .split("[Bewegungsdaten]")[1]
      .split("\r\n")
      .filter((l) => l.trim().length > 0);
    const urlaubRowA = rowsA.find((r) => r.includes(";U;") && r.split(";")[F_LOHNART] === "300");

    expect(urlaubRowC).toBeDefined();
    expect(urlaubRowA).toBeDefined();

    const tageC = Number(urlaubRowC!.split(";")[F_TAGE].replace(",", "."));
    const tageA = Number(urlaubRowA!.split(";")[F_TAGE].replace(",", "."));
    expect(tageC).toBe(5);
    expect(tageC).toBe(tageA);
  });
});
