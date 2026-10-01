/**
 * Issue #445 finding 2 — per-year self-heal and cancellation (D-10/D-11).
 *
 * Fixed dates only (2026/2027) — no assertion depends on `new Date()`. Every scenario uses its
 * own fresh employee (hire 2024-01-01, FIXED Mo-Fr unless stated, initials-only).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("Issue #445 finding 2 — per-year self-heal and cancellation (D-10/D-11)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  async function mkEmployee(
    label: string,
    type: "SHIFT_BASED" | "FIXED_SCHEDULE" = "FIXED_SCHEDULE",
  ): Promise<{ employeeId: string; userId: string }> {
    const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `cysh-${label}-${uid}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `CYSH-${label}-${uid}`,
        firstName: "T",
        lastName: "T",
        hireDate: new Date(Date.UTC(2024, 0, 1)),
      },
    });
    if (type === "SHIFT_BASED") {
      await app.prisma.workSchedule.create({
        data: {
          employeeId: employee.id,
          type: "SHIFT_BASED",
          weeklyHours: 32,
          contractWorkDaysPerWeek: 4,
          workDays: [1, 2, 3, 4, 5, 6],
          validFrom: new Date(Date.UTC(2024, 0, 1)),
        },
      });
    } else {
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
    }
    await app.prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
    return { employeeId: employee.id, userId: user.id };
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "cysh");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("scenario 1: a cross-year APPROVED request heals both years' usedDays (unfixed: both 0)", async () => {
    const { employeeId } = await mkEmployee("s1");
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: 2026,
        totalDays: 30,
        usedDays: 0,
        isAutoCalculated: true,
      },
    });
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: 2027,
        totalDays: 30,
        usedDays: 0,
        isAutoCalculated: true,
      },
    });
    await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        status: "APPROVED",
        startDate: new Date(Date.UTC(2026, 11, 28)),
        endDate: new Date(Date.UTC(2027, 0, 8)),
        days: 9,
      },
    });

    const res2026 = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${employeeId}?year=2026`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res2026.statusCode).toBe(200);
    const row2026 = (
      JSON.parse(res2026.body) as Array<{ leaveTypeId: string; usedDays: number }>
    ).find((r) => r.leaveTypeId === data.vacationType.id);
    expect(Number(row2026?.usedDays)).toBe(4);

    const res2027 = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${employeeId}?year=2027`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res2027.statusCode).toBe(200);
    const row2027 = (
      JSON.parse(res2027.body) as Array<{ leaveTypeId: string; usedDays: number }>
    ).find((r) => r.leaveTypeId === data.vacationType.id);
    expect(Number(row2027?.usedDays)).toBe(5);
  });

  it("scenario 2: SHIFT_BASED cross-year request heals 4 / 3 (unfixed: 0 / 0)", async () => {
    const { employeeId } = await mkEmployee("s2", "SHIFT_BASED");
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: 2026,
        totalDays: 30,
        usedDays: 0,
        isAutoCalculated: true,
      },
    });
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: 2027,
        totalDays: 30,
        usedDays: 0,
        isAutoCalculated: true,
      },
    });
    await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        status: "APPROVED",
        startDate: new Date(Date.UTC(2026, 11, 28)),
        endDate: new Date(Date.UTC(2027, 0, 9)),
        days: 7,
      },
    });

    const res2026 = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${employeeId}?year=2026`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    const row2026 = (
      JSON.parse(res2026.body) as Array<{ leaveTypeId: string; usedDays: number }>
    ).find((r) => r.leaveTypeId === data.vacationType.id);
    expect(Number(row2026?.usedDays)).toBe(4);

    const res2027 = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${employeeId}?year=2027`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    const row2027 = (
      JSON.parse(res2027.body) as Array<{ leaveTypeId: string; usedDays: number }>
    ).find((r) => r.leaveTypeId === data.vacationType.id);
    expect(Number(row2027?.usedDays)).toBe(3);
  });

  it("scenario 3: a CANCELLATION_REQUESTED request still counts in self-heal (unfixed: 0)", async () => {
    const { employeeId } = await mkEmployee("s3");
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: 2026,
        totalDays: 30,
        usedDays: 0,
        isAutoCalculated: true,
      },
    });
    await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        status: "CANCELLATION_REQUESTED",
        startDate: new Date(Date.UTC(2026, 2, 2)),
        endDate: new Date(Date.UTC(2026, 2, 6)),
        days: 5,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${employeeId}?year=2026`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const row = (JSON.parse(res.body) as Array<{ leaveTypeId: string; usedDays: number }>).find(
      (r) => r.leaveTypeId === data.vacationType.id,
    );
    expect(Number(row?.usedDays)).toBe(5);
  });

  it("scenario 4: a wrong usedDays is healed with an audit, and the next year's carry-over is recomputed", async () => {
    const { employeeId } = await mkEmployee("s4");
    const ent2026 = await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: 2026,
        totalDays: 30,
        usedDays: 12,
        carriedOverDays: 0,
        isAutoCalculated: true,
      },
    });
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: 2027,
        totalDays: 30,
        usedDays: 0,
        carriedOverDays: 18,
        isAutoCalculated: true,
      },
    });
    await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        status: "APPROVED",
        startDate: new Date(Date.UTC(2026, 4, 4)),
        endDate: new Date(Date.UTC(2026, 4, 8)),
        days: 5,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${employeeId}?year=2026`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const row = (JSON.parse(res.body) as Array<{ leaveTypeId: string; usedDays: number }>).find(
      (r) => r.leaveTypeId === data.vacationType.id,
    );
    expect(Number(row?.usedDays)).toBe(5);

    const audit = await app.prisma.auditLog.findFirst({
      where: { entity: "LeaveEntitlement", entityId: ent2026.id, action: "UPDATE" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(audit!.userId).toBeNull();
    expect((audit!.oldValue as { usedDays?: number })?.usedDays).toBe(12);
    expect((audit!.newValue as { usedDays?: number; reason?: string })?.usedDays).toBe(5);
    expect((audit!.newValue as { reason?: string })?.reason).toBe("Self-Heal");

    const row2027 = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: { employeeId, leaveTypeId: data.vacationType.id, year: 2027 },
      },
    });
    expect(Number(row2027!.carriedOverDays)).toBe(25); // unfixed: 18
  });

  it("scenario 5: self-heal never creates a missing next-year row (read-only guard)", async () => {
    const { employeeId } = await mkEmployee("s5");
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: 2026,
        totalDays: 30,
        usedDays: 12,
        carriedOverDays: 0,
        isAutoCalculated: true,
      },
    });
    await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        status: "APPROVED",
        startDate: new Date(Date.UTC(2026, 4, 4)),
        endDate: new Date(Date.UTC(2026, 4, 8)),
        days: 5,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${employeeId}?year=2026`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);

    const row2027 = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: { employeeId, leaveTypeId: data.vacationType.id, year: 2027 },
      },
    });
    expect(row2027).toBeNull();
  });

  it("scenario 6: a CONFIRMED § 9 credit is attributed to the correct year (unfixed: 0 / 0)", async () => {
    const { employeeId } = await mkEmployee("s6");
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: 2026,
        totalDays: 30,
        usedDays: 0,
        isAutoCalculated: true,
      },
    });
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: 2027,
        totalDays: 30,
        usedDays: 0,
        isAutoCalculated: true,
      },
    });
    const vacationRequest = await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        status: "APPROVED",
        startDate: new Date(Date.UTC(2026, 11, 28)),
        endDate: new Date(Date.UTC(2027, 0, 8)),
        days: 9,
      },
    });
    const sickType = await app.prisma.leaveType.create({
      data: {
        tenantId: data.tenant.id,
        code: "SICK",
        name: "Krankmeldung",
        isPaid: true,
        requiresApproval: false,
      },
    });
    const sickRequest = await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: sickType.id,
        status: "APPROVED",
        startDate: new Date(Date.UTC(2027, 0, 4)),
        endDate: new Date(Date.UTC(2027, 0, 5)),
        days: 2,
      },
    });
    await app.prisma.section9Credit.create({
      data: {
        employeeId,
        sickRequestId: sickRequest.id,
        vacationRequestId: vacationRequest.id,
        overlapStart: new Date(Date.UTC(2027, 0, 4)),
        overlapEnd: new Date(Date.UTC(2027, 0, 5)),
        status: "CONFIRMED",
        creditedStart: new Date(Date.UTC(2027, 0, 4)),
        creditedEnd: new Date(Date.UTC(2027, 0, 5)),
        creditedDays: 2,
      },
    });

    const res2026 = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${employeeId}?year=2026`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    const row2026 = (
      JSON.parse(res2026.body) as Array<{ leaveTypeId: string; usedDays: number }>
    ).find((r) => r.leaveTypeId === data.vacationType.id);
    expect(Number(row2026?.usedDays)).toBe(4);

    const res2027 = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${employeeId}?year=2027`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    const row2027 = (
      JSON.parse(res2027.body) as Array<{ leaveTypeId: string; usedDays: number }>
    ).find((r) => r.leaveTypeId === data.vacationType.id);
    expect(Number(row2027?.usedDays)).toBe(3);
  });

  it("scenario 7: approving a cross-year cancellation reverses both years and refreshes next year's carry-over", async () => {
    const { employeeId, userId } = await mkEmployee("s7");
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: 2026,
        totalDays: 30,
        usedDays: 4,
        carriedOverDays: 0,
        isAutoCalculated: true,
      },
    });
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: 2027,
        totalDays: 30,
        usedDays: 5,
        carriedOverDays: 26,
        isAutoCalculated: true,
      },
    });
    const req = await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        status: "CANCELLATION_REQUESTED",
        startDate: new Date(Date.UTC(2026, 11, 28)),
        endDate: new Date(Date.UTC(2027, 0, 8)),
        days: 9,
        cancellationRequestedBy: userId,
        reviewedBy: null,
      },
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${req.id}/review`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { status: "APPROVED" },
    });
    expect(res.statusCode, `cancellation approval must succeed: ${res.body}`).toBe(200);

    const row2026 = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: { employeeId, leaveTypeId: data.vacationType.id, year: 2026 },
      },
    });
    const row2027 = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: { employeeId, leaveTypeId: data.vacationType.id, year: 2027 },
      },
    });
    expect(Number(row2026!.usedDays)).toBe(0); // unfixed: -5
    expect(Number(row2027!.usedDays)).toBe(0); // unfixed: 5
    expect(Number(row2027!.carriedOverDays)).toBe(30); // unfixed: 26
  });
});
