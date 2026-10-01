/**
 * Issue #445 findings 3 — chronological cross-year attribution (D-08/D-09).
 *
 * Fixed dates only (2026/2027) — no assertion depends on `new Date()`. Every scenario uses its
 * own fresh employee (hireDate 2024-01-01, initials-only).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import {
  splitLeaveDaysByYear,
  leaveDaysWithin,
  deductVacationDays,
  reverseVacationDays,
} from "../contexts/absence/leave-days";
import type { FastifyInstance } from "fastify";

describe("Issue #445 findings 3 — chronological cross-year attribution (D-08/D-09)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  const NJ = new Set(["2027-01-01"]);

  async function mkEmployee(
    label: string,
    type: "SHIFT_BASED" | "FIXED_SCHEDULE",
  ): Promise<string> {
    const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `cylb-${label}-${uid}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `CYLB-${label}-${uid}`,
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
    return employee.id;
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "cylb");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("splitLeaveDaysByYear: SHIFT_BASED over New Year with a holiday → 4 / 3", async () => {
    const sb = await mkEmployee("s1", "SHIFT_BASED");
    const result = await splitLeaveDaysByYear(
      app.prisma,
      sb,
      data.tenant.id,
      new Date(Date.UTC(2026, 11, 28)),
      new Date(Date.UTC(2027, 0, 9)),
      7,
      NJ,
    );
    expect(result).toEqual({ year1: 2026, year2: 2027, year1Days: 4, year2Days: 3 });
  });

  it("splitLeaveDaysByYear: SHIFT_BASED over New Year without a holiday → 4 / 4", async () => {
    const sb = await mkEmployee("s2", "SHIFT_BASED");
    const result = await splitLeaveDaysByYear(
      app.prisma,
      sb,
      data.tenant.id,
      new Date(Date.UTC(2026, 11, 28)),
      new Date(Date.UTC(2027, 0, 9)),
      8,
      new Set<string>(),
    );
    expect(result.year1Days).toBe(4);
    expect(result.year2Days).toBe(4);
  });

  it("splitLeaveDaysByYear: FIXED_SCHEDULE over New Year, parity with the old Mo-Fr split → 2 / 2", async () => {
    const fx = await mkEmployee("f1", "FIXED_SCHEDULE");
    const result = await splitLeaveDaysByYear(
      app.prisma,
      fx,
      data.tenant.id,
      new Date(Date.UTC(2026, 11, 30)),
      new Date(Date.UTC(2027, 0, 5)),
      4,
      NJ,
    );
    expect(result.year1Days).toBe(2);
    expect(result.year2Days).toBe(2);
  });

  it("splitLeaveDaysByYear: same-year request never splits → year1Days = totalDays, year2Days = 0", async () => {
    const fx = await mkEmployee("f2", "FIXED_SCHEDULE");
    const result = await splitLeaveDaysByYear(
      app.prisma,
      fx,
      data.tenant.id,
      new Date(Date.UTC(2026, 2, 2)),
      new Date(Date.UTC(2026, 2, 6)),
      5,
      NJ,
    );
    expect(result).toEqual({ year1: 2026, year2: 2026, year1Days: 5, year2Days: 0 });
  });

  it("leaveDaysWithin: windows over a cross-year SHIFT_BASED request sum to its total", async () => {
    const sb = await mkEmployee("s3", "SHIFT_BASED");
    const request = {
      startDate: new Date(Date.UTC(2026, 11, 28)),
      endDate: new Date(Date.UTC(2027, 0, 9)),
      days: 7,
    };
    const year2026 = await leaveDaysWithin(
      app.prisma,
      sb,
      data.tenant.id,
      request,
      new Date(Date.UTC(2026, 0, 1)),
      new Date(Date.UTC(2026, 11, 31)),
      NJ,
    );
    const year2027 = await leaveDaysWithin(
      app.prisma,
      sb,
      data.tenant.id,
      request,
      new Date(Date.UTC(2027, 0, 1)),
      new Date(Date.UTC(2027, 11, 31)),
      NJ,
    );
    const tail = await leaveDaysWithin(
      app.prisma,
      sb,
      data.tenant.id,
      request,
      new Date(Date.UTC(2027, 0, 4)),
      new Date(Date.UTC(2027, 0, 9)),
      NJ,
    );
    expect(year2026).toBe(4);
    expect(year2027).toBe(3);
    expect(tail).toBe(4);
  });

  it("deductVacationDays / reverseVacationDays: cross-year SHIFT_BASED books 4 / 3, reverses to 0 / 0", async () => {
    const sb = await mkEmployee("s4", "SHIFT_BASED");
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: sb,
        leaveTypeId: data.vacationType.id,
        year: 2026,
        totalDays: 30,
        usedDays: 0,
        isAutoCalculated: true,
      },
    });
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: sb,
        leaveTypeId: data.vacationType.id,
        year: 2027,
        totalDays: 30,
        usedDays: 0,
        isAutoCalculated: true,
      },
    });

    await deductVacationDays(
      app.prisma,
      sb,
      data.vacationType.id,
      new Date(Date.UTC(2026, 11, 28)),
      new Date(Date.UTC(2027, 0, 9)),
      7,
      NJ,
      data.tenant.id,
    );
    const row2026after = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: sb,
          leaveTypeId: data.vacationType.id,
          year: 2026,
        },
      },
    });
    const row2027after = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: sb,
          leaveTypeId: data.vacationType.id,
          year: 2027,
        },
      },
    });
    expect(Number(row2026after!.usedDays)).toBe(4); // unfixed: 4
    expect(Number(row2027after!.usedDays)).toBe(3); // unfixed: 7

    await reverseVacationDays(
      app.prisma,
      sb,
      data.vacationType.id,
      new Date(Date.UTC(2026, 11, 28)),
      new Date(Date.UTC(2027, 0, 9)),
      7,
      NJ,
      data.tenant.id,
    );
    const row2026reversed = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: sb,
          leaveTypeId: data.vacationType.id,
          year: 2026,
        },
      },
    });
    const row2027reversed = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: sb,
          leaveTypeId: data.vacationType.id,
          year: 2027,
        },
      },
    });
    expect(Number(row2026reversed!.usedDays)).toBe(0);
    expect(Number(row2027reversed!.usedDays)).toBe(0); // unfixed: -4
  });

  it("POST /leave/requests: cross-year SHIFT_BASED over New Year is accepted with the chronological day count", async () => {
    const sb = await mkEmployee("s5", "SHIFT_BASED");
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: sb,
        leaveTypeId: data.vacationType.id,
        year: 2026,
        totalDays: 4,
        usedDays: 0,
        isAutoCalculated: false,
      },
    });
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: sb,
        leaveTypeId: data.vacationType.id,
        year: 2027,
        totalDays: 2,
        usedDays: 0,
        isAutoCalculated: false,
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: sb,
        type: "VACATION",
        startDate: "2026-12-28",
        endDate: "2027-01-09",
        halfDay: false,
      },
    });
    expect(res.statusCode, `request must succeed: ${res.body}`).toBe(201);
    const body = JSON.parse(res.body) as { days: string | number };
    expect(Number(body.days)).toBe(7);
  });
});
