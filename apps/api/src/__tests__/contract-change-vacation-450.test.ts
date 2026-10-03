/**
 * Issue #450 (D-01, D-02, D-05, D-06, D-07, D-08, D-09) — end-to-end tracer: a contract change
 * through the REGULAR branch of PUT /api/v1/settings/work/:employeeId recomputes the affected
 * auto-calculated VACATION entitlement per contract segment (EuGH Brandes C-415/12, Greenfield
 * C-219/14), audited as "Vertragswechsel".
 *
 * Fixed dates only — every date is built via `new Date(Date.UTC(...))`. Initials-only fixtures
 * (firstName "T", lastName "T") — no PII per CLAUDE.md.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("PUT /api/v1/settings/work/:employeeId — Vertragswechsel recomputes VACATION entitlement per segment (Issue #450)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  async function mkEmployee(
    label: string,
    workDays: number[],
    options: { totalDays: number; isAutoCalculated?: boolean } = { totalDays: 30 },
  ): Promise<string> {
    const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `cc450-${label}-${uid}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `CC450-${label}-${uid}`,
        firstName: "T",
        lastName: "T",
        hireDate: new Date(Date.UTC(2024, 0, 1)),
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        type: "FIXED_SCHEDULE",
        mondayHours: workDays.includes(1) ? 8 : 0,
        tuesdayHours: workDays.includes(2) ? 8 : 0,
        wednesdayHours: workDays.includes(3) ? 8 : 0,
        thursdayHours: workDays.includes(4) ? 8 : 0,
        fridayHours: workDays.includes(5) ? 8 : 0,
        saturdayHours: 0,
        sundayHours: 0,
        workDays,
        validFrom: new Date(Date.UTC(2024, 0, 1)),
      },
    });
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: employee.id,
        leaveTypeId: data.vacationType.id,
        year: 2026,
        totalDays: options.totalDays,
        usedDays: 5,
        carriedOverDays: 2,
        isAutoCalculated: options.isAutoCalculated ?? true,
      },
    });
    return employee.id;
  }

  async function entitlementRow(employeeId: string) {
    return app.prisma.leaveEntitlement.findUniqueOrThrow({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId,
          leaveTypeId: data.vacationType.id,
          year: 2026,
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
    data = await seedTestData(app, "cc450");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("3-day -> 5-day from 01.07.2026: auto-calculated 2026 row 18 -> 24, one Vertragswechsel audit", async () => {
    const employeeId = await mkEmployee("a", [1, 2, 3], { totalDays: 18 });

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${employeeId}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { type: "FIXED_SCHEDULE", validFrom: "2026-07-01" },
    });
    expect(res.statusCode).toBe(200);

    const row = await entitlementRow(employeeId);
    expect(Number(row.totalDays)).toBe(24);
    expect(Number(row.usedDays)).toBe(5);
    expect(Number(row.carriedOverDays)).toBe(2);
    expect(row.isAutoCalculated).toBe(true);

    const audits = await entitlementAudits(row.id);
    expect(audits).toHaveLength(1);
    const audit = audits[0];
    expect((audit.oldValue as { totalDays: number }).totalDays).toBe(18);
    const newValue = audit.newValue as {
      totalDays: number;
      isAutoCalculated: boolean;
      reason: string;
      validFrom: string;
    };
    expect(newValue.totalDays).toBe(24);
    expect(newValue.isAutoCalculated).toBe(true);
    expect(newValue.reason).toBe("Vertragswechsel");
    expect(newValue.validFrom).toBe("2026-07-01");
    expect(audit.userId).toBe(data.adminUser.id);
  });

  it("5-day -> 3-day from 01.07.2026: auto-calculated 2026 row 30 -> 24, one Vertragswechsel audit", async () => {
    const employeeId = await mkEmployee("b", [1, 2, 3, 4, 5], { totalDays: 30 });

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${employeeId}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        type: "FIXED_SCHEDULE",
        thursdayHours: 0,
        fridayHours: 0,
        validFrom: "2026-07-01",
      },
    });
    expect(res.statusCode).toBe(200);

    const row = await entitlementRow(employeeId);
    expect(Number(row.totalDays)).toBe(24);

    const audits = await entitlementAudits(row.id);
    expect(audits).toHaveLength(1);
    expect((audits[0].oldValue as { totalDays: number }).totalDays).toBe(30);
  });

  it("human-set row (isAutoCalculated: false) is never overwritten and gets no audit", async () => {
    const employeeId = await mkEmployee("c", [1, 2, 3], { totalDays: 18, isAutoCalculated: false });

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${employeeId}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { type: "FIXED_SCHEDULE", validFrom: "2026-07-01" },
    });
    expect(res.statusCode).toBe(200);

    const row = await entitlementRow(employeeId);
    expect(Number(row.totalDays)).toBe(18);

    const audits = await entitlementAudits(row.id);
    expect(audits).toHaveLength(0);
  });

  it("D-02 precedence: an hours-only change on the same five days never triggers a recompute or audit", async () => {
    const employeeId = await mkEmployee("d", [1, 2, 3, 4, 5], { totalDays: 30 });

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${employeeId}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        type: "FIXED_SCHEDULE",
        mondayHours: 7.5,
        tuesdayHours: 7.5,
        wednesdayHours: 7.5,
        thursdayHours: 7.5,
        fridayHours: 7.5,
        weeklyHours: 37.5,
        validFrom: "2026-07-01",
      },
    });
    expect(res.statusCode).toBe(200);

    const row = await entitlementRow(employeeId);
    expect(Number(row.totalDays)).toBe(30);

    const audits = await entitlementAudits(row.id);
    expect(audits).toHaveLength(0);
  });
});
