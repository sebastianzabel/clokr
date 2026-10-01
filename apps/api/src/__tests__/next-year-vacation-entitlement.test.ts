/**
 * Issue #445 finding 1 — next-year VACATION entitlement (D-04/D-05/D-06).
 *
 * Fixed dates only (2026/2027) — no assertion depends on `new Date()`. Every scenario uses its
 * own fresh employee (hireDate 2024-01-01, FIXED Mo-Fr WorkSchedule validFrom 2024-01-01,
 * OvertimeAccount balance 0, initials-only) so the seeded current-year row of `data.employee`
 * never interferes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("Issue #445 finding 1 — next-year VACATION entitlement (D-04/D-05/D-06)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  async function mkEmployee(label: string): Promise<string> {
    const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `nyve-${label}-${uid}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `NYVE-${label}-${uid}`,
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

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "nyve");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("scenario 1: approving a 2026 booking creates the missing 2027 row with the regular entitlement, not 0", async () => {
    const employeeId = await mkEmployee("s1");
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: 2026,
        totalDays: 30,
        isAutoCalculated: true,
      },
    });

    const req = await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        status: "PENDING",
        startDate: new Date(Date.UTC(2026, 6, 6)), // Monday
        endDate: new Date(Date.UTC(2026, 6, 10)), // Friday
        days: 5,
      },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${req.id}/review`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { status: "APPROVED" },
    });
    expect(res.statusCode, `approval must succeed: ${res.body}`).toBe(200);

    const row2027 = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: { employeeId, leaveTypeId: data.vacationType.id, year: 2027 },
      },
    });
    expect(row2027).not.toBeNull();
    expect(Number(row2027!.totalDays)).toBe(30); // unfixed code: 0
    expect(row2027!.isAutoCalculated).toBe(true);
    expect(Number(row2027!.carriedOverDays)).toBe(25);

    const createAudit = await app.prisma.auditLog.findFirst({
      where: { entity: "LeaveEntitlement", entityId: row2027!.id, action: "CREATE" },
    });
    expect(createAudit).not.toBeNull();
    expect((createAudit!.newValue as { totalDays: number }).totalDays).toBe(30);
    expect((createAudit!.newValue as { reason: string }).reason).toBe(
      "Jahreswechsel: regulärer Jahresanspruch",
    );

    const updateAudit = await app.prisma.auditLog.findFirst({
      where: { entity: "LeaveEntitlement", entityId: row2027!.id, action: "UPDATE" },
    });
    expect(updateAudit).not.toBeNull();
    expect((updateAudit!.newValue as { carriedOverDays: number }).carriedOverDays).toBe(25);
  });

  it("scenario 2: a raw 2027 placeholder heals to the regular entitlement when a 2026 booking is approved", async () => {
    const employeeId = await mkEmployee("s2");
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: 2026,
        totalDays: 30,
        isAutoCalculated: true,
      },
    });
    const placeholder = await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: 2027,
        totalDays: 0,
        isAutoCalculated: false,
      },
    });

    const req = await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        status: "PENDING",
        startDate: new Date(Date.UTC(2026, 6, 6)),
        endDate: new Date(Date.UTC(2026, 6, 10)),
        days: 5,
      },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${req.id}/review`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { status: "APPROVED" },
    });
    expect(res.statusCode, `approval must succeed: ${res.body}`).toBe(200);

    const healed = await app.prisma.leaveEntitlement.findUnique({
      where: { id: placeholder.id },
    });
    expect(Number(healed!.totalDays)).toBe(30);
    expect(healed!.isAutoCalculated).toBe(true);

    const updateAudit = await app.prisma.auditLog.findFirst({
      where: { entity: "LeaveEntitlement", entityId: placeholder.id, action: "UPDATE" },
    });
    expect(updateAudit).not.toBeNull();
    expect((updateAudit!.oldValue as { totalDays: number }).totalDays).toBe(0);
    expect((updateAudit!.newValue as { totalDays: number }).totalDays).toBe(30);
  });

  it("scenario 3: GET /leave/entitlements heals a raw 2027 placeholder on read", async () => {
    const employeeId = await mkEmployee("s3");
    const placeholder = await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: 2027,
        totalDays: 0,
        isAutoCalculated: false,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${employeeId}?year=2027`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode, `GET must succeed: ${res.body}`).toBe(200);
    const list = JSON.parse(res.body) as Array<{ totalDays: number; leaveTypeId: string }>;
    const vacationRow = list.find((r) => r.leaveTypeId === data.vacationType.id);
    expect(Number(vacationRow?.totalDays)).toBe(30);

    const dbRow = await app.prisma.leaveEntitlement.findUnique({ where: { id: placeholder.id } });
    expect(Number(dbRow!.totalDays)).toBe(30);

    const updateAudit = await app.prisma.auditLog.findFirst({
      where: { entity: "LeaveEntitlement", entityId: placeholder.id, action: "UPDATE" },
    });
    expect(updateAudit).not.toBeNull();
    expect((updateAudit!.newValue as { reason: string }).reason).toBe(
      "Self-Heal: Urlaubsanspruch 0 ohne manuelle Setzung",
    );
  });

  it("scenario 4: GET /settings/vacation/:employeeId heals a raw 2027 placeholder on read", async () => {
    const employeeId = await mkEmployee("s4");
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: 2027,
        totalDays: 0,
        isAutoCalculated: false,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/settings/vacation/${employeeId}?year=2027`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode, `GET must succeed: ${res.body}`).toBe(200);
    const body = JSON.parse(res.body) as { totalDays: number };
    expect(body.totalDays).toBe(30);
  });

  it("scenario 5: a human-written 0 via PUT /settings/vacation never heals", async () => {
    const employeeId = await mkEmployee("s5");

    const putRes = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/vacation/${employeeId}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { year: 2027, totalDays: 0 },
    });
    expect(putRes.statusCode, `PUT must succeed: ${putRes.body}`).toBe(200);

    const getEntitlementsRes = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${employeeId}?year=2027`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(getEntitlementsRes.statusCode).toBe(200);

    const getSettingsRes = await app.inject({
      method: "GET",
      url: `/api/v1/settings/vacation/${employeeId}?year=2027`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(getSettingsRes.statusCode).toBe(200);
    const settingsBody = JSON.parse(getSettingsRes.body) as { totalDays: number };
    expect(settingsBody.totalDays).toBe(0);

    const row = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: { employeeId, leaveTypeId: data.vacationType.id, year: 2027 },
      },
    });
    expect(Number(row!.totalDays)).toBe(0);

    const healAudit = await app.prisma.auditLog.findFirst({
      where: {
        entity: "LeaveEntitlement",
        entityId: row!.id,
        action: "UPDATE",
      },
    });
    // No UPDATE audit with isAutoCalculated true must exist — the human zero is never healed.
    if (healAudit) {
      const nv = healAudit.newValue as { isAutoCalculated?: boolean };
      expect(nv.isAutoCalculated).not.toBe(true);
    }
  });

  it("scenario 6: POST /leave/requests ensures the year's row before checking availability", async () => {
    const employeeId = await mkEmployee("s6");

    const tooMuchRes = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId,
        type: "VACATION",
        startDate: "2027-03-01",
        endDate: "2027-04-30",
      },
    });
    expect(tooMuchRes.statusCode, `oversized request must be rejected: ${tooMuchRes.body}`).toBe(
      400,
    );
    const tooMuchBody = JSON.parse(tooMuchRes.body) as { error: string };
    expect(tooMuchBody.error).toContain("Nicht genug Urlaubstage in 2027");

    const row2027 = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: { employeeId, leaveTypeId: data.vacationType.id, year: 2027 },
      },
    });
    expect(row2027).not.toBeNull();
    expect(Number(row2027!.totalDays)).toBe(30);

    const createAudit = await app.prisma.auditLog.findFirst({
      where: { entity: "LeaveEntitlement", entityId: row2027!.id, action: "CREATE" },
    });
    expect(createAudit).not.toBeNull();
    expect((createAudit!.newValue as { reason: string }).reason).toBe(
      "Urlaubsantrag: regulärer Jahresanspruch",
    );

    const okRes = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId,
        type: "VACATION",
        startDate: "2027-03-01",
        endDate: "2027-03-05",
      },
    });
    expect(okRes.statusCode, `in-budget request must succeed: ${okRes.body}`).toBe(201);
  });
});
