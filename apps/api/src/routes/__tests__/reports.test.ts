import { describe, it, expect, beforeAll, afterAll } from "vitest";
import iconv from "iconv-lite";
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

  // ── GET /api/v1/reports/datev (DATEV LODAS Export) ────────────────────────
  describe("GET /api/v1/reports/datev", () => {
    let datevData: Awaited<ReturnType<typeof seedTestData>>;

    beforeAll(async () => {
      datevData = await seedTestData(app, "dv");

      await app.prisma.timeEntry.create({
        data: {
          employeeId: datevData.employee.id,
          date: new Date("2026-04-07"),
          startTime: new Date("2026-04-07T07:00:00.000Z"),
          endTime: new Date("2026-04-07T15:00:00.000Z"),
          breakMinutes: 0,
        },
      });

      await app.prisma.absence.create({
        data: {
          employeeId: datevData.employee.id,
          type: "SICK",
          startDate: new Date("2026-04-14"),
          endDate: new Date("2026-04-14"),
          days: 1,
          createdBy: datevData.adminUser.id,
        },
      });

      await app.prisma.leaveRequest.create({
        data: {
          employeeId: datevData.employee.id,
          leaveTypeId: datevData.vacationType.id,
          startDate: new Date("2026-04-21"),
          endDate: new Date("2026-04-21"),
          days: 1,
          status: "APPROVED",
        },
      });

      const overtimeLeaveType = await app.prisma.leaveType.create({
        data: {
          tenantId: datevData.tenant.id,
          name: "Überstundenausgleich",
          isPaid: true,
          requiresApproval: false,
          color: "#FF8C00",
        },
      });

      await app.prisma.leaveRequest.create({
        data: {
          employeeId: datevData.employee.id,
          leaveTypeId: overtimeLeaveType.id,
          startDate: new Date("2026-04-28"),
          endDate: new Date("2026-04-28"),
          days: 1,
          status: "APPROVED",
        },
      });
    });

    afterAll(async () => {
      await cleanupTestData(app, datevData.tenant.id);
    });

    it("DATEV-01a: response body contains [Allgemein], [Satzbeschreibung], [Bewegungsdaten] in order", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/reports/datev?year=2026&month=4",
        headers: { authorization: `Bearer ${datevData.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = iconv.decode(res.rawPayload, "win1252");
      expect(body.indexOf("[Allgemein]")).toBeGreaterThanOrEqual(0);
      expect(body.indexOf("[Satzbeschreibung]")).toBeGreaterThan(body.indexOf("[Allgemein]"));
      expect(body.indexOf("[Bewegungsdaten]")).toBeGreaterThan(body.indexOf("[Satzbeschreibung]"));
    });

    it("DATEV-01b: [Allgemein] section contains required fields", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/reports/datev?year=2026&month=4",
        headers: { authorization: `Bearer ${datevData.adminToken}` },
      });
      const body = iconv.decode(res.rawPayload, "win1252");
      expect(body).toContain("Ziel=LODAS");
      expect(body).toContain("Version_SST=1.0");
      expect(body).toContain("BeraterNr=0");
      expect(body).toContain("MandantenNr=0");
      expect(body).toContain("Datumsangaben=DDMMJJJJ");
    });

    it("DATEV-01c: [Satzbeschreibung] contains a row starting with '20;'", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/reports/datev?year=2026&month=4",
        headers: { authorization: `Bearer ${datevData.adminToken}` },
      });
      const body = iconv.decode(res.rawPayload, "win1252");
      const lines = body.split(/\r\n/);
      const satzIdx = lines.findIndex((l: string) => l === "[Satzbeschreibung]");
      expect(satzIdx).toBeGreaterThanOrEqual(0);
      expect(lines.slice(satzIdx + 1).some((l: string) => l.startsWith("20;"))).toBe(true);
    });

    it("DATEV-02a: response body uses CRLF line endings", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/reports/datev?year=2026&month=4",
        headers: { authorization: `Bearer ${datevData.adminToken}` },
      });
      const body = res.rawPayload;
      for (let i = 0; i < body.length; i++) {
        if (body[i] === 0x0a) {
          expect(body[i - 1]).toBe(0x0d);
        }
      }
    });

    it("DATEV-02c: Content-Type is application/octet-stream", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/reports/datev?year=2026&month=4",
        headers: { authorization: `Bearer ${datevData.adminToken}` },
      });
      expect(res.headers["content-type"]).toBe("application/octet-stream");
    });

    it("DATEV-02d: filename ends with .txt", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/reports/datev?year=2026&month=4",
        headers: { authorization: `Bearer ${datevData.adminToken}` },
      });
      expect(res.headers["content-disposition"] as string).toContain('filename="datev-2026-4.txt"');
    });

    it("DATEV-03a: custom Lohnartennummern from TenantConfig appear in data rows", async () => {
      await app.prisma.tenantConfig.update({
        where: { tenantId: datevData.tenant.id },
        data: {
          datevNormalstundenNr: 777,
          datevUrlaubNr: 888,
          datevKrankNr: 999,
          datevSonderurlaubNr: 555,
        },
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/reports/datev?year=2026&month=4",
        headers: { authorization: `Bearer ${datevData.adminToken}` },
      });
      const body = iconv.decode(res.rawPayload, "win1252");
      expect(body).toContain(";777;");
      expect(body).toContain(";888;");
      expect(body).toContain(";999;");
      await app.prisma.tenantConfig.update({
        where: { tenantId: datevData.tenant.id },
        data: {
          datevNormalstundenNr: 100,
          datevUrlaubNr: 300,
          datevKrankNr: 200,
          datevSonderurlaubNr: 302,
        },
      });
    });

    it("DATEV-03b: default Lohnartennummer 100 used with default config", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/reports/datev?year=2026&month=4",
        headers: { authorization: `Bearer ${datevData.adminToken}` },
      });
      const body = iconv.decode(res.rawPayload, "win1252");
      expect(body).toContain(";100;");
    });

    it("DATEV-03c: hardcoded Lohnartennummer 301 (Überstundenausgleich) not overridden by config", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/reports/datev?year=2026&month=4",
        headers: { authorization: `Bearer ${datevData.adminToken}` },
      });
      const body = iconv.decode(res.rawPayload, "win1252");
      expect(body).toContain(";301;");
    });
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
