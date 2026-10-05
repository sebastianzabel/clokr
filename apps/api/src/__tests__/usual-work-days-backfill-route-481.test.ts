/**
 * usual-work-days-backfill-route-481.test.ts
 *
 * Issue #481 R6 (D-05): PATCH /api/v1/settings/work/:employeeId/usual-work-days fills the
 * übliche Arbeitstage on an EXISTING SHIFT_BASED contract row — in place, audited, without a new
 * row and without repricing anything stored. The next pricing of that period (preview, a new
 * request, the audited repricing script) reads the new Angabe.
 *
 * Contract B is the measured prod case: 4 days since 18.05.2026 with an empty Angabe, plus a row
 * from 01.10.2026 with Di–Fr. 12.06.–28.06.2026 prices 10 without the Angabe on the May row and 9
 * with it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("PATCH /settings/work/:employeeId/usual-work-days — Nachtrag on an existing row (Issue #481, R6)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let employeeId: string;
  let empToken: string;
  let row1Id: string;
  let row2Id: string;
  let requestId: string;
  let patchedAt: Date;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "uwb481");

    const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const email = `uwb481-b-${uid}@test.de`;
    const user = await app.prisma.user.create({
      data: {
        email,
        passwordHash: await (await import("bcryptjs")).default.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `UWB-${uid}`,
        firstName: "B",
        lastName: "K",
        hireDate: new Date("2026-05-18"),
      },
    });
    employeeId = employee.id;
    await app.prisma.overtimeAccount.create({ data: { employeeId, balanceHours: 0 } });
    const base = {
      employeeId,
      type: "SHIFT_BASED" as const,
      weeklyHours: 32,
      contractWorkDaysPerWeek: 4,
      workDays: [2, 3, 4, 5],
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
    };
    row1Id = (
      await app.prisma.workSchedule.create({
        data: { ...base, usualWorkDays: [], validFrom: new Date("2026-05-18") },
      })
    ).id;
    row2Id = (
      await app.prisma.workSchedule.create({
        data: { ...base, usualWorkDays: [2, 3, 4, 5], validFrom: new Date("2026-10-01") },
      })
    ).id;
    requestId = (
      await app.prisma.leaveRequest.create({
        data: {
          employeeId,
          leaveTypeId: data.vacationType.id,
          startDate: new Date("2026-06-12"),
          endDate: new Date("2026-06-28"),
          days: 10,
          status: "APPROVED",
        },
      })
    ).id;

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: "test1234" },
    });
    empToken = JSON.parse(login.body).accessToken as string;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Cleanup failed:", err);
    }
  });

  async function previewDays(): Promise<number> {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/leave/hours-preview?startDate=2026-06-12&endDate=2026-06-28",
      headers: { authorization: `Bearer ${empToken}` },
    });
    expect(res.statusCode).toBe(200);
    return Number(JSON.parse(res.body).days);
  }

  function patch(id: string, payload: Record<string, unknown>, token = data.adminToken) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/settings/work/${id}/usual-work-days`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  it("before the Nachtrag the period prices 10 (Sa 13.06. counts without an Angabe)", async () => {
    expect(await previewDays()).toBe(10);
  });

  it("PATCH sets the Angabe on the historic row in place (sorted, same id and validFrom)", async () => {
    patchedAt = new Date();
    const res = await patch(employeeId, { workScheduleId: row1Id, usualWorkDays: [5, 4, 3, 2] });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe(row1Id);
    expect(body.usualWorkDays).toEqual([2, 3, 4, 5]);
    expect(new Date(body.validFrom).toISOString().slice(0, 10)).toBe("2026-05-18");
  });

  it("no row is created; the other fields of row 1 and all of row 2 are unchanged", async () => {
    const rows = await app.prisma.workSchedule.findMany({
      where: { employeeId },
      orderBy: { validFrom: "asc" },
    });
    expect(rows.map((r) => r.id)).toEqual([row1Id, row2Id]);
    expect(rows[0].type).toBe("SHIFT_BASED");
    expect(rows[0].contractWorkDaysPerWeek).toBe(4);
    expect(rows[0].workDays).toEqual([2, 3, 4, 5]);
    expect(Number(rows[0].weeklyHours)).toBe(32);
    expect(rows[1].usualWorkDays).toEqual([2, 3, 4, 5]);
    expect(rows[1].updatedAt.getTime()).toBeLessThan(patchedAt.getTime());
  });

  it("exactly one AuditLog UPDATE WorkSchedule with old [] and new [2,3,4,5] by the admin", async () => {
    const audits = await app.prisma.auditLog.findMany({
      where: { entity: "WorkSchedule", entityId: row1Id },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("UPDATE");
    expect(audits[0].userId).toBe(data.adminUser.id);
    expect((audits[0].oldValue as { usualWorkDays: number[] }).usualWorkDays).toEqual([]);
    expect((audits[0].newValue as { usualWorkDays: number[] }).usualWorkDays).toEqual([2, 3, 4, 5]);
  });

  it("after the Nachtrag the period prices 9, but nothing stored is repriced", async () => {
    expect(await previewDays()).toBe(9);
    const stored = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(Number(stored.days)).toBe(10);
    const leaveAudits = await app.prisma.auditLog.count({
      where: {
        entity: { in: ["LeaveRequest", "LeaveEntitlement"] },
        createdAt: { gte: patchedAt },
      },
    });
    expect(leaveAudits).toBe(0);
  });

  it("repeating the identical PATCH is a no-op: 200, no further audit row", async () => {
    const res = await patch(employeeId, { workScheduleId: row1Id, usualWorkDays: [2, 3, 4, 5] });
    expect(res.statusCode).toBe(200);
    expect(
      await app.prisma.auditLog.count({ where: { entity: "WorkSchedule", entityId: row1Id } }),
    ).toBe(1);
  });
});

describe("PATCH /settings/work/:employeeId/usual-work-days — validation, oracle, permission (Issue #481, R6)", () => {
  let app: FastifyInstance;
  let a: Awaited<ReturnType<typeof seedTestData>>;
  let b: Awaited<ReturnType<typeof seedTestData>>;
  let shiftRowId: string;
  let shiftEmpId: string;
  let otherRowId: string;
  let foreignRowId: string;
  let fixedRowId: string;
  let fixedEmpId: string;

  async function mkEmployee(
    seed: Awaited<ReturnType<typeof seedTestData>>,
    tag: string,
    row: { type: "SHIFT_BASED" | "FIXED_SCHEDULE"; usualWorkDays: number[] },
  ) {
    const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `uwb481v-${tag}-${uid}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: seed.tenant.id,
        userId: user.id,
        employeeNumber: `UWBV-${tag}-${uid}`,
        firstName: "V",
        lastName: "R",
        hireDate: new Date("2026-01-01"),
      },
    });
    const schedule = await app.prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        type: row.type,
        weeklyHours: 32,
        contractWorkDaysPerWeek: row.type === "SHIFT_BASED" ? 4 : null,
        workDays: [1, 2, 3, 4, 5],
        usualWorkDays: row.usualWorkDays,
        validFrom: new Date("2026-01-01"),
      },
    });
    return { employeeId: employee.id, rowId: schedule.id };
  }

  beforeAll(async () => {
    app = await getTestApp();
    a = await seedTestData(app, "uwb481v");
    b = await seedTestData(app, "uwb481b");
    const shift = await mkEmployee(a, "shift", { type: "SHIFT_BASED", usualWorkDays: [] });
    shiftEmpId = shift.employeeId;
    shiftRowId = shift.rowId;
    otherRowId = (await mkEmployee(a, "other", { type: "SHIFT_BASED", usualWorkDays: [] })).rowId;
    foreignRowId = (await mkEmployee(b, "foreign", { type: "SHIFT_BASED", usualWorkDays: [] }))
      .rowId;
    const fixed = await mkEmployee(a, "fixed", { type: "FIXED_SCHEDULE", usualWorkDays: [] });
    fixedRowId = fixed.rowId;
    fixedEmpId = fixed.employeeId;
  });

  afterAll(async () => {
    for (const seed of [a, b]) {
      try {
        await cleanupTestData(app, seed.tenant.id);
      } catch (err) {
        console.error("Cleanup failed:", err);
      }
    }
  });

  function patch(employeeId: string, payload: Record<string, unknown>, token = a.adminToken) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/settings/work/${employeeId}/usual-work-days`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  async function writesSince(t: Date) {
    return app.prisma.auditLog.count({
      where: { entity: "WorkSchedule", action: "UPDATE", createdAt: { gte: t } },
    });
  }

  it("rejects every invalid Angabe like R5 and writes nothing", async () => {
    const t = new Date();
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ workScheduleId: shiftRowId, usualWorkDays: [] }, shiftEmpId, "Pflicht"],
      [{ workScheduleId: shiftRowId, usualWorkDays: [2, 3] }, shiftEmpId, "mindestens 4"],
      [{ workScheduleId: shiftRowId, usualWorkDays: [2, 2, 3, 4] }, shiftEmpId, "nur einmal"],
      [{ workScheduleId: shiftRowId, usualWorkDays: [7] }, shiftEmpId, "Validierungsfehler"],
      [{ workScheduleId: "abc", usualWorkDays: [2, 3, 4, 5] }, shiftEmpId, "Validierungsfehler"],
      [
        { workScheduleId: fixedRowId, usualWorkDays: [1, 2, 3, 4, 5] },
        fixedEmpId,
        "nur bei Schichtbetrieb",
      ],
    ];
    for (const [payload, empId, fragment] of cases) {
      const res = await patch(empId, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(JSON.parse(res.body).error).toContain(fragment);
    }
    expect(await writesSince(t)).toBe(0);
    const row = await app.prisma.workSchedule.findUniqueOrThrow({ where: { id: shiftRowId } });
    expect(row.usualWorkDays).toEqual([]);
  });

  it("row oracle: unknown, another employee's and a foreign tenant's row answer one identical 404", async () => {
    const bodies = [];
    for (const workScheduleId of [
      "00000000-0000-4000-8000-000000000001",
      otherRowId,
      foreignRowId,
    ]) {
      const res = await patch(shiftEmpId, { workScheduleId, usualWorkDays: [2, 3, 4, 5] });
      expect(res.statusCode).toBe(404);
      bodies.push(res.body);
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0])).toEqual({ error: "Vertragsdatensatz nicht gefunden" });
    const foreign = await app.prisma.workSchedule.findUniqueOrThrow({
      where: { id: foreignRowId },
    });
    expect(foreign.usualWorkDays).toEqual([]);
  });

  it("employee oracle: a foreign tenant's employee and a nonexistent id answer the identical 404, foreign audited", async () => {
    const foreignEmp = await app.prisma.workSchedule.findUniqueOrThrow({
      where: { id: foreignRowId },
    });
    const body = { workScheduleId: foreignRowId, usualWorkDays: [2, 3, 4, 5] };
    const t = new Date();
    const foreignRes = await patch(foreignEmp.employeeId, body);
    const missingRes = await patch("00000000-0000-4000-8000-0000000000aa", body);
    expect(foreignRes.statusCode).toBe(404);
    expect(missingRes.statusCode).toBe(404);
    expect(foreignRes.body).toBe(missingRes.body);
    expect(
      await app.prisma.auditLog.count({
        where: {
          action: "CROSS_TENANT_ACCESS_DENIED",
          entityId: foreignEmp.employeeId,
          createdAt: { gte: t },
        },
      }),
    ).toBe(1);
  });

  it("an EMPLOYEE token gets 403 on its own employee and nothing is written", async () => {
    const own = await app.prisma.workSchedule.create({
      data: {
        employeeId: a.employee.id,
        type: "SHIFT_BASED",
        weeklyHours: 32,
        contractWorkDaysPerWeek: 4,
        workDays: [2, 3, 4, 5],
        usualWorkDays: [],
        validFrom: new Date("2025-01-01"),
      },
    });
    const res = await patch(
      a.employee.id,
      { workScheduleId: own.id, usualWorkDays: [2, 3, 4, 5] },
      a.empToken,
    );
    expect(res.statusCode).toBe(403);
    const after = await app.prisma.workSchedule.findUniqueOrThrow({ where: { id: own.id } });
    expect(after.usualWorkDays).toEqual([]);
  });
});
