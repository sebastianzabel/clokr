/**
 * usual-workdays-required-481.test.ts
 *
 * Issue #481 R5 (owner decision 2026-10-04, Unterbau-Semantikänderung): every write that creates
 * or changes a SHIFT_BASED contract requires übliche Arbeitstage — at least
 * `contractWorkDaysPerWeek` of them. The rule lives in ONE place, `validateUsualWorkDays()`, which
 * both real write paths already call (POST /employees, PUT /settings/work/:employeeId).
 *
 * The second describe block locks D-08: tenant bulk apply, the cancelOrphanShifts branch and the
 * CSV employee import never write a SHIFT_BASED row, so they need no validator call of their own.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import { monthsAheadStr } from "./test-dates";
import type { FastifyInstance } from "fastify";

/** First of the month N months from now — WorkSchedule.validFrom must be a month-1st. */
function monthFirstStr(monthsFromNow: number): string {
  return monthsAheadStr(monthsFromNow).slice(0, 8) + "01";
}

const PFLICHT = "Bei Schichtbetrieb sind die üblichen Arbeitstage Pflicht";

describe("Issue #481 R5 — übliche Arbeitstage are required for SHIFT_BASED contracts", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let salonId: string;
  const baseValidFrom = monthFirstStr(0);

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "uwr481");
    salonId = data.salonId!;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Cleanup failed:", err);
    }
  });

  /** A SHIFT_BASED employee created directly via Prisma (the write path under test is the PUT). */
  async function shiftEmployee(tag: string, usualWorkDays: number[]) {
    const user = await app.prisma.user.create({
      data: {
        email: `uwr481-${tag}-${Date.now()}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `UWR-${tag}-${Date.now()}`,
        firstName: "U",
        lastName: "W",
        hireDate: new Date(baseValidFrom),
      },
    });
    await app.prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
    const schedule = await app.prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        type: "SHIFT_BASED",
        weeklyHours: 32,
        workDays: [2, 3, 4, 5],
        contractWorkDaysPerWeek: 4,
        usualWorkDays,
        validFrom: new Date(baseValidFrom),
      },
    });
    return { employee, schedule };
  }

  async function putWork(employeeId: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${employeeId}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload,
    });
  }

  async function postEmployee(payload: Record<string, unknown>) {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    return app.inject({
      method: "POST",
      url: "/api/v1/employees",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        firstName: "T",
        lastName: "R",
        employeeNumber: `UWRP-${suffix}`,
        email: `uwr481p-${suffix}@test.de`,
        hireDate: new Date(baseValidFrom).toISOString(),
        homeSalonId: salonId,
        ...payload,
      },
    });
  }

  async function tenantCounts() {
    const [users, employees, schedules] = await Promise.all([
      app.prisma.user.count(),
      app.prisma.employee.count({ where: { tenantId: data.tenant.id } }),
      app.prisma.workSchedule.count({ where: { employee: { tenantId: data.tenant.id } } }),
    ]);
    return { users, employees, schedules };
  }

  it("POST /employees SHIFT_BASED contract 4 without usualWorkDays -> 400 Pflicht, nothing created", async () => {
    const before = await tenantCounts();
    const res = await postEmployee({ scheduleType: "SHIFT_BASED", contractWorkDaysPerWeek: 4 });
    expect(res.statusCode).toBe(400);
    const error = JSON.parse(res.body).error as string;
    expect(error).toContain(PFLICHT);
    expect(error).toContain("mindestens 4");
    expect(await tenantCounts()).toEqual(before);
  });

  it("POST /employees without scheduleType (default SHIFT_BASED) and without usualWorkDays -> 400 'mindestens 5'", async () => {
    const before = await tenantCounts();
    const res = await postEmployee({});
    expect(res.statusCode).toBe(400);
    const error = JSON.parse(res.body).error as string;
    expect(error).toContain(PFLICHT);
    expect(error).toContain("mindestens 5");
    expect(await tenantCounts()).toEqual(before);
  });

  it("POST /employees default SHIFT_BASED with usualWorkDays [] or null -> the same 400", async () => {
    for (const usualWorkDays of [[], null]) {
      const res = await postEmployee({ usualWorkDays });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain(PFLICHT);
    }
  });

  it("POST /employees SHIFT_BASED contract 4 with usualWorkDays [5,2,3,4] -> 201, stored sorted", async () => {
    const res = await postEmployee({
      scheduleType: "SHIFT_BASED",
      contractWorkDaysPerWeek: 4,
      usualWorkDays: [5, 2, 3, 4],
    });
    expect(res.statusCode).toBe(201);
    const schedule = await app.prisma.workSchedule.findFirstOrThrow({
      where: { employeeId: JSON.parse(res.body).id },
    });
    expect(schedule.usualWorkDays).toEqual([2, 3, 4, 5]);
  });

  it("PUT SHIFT_BASED new contract row (next month) without usualWorkDays -> 400, no row written", async () => {
    const { employee } = await shiftEmployee("new", [2, 3, 4, 5]);
    const before = await app.prisma.workSchedule.count({ where: { employeeId: employee.id } });
    const res = await putWork(employee.id, {
      type: "SHIFT_BASED",
      weeklyHours: 32,
      contractWorkDaysPerWeek: 4,
      validFrom: monthFirstStr(1),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain(PFLICHT);
    expect(await app.prisma.workSchedule.count({ where: { employeeId: employee.id } })).toBe(
      before,
    );
  });

  it("PUT SHIFT_BASED update in place over a stored empty Angabe, usualWorkDays omitted -> 400", async () => {
    const { employee, schedule } = await shiftEmployee("empty", []);
    const res = await putWork(employee.id, {
      type: "SHIFT_BASED",
      weeklyHours: 33,
      contractWorkDaysPerWeek: 4,
      validFrom: baseValidFrom,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain(PFLICHT);
    const row = await app.prisma.workSchedule.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(Number(row.weeklyHours)).toBe(32);
  });

  it("PUT SHIFT_BASED update in place: null over a stored [2,3,4,5] -> 400 and the Angabe survives; omitted -> 200 keeps it", async () => {
    const { employee, schedule } = await shiftEmployee("keep", [2, 3, 4, 5]);
    const nullRes = await putWork(employee.id, {
      type: "SHIFT_BASED",
      weeklyHours: 33,
      contractWorkDaysPerWeek: 4,
      usualWorkDays: null,
      validFrom: baseValidFrom,
    });
    expect(nullRes.statusCode).toBe(400);
    expect(JSON.parse(nullRes.body).error).toContain(PFLICHT);
    const afterNull = await app.prisma.workSchedule.findUniqueOrThrow({
      where: { id: schedule.id },
    });
    expect(afterNull.usualWorkDays).toEqual([2, 3, 4, 5]);

    const omitRes = await putWork(employee.id, {
      type: "SHIFT_BASED",
      weeklyHours: 33,
      contractWorkDaysPerWeek: 4,
      validFrom: baseValidFrom,
    });
    expect(omitRes.statusCode).toBe(200);
    expect(JSON.parse(omitRes.body).usualWorkDays).toEqual([2, 3, 4, 5]);
  });

  it("PUT SHIFT_BASED contract 4 with usualWorkDays [2,3] -> 400 'mindestens 4' (unchanged rule)", async () => {
    const { employee } = await shiftEmployee("short", [2, 3, 4, 5]);
    const res = await putWork(employee.id, {
      type: "SHIFT_BASED",
      weeklyHours: 32,
      contractWorkDaysPerWeek: 4,
      usualWorkDays: [2, 3],
      validFrom: baseValidFrom,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("mindestens 4");
  });

  it("PUT FIXED_SCHEDULE: usualWorkDays [] -> 200 stored []; [1,2] -> 400 'nur bei Schichtbetrieb' (unchanged)", async () => {
    const fixed = {
      type: "FIXED_SCHEDULE",
      weeklyHours: 40,
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
    };
    const emptyRes = await putWork(data.employee.id, {
      ...fixed,
      usualWorkDays: [],
      validFrom: monthFirstStr(2),
    });
    expect(emptyRes.statusCode).toBe(200);
    expect(JSON.parse(emptyRes.body).usualWorkDays).toEqual([]);

    const badRes = await putWork(data.employee.id, {
      ...fixed,
      usualWorkDays: [1, 2],
      validFrom: monthFirstStr(3),
    });
    expect(badRes.statusCode).toBe(400);
    expect(JSON.parse(badRes.body).error).toBe(
      "Übliche Arbeitstage gibt es nur bei Schichtbetrieb.",
    );
  });
});

describe("D-08 write-path audit (Issue #481) — paths without a validator call never write SHIFT_BASED", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  const pastValidFrom = monthFirstStr(-6);

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "uwr481d");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Cleanup failed:", err);
    }
  });

  async function bareEmployee(tag: string) {
    const user = await app.prisma.user.create({
      data: {
        email: `uwr481d-${tag}-${Date.now()}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `UWRD-${tag}-${Date.now()}`,
        firstName: "D",
        lastName: "W",
        hireDate: new Date(pastValidFrom),
      },
    });
    await app.prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
    return employee;
  }

  async function shiftBasedRowCount() {
    return app.prisma.workSchedule.count({
      where: { type: "SHIFT_BASED", employee: { tenantId: data.tenant.id } },
    });
  }

  it("tenant bulk apply never creates or changes a SHIFT_BASED row", async () => {
    const shiftEmp = await bareEmployee("bulk-shift");
    const shiftRow = await app.prisma.workSchedule.create({
      data: {
        employeeId: shiftEmp.id,
        type: "SHIFT_BASED",
        weeklyHours: 32,
        workDays: [2, 3, 4, 5],
        contractWorkDaysPerWeek: 4,
        usualWorkDays: [],
        validFrom: new Date(pastValidFrom),
      },
    });
    const noScheduleEmp = await bareEmployee("bulk-none");
    const shiftCountBefore = await shiftBasedRowCount();

    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { applyToExisting: true, defaultWeeklyHours: 39 },
    });
    expect(res.statusCode).toBe(200);

    expect(await shiftBasedRowCount()).toBe(shiftCountBefore);
    const shiftRowAfter = await app.prisma.workSchedule.findUniqueOrThrow({
      where: { id: shiftRow.id },
    });
    expect(shiftRowAfter).toEqual(shiftRow);
    const created = await app.prisma.workSchedule.findMany({
      where: { employeeId: noScheduleEmp.id },
    });
    expect(created.map((r) => r.type)).toEqual(["FIXED_SCHEDULE"]);
  });

  it("cancelOrphanShifts (leaving SHIFT_BASED) writes only a non-SHIFT_BASED row with an empty Angabe", async () => {
    const emp = await bareEmployee("orphan");
    const oldRow = await app.prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
        type: "SHIFT_BASED",
        weeklyHours: 32,
        workDays: [2, 3, 4, 5],
        contractWorkDaysPerWeek: 4,
        usualWorkDays: [2, 3, 4, 5],
        validFrom: new Date(pastValidFrom),
      },
    });
    const future = new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 15),
    );
    await app.prisma.shift.create({
      data: {
        employeeId: emp.id,
        salonId: data.salonId!,
        date: future,
        startTime: "09:00",
        endTime: "17:00",
      },
    });
    const shiftCountBefore = await shiftBasedRowCount();

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${emp.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        type: "FLEXTIME",
        weeklyHours: 32,
        workDays: [1, 2, 3, 4],
        cancelOrphanShifts: true,
        validFrom: monthFirstStr(1),
      },
    });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.type).toBe("FLEXTIME");
    expect(body.usualWorkDays).toEqual([]);
    expect(await shiftBasedRowCount()).toBe(shiftCountBefore);
    const oldRowAfter = await app.prisma.workSchedule.findUniqueOrThrow({
      where: { id: oldRow.id },
    });
    expect(oldRowAfter.updatedAt).toEqual(oldRow.updatedAt);
  });

  it("CSV employee import rejects a SHIFT_BASED row and still imports a FIXED_SCHEDULE row", async () => {
    const uid = Date.now().toString(36);
    const csv = `email;vorname;nachname;nr;eintrittsdatum;rolle;wochenstunden;modell;passwort
uwr481-csv-s-${uid}@test.de;C;S;CSVS-${uid};01.01.2026;EMPLOYEE;40;SHIFT_BASED;test12345
uwr481-csv-f-${uid}@test.de;C;F;CSVF-${uid};01.01.2026;EMPLOYEE;40;FIXED_SCHEDULE;test12345`;
    const shiftCountBefore = await shiftBasedRowCount();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/imports/employees",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { csv },
    });
    expect(res.statusCode, res.body.slice(0, 400)).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.imported).toBe(1);
    expect(body.errors).toBe(1);
    expect(await app.prisma.employee.count({ where: { employeeNumber: `CSVS-${uid}` } })).toBe(0);
    expect(await app.prisma.employee.count({ where: { employeeNumber: `CSVF-${uid}` } })).toBe(1);
    expect(await shiftBasedRowCount()).toBe(shiftCountBefore);
  });
});
