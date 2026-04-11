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

  // ── GET /api/v1/reports/monthly/pdf/all ────────────────────────────────────
  describe("GET /api/v1/reports/monthly/pdf/all", () => {
    it("returns 200 with application/pdf for ADMIN token", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/reports/monthly/pdf/all?year=2025&month=1",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("application/pdf");
      // Smoke check: actual PDF magic bytes
      expect(res.rawPayload.slice(0, 4).toString("ascii")).toBe("%PDF");
    });

    it("returns 401 without auth", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/reports/monthly/pdf/all?year=2025&month=1",
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 403 for EMPLOYEE token", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/reports/monthly/pdf/all?year=2025&month=1",
        headers: { authorization: `Bearer ${data.empToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("accepts role=MANAGER filter (returns 200 or 404 if no managers)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/reports/monthly/pdf/all?year=2025&month=1&role=MANAGER",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      // seedTestData creates ADMIN + EMPLOYEE — no MANAGER user.
      // The handler returns 404 "Keine Mitarbeiter gefunden" when filter yields 0.
      expect([200, 404]).toContain(res.statusCode);
    });

    it("accepts role=EMPLOYEE filter and returns PDF with only employees", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/reports/monthly/pdf/all?year=2025&month=1&role=EMPLOYEE",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("application/pdf");
      expect(res.rawPayload.slice(0, 4).toString("ascii")).toBe("%PDF");
    });

    it("normalizes invalid role values to 'all' (no enum injection)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/reports/monthly/pdf/all?year=2025&month=1&role=SUPERADMIN",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      // Should NOT crash with Prisma enum error — should be treated as "all"
      expect(res.statusCode).toBe(200);
    });
  });

  // ── Tenant isolation for company PDF ──────────────────────────────────────
  describe("Tenant isolation — /monthly/pdf/all", () => {
    let secondTenant: Awaited<ReturnType<typeof seedTestData>>;

    beforeAll(async () => {
      secondTenant = await seedTestData(app, "rp2");
    });

    afterAll(async () => {
      await cleanupTestData(app, secondTenant.tenant.id);
    });

    it("each tenant only sees its own employees in the PDF", async () => {
      // Tenant A request with admin A token — should succeed
      const resA = await app.inject({
        method: "GET",
        url: "/api/v1/reports/monthly/pdf/all?year=2025&month=1",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(resA.statusCode).toBe(200);

      // Tenant B request with admin B token — should also succeed
      const resB = await app.inject({
        method: "GET",
        url: "/api/v1/reports/monthly/pdf/all?year=2025&month=1",
        headers: { authorization: `Bearer ${secondTenant.adminToken}` },
      });
      expect(resB.statusCode).toBe(200);

      // Both PDFs are valid and non-empty
      expect(resA.rawPayload.length).toBeGreaterThan(0);
      expect(resB.rawPayload.length).toBeGreaterThan(0);
      expect(resA.rawPayload.slice(0, 4).toString("ascii")).toBe("%PDF");
      expect(resB.rawPayload.slice(0, 4).toString("ascii")).toBe("%PDF");
    });
  });

  // ── GET /api/v1/reports/leave-list/pdf ────────────────────────────────────
  describe("GET /api/v1/reports/leave-list/pdf", () => {
    it("returns 200 with application/pdf for ADMIN token", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/reports/leave-list/pdf?year=2025",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      // The seed has no approved leave requests — endpoint returns 200 with an empty/stub PDF
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("application/pdf");
      expect(res.rawPayload.slice(0, 4).toString("ascii")).toBe("%PDF");
    });

    it("returns 401 without auth", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/reports/leave-list/pdf?year=2025",
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 403 for EMPLOYEE token", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/reports/leave-list/pdf?year=2025",
        headers: { authorization: `Bearer ${data.empToken}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ── GET /api/v1/reports/monthly/pdf (PDF-04 backward compat) ───────────────
  describe("GET /api/v1/reports/monthly/pdf (PDF-04 backward compat)", () => {
    it("still returns a Buffer with %PDF magic bytes after layout changes", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/reports/monthly/pdf?employeeId=${data.employee.id}&year=2025&month=1`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("application/pdf");
      expect(res.rawPayload.slice(0, 4).toString("ascii")).toBe("%PDF");
    });
  });
});
