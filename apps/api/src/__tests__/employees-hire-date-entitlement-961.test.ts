/**
 * Issue #961 — a changed hire date moves the person's LeaveEntitlement rows with it:
 * - later: rows of years before the new hire year are set to 0 (nothing deleted), the new hire
 *   year is recomputed through the regular formula, the carry-over chain is recomputed, every
 *   change audited with the acting user and the reason "Eintrittsdatum geändert";
 * - later with leave before the new hire date: 409 LEAVE_BEFORE_HIRE_DATE, nothing committed;
 * - earlier: the missing new hire year row is created (as at employee creation) and the
 *   carry-over follows.
 *
 * Relative years only (current UTC year and the one before). Initials-only fixtures, no PII.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, soleAuditRow } from "./setup";
import type { FastifyInstance } from "fastify";
import { resolveRegularVacationDays } from "../contexts/absence/leave-days";

const Y0 = new Date().getUTCFullYear();
const PREV = Y0 - 1;

describe("Hire-date change keeps the entitlement rows consistent (Issue #961)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  async function mkEmployee(label: string, hireDate: Date): Promise<string> {
    const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: { email: `hd961-${label}-${uid}@test.de`, passwordHash: "x", isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `HD961-${label}-${uid}`,
        firstName: "T",
        lastName: "T",
        hireDate,
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        type: "FIXED_SCHEDULE",
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: hireDate,
      },
    });
    return employee.id;
  }

  async function row(employeeId: string, year: number, totalDays: number, carriedOverDays = 0) {
    return app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year,
        totalDays,
        carriedOverDays,
        isAutoCalculated: true,
      },
    });
  }

  async function rowOf(employeeId: string, year: number) {
    return app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: { employeeId, leaveTypeId: data.vacationType.id, year },
      },
    });
  }

  async function patchHireDate(employeeId: string, hireDate: Date) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${employeeId}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { hireDate: hireDate.toISOString() },
    });
  }

  async function hireDateAudits(entityId: string) {
    const rows = await app.prisma.auditLog.findMany({
      where: { entity: "LeaveEntitlement", entityId },
    });
    return rows.filter(
      (r) => (r.newValue as Record<string, unknown> | null)?.reason === "Eintrittsdatum geändert",
    );
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "hd961");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("moving the hire date into the next year voids the earlier year and its carry-over", async () => {
    const empId = await mkEmployee("later", new Date(Date.UTC(PREV, 1, 1)));
    const prevRow = await row(empId, PREV, 24);
    const curRow = await row(empId, Y0, 30, 24);

    const newHire = new Date(Date.UTC(Y0, 9, 1));
    const res = await patchHireDate(empId, newHire);
    expect(res.statusCode).toBe(200);

    // Nothing is deleted: the earlier row stays, at 0.
    const prevAfter = await rowOf(empId, PREV);
    expect(prevAfter?.id).toBe(prevRow.id);
    expect(Number(prevAfter!.totalDays)).toBe(0);
    expect(Number(prevAfter!.carriedOverDays)).toBe(0);

    // The new hire year is pro-rated through the one regular formula, and its carry is gone.
    const expected = await resolveRegularVacationDays(app.prisma, empId, data.tenant.id, Y0);
    expect(expected).toBeLessThan(30);
    const curAfter = await rowOf(empId, Y0);
    expect(Number(curAfter!.totalDays)).toBe(expected);
    expect(Number(curAfter!.carriedOverDays)).toBe(0);

    // Every change is audited with the acting admin and the hire-date reason.
    const prevAudits = await hireDateAudits(prevRow.id);
    expect(prevAudits.map((a) => [a.userId, a.oldValue, a.newValue])).toEqual([
      [
        data.adminUser.id,
        { totalDays: 24, carriedOverDays: 0 },
        { totalDays: 0, carriedOverDays: 0, reason: "Eintrittsdatum geändert" },
      ],
    ]);

    const curAudits = await hireDateAudits(curRow.id);
    expect(curAudits.map((a) => a.oldValue)).toEqual(
      expect.arrayContaining([{ totalDays: 30 }, { carriedOverDays: 24 }]),
    );
    expect(curAudits.every((a) => a.userId === data.adminUser.id)).toBe(true);
  });

  it("refuses a later hire date while approved leave lies before it, and commits nothing", async () => {
    const oldHire = new Date(Date.UTC(PREV, 1, 1));
    const empId = await mkEmployee("leave", oldHire);
    const prevRow = await row(empId, PREV, 24);
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: empId,
        leaveTypeId: data.vacationType.id,
        startDate: new Date(Date.UTC(PREV, 5, 1)),
        endDate: new Date(Date.UTC(PREV, 5, 5)),
        days: 5,
        status: "APPROVED",
      },
    });

    const res = await patchHireDate(empId, new Date(Date.UTC(Y0, 0, 1)));
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("LEAVE_BEFORE_HIRE_DATE");

    const employee = await app.prisma.employee.findUniqueOrThrow({ where: { id: empId } });
    expect(employee.hireDate.getTime()).toBe(oldHire.getTime());
    const prevAfter = await rowOf(empId, PREV);
    expect(Number(prevAfter!.totalDays)).toBe(24);
    expect(await hireDateAudits(prevRow.id)).toHaveLength(0);
  });

  it("allows a later hire date when the leave before it is cancelled", async () => {
    const empId = await mkEmployee("cancelled", new Date(Date.UTC(PREV, 1, 1)));
    await row(empId, PREV, 24);
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: empId,
        leaveTypeId: data.vacationType.id,
        startDate: new Date(Date.UTC(PREV, 5, 1)),
        endDate: new Date(Date.UTC(PREV, 5, 5)),
        days: 5,
        status: "CANCELLED",
      },
    });

    const res = await patchHireDate(empId, new Date(Date.UTC(Y0, 0, 1)));
    expect(res.statusCode).toBe(200);
    expect(Number((await rowOf(empId, PREV))!.totalDays)).toBe(0);
  });

  it("moving the hire date earlier creates the new hire year and carries it over", async () => {
    const empId = await mkEmployee("earlier", new Date(Date.UTC(Y0, 9, 1)));
    const lateValue = await resolveRegularVacationDays(app.prisma, empId, data.tenant.id, Y0);
    const curRow = await row(empId, Y0, lateValue);

    const res = await patchHireDate(empId, new Date(Date.UTC(PREV, 0, 1)));
    expect(res.statusCode).toBe(200);

    const fullYear = await resolveRegularVacationDays(app.prisma, empId, data.tenant.id, Y0);
    expect(fullYear).toBeGreaterThan(lateValue);
    const curAfter = await rowOf(empId, Y0);
    expect(curAfter?.id).toBe(curRow.id);
    expect(Number(curAfter!.totalDays)).toBe(fullYear);

    const prevAfter = await rowOf(empId, PREV);
    expect(prevAfter).not.toBeNull();
    const prevExpected = await resolveRegularVacationDays(app.prisma, empId, data.tenant.id, PREV);
    expect(Number(prevAfter!.totalDays)).toBe(prevExpected);
    // Nothing of the earlier year was taken, so all of it is carried into the current year.
    expect(Number(curAfter!.carriedOverDays)).toBe(prevExpected);

    const created = await soleAuditRow(app.prisma, {
      where: { entity: "LeaveEntitlement", entityId: prevAfter!.id, action: "CREATE" },
    });
    expect(created.userId).toBe(data.adminUser.id);
    expect((created.newValue as Record<string, unknown>).reason).toBe("Eintrittsdatum geändert");
  });

  it("an unchanged hire date writes no entitlement audit", async () => {
    const hire = new Date(Date.UTC(PREV, 1, 1));
    const empId = await mkEmployee("same", hire);
    const prevRow = await row(empId, PREV, 24);
    const res = await patchHireDate(empId, hire);
    expect(res.statusCode).toBe(200);
    expect(await hireDateAudits(prevRow.id)).toHaveLength(0);
  });
});
