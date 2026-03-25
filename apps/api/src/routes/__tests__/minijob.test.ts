import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../__tests__/setup";
import { calcExpectedMinutesTz } from "../../utils/timezone";
import type { FastifyInstance } from "fastify";

describe("Minijob / MONTHLY_HOURS Schedule", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "mj");
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
    await closeTestApp();
  });

  describe("Employee with MONTHLY_HOURS schedule", () => {
    it("can create employee with scheduleType=MONTHLY_HOURS via API", async () => {
      // Update the employee's schedule to MONTHLY_HOURS
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/settings/work/${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          type: "MONTHLY_HOURS",
          weeklyHours: 10,
          monthlyHours: 15,
          mondayHours: 0,
          tuesdayHours: 0,
          wednesdayHours: 0,
          thursdayHours: 0,
          fridayHours: 0,
          saturdayHours: 0,
          sundayHours: 0,
          overtimeThreshold: 60,
          allowOvertimePayout: false,
          validFrom: "2025-09-01",
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.type).toBe("MONTHLY_HOURS");
      expect(Number(body.monthlyHours)).toBe(15);
    });
  });

  describe("calcExpectedMinutesTz", () => {
    it("MONTHLY_HOURS with monthlyHours=15 returns 15*60=900 minutes", () => {
      const schedule = {
        type: "MONTHLY_HOURS",
        monthlyHours: 15,
        mondayHours: 0,
        tuesdayHours: 0,
        wednesdayHours: 0,
        thursdayHours: 0,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
      };

      const result = calcExpectedMinutesTz(
        schedule,
        new Date("2025-09-01"),
        new Date("2025-09-30"),
        "Europe/Berlin",
      );
      expect(result).toBe(900);
    });

    it("MONTHLY_HOURS with no monthlyHours returns 0 (pure tracking)", () => {
      const schedule = {
        type: "MONTHLY_HOURS",
        monthlyHours: 0,
        mondayHours: 0,
        tuesdayHours: 0,
        wednesdayHours: 0,
        thursdayHours: 0,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
      };

      const result = calcExpectedMinutesTz(
        schedule,
        new Date("2025-09-01"),
        new Date("2025-09-30"),
        "Europe/Berlin",
      );
      expect(result).toBe(0);
    });

    it("MONTHLY_HOURS with null monthlyHours returns 0", () => {
      const schedule = {
        type: "MONTHLY_HOURS",
        monthlyHours: null,
        mondayHours: 0,
        tuesdayHours: 0,
        wednesdayHours: 0,
        thursdayHours: 0,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
      };

      const result = calcExpectedMinutesTz(
        schedule,
        new Date("2025-09-01"),
        new Date("2025-09-30"),
        "Europe/Berlin",
      );
      expect(result).toBe(0);
    });

    it("FIXED_WEEKLY uses day-of-week logic", () => {
      const schedule = {
        type: "FIXED_WEEKLY",
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
      };

      // 2025-01-06 (Mon) to 2025-01-10 (Fri) = 5 weekdays * 8h = 2400min
      const result = calcExpectedMinutesTz(
        schedule,
        new Date("2025-01-06"),
        new Date("2025-01-10"),
        "Europe/Berlin",
      );
      expect(result).toBe(2400);
    });

    it("FIXED_WEEKLY excludes weekends", () => {
      const schedule = {
        type: "FIXED_WEEKLY",
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
      };

      // 2025-01-06 (Mon) to 2025-01-12 (Sun) = full week but only 5 workdays
      const result = calcExpectedMinutesTz(
        schedule,
        new Date("2025-01-06"),
        new Date("2025-01-12"),
        "Europe/Berlin",
      );
      expect(result).toBe(2400); // 5 * 8h * 60
    });
  });
});
