/**
 * Issue #445 finding 1 — next-year VACATION entitlement (D-04/D-05/D-06).
 *
 * Fixed dates only (2026/2027) — no assertion depends on `new Date()`. Every scenario uses its
 * own fresh employee (hireDate 2024-01-01, FIXED Mo-Fr WorkSchedule validFrom 2024-01-01,
 * OvertimeAccount balance 0, initials-only) so the seeded current-year row of `data.employee`
 * never interferes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  auditRowsFor,
  auditRowsChangingField,
} from "./setup";
import type { FastifyInstance } from "fastify";

describe("Issue #445 finding 1 — next-year VACATION entitlement (D-04/D-05/D-06)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  // Issue #555/#561: one action can write several UPDATE audits on the same entitlement row, so
  // every lookup reads ALL rows of the action in creation order (shared helpers in ./setup) and
  // selects by the field the scenario is about.
  const auditRows = (entityId: string, action: "CREATE" | "UPDATE") =>
    auditRowsFor(app, "LeaveEntitlement", entityId, action);
  const changing = auditRowsChangingField;

  async function mkEmployee(
    label: string,
    hireDate = new Date(Date.UTC(2024, 0, 1)),
  ): Promise<string> {
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

    const creates = await auditRows(row2027!.id, "CREATE");
    expect(creates).toHaveLength(1);
    const createAudit = creates[0];
    expect((createAudit!.newValue as { totalDays: number }).totalDays).toBe(30);
    expect((createAudit!.newValue as { reason: string }).reason).toBe(
      "Jahreswechsel: regulärer Jahresanspruch",
    );

    const carryUpdates = changing(await auditRows(row2027!.id, "UPDATE"), "carriedOverDays");
    expect(carryUpdates).toHaveLength(1);
    expect((carryUpdates[0].newValue as { carriedOverDays: number }).carriedOverDays).toBe(25);
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

    // The approval writes two UPDATE audits: the heal (totalDays) and the carry-over recompute
    // (carriedOverDays). The heal is the one this scenario is about, and it is written exactly once.
    const healUpdates = changing(await auditRows(placeholder.id, "UPDATE"), "totalDays");
    expect(healUpdates).toHaveLength(1);
    expect((healUpdates[0].oldValue as { totalDays: number }).totalDays).toBe(0);
    expect((healUpdates[0].newValue as { totalDays: number }).totalDays).toBe(30);
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

    const selfHeals = changing(await auditRows(placeholder.id, "UPDATE"), "totalDays");
    expect(selfHeals).toHaveLength(1);
    const updateAudit = selfHeals[0];
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
    // Issue #435 (D-10): a totalDays write below the statutory minimum is now rejected. Hired
    // AFTER the queried year keeps the statutory threshold at 0 (not-yet-employed guard), so an
    // explicit 0 for 2027 is still a legal write — this test is about the "never heals"
    // human-write detection, not about the number itself.
    const employeeId = await mkEmployee("s5", new Date(Date.UTC(2028, 0, 1)));

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

    // No UPDATE audit may heal the human zero: checked over EVERY update row, not just the first one
    // an unordered lookup happens to return (#555).
    const updates = await auditRows(row!.id, "UPDATE");
    expect(
      updates.filter(
        (r) => (r.newValue as { isAutoCalculated?: boolean }).isAutoCalculated === true,
      ),
    ).toEqual([]);
    expect(changing(updates, "totalDays")).toEqual([]);
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

    const creates = await auditRows(row2027!.id, "CREATE");
    expect(creates).toHaveLength(1);
    const createAudit = creates[0];
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
