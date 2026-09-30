import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { contractWorkDaysPerWeekFrom } from "../leave-days";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { getShiftBasedLeaveDaysForWeek, resolveContractWorkDaysPerWeek } from "../index";
import type { FastifyInstance } from "fastify";

describe("contractWorkDaysPerWeekFrom (Issue #429, D-03)", () => {
  it("uses schedule.contractWorkDaysPerWeek when set, regardless of workDays or tenant default", () => {
    const schedule = { contractWorkDaysPerWeek: 4, workDays: [1, 2, 3, 4, 5, 6] };
    expect(contractWorkDaysPerWeekFrom(schedule, [1, 2, 3])).toBe(4);
  });

  it("falls back to workDays.length when contractWorkDaysPerWeek is null", () => {
    const schedule = { contractWorkDaysPerWeek: null, workDays: [1, 2, 3, 4, 5] };
    expect(contractWorkDaysPerWeekFrom(schedule, [1, 2, 3, 4])).toBe(5);
  });

  it("falls back to tenantDefaultWorkDays.length when contractWorkDaysPerWeek is null and workDays is empty", () => {
    const schedule = { contractWorkDaysPerWeek: null, workDays: [] };
    expect(contractWorkDaysPerWeekFrom(schedule, [1, 2, 3, 4])).toBe(4);
  });

  it("falls back to 5 when contractWorkDaysPerWeek, workDays and tenantDefaultWorkDays are all absent/empty", () => {
    const schedule = { contractWorkDaysPerWeek: null, workDays: [] };
    expect(contractWorkDaysPerWeekFrom(schedule, [])).toBe(5);
  });

  it("with schedule null, falls back to tenantDefaultWorkDays.length", () => {
    expect(contractWorkDaysPerWeekFrom(null, [1, 2, 3])).toBe(3);
  });

  it("with schedule null and no tenant default, falls back to 5", () => {
    expect(contractWorkDaysPerWeekFrom(null, null)).toBe(5);
    expect(contractWorkDaysPerWeekFrom(null, undefined)).toBe(5);
  });
});

/**
 * Phase 430 (D-08, revised 430-06) — focused integration test for `getShiftBasedLeaveDaysForWeek`
 * and the additive `resolveContractWorkDaysPerWeek` re-export from `contexts/absence/index.ts`.
 *
 * `getShiftBasedLeaveDaysForWeek` is now a thin DB-fetching wrapper that delegates to
 * `leaveDaysPerWeek()` (Issue #429, D-01/D-02 — the shared per-week kernel also used by the saldo
 * side) rather than re-implementing BUrlG day-counting — this file does not re-test the
 * day-counting rules themselves (see `vacation-calc.test.ts` for that); it only proves the
 * wrapper composes the existing pieces correctly (clipping, weekday derivation, holiday
 * exclusion, single-week extraction from `leaveDaysPerWeek`'s multi-week result).
 */
function utcDate(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

describe("getShiftBasedLeaveDaysForWeek (Phase 430, D-08)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  // Week: Mon 2028-03-06 .. Sun 2028-03-12. Far enough in the future to never collide with a
  // real fixture; deliberately not `new Date()`-relative so the fixture reads the same any day.
  const weekStart = utcDate(2028, 3, 6);
  const weekEnd = utcDate(2028, 3, 12);

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "shift-based-leave-days-week");
    await app.prisma.workSchedule.create({
      data: {
        employeeId: data.employee.id,
        type: "SHIFT_BASED",
        weeklyHours: 40,
        contractWorkDaysPerWeek: 5,
        validFrom: new Date("2024-01-01"),
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("resolveContractWorkDaysPerWeek is importable from the index barrel and resolves the seeded contract count", async () => {
    const n = await resolveContractWorkDaysPerWeek(app.prisma, data.employee.id, data.tenant.id);
    expect(n).toBe(5);
  });

  it("no approved leave that week -> { days: 0, weekdays: [] }", async () => {
    const result = await getShiftBasedLeaveDaysForWeek(
      app.prisma,
      data.employee.id,
      data.tenant.id,
      weekStart,
      weekEnd,
    );
    expect(result).toEqual({ days: 0, weekdays: [] });
  });

  it("an approved leave Thursday+Friday that week -> { days: 2, weekdays: ['Do', 'Fr'] }", async () => {
    const lr = await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        startDate: utcDate(2028, 3, 9), // Thursday
        endDate: utcDate(2028, 3, 10), // Friday
        days: 2,
        status: "APPROVED",
        halfDay: false,
      },
    });
    try {
      const result = await getShiftBasedLeaveDaysForWeek(
        app.prisma,
        data.employee.id,
        data.tenant.id,
        weekStart,
        weekEnd,
      );
      expect(result).toEqual({ days: 2, weekdays: ["Do", "Fr"] });
    } finally {
      await app.prisma.leaveRequest.delete({ where: { id: lr.id } });
    }
  });

  it("a PENDING (not APPROVED) leave that week does not count", async () => {
    const lr = await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        startDate: utcDate(2028, 3, 9),
        endDate: utcDate(2028, 3, 10),
        days: 2,
        status: "PENDING",
        halfDay: false,
      },
    });
    try {
      const result = await getShiftBasedLeaveDaysForWeek(
        app.prisma,
        data.employee.id,
        data.tenant.id,
        weekStart,
        weekEnd,
      );
      expect(result).toEqual({ days: 0, weekdays: [] });
    } finally {
      await app.prisma.leaveRequest.delete({ where: { id: lr.id } });
    }
  });

  it("a public holiday on one of the leave days excludes it from BOTH days and weekdays", async () => {
    if (!data.salonId) throw new Error("test setup: expected a default salon");
    const holiday = await app.prisma.publicHoliday.create({
      data: {
        tenantId: data.tenant.id,
        salonId: data.salonId,
        date: utcDate(2028, 3, 9), // Thursday — same day as the leave request below
        name: "Test-Feiertag (Phase 430)",
        federalState: "BERLIN",
        year: 2028,
      },
    });
    const lr = await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        startDate: utcDate(2028, 3, 9), // Thursday (holiday)
        endDate: utcDate(2028, 3, 10), // Friday
        days: 2,
        status: "APPROVED",
        halfDay: false,
      },
    });
    try {
      const result = await getShiftBasedLeaveDaysForWeek(
        app.prisma,
        data.employee.id,
        data.tenant.id,
        weekStart,
        weekEnd,
      );
      // Thursday is a holiday -> excluded from both days and weekdays; only Friday counts.
      expect(result).toEqual({ days: 1, weekdays: ["Fr"] });
    } finally {
      await app.prisma.leaveRequest.delete({ where: { id: lr.id } });
      await app.prisma.publicHoliday.delete({ where: { id: holiday.id } });
    }
  });

  it("a leave request spanning into the next week only counts days inside [weekStart, weekEnd]", async () => {
    const lr = await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        startDate: utcDate(2028, 3, 10), // Friday — this week
        endDate: utcDate(2028, 3, 14), // Tuesday — NEXT week
        days: 5,
        status: "APPROVED",
        halfDay: false,
      },
    });
    try {
      const result = await getShiftBasedLeaveDaysForWeek(
        app.prisma,
        data.employee.id,
        data.tenant.id,
        weekStart,
        weekEnd,
      );
      // Only Friday (03-10) falls inside [weekStart, weekEnd] — Saturday/Sunday/next-week days
      // are clipped away. Saturday (03-11) is inside the window too, but the leave request only
      // covers 03-10..03-14 so 03-11 IS covered (Sat is a Werktag under § 3 Abs. 2 BUrlG).
      expect(result).toEqual({ days: 2, weekdays: ["Fr", "Sa"] });
    } finally {
      await app.prisma.leaveRequest.delete({ where: { id: lr.id } });
    }
  });
});
