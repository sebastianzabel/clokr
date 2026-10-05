/**
 * workschedule-usual-workdays-436.test.ts
 *
 * Phase 436 Plan 02 (D-02) — the write-path matrix for `WorkSchedule.usualWorkDays` across every
 * write path, not just the SHIFT_BASED branch plan 01 proved:
 *
 *   - PUT /api/v1/settings/work/:employeeId rejects a non-SHIFT_BASED body carrying a non-empty
 *     `usualWorkDays` BEFORE any write — including before the cancelOrphanShifts transaction.
 *   - The cancelOrphanShifts branch (switching away from SHIFT_BASED) always stores `[]`.
 *   - POST /api/v1/employees accepts, validates and audits `usualWorkDays` on create.
 *   - PUT /settings/work's AuditLog row carries `usualWorkDays` in both old and new value.
 *
 * RED evidence (recorded against the plan-01 base commit, before this plan's GREEN changes):
 *   - "PUT FIXED_SCHEDULE with usualWorkDays [1,2] -> 400": returned 200 — no early rejection
 *     existed yet, the non-SHIFT_BASED branch silently wrote `usualWorkDays: []` without checking
 *     the caller's value at all.
 *   - "switch away from SHIFT_BASED with a non-empty usualWorkDays is rejected and the future
 *     shift survives": the PUT returned 200, cancelled the future shift anyway (no early guard),
 *     and the resulting row ignored the caller's `usualWorkDays` silently instead of rejecting.
 *   - "POST /employees SHIFT_BASED stores usualWorkDays": the field did not exist on the create
 *     schema at all — Zod stripped it silently, the created row's `usualWorkDays` was `[]`
 *     regardless of the body.
 *   - "POST SHIFT_BASED, contract 4, usualWorkDays [2,3] -> 400": returned 201 — no pre-transaction
 *     validation existed, so an Employee + User row was created despite the too-short Angabe.
 *   - "POST audit newValue.workSchedule": the Employee CREATE audit's `newValue` had no
 *     `workSchedule` key at all.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import { monthsAheadStr, dbDateStr, utcMidnight } from "./test-dates";
import type { FastifyInstance } from "fastify";

/** First of the month N months from now (tenant TZ) — WorkSchedule.validFrom must be month-1st. */
function monthFirstStr(monthsFromNow: number): string {
  return monthsAheadStr(monthsFromNow).slice(0, 8) + "01";
}

describe("Issue #436 Plan 02 — WorkSchedule.usualWorkDays on every write path (D-02)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let shiftEmployee: { id: string };
  let switchEmployee: { id: string };
  let salonId: string;

  const SEED_CONTRACT_DAYS = 4;
  const seedValidFrom = monthFirstStr(-12);
  const switchValidFrom = monthFirstStr(-12);

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "w436w");
    salonId = data.salonId!;

    const bcryptMod = await import("bcryptjs");
    const passwordHash = await bcryptMod.default.hash("test1234", 10);

    const user1 = await app.prisma.user.create({
      data: {
        email: `w436w-shift1-${Date.now()}@test.de`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    shiftEmployee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user1.id,
        employeeNumber: `W436W1-${Date.now()}`,
        firstName: "Shift",
        lastName: "UsualDaysA",
        hireDate: new Date(seedValidFrom),
      },
    });
    await app.prisma.overtimeAccount.create({
      data: { employeeId: shiftEmployee.id, balanceHours: 0 },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: shiftEmployee.id,
        type: "SHIFT_BASED",
        weeklyHours: 32,
        workDays: [2, 3, 4, 5],
        contractWorkDaysPerWeek: SEED_CONTRACT_DAYS,
        usualWorkDays: [],
        validFrom: new Date(seedValidFrom),
      },
    });

    // Second employee, dedicated to the switch-away-from-SHIFT_BASED cases, with a future shift
    // so cancelOrphanShifts has something to cancel (or must leave untouched on rejection).
    const user2 = await app.prisma.user.create({
      data: {
        email: `w436w-switch-${Date.now()}@test.de`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    switchEmployee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user2.id,
        employeeNumber: `W436W2-${Date.now()}`,
        firstName: "Shift",
        lastName: "UsualDaysSwitch",
        hireDate: new Date(switchValidFrom),
      },
    });
    await app.prisma.overtimeAccount.create({
      data: { employeeId: switchEmployee.id, balanceHours: 0 },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: switchEmployee.id,
        type: "SHIFT_BASED",
        weeklyHours: 32,
        workDays: [2, 3, 4, 5],
        contractWorkDaysPerWeek: SEED_CONTRACT_DAYS,
        usualWorkDays: [2, 3, 4, 5],
        validFrom: new Date(switchValidFrom),
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Cleanup failed:", err);
    }
  });

  async function putWork(employeeId: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${employeeId}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload,
    });
  }

  async function seedFutureShift(employeeId: string) {
    const future = new Date(
      utcMidnight(dbDateStr(new Date())).getTime() + 30 * 24 * 60 * 60 * 1000,
    );
    return app.prisma.shift.create({
      data: {
        employeeId,
        salonId,
        date: future,
        startTime: "09:00",
        endTime: "17:00",
      },
    });
  }

  it("PUT FIXED_SCHEDULE with usualWorkDays [1,2] -> 400 'nur bei Schichtbetrieb', row unchanged", async () => {
    const before = await app.prisma.workSchedule.count({
      where: { employeeId: data.employee.id },
    });
    const res = await putWork(data.employee.id, {
      type: "FIXED_SCHEDULE",
      weeklyHours: 32,
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
      usualWorkDays: [1, 2],
      validFrom: monthFirstStr(2),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("Übliche Arbeitstage gibt es nur bei Schichtbetrieb.");
    const after = await app.prisma.workSchedule.count({ where: { employeeId: data.employee.id } });
    expect(after).toBe(before);
  });

  it("PUT FIXED_SCHEDULE with usualWorkDays [] -> 200, stored []", async () => {
    const res = await putWork(data.employee.id, {
      type: "FIXED_SCHEDULE",
      weeklyHours: 32,
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
      usualWorkDays: [],
      validFrom: monthFirstStr(3),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.usualWorkDays).toEqual([]);
  });

  it("PUT SHIFT_BASED with duplicate usualWorkDays [2,2,3,4] -> 400", async () => {
    const res = await putWork(shiftEmployee.id, {
      type: "SHIFT_BASED",
      weeklyHours: 32,
      contractWorkDaysPerWeek: 4,
      usualWorkDays: [2, 2, 3, 4],
      validFrom: seedValidFrom,
    });
    expect(res.statusCode).toBe(400);
  });

  it("PUT SHIFT_BASED with usualWorkDays [7] -> 400 (Zod range)", async () => {
    const res = await putWork(shiftEmployee.id, {
      type: "SHIFT_BASED",
      weeklyHours: 32,
      contractWorkDaysPerWeek: 4,
      usualWorkDays: [7],
      validFrom: seedValidFrom,
    });
    expect(res.statusCode).toBe(400);
  });

  // Issue #481 R5 (owner decision 04.10.2026): empty Angabe no longer valid for SHIFT_BASED — null
  // used to clear the Angabe to [], it is now rejected and the stored value survives.
  it("PUT SHIFT_BASED update-in-place: stored [2,3,4,5], omitting usualWorkDays keeps it; sending null is rejected and keeps it", async () => {
    // First, make sure the stored value is [2,3,4,5] (seed already set it, but be explicit).
    const setRes = await putWork(shiftEmployee.id, {
      type: "SHIFT_BASED",
      weeklyHours: 32,
      contractWorkDaysPerWeek: 4,
      usualWorkDays: [2, 3, 4, 5],
      validFrom: seedValidFrom,
    });
    expect(setRes.statusCode).toBe(200);

    const omitRes = await putWork(shiftEmployee.id, {
      type: "SHIFT_BASED",
      weeklyHours: 33,
      contractWorkDaysPerWeek: 4,
      validFrom: seedValidFrom,
    });
    expect(omitRes.statusCode).toBe(200);
    expect(JSON.parse(omitRes.body).usualWorkDays).toEqual([2, 3, 4, 5]);

    const nullRes = await putWork(shiftEmployee.id, {
      type: "SHIFT_BASED",
      weeklyHours: 33,
      contractWorkDaysPerWeek: 4,
      usualWorkDays: null,
      validFrom: seedValidFrom,
    });
    expect(nullRes.statusCode).toBe(400);
    const stored = await app.prisma.workSchedule.findFirstOrThrow({
      where: { employeeId: shiftEmployee.id, validFrom: new Date(seedValidFrom) },
    });
    expect(stored.usualWorkDays).toEqual([2, 3, 4, 5]);

    // Restore for subsequent tests in this file.
    const restoreRes = await putWork(shiftEmployee.id, {
      type: "SHIFT_BASED",
      weeklyHours: 32,
      contractWorkDaysPerWeek: 4,
      usualWorkDays: [2, 3, 4, 5],
      validFrom: seedValidFrom,
    });
    expect(restoreRes.statusCode).toBe(200);
  });

  it("PUT SHIFT_BASED raising contractWorkDaysPerWeek 4 -> 5 while omitting usualWorkDays (inherited [2,3,4,5]) -> 400 'mindestens 5'", async () => {
    const res = await putWork(shiftEmployee.id, {
      type: "SHIFT_BASED",
      weeklyHours: 32,
      contractWorkDaysPerWeek: 5,
      validFrom: seedValidFrom,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("mindestens 5");

    const stored = await app.prisma.workSchedule.findFirst({
      where: { employeeId: shiftEmployee.id, validFrom: new Date(seedValidFrom) },
    });
    expect(stored?.contractWorkDaysPerWeek).toBe(4);
  });

  it("switch SHIFT_BASED -> FIXED_SCHEDULE (cancelOrphanShifts, future shift present) -> 200, new row's usualWorkDays is []", async () => {
    const shift = await seedFutureShift(switchEmployee.id);
    const newValidFrom = monthFirstStr(1);

    const res = await putWork(switchEmployee.id, {
      type: "FIXED_SCHEDULE",
      weeklyHours: 32,
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
      cancelOrphanShifts: true,
      validFrom: newValidFrom,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.usualWorkDays).toEqual([]);

    const deletedShift = await app.prisma.shift.findUnique({ where: { id: shift.id } });
    expect(deletedShift).toBeNull();
  });

  it("same switch with a non-empty usualWorkDays in the body -> 400, future shift NOT cancelled", async () => {
    // Re-seed: switchEmployee is now FIXED_SCHEDULE after the previous test, so set it back to
    // SHIFT_BASED at a fresh validFrom for this isolated case.
    const freshValidFrom = monthFirstStr(2);
    await app.prisma.workSchedule.create({
      data: {
        employeeId: switchEmployee.id,
        type: "SHIFT_BASED",
        weeklyHours: 32,
        workDays: [2, 3, 4, 5],
        contractWorkDaysPerWeek: 4,
        usualWorkDays: [],
        validFrom: new Date(freshValidFrom),
      },
    });
    const shift = await seedFutureShift(switchEmployee.id);

    const res = await putWork(switchEmployee.id, {
      type: "FIXED_SCHEDULE",
      weeklyHours: 32,
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
      usualWorkDays: [1, 2],
      cancelOrphanShifts: true,
      validFrom: monthFirstStr(3),
    });
    expect(res.statusCode).toBe(400);

    const survivingShift = await app.prisma.shift.findUnique({ where: { id: shift.id } });
    expect(survivingShift).not.toBeNull();
  });

  it("audit: PUT changing [] -> [2,3,4,5] writes a WorkSchedule AuditLog row with usualWorkDays in old and new value", async () => {
    // Issue #481 R5 (owner decision 04.10.2026): empty Angabe no longer valid for SHIFT_BASED — the
    // legacy empty state can no longer be produced through the route, so the fixture sets it directly.
    const zeroRow = await app.prisma.workSchedule.findFirstOrThrow({
      where: { employeeId: shiftEmployee.id, validFrom: new Date(seedValidFrom) },
    });
    await app.prisma.workSchedule.update({
      where: { id: zeroRow.id },
      data: { usualWorkDays: [] },
    });
    const scheduleId = zeroRow.id;

    const updateRes = await putWork(shiftEmployee.id, {
      type: "SHIFT_BASED",
      weeklyHours: 32,
      contractWorkDaysPerWeek: 4,
      usualWorkDays: [2, 3, 4, 5],
      validFrom: seedValidFrom,
    });
    expect(updateRes.statusCode).toBe(200);

    const audit = await app.prisma.auditLog.findFirst({
      where: { entity: "WorkSchedule", entityId: scheduleId, action: "UPDATE" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    const oldValue = audit!.oldValue as { usualWorkDays: number[] };
    const newValue = audit!.newValue as { usualWorkDays: number[] };
    expect(oldValue.usualWorkDays).toEqual([]);
    expect(newValue.usualWorkDays).toEqual([2, 3, 4, 5]);
  });

  async function postEmployee(payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/v1/employees",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        firstName: "Test",
        lastName: "W436",
        employeeNumber: `W436P-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        email: `w436p-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.de`,
        hireDate: new Date(monthFirstStr(0)).toISOString(),
        homeSalonId: salonId,
        ...payload,
      },
    });
  }

  it("POST /employees SHIFT_BASED, contractWorkDaysPerWeek 4, usualWorkDays [5,2,3,4] -> stores sorted [2,3,4,5]", async () => {
    const res = await postEmployee({
      scheduleType: "SHIFT_BASED",
      contractWorkDaysPerWeek: 4,
      usualWorkDays: [5, 2, 3, 4],
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    const schedule = await app.prisma.workSchedule.findFirstOrThrow({
      where: { employeeId: body.id },
    });
    expect(schedule.usualWorkDays).toEqual([2, 3, 4, 5]);
  });

  it("POST SHIFT_BASED, contract 4, usualWorkDays [2,3] -> 400 'mindestens 4', no Employee/User created", async () => {
    const email = `w436p-reject-${Date.now()}@test.de`;
    const res = await postEmployee({
      email,
      scheduleType: "SHIFT_BASED",
      contractWorkDaysPerWeek: 4,
      usualWorkDays: [2, 3],
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("mindestens 4");

    const user = await app.prisma.user.findUnique({ where: { email } });
    expect(user).toBeNull();
  });

  it("POST FIXED_SCHEDULE with usualWorkDays [1] -> 400 'nur bei Schichtbetrieb'", async () => {
    const res = await postEmployee({
      scheduleType: "FIXED_SCHEDULE",
      usualWorkDays: [1],
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("nur bei Schichtbetrieb");
  });

  // Issue #481 R5 (owner decision 04.10.2026): empty Angabe no longer valid for SHIFT_BASED — a
  // create without the field used to store [], it is now rejected and nothing is created.
  it("POST SHIFT_BASED without usualWorkDays field -> 400, no Employee/User created", async () => {
    const email = `w436p-noangabe-${Date.now()}@test.de`;
    const res = await postEmployee({
      email,
      scheduleType: "SHIFT_BASED",
      contractWorkDaysPerWeek: 4,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("Pflicht");
    const user = await app.prisma.user.findUnique({ where: { email } });
    expect(user).toBeNull();
  });

  it("POST audit: Employee CREATE newValue.workSchedule equals {type, contractWorkDaysPerWeek, usualWorkDays}", async () => {
    const res = await postEmployee({
      scheduleType: "SHIFT_BASED",
      contractWorkDaysPerWeek: 4,
      usualWorkDays: [2, 3, 4, 5],
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);

    const audit = await app.prisma.auditLog.findFirst({
      where: { entity: "Employee", entityId: body.id, action: "CREATE" },
    });
    expect(audit).not.toBeNull();
    const newValue = audit!.newValue as { workSchedule: Record<string, unknown> };
    expect(newValue.workSchedule).toEqual({
      type: "SHIFT_BASED",
      contractWorkDaysPerWeek: 4,
      usualWorkDays: [2, 3, 4, 5],
    });
  });
});
