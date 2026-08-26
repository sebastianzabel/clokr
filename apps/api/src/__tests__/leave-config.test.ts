import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { futureDateStr, nextWeekdayStr, monthsAheadStr } from "./test-dates";
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
      const dateStr = futureDateStr(1);

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
      const dateStr = futureDateStr(1);

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
      // Ensure it's a weekday — weekday read off the tenant-TZ date string (dowOf), not local getDay().
      const dateStr = nextWeekdayStr(futureDateStr(14));

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
      const dateStr = nextWeekdayStr(monthsAheadStr(8));

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
      // 60 days ahead — far enough to avoid overlaps
      const dateStr = nextWeekdayStr(futureDateStr(60));

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
      expect(
        rules.some(
          (r: { name: string; isStatutory: boolean }) =>
            r.name === "Eigene Hochzeit" && r.isStatutory,
        ),
      ).toBe(true);
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
      const statutory = JSON.parse(listRes.body).find(
        (r: { id: string; isStatutory: boolean }) => r.isStatutory,
      );

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/special-leave/rules/${statutory.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain("Gesetzliche");
    });

    it("requires specialLeaveRuleId for SPECIAL type", async () => {
      // 90 days ahead — avoid overlaps
      const dateStr = nextWeekdayStr(futureDateStr(90));

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
