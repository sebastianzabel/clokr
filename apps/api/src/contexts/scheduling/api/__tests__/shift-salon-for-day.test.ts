import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
} from "../../../../__tests__/setup";
import { holidayFreeMondayStr, addDaysStr } from "../../../../__tests__/test-dates";
import type { FastifyInstance } from "fastify";
import { DEFAULT_SALON_OPENING_HOURS } from "../../../platform/facade/salons";

/**
 * Phase 344 (issue #344) — a shift created WITHOUT an explicit salonId now resolves the employee's
 * salonForDay() assignment for that date (Einsatzsalon by weekday, else Stammsalon) instead of
 * always defaulting to the tenant's oldest active salon (#325's prior behavior).
 */
describe("POST /shifts — omitted salonId resolves via salonForDay() (Phase 344, issue #344)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  const MONDAY = holidayFreeMondayStr(2);
  const THURSDAY = addDaysStr(MONDAY, 3);

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "shifts-344");

    // seedTestData's default employee already carries a FIXED_SCHEDULE row with
    // validFrom = 2024-01-01 (setup.ts). assertEmployeeShiftEligible() picks the row with the
    // LATEST validFrom <= now — using a later validFrom here (2024-01-02) makes the SHIFT_BASED
    // row deterministically win, instead of tying on the same date and depending on undefined
    // row order.
    await app.prisma.workSchedule.create({
      data: {
        employeeId: data.employee.id,
        type: "SHIFT_BASED",
        weeklyHours: 40,
        validFrom: new Date("2024-01-02"),
      },
    });

    salonA = await app.prisma.salon.create({
      data: {
        tenantId: data.tenant.id,
        name: "Salon A",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
      },
    });
    salonB = await app.prisma.salon.create({
      data: {
        tenantId: data.tenant.id,
        name: "Salon B",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
      },
    });

    // Stammsalon (HOME): salon A, open-ended from hireDate (2024-01-01, per seedTestData).
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId: data.employee.id,
        salonId: salonA.id,
        kind: "HOME",
        validFrom: new Date("2024-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });
    // Einsatzsalon (DEPLOYMENT): salon B, Thursdays only (weekdays: Mo=0..So=6 → Thursday=3).
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId: data.employee.id,
        salonId: salonB.id,
        kind: "DEPLOYMENT",
        validFrom: new Date("2024-01-01"),
        validUntil: null,
        weekdays: [3],
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

  it("a shift on Thursday with no salonId lands on the Einsatzsalon (B), not the oldest active salon (A)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/shifts",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: data.employee.id,
        date: THURSDAY,
        startTime: "09:00",
        endTime: "17:00",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.salonId).toBe(salonB.id);
  });

  it("a shift on Monday with no salonId lands on the Stammsalon (A)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/shifts",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: data.employee.id,
        date: MONDAY,
        startTime: "09:00",
        endTime: "17:00",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.salonId).toBe(salonA.id);
  });

  it("an explicit salonId still always wins over salonForDay()", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/shifts",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: data.employee.id,
        date: THURSDAY,
        startTime: "09:00",
        endTime: "17:00",
        salonId: salonA.id, // explicit — must win even though salonForDay(Thursday) = B
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.salonId).toBe(salonA.id);
  });
});
