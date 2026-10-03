/**
 * Issue #468, finding 3 (G20) — a 6-day contract must NOT be capped at the 5-day base.
 * `calculatePartTimeVacation` capped `employeeWorkDays >= fullTimeWorkDays` at `baseVacationDays`,
 * so a Mo-Sa (6 days/week) contract got the same 30 as a Mo-Fr (5 days/week) contract instead of
 * the proportionally larger 36 (D-06: BUrlG § 3 counts Werktage, and a contract with MORE workdays
 * than the reference week scales UP exactly like fewer workdays scales DOWN).
 *
 * End-to-end tracer at the route level:
 *   - GET /api/v1/settings/vacation/:employeeId suggestion (regularDays) for a Mo-Sa employee
 *   - PUT /api/v1/settings/work/:employeeId contract change 5->6 days, the #450 reactive recompute
 *   - a Mo-Fr (5-day) employee and a fractional person-base employee stay byte-identical (D-06)
 *
 * Fixed dates only — every date via `new Date(Date.UTC(...))`. Initials-only fixtures, no PII.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("Issue #468 (D-06): 6-day contract scales proportionally instead of capping at the 5-day base", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  async function mkEmployee(
    label: string,
    options: {
      workDays: number[]; // Mo=1 .. Sa=6
      saturdayHours?: number;
      annualVacationDays?: number;
    },
  ): Promise<string> {
    const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `sd468-${label}-${uid}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `SD468-${label}-${uid}`,
        firstName: "T",
        lastName: "T",
        hireDate: new Date(Date.UTC(2024, 0, 1)),
        birthDate: new Date(Date.UTC(1990, 0, 1)),
        annualVacationDays: options.annualVacationDays ?? null,
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        type: "FIXED_SCHEDULE",
        mondayHours: options.workDays.includes(1) ? 8 : 0,
        tuesdayHours: options.workDays.includes(2) ? 8 : 0,
        wednesdayHours: options.workDays.includes(3) ? 8 : 0,
        thursdayHours: options.workDays.includes(4) ? 8 : 0,
        fridayHours: options.workDays.includes(5) ? 8 : 0,
        saturdayHours: options.saturdayHours ?? (options.workDays.includes(6) ? 8 : 0),
        sundayHours: 0,
        weeklyHours: options.workDays.length * 8,
        workDays: options.workDays,
        validFrom: new Date(Date.UTC(2024, 0, 1)),
      },
    });
    return employee.id;
  }

  async function entitlementRow(employeeId: string, year: number) {
    return app.prisma.leaveEntitlement.findUniqueOrThrow({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId,
          leaveTypeId: data.vacationType.id,
          year,
        },
      },
    });
  }

  async function entitlementAudits(entitlementId: string) {
    return app.prisma.auditLog.findMany({
      where: { entity: "LeaveEntitlement", entityId: entitlementId, action: "UPDATE" },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "sd468");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("S6: a Mo-Sa (6-day) contract gets regularDays 36 (not capped at 30), statutoryMinimumDays stays 24", async () => {
    const employeeId = await mkEmployee("s6", { workDays: [1, 2, 3, 4, 5, 6], saturdayHours: 8 });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/settings/vacation/${employeeId}?year=2027`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.regularDays).toBe(36);
    expect(body.statutoryMinimumDays).toBe(24);
  });

  it("S5: a Mo-Fr (5-day) contract stays unchanged at regularDays 30", async () => {
    const employeeId = await mkEmployee("s5", { workDays: [1, 2, 3, 4, 5], saturdayHours: 0 });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/settings/vacation/${employeeId}?year=2027`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.regularDays).toBe(30);
  });

  it("P4: a fractional person-base (29.3) Mo-Fr contract stays byte-identical at regularDays 29.3 (equal-case guard)", async () => {
    const employeeId = await mkEmployee("p4", {
      workDays: [1, 2, 3, 4, 5],
      saturdayHours: 0,
      annualVacationDays: 29.3,
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/settings/vacation/${employeeId}?year=2027`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.regularDays).toBe(29.3);
  });

  it("C1: a 5-day -> 6-day contract change from 01.07.2027 recomputes the auto-calculated 2027 row from 30 to 33 (#450 reactive recompute)", async () => {
    const employeeId = await mkEmployee("c1", { workDays: [1, 2, 3, 4, 5], saturdayHours: 0 });
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: 2027,
        totalDays: 30,
        usedDays: 0,
        carriedOverDays: 0,
        isAutoCalculated: true,
      },
    });

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${employeeId}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        type: "FIXED_SCHEDULE",
        saturdayHours: 8,
        weeklyHours: 48,
        validFrom: "2027-07-01",
      },
    });
    expect(res.statusCode).toBe(200);

    const row = await entitlementRow(employeeId, 2027);
    expect(Number(row.totalDays)).toBe(33);
    expect(row.isAutoCalculated).toBe(true);

    const audits = await entitlementAudits(row.id);
    expect(audits).toHaveLength(1);
    const newValue = audits[0].newValue as { totalDays: number; reason: string };
    expect(newValue.totalDays).toBe(33);
    expect(newValue.reason).toBe("Vertragswechsel");
  });
});
