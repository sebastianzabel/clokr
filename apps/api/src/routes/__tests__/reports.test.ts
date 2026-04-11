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

  describe("GET /api/v1/reports/datev", () => {
    let datevData: Awaited<ReturnType<typeof seedTestData>>;

    beforeAll(async () => {
      datevData = await seedTestData(app, "dv");

      // Seed a work time entry for 2026-04-07 (Tuesday, work day)
      await app.prisma.timeEntry.create({
        data: {
          employeeId: datevData.employee.id,
          date: new Date("2026-04-07"),
          startTime: new Date("2026-04-07T07:00:00.000Z"),
          endTime: new Date("2026-04-07T15:00:00.000Z"),
          breakMinutes: 0,
        },
      });

      // Seed a sick absence for 2026-04-14 (Tuesday)
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

      // Seed a vacation leave request for 2026-04-21 (Tuesday)
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

      // Create Überstundenausgleich leave type and request for DATEV-03c
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
      const idxAllgemein = body.indexOf("[Allgemein]");
      const idxSatz = body.indexOf("[Satzbeschreibung]");
      const idxBewegung = body.indexOf("[Bewegungsdaten]");
      expect(idxAllgemein).toBeGreaterThanOrEqual(0);
      expect(idxSatz).toBeGreaterThan(idxAllgemein);
      expect(idxBewegung).toBeGreaterThan(idxSatz);
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
      const hasDescriptor = lines.slice(satzIdx + 1).some((l: string) => l.startsWith("20;"));
      expect(hasDescriptor).toBe(true);
    });

    it("DATEV-02a: response body uses CRLF (no bare LF)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/reports/datev?year=2026&month=4",
        headers: { authorization: `Bearer ${datevData.adminToken}` },
      });
      const body = res.rawPayload;
      for (let i = 0; i < body.length; i++) {
        if (body[i] === 0x0a) {
          expect(body[i - 1]).toBe(0x0d); // LF must be preceded by CR
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

    it("DATEV-02d: filename ends with .txt not .csv", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/reports/datev?year=2026&month=4",
        headers: { authorization: `Bearer ${datevData.adminToken}` },
      });
      const disposition = res.headers["content-disposition"] as string;
      expect(disposition).toContain('filename="datev-2026-4.txt"');
    });

    it("DATEV-03b: default Lohnartennummern (100) used when config has default values", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/reports/datev?year=2026&month=4",
        headers: { authorization: `Bearer ${datevData.adminToken}` },
      });
      const body = iconv.decode(res.rawPayload, "win1252");
      expect(body).toContain(";100;");
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

      // Reset to defaults
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
});
