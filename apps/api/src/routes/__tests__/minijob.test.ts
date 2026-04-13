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

    it("can save MONTHLY_HOURS schedule with monthlyHours = null", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/settings/work/${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          type: "MONTHLY_HOURS",
          weeklyHours: 10,
          monthlyHours: null,
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
      expect(body.monthlyHours).toBeNull();
    });

    it("pure tracking employee accumulates worked hours in overtime balance", async () => {
      // Set schedule to pure tracking (monthlyHours = null)
      const schedRes = await app.inject({
        method: "PUT",
        url: `/api/v1/settings/work/${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          type: "MONTHLY_HOURS",
          weeklyHours: 10,
          monthlyHours: null,
          mondayHours: 0,
          tuesdayHours: 0,
          wednesdayHours: 0,
          thursdayHours: 0,
          fridayHours: 0,
          saturdayHours: 0,
          sundayHours: 0,
          overtimeThreshold: 60,
          allowOvertimePayout: false,
          validFrom: "2024-01-01",
        },
      });
      expect(schedRes.statusCode).toBe(200);

      // Create a time entry 2 days ago (4h of work)
      const now = new Date();
      const twoDaysAgo = new Date(now);
      twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
      const dateStr = twoDaysAgo.toISOString().slice(0, 10);

      const startTime = `${dateStr}T08:00:00.000Z`;
      const endTime = `${dateStr}T12:00:00.000Z`;

      // Create entry directly via prisma to bypass business logic for test isolation
      const entry = await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date(dateStr),
          startTime: new Date(startTime),
          endTime: new Date(endTime),
          breakMinutes: 0,
          source: "MANUAL",
        },
      });

      // Trigger overtime recalculation via POST time entry or direct call
      // Use the API to GET overtime which triggers update via updateOvertimeAccount
      // Actually we need to call updateOvertimeAccount — do it via the API endpoint
      const { updateOvertimeAccount } = await import("../time-entries");
      await updateOvertimeAccount(app, data.employee.id);

      const overtimeRes = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(overtimeRes.statusCode).toBe(200);
      const overtimeBody = JSON.parse(overtimeRes.body);
      // Pure tracking: balanceHours should reflect worked hours (4h), not 0
      // Note: Prisma Decimal is serialized as string in JSON, so we cast to Number
      expect(Number(overtimeBody.balanceHours)).toBeGreaterThan(0);

      // Cleanup: soft-delete test entry (hard deletes violate audit-proof convention)
      await app.prisma.timeEntry.update({
        where: { id: entry.id },
        data: { deletedAt: new Date() },
      });
      await app.inject({
        method: "PUT",
        url: `/api/v1/settings/work/${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          type: "FIXED_WEEKLY",
          weeklyHours: 40,
          monthlyHours: null,
          mondayHours: 8,
          tuesdayHours: 8,
          wednesdayHours: 8,
          thursdayHours: 8,
          fridayHours: 8,
          saturdayHours: 0,
          sundayHours: 0,
          overtimeThreshold: 60,
          allowOvertimePayout: false,
          validFrom: "2024-01-01",
        },
      });
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
