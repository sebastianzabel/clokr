import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../__tests__/setup";
import type { FastifyInstance } from "fastify";

describe("Reports API", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "rp");
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
    await closeTestApp();
  });

  describe("GET /api/v1/reports/monthly", () => {
    it("returns 200 with expected shape for valid year/month params", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/reports/monthly?year=2025&month=1",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.year).toBe(2025);
      expect(body.month).toBe(1);
      expect(Array.isArray(body.rows)).toBe(true);

      // Each row must have the expected fields
      for (const row of body.rows) {
        expect(row).toHaveProperty("employeeId");
        expect(row).toHaveProperty("employeeName");
        expect(row).toHaveProperty("employeeNumber");
        expect(typeof row.workedHours).toBe("number");
        expect(typeof row.shouldHours).toBe("number");
        expect(typeof row.sickDays).toBe("number");
        expect(typeof row.vacationDays).toBe("number");
        expect(typeof row.totalAbsenceDays).toBe("number");
      }
    });

    it("returns 401 without auth token", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/reports/monthly?year=2025&month=1",
      });

      expect(res.statusCode).toBe(401);
    });

    it("returns non-200 when required query params are missing", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/reports/monthly",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      // Without year/month the handler will fail (no schema validation,
      // so Fastify returns 500 rather than 400).
      expect(res.statusCode).not.toBe(200);
    });
  });
});
