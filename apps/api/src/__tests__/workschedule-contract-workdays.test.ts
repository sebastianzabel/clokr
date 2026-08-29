/**
 * workschedule-contract-workdays.test.ts
 *
 * Phase 107 Plan 02 (issue #94) — locks the SHIFT_BASED write-path freeze built in
 * Task 1 and the count-persistence contract for `WorkSchedule.contractWorkDaysPerWeek`:
 *
 *   - D-02 freeze: PUT /api/v1/settings/work/:employeeId never derives (guesses)
 *     `workDays` for a SHIFT_BASED employee again — an update-in-place reuses the
 *     existing row's own `workDays` verbatim, and a brand-new `validFrom` row
 *     inherits the most recent PRIOR row's `workDays`. A caller-supplied `workDays`
 *     value is silently ignored on this branch, by construction.
 *   - D-01: `contractWorkDaysPerWeek` is written ONLY for SHIFT_BASED, bounded 1-7,
 *     and explicit `null` for every other type.
 *   - The bulk `PUT /api/v1/settings/work` (`applyToExisting`) path structurally
 *     cannot touch a SHIFT_BASED row (settings.ts only ever updates employees whose
 *     CURRENT row is FIXED_SCHEDULE) — pinned here as a regression guard.
 *   - Cross-tenant isolation (settings-work-tenant-isolation.test.ts's existing
 *     guard) still holds with the new field present in the payload.
 *
 * Every date in this file is built from `monthFirstStr()`, which composes
 * `monthsAheadStr()` from `./test-dates` (this repo's single shared tenant-TZ date
 * helper, issue #34) with a day-component override to "01" — `WorkSchedule.validFrom`
 * must be the 1st of a calendar month for every contract CHANGE (CLAUDE.md, "Schedule
 * Types"). No hardcoded calendar literal appears anywhere in this file.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import { monthsAheadStr } from "./test-dates";
import type { FastifyInstance } from "fastify";

/** First of the month N months from now (tenant TZ), built on the shared
 *  test-dates helper — WorkSchedule.validFrom must be month-1st. */
function monthFirstStr(monthsFromNow: number): string {
  return monthsAheadStr(monthsFromNow).slice(0, 8) + "01";
}

describe("PUT /api/v1/settings/work/:employeeId — WorkSchedule.contractWorkDaysPerWeek (Phase 107 D-01/D-02, issue #94)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let shiftEmployee: { id: string };
  let shiftEmployee2: { id: string };

  const SEED_WORK_DAYS = [2, 3, 4, 5];
  const SEED_CONTRACT_DAYS = 4;
  const seedValidFrom = monthFirstStr(-12);

  // Second employee — seeded with a non-Mo–Fr-prefix cardinality ([0,3,6]), the
  // exact shape normalizeWorkDays()'s isLiteralMoFr rule used to wave through as
  // an "admin override" even when it was really a guess.
  const SEED2_WORK_DAYS = [0, 3, 6];
  const SEED2_CONTRACT_DAYS = 3;
  const seed2ValidFrom = monthFirstStr(-12);

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "wcwd");

    const bcryptMod = await import("bcryptjs");
    const passwordHash = await bcryptMod.default.hash("test1234", 10);

    const user1 = await app.prisma.user.create({
      data: {
        email: `wcwd-shift1-${Date.now()}@test.de`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    shiftEmployee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user1.id,
        employeeNumber: `WCWD1-${Date.now()}`,
        firstName: "Shift",
        lastName: "ContractDaysA",
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
        workDays: SEED_WORK_DAYS,
        contractWorkDaysPerWeek: SEED_CONTRACT_DAYS,
        validFrom: new Date(seedValidFrom),
      },
    });

    const user2 = await app.prisma.user.create({
      data: {
        email: `wcwd-shift2-${Date.now()}@test.de`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    shiftEmployee2 = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user2.id,
        employeeNumber: `WCWD2-${Date.now()}`,
        firstName: "Shift",
        lastName: "ContractDaysB",
        hireDate: new Date(seed2ValidFrom),
      },
    });
    await app.prisma.overtimeAccount.create({
      data: { employeeId: shiftEmployee2.id, balanceHours: 0 },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: shiftEmployee2.id,
        type: "SHIFT_BASED",
        weeklyHours: 24,
        workDays: SEED2_WORK_DAYS,
        contractWorkDaysPerWeek: SEED2_CONTRACT_DAYS,
        validFrom: new Date(seed2ValidFrom),
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

  it("update-in-place at the SAME validFrom: a differing body.workDays is ignored, workDays stays [2,3,4,5], contractWorkDaysPerWeek updates to the submitted number (AC-FE-02)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${shiftEmployee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        type: "SHIFT_BASED",
        weeklyHours: 32,
        workDays: [0, 1, 2, 3, 4, 5, 6], // attempted overwrite — must be ignored
        contractWorkDaysPerWeek: 6,
        validFrom: seedValidFrom,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.workDays).toEqual(SEED_WORK_DAYS);
    expect(body.contractWorkDaysPerWeek).toBe(6);

    const stored = await app.prisma.workSchedule.findUniqueOrThrow({ where: { id: body.id } });
    expect(stored.workDays).toEqual(SEED_WORK_DAYS);
    expect(stored.contractWorkDaysPerWeek).toBe(6);
  });

  it("a PUT with a NEW validFrom creates a new row whose workDays equals the most recent prior row's workDays, not a derived value", async () => {
    const newValidFrom = monthFirstStr(-6); // between seed (-12) and now — no row exists here yet

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${shiftEmployee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        type: "SHIFT_BASED",
        weeklyHours: 32,
        workDays: [1, 2, 3, 4, 5, 6, 0], // attempted overwrite — must be ignored
        contractWorkDaysPerWeek: 5,
        validFrom: newValidFrom,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.workDays).toEqual(SEED_WORK_DAYS);
    expect(body.contractWorkDaysPerWeek).toBe(5);
    expect(String(body.validFrom).slice(0, 10)).toBe(newValidFrom);

    const stored = await app.prisma.workSchedule.findUniqueOrThrow({ where: { id: body.id } });
    expect(stored.workDays).toEqual(SEED_WORK_DAYS);
  });

  it("SHIFT_BASED save freezes a non-Mo–Fr-prefix cardinality workDays=[0,3,6] — the exact shape normalizeWorkDays()'s isLiteralMoFr rule used to wave through", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${shiftEmployee2.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        type: "SHIFT_BASED",
        weeklyHours: 24,
        workDays: [1, 2, 3, 4, 5], // attempted overwrite — must be ignored
        contractWorkDaysPerWeek: 3,
        validFrom: seed2ValidFrom, // update-in-place
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.workDays).toEqual(SEED2_WORK_DAYS);
  });

  it.each([0, 8, -1, 3.5])(
    "contractWorkDaysPerWeek=%s is rejected with 400 and persists nothing",
    async (invalid) => {
      const beforeCount = await app.prisma.workSchedule.count({
        where: { employeeId: shiftEmployee.id },
      });

      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/settings/work/${shiftEmployee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          type: "SHIFT_BASED",
          weeklyHours: 32,
          contractWorkDaysPerWeek: invalid,
        },
      });
      expect(res.statusCode).toBe(400);

      const afterCount = await app.prisma.workSchedule.count({
        where: { employeeId: shiftEmployee.id },
      });
      expect(afterCount).toBe(beforeCount);
    },
  );

  it("FIXED_SCHEDULE PUT still derives workDays from per-day hours unchanged (AC-FE-03/AC-DM-02 regression guard)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        type: "FIXED_SCHEDULE",
        weeklyHours: 32,
        mondayHours: 0,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: monthFirstStr(1),
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Anna-bug fix (Phase 61): mondayHours=0 → Monday drops out of the derived set.
    expect(body.workDays).toEqual([2, 3, 4, 5]);
    // D-01: contractWorkDaysPerWeek is explicitly null for non-SHIFT_BASED types.
    expect(body.contractWorkDaysPerWeek).toBeNull();
  });

  it("PUT /api/v1/settings/work (applyToExisting bulk) leaves a SHIFT_BASED employee's WorkSchedule row completely untouched (id, workDays, contractWorkDaysPerWeek, validFrom)", async () => {
    const before = await app.prisma.workSchedule.findFirstOrThrow({
      where: { employeeId: shiftEmployee2.id },
      orderBy: { validFrom: "desc" },
    });

    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { applyToExisting: true, defaultWeeklyHours: 41 },
    });
    expect(res.statusCode).toBe(200);

    const after = await app.prisma.workSchedule.findFirstOrThrow({
      where: { employeeId: shiftEmployee2.id },
      orderBy: { validFrom: "desc" },
    });
    expect(after).toEqual(before);
  });
});

describe("PUT /api/v1/settings/work/:employeeId — cross-tenant guard with contractWorkDaysPerWeek present (Phase 107)", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;
  let victimShiftEmployee: { id: string };
  const KNOWN_VICTIM_WORK_DAYS = [1, 3, 5];
  const KNOWN_VICTIM_CONTRACT_DAYS = 3;
  const victimValidFrom = monthFirstStr(-12);

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "wcwd-tenant-a");
    tenantB = await seedTestData(app, "wcwd-tenant-b");

    const bcryptMod = await import("bcryptjs");
    const passwordHash = await bcryptMod.default.hash("test1234", 10);
    const user = await app.prisma.user.create({
      data: {
        email: `wcwd-victim-${Date.now()}@test.de`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    victimShiftEmployee = await app.prisma.employee.create({
      data: {
        tenantId: tenantB.tenant.id,
        userId: user.id,
        employeeNumber: `WCWD-V-${Date.now()}`,
        firstName: "Victim",
        lastName: "CrossTenant",
        hireDate: new Date(victimValidFrom),
      },
    });
    await app.prisma.overtimeAccount.create({
      data: { employeeId: victimShiftEmployee.id, balanceHours: 0 },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: victimShiftEmployee.id,
        type: "SHIFT_BASED",
        weeklyHours: 24,
        workDays: KNOWN_VICTIM_WORK_DAYS,
        contractWorkDaysPerWeek: KNOWN_VICTIM_CONTRACT_DAYS,
        validFrom: new Date(victimValidFrom),
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantA.tenant.id);
    } catch (err) {
      console.error("Cleanup tenantA failed:", err);
    }
    try {
      await cleanupTestData(app, tenantB.tenant.id);
    } catch (err) {
      console.error("Cleanup tenantB failed:", err);
    }
  });

  it("tenantA ADMIN writing contractWorkDaysPerWeek to tenantB's SHIFT_BASED employee → 404, no row written, victim row unchanged", async () => {
    const beforeCount = await app.prisma.workSchedule.count({
      where: { employeeId: victimShiftEmployee.id },
    });

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${victimShiftEmployee.id}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
      payload: {
        type: "SHIFT_BASED",
        weeklyHours: 24,
        contractWorkDaysPerWeek: 7,
        validFrom: monthFirstStr(3),
      },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Mitarbeiter nicht gefunden" });

    const afterCount = await app.prisma.workSchedule.count({
      where: { employeeId: victimShiftEmployee.id },
    });
    expect(afterCount).toBe(beforeCount);

    const victim = await app.prisma.workSchedule.findFirstOrThrow({
      where: { employeeId: victimShiftEmployee.id },
    });
    expect(victim.workDays).toEqual(KNOWN_VICTIM_WORK_DAYS);
    expect(victim.contractWorkDaysPerWeek).toBe(KNOWN_VICTIM_CONTRACT_DAYS);
  });
});
