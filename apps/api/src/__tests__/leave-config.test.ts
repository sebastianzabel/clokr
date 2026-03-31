import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("Leave Config — Lead time, half-day, max advance, special leave", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "lcfg");

    // Configure leave rules: 7 days lead time, max 6 months advance, half-day disabled
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: {
        vacationLeadTimeDays: 7,
        vacationMaxAdvanceMonths: 6,
        halfDayAllowed: false,
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

  describe("Lead time validation", () => {
    it("rejects vacation request within lead time", async () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const dateStr = tomorrow.toISOString().split("T")[0];

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: { type: "VACATION", startDate: dateStr, endDate: dateStr },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain("Voraus");
    });

    it("allows sick leave without lead time", async () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const dateStr = tomorrow.toISOString().split("T")[0];

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: { type: "SICK", startDate: dateStr, endDate: dateStr },
      });

      // SICK is exempt from lead time
      expect(res.statusCode).toBe(201);
    });

    it("allows vacation request beyond lead time", async () => {
      const future = new Date();
      future.setDate(future.getDate() + 14);
      // Ensure it's a weekday
      while (future.getDay() === 0 || future.getDay() === 6) future.setDate(future.getDate() + 1);
      const dateStr = future.toISOString().split("T")[0];

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: { type: "VACATION", startDate: dateStr, endDate: dateStr },
      });

      expect(res.statusCode).toBe(201);
    });
  });

  describe("Max advance months", () => {
    it("rejects vacation too far in advance", async () => {
      const tooFar = new Date();
      tooFar.setMonth(tooFar.getMonth() + 8);
      while (tooFar.getDay() === 0 || tooFar.getDay() === 6) tooFar.setDate(tooFar.getDate() + 1);
      const dateStr = tooFar.toISOString().split("T")[0];

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: { type: "VACATION", startDate: dateStr, endDate: dateStr },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain("Monate");
    });
  });

  describe("Half-day toggle", () => {
    it("rejects half-day when globally disabled", async () => {
      const future = new Date();
      future.setDate(future.getDate() + 60); // far enough to avoid overlaps
      while (future.getDay() === 0 || future.getDay() === 6) future.setDate(future.getDate() + 1);
      const dateStr = future.toISOString().split("T")[0];

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: { type: "VACATION", startDate: dateStr, endDate: dateStr, halfDay: true },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain("Halbe Tage");
    });
  });

  describe("Special leave rules", () => {
    it("lists statutory default rules", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/special-leave/rules",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const rules = JSON.parse(res.body);
      expect(rules.length).toBeGreaterThanOrEqual(11);
      expect(rules.some((r: any) => r.name === "Eigene Hochzeit" && r.isStatutory)).toBe(true);
    });

    it("creates a custom rule", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/special-leave/rules",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { name: "Ehrenamt", defaultDays: 2, requiresProof: false },
      });

      expect(res.statusCode).toBe(200);
      const rule = JSON.parse(res.body);
      expect(rule.name).toBe("Ehrenamt");
      expect(rule.isStatutory).toBe(false);
    });

    it("prevents deletion of statutory rules", async () => {
      const listRes = await app.inject({
        method: "GET",
        url: "/api/v1/special-leave/rules",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      const statutory = JSON.parse(listRes.body).find((r: any) => r.isStatutory);

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/special-leave/rules/${statutory.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain("Gesetzliche");
    });

    it("requires specialLeaveRuleId for SPECIAL type", async () => {
      const future = new Date();
      future.setDate(future.getDate() + 90); // avoid overlaps
      while (future.getDay() === 0 || future.getDay() === 6) future.setDate(future.getDate() + 1);
      const dateStr = future.toISOString().split("T")[0];

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: { type: "SPECIAL", startDate: dateStr, endDate: dateStr },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain("specialLeaveRuleId");
    });
  });
});
