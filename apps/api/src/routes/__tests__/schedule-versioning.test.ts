import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../__tests__/setup";
import { getEffectiveSchedule } from "../time-entries";
import type { FastifyInstance } from "fastify";

describe("Work Schedule Versioning", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "sv");
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
    await closeTestApp();
  });

  describe("Initial schedule on employee creation", () => {
    it("employee has an initial schedule with validFrom matching hireDate", async () => {
      const schedule = await app.prisma.workSchedule.findFirst({
        where: { employeeId: data.employee.id },
        orderBy: { validFrom: "asc" },
      });

      expect(schedule).toBeDefined();
      // The seed creates schedule with validFrom = 2024-01-01 (same as hireDate)
      expect(schedule!.validFrom.toISOString().split("T")[0]).toBe("2024-01-01");
    });
  });

  describe("PUT /settings/work/:id creates new version", () => {
    it("creates a new schedule version with different validFrom", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/settings/work/${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          type: "FIXED_WEEKLY",
          weeklyHours: 35,
          mondayHours: 7,
          tuesdayHours: 7,
          wednesdayHours: 7,
          thursdayHours: 7,
          fridayHours: 7,
          saturdayHours: 0,
          sundayHours: 0,
          overtimeThreshold: 60,
          allowOvertimePayout: false,
          validFrom: "2025-06-01",
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Number(body.weeklyHours)).toBe(35);

      // Verify two versions exist
      const allSchedules = await app.prisma.workSchedule.findMany({
        where: { employeeId: data.employee.id },
        orderBy: { validFrom: "asc" },
      });
      expect(allSchedules.length).toBeGreaterThanOrEqual(2);
    });

    it("updates existing version when validFrom matches", async () => {
      const beforeCount = await app.prisma.workSchedule.count({
        where: { employeeId: data.employee.id },
      });

      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/settings/work/${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          type: "FIXED_WEEKLY",
          weeklyHours: 36,
          mondayHours: 7.2,
          tuesdayHours: 7.2,
          wednesdayHours: 7.2,
          thursdayHours: 7.2,
          fridayHours: 7.2,
          saturdayHours: 0,
          sundayHours: 0,
          overtimeThreshold: 60,
          allowOvertimePayout: false,
          validFrom: "2025-06-01", // same validFrom as previous test
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Number(body.weeklyHours)).toBe(36);

      const afterCount = await app.prisma.workSchedule.count({
        where: { employeeId: data.employee.id },
      });
      // No new version created; count should remain the same
      expect(afterCount).toBe(beforeCount);
    });
  });

  describe("getEffectiveSchedule returns correct version by date", () => {
    it("returns old schedule for a date before the new validFrom", async () => {
      // Date before 2025-06-01 → should return original schedule (40h / 8h per day)
      const schedule = await getEffectiveSchedule(app, data.employee.id, new Date("2025-03-15"));
      expect(Number(schedule.weeklyHours)).toBe(40);
    });

    it("returns new schedule for a date after the new validFrom", async () => {
      // Date after 2025-06-01 → should return updated schedule (36h)
      const schedule = await getEffectiveSchedule(app, data.employee.id, new Date("2025-07-01"));
      expect(Number(schedule.weeklyHours)).toBe(36);
    });
  });

  describe("GET /settings/work/:id/history", () => {
    it("returns all schedule versions ordered by validFrom desc", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/settings/work/${data.employee.id}/history`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(2);

      // Should be ordered by validFrom desc (newest first)
      for (let i = 1; i < body.length; i++) {
        expect(new Date(body[i - 1].validFrom).getTime()).toBeGreaterThanOrEqual(
          new Date(body[i].validFrom).getTime(),
        );
      }
    });
  });
});
