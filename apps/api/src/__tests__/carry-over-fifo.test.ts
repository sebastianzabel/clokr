/**
 * Issue #445 finding 4 — carry-over FIFO and expiry of the untaken part (D-12..D-15).
 *
 * Fixed dates only (2020/2027/2028) — no assertion depends on `new Date()`. Every scenario uses
 * its own fresh employee (hire 2024-01-01, FIXED Mo-Fr, initials-only).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { effectiveCarryOverDays, recalculateCarryOver } from "../contexts/absence/leave-days";
import type { FastifyInstance } from "fastify";

describe("Issue #445 finding 4 — carry-over FIFO and expiry of the untaken part (D-12..D-15)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  // Carry-over deadline for the 2027 accrual year: 31 March 2027.
  const DL27 = new Date(Date.UTC(2027, 2, 31, 23, 59, 59));

  async function mkEmployee(label: string): Promise<string> {
    const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `cofo-${label}-${uid}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `COFO-${label}-${uid}`,
        firstName: "T",
        lastName: "T",
        hireDate: new Date(Date.UTC(2024, 0, 1)),
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
        validFrom: new Date(Date.UTC(2024, 0, 1)),
      },
    });
    await app.prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
    return employee.id;
  }

  async function seedWarned(entitlementId: string, year: number, carriedOverDays: number) {
    await app.prisma.auditLog.create({
      data: {
        action: "CARRYOVER_WARNED",
        entity: "LeaveEntitlement",
        entityId: entitlementId,
        newValue: { year, carriedOverDays },
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "cofo");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("scenario 1: carry-over consumed by days taken before the deadline is not charged again in availability (POST, unfixed: 400 available 5)", async () => {
    const employeeId = await mkEmployee("s1");
    const ent1 = await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: 2027,
        totalDays: 10,
        usedDays: 5,
        carriedOverDays: 5,
        carryOverDeadline: DL27,
        isAutoCalculated: true,
      },
    });
    await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        status: "APPROVED",
        startDate: new Date(Date.UTC(2027, 1, 1)),
        endDate: new Date(Date.UTC(2027, 1, 5)),
        days: 5,
      },
    });
    await seedWarned(ent1.id, 2027, 5);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId,
        type: "VACATION",
        startDate: "2027-04-19",
        endDate: "2027-04-28",
        halfDay: false,
      },
    });
    expect(res.statusCode, `request must succeed: ${res.body}`).toBe(201);
    const body = JSON.parse(res.body) as { days: string | number };
    expect(Number(body.days)).toBe(8);
  });

  it("scenario 2: GET /leave/entitlements reports the FIFO effective carry-over (warned: 3, unwarned guard: 5)", async () => {
    const employeeId = await mkEmployee("s2");
    const ent = await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: 2020,
        totalDays: 20,
        usedDays: 3,
        carriedOverDays: 5,
        carryOverDeadline: new Date(Date.UTC(2020, 2, 31, 23, 59, 59)),
      },
    });
    await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        status: "APPROVED",
        startDate: new Date(Date.UTC(2020, 1, 3)),
        endDate: new Date(Date.UTC(2020, 1, 5)),
        days: 3,
      },
    });
    await seedWarned(ent.id, 2020, 5);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${employeeId}?year=2020`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const rows = JSON.parse(res.body) as Array<{ id: string; effectiveCarryOverDays: number }>;
    const row = rows.find((r) => r.id === ent.id);
    expect(row, "entitlement row must be present").toBeDefined();
    expect(row!.effectiveCarryOverDays).toBe(3);

    // Guard: the same fixture WITHOUT a documented warning must preserve the full carry.
    const employeeId2 = await mkEmployee("s2b");
    const ent2 = await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: employeeId2,
        leaveTypeId: data.vacationType.id,
        year: 2020,
        totalDays: 20,
        usedDays: 3,
        carriedOverDays: 5,
        carryOverDeadline: new Date(Date.UTC(2020, 2, 31, 23, 59, 59)),
      },
    });
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: employeeId2,
        leaveTypeId: data.vacationType.id,
        status: "APPROVED",
        startDate: new Date(Date.UTC(2020, 1, 3)),
        endDate: new Date(Date.UTC(2020, 1, 5)),
        days: 3,
      },
    });
    const res2 = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${employeeId2}?year=2020`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res2.statusCode).toBe(200);
    const rows2 = JSON.parse(res2.body) as Array<{ id: string; effectiveCarryOverDays: number }>;
    const row2 = rows2.find((r) => r.id === ent2.id);
    expect(row2, "entitlement row must be present").toBeDefined();
    expect(row2!.effectiveCarryOverDays).toBe(5);
  });

  it("scenario 3: effectiveCarryOverDays direct-call matrix (D-13)", async () => {
    const employeeId = await mkEmployee("s3");
    await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        status: "APPROVED",
        startDate: new Date(Date.UTC(2027, 1, 1)),
        endDate: new Date(Date.UTC(2027, 1, 2)),
        days: 2,
      },
    });
    await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        status: "APPROVED",
        startDate: new Date(Date.UTC(2027, 3, 12)),
        endDate: new Date(Date.UTC(2027, 3, 16)),
        days: 5,
      },
    });

    const row = {
      employeeId,
      leaveTypeId: data.vacationType.id,
      year: 2027,
      carriedOverDays: 5,
      carryOverDeadline: DL27,
      tenantId: data.tenant.id,
    };

    // Before the deadline, warned.
    expect(
      await effectiveCarryOverDays(app.prisma, row, new Date(Date.UTC(2027, 2, 15)), true),
    ).toBe(5);
    // After the deadline, NOT warned.
    expect(
      await effectiveCarryOverDays(app.prisma, row, new Date(Date.UTC(2027, 3, 15)), false),
    ).toBe(5);
    // After the deadline, warned: only the 2 days taken before 31 March count.
    expect(
      await effectiveCarryOverDays(app.prisma, row, new Date(Date.UTC(2027, 3, 15)), true),
    ).toBe(2);
    // No carry at all.
    expect(
      await effectiveCarryOverDays(
        app.prisma,
        { ...row, carriedOverDays: 0 },
        new Date(Date.UTC(2027, 3, 15)),
        true,
      ),
    ).toBe(0);
    // No deadline configured — full carry regardless of reference date.
    expect(
      await effectiveCarryOverDays(
        app.prisma,
        { ...row, carryOverDeadline: null },
        new Date(Date.UTC(2027, 11, 31)),
        true,
      ),
    ).toBe(5);
    // Deadline falls into the NEXT calendar year — window clamps to 31 Dec of the row's own
    // year, so both requests (2 + 5 = 7 days) count, capped at the carry (5).
    expect(
      await effectiveCarryOverDays(
        app.prisma,
        { ...row, carryOverDeadline: new Date(Date.UTC(2028, 2, 31, 23, 59, 59)) },
        new Date(Date.UTC(2028, 3, 15)),
        true,
      ),
    ).toBe(5);
  });

  it("scenario 4+5: recalculateCarryOver computes the next year's remainder from the effective carry, and only audits a real change (D-14, D-15)", async () => {
    const employeeId = await mkEmployee("s4");
    const ent2027 = await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: 2027,
        totalDays: 30,
        usedDays: 10,
        carriedOverDays: 5,
        carryOverDeadline: DL27,
        isAutoCalculated: true,
      },
    });
    await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        status: "APPROVED",
        startDate: new Date(Date.UTC(2027, 5, 7)),
        endDate: new Date(Date.UTC(2027, 5, 18)),
        days: 10,
      },
    });
    await seedWarned(ent2027.id, 2027, 5);

    await recalculateCarryOver(app.prisma, data.tenant.id, employeeId, data.vacationType.id, 2028);

    const ent2028 = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId,
          leaveTypeId: data.vacationType.id,
          year: 2028,
        },
      },
    });
    expect(ent2028, "2028 row must be created").toBeDefined();
    expect(Number(ent2028!.totalDays)).toBe(30); // regular entitlement, FIXED Mo-Fr full-timer
    expect(Number(ent2028!.carriedOverDays)).toBe(20); // 30 + 0 effective carry - 10, not 25

    const audits1 = await app.prisma.auditLog.findMany({
      where: {
        action: "UPDATE",
        entity: "LeaveEntitlement",
        entityId: ent2028!.id,
        newValue: { path: ["carriedOverDays"], equals: 20 },
      },
    });
    expect(audits1.length).toBe(1);

    // D-15: a second recalc with no change in the underlying numbers writes no further audit.
    await recalculateCarryOver(app.prisma, data.tenant.id, employeeId, data.vacationType.id, 2028);
    const audits2 = await app.prisma.auditLog.findMany({
      where: {
        action: "UPDATE",
        entity: "LeaveEntitlement",
        entityId: ent2028!.id,
        newValue: { path: ["carriedOverDays"], equals: 20 },
      },
    });
    expect(audits2.length).toBe(1);
  });

  it("scenario 4 guard: without the warning the full carry rolls forward (25, not 20)", async () => {
    const employeeId = await mkEmployee("s4b");
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: 2027,
        totalDays: 30,
        usedDays: 10,
        carriedOverDays: 5,
        carryOverDeadline: DL27,
        isAutoCalculated: true,
      },
    });
    await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        status: "APPROVED",
        startDate: new Date(Date.UTC(2027, 5, 7)),
        endDate: new Date(Date.UTC(2027, 5, 18)),
        days: 10,
      },
    });
    // No CARRYOVER_WARNED audit this time.

    await recalculateCarryOver(app.prisma, data.tenant.id, employeeId, data.vacationType.id, 2028);

    const ent2028 = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId,
          leaveTypeId: data.vacationType.id,
          year: 2028,
        },
      },
    });
    expect(Number(ent2028!.carriedOverDays)).toBe(25);
  });

  it("scenario 6: autoCarryOver (via GET /entitlements) uses the effective remainder too (20, not 25)", async () => {
    const employeeId = await mkEmployee("s6");
    const ent2027 = await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: 2027,
        totalDays: 30,
        usedDays: 10,
        carriedOverDays: 5,
        carryOverDeadline: DL27,
        isAutoCalculated: true,
      },
    });
    await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        status: "APPROVED",
        startDate: new Date(Date.UTC(2027, 5, 7)),
        endDate: new Date(Date.UTC(2027, 5, 18)),
        days: 10,
      },
    });
    await seedWarned(ent2027.id, 2027, 5);
    // Deliberately NO 2028 row — autoCarryOver must create it via GET.

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${employeeId}?year=2028`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode, `GET must succeed: ${res.body}`).toBe(200);

    const ent2028 = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId,
          leaveTypeId: data.vacationType.id,
          year: 2028,
        },
      },
    });
    expect(ent2028, "2028 row must be created by autoCarryOver").toBeDefined();
    expect(Number(ent2028!.carriedOverDays)).toBe(20);
  });
});
