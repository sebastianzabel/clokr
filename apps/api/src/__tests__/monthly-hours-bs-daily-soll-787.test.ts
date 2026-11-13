// Issue #787 — Berufsschule readers of the individual daily Soll must use the Ø-day of
// calcMonthlyHoursDayMinutesTz() (#473) for a MONTHLY_HOURS contract. computeDailySollMinutes()
// is weeklyHours-based and returns 0 there. Readers covered:
//   1. checkJArbSchG (§ 9 JArbSchG Langtag classification, absence context)
//   2. GET /shifts/week vocationalSchoolMinutesByEmp (Schichtplanung BS amount)
// Dates are derived from the current clock so the file never expires.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { checkJArbSchG } from "../contexts/absence/jarbschg";
import { calcMonthlyHoursDayMinutesTz, getTenantTimezone } from "../contexts/working-time-account";

/** Next Monday strictly in the future (UTC midnight). */
function nextMonday(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + ((1 - d.getUTCDay() + 7) % 7 || 7));
  return d;
}
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

describe("MONTHLY_HOURS Berufsschule daily Soll (Issue #787)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "bs787");
    await app.prisma.workSchedule.deleteMany({ where: { employeeId: data.employee.id } });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: data.employee.id,
        type: "MONTHLY_HOURS",
        weeklyHours: 0,
        monthlyHours: 160,
        mondayHours: 0,
        tuesdayHours: 0,
        wednesdayHours: 0,
        thursdayHours: 0,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4, 5],
        validFrom: new Date("2020-01-01"),
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

  beforeEach(async () => {
    await app.prisma.absence.deleteMany({ where: { employeeId: data.employee.id } });
    await app.prisma.employeeVocationalSchoolPattern.deleteMany({
      where: { employeeId: data.employee.id },
    });
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: {
        classification: "AZUBI",
        birthDate: null,
        bsSlotFirstLongDayMinutes: null,
        bsSlotSecondLongDayMinutes: null,
        bsSlotShortDayMinutes: null,
        bsSlotBlockWeekMinutes: null,
      },
    });
  });

  async function seedBs(date: Date) {
    await app.prisma.absence.create({
      data: {
        employeeId: data.employee.id,
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        startDate: date,
        endDate: date,
        days: 1.0,
        createdBy: "bs-787-test",
      },
    });
  }

  it("§ 9 JArbSchG: the second school day of a minor MONTHLY_HOURS apprentice is a Langtag (Ø-day > 225 min)", async () => {
    const mon = nextMonday();
    const tue = addDays(mon, 1);
    // Under 18 on the work date: born 17 years and 6 months before `tue`.
    const birth = new Date(tue);
    birth.setUTCFullYear(birth.getUTCFullYear() - 17);
    birth.setUTCMonth(birth.getUTCMonth() - 6);
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { birthDate: birth },
    });
    // Two BS days in the ISO week -> slot resolver; target = Tuesday (ordinal 2, SECOND_LONG_DAY,
    // no config -> credited the individual daily Soll).
    await seedBs(mon);
    await seedBs(tue);

    const res = await checkJArbSchG(app.prisma, {
      employeeId: data.employee.id,
      date: tue,
      plannedNetWorkMin: 300,
    });

    expect(res.blocked).toBe(true);
  });

  it("Schichtplan: /shifts/week BS amount of a MONTHLY_HOURS apprentice is the Ø-day", async () => {
    const mon = nextMonday();
    await seedBs(mon);
    const tz = await getTenantTimezone(app.prisma, data.tenant.id);
    const oDay = calcMonthlyHoursDayMinutesTz(
      { monthlyHours: 160, workDays: [1, 2, 3, 4, 5] },
      iso(mon),
      tz,
    );
    expect(oDay).toBeGreaterThan(0);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/week?date=${iso(mon)}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.vocationalSchoolMinutesByEmp[data.employee.id]).toBe(oDay);
  });
});
