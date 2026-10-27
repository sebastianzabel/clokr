/**
 * Issue #389: GET /shifts/week and GET /shifts/my-week pick the working-time model by the
 * DISPLAYED week (the contract valid on each day), never by today. Contract changes are
 * month-first only, so a week holds at most one change. A person belongs to the SHIFT_BASED grid
 * when the contract is SHIFT_BASED on at least one day of the week.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import { addDaysStr, monthFirstAheadStr, mondayOfWeekStr } from "./test-dates";

type WeekBody = {
  employees: Array<{ id: string; workSchedules: Array<{ type: string }> }>;
  contractSollMinutesByEmp: Record<string, number>;
};

describe("shift plan contract by displayed week (#389)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let toShiftId: string; // FIXED_SCHEDULE -> SHIFT_BASED on the 1st of next month
  let fromShiftId: string; // SHIFT_BASED -> FIXED_SCHEDULE on the 1st of next month
  const change = monthFirstAheadStr(1);

  async function makePerson(label: string, before: string, after: string) {
    const user = await app.prisma.user.create({
      data: {
        email: `${label}-389-${Date.now()}@test.de`,
        passwordHash: "UNUSED",
        role: "EMPLOYEE",
        isActive: false,
      },
    });
    const emp = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `${label}-${Date.now()}`,
        firstName: label,
        lastName: "Vertrag389",
        hireDate: new Date("2024-01-01"),
      },
    });
    const base = {
      employeeId: emp.id,
      weeklyHours: 40,
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
      workDays: [1, 2, 3, 4, 5],
    };
    await app.prisma.workSchedule.create({
      data: { ...base, type: before as never, validFrom: new Date("2024-01-01") },
    });
    await app.prisma.workSchedule.create({
      data: { ...base, type: after as never, validFrom: new Date(`${change}T00:00:00Z`) },
    });
    return emp.id;
  }

  async function week(date: string) {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/week?date=${date}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as WeekBody;
  }
  const typeOf = (b: WeekBody, id: string) =>
    b.employees.find((e) => e.id === id)?.workSchedules[0]?.type;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "wk389");
    toShiftId = await makePerson("ZuSchicht", "FIXED_SCHEDULE", "SHIFT_BASED");
    fromShiftId = await makePerson("AusSchicht", "SHIFT_BASED", "FIXED_SCHEDULE");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Cleanup failed:", err);
    }
  });

  it("a week fully before the change shows the old contracts", async () => {
    const b = await week(addDaysStr(change, -14));
    expect(typeOf(b, toShiftId)).toBe("FIXED_SCHEDULE");
    expect(typeOf(b, fromShiftId)).toBe("SHIFT_BASED");
    expect(b.contractSollMinutesByEmp[toShiftId]).toBeUndefined();
    expect(b.contractSollMinutesByEmp[fromShiftId]).toBeGreaterThan(0);
  });

  it("a week fully after the change shows the new contracts (both directions)", async () => {
    const b = await week(addDaysStr(change, 14));
    expect(typeOf(b, toShiftId)).toBe("SHIFT_BASED");
    expect(typeOf(b, fromShiftId)).toBe("FIXED_SCHEDULE");
    expect(b.contractSollMinutesByEmp[toShiftId]).toBeGreaterThan(0);
    expect(b.contractSollMinutesByEmp[fromShiftId]).toBeUndefined();
  });

  it("the week containing the change keeps both persons in the SHIFT_BASED grid", async () => {
    const b = await week(change);
    expect(typeOf(b, toShiftId)).toBe("SHIFT_BASED");
    expect(typeOf(b, fromShiftId)).toBe("SHIFT_BASED");
    expect(b.contractSollMinutesByEmp[toShiftId]).toBeGreaterThan(0);
    expect(b.contractSollMinutesByEmp[fromShiftId]).toBeGreaterThan(0);
  });

  it("the current week is unaffected by a future change (control)", async () => {
    const monday = mondayOfWeekStr();
    if (addDaysStr(monday, 6) >= change) return; // the change falls into this week: mixed case, covered above
    const b = await week(monday);
    expect(typeOf(b, toShiftId)).toBe("FIXED_SCHEDULE");
    expect(typeOf(b, fromShiftId)).toBe("SHIFT_BASED");
  });

  it("GET /my-week judges the displayed week, not today", async () => {
    // Re-point the seeded employee at the same pattern: FIXED now, SHIFT_BASED from `change`.
    await app.prisma.workSchedule.updateMany({
      where: { employeeId: data.employee.id },
      data: { type: "FIXED_SCHEDULE" as never },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: data.employee.id,
        type: "SHIFT_BASED" as never,
        weeklyHours: 20,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4, 5],
        validFrom: new Date(`${change}T00:00:00Z`),
      },
    });
    const get = (date: string) =>
      app.inject({
        method: "GET",
        url: `/api/v1/shifts/my-week?date=${date}`,
        headers: { authorization: `Bearer ${data.empToken}` },
      });
    expect((await get(addDaysStr(change, 14))).statusCode).toBe(200);
    expect((await get(addDaysStr(change, -14))).statusCode).toBe(410);
  });
});
