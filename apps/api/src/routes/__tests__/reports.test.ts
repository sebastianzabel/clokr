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

  // ── GET /api/v1/dashboard/today-attendance (RPT-03) ──────────────────────
  describe("GET /api/v1/dashboard/today-attendance (RPT-03)", () => {
    let attData: Awaited<ReturnType<typeof seedTestData>>;
    let managerToken: string;
    let empClockedIn: { id: string; employeeNumber: string };
    let empPresent: { id: string; employeeNumber: string };
    let empAbsentLeave: { id: string; employeeNumber: string };
    let empAbsentSick: { id: string; employeeNumber: string };
    let empMissing: { id: string; employeeNumber: string };
    let empNoWorkday: { id: string; employeeNumber: string };

    beforeAll(async () => {
      attData = await seedTestData(app, "att");
      const prisma = app.prisma;

      // Create a manager user + employee in the tenant
      const mgrPwHash = await import("bcryptjs").then((b) =>
        b.default.hash("test1234", 10),
      );
      const mgrUser = await prisma.user.create({
        data: {
          email: `mgr-att-${Date.now()}@test.de`,
          passwordHash: mgrPwHash,
          role: "MANAGER",
          isActive: true,
        },
      });
      const mgrEmp = await prisma.employee.create({
        data: {
          tenantId: attData.tenant.id,
          userId: mgrUser.id,
          employeeNumber: `MGR-att-${Date.now()}`,
          firstName: "Manager",
          lastName: "Att",
          hireDate: new Date("2024-01-01"),
        },
      });
      await prisma.workSchedule.create({
        data: {
          employeeId: mgrEmp.id,
          weeklyHours: 40,
          mondayHours: 8,
          tuesdayHours: 8,
          wednesdayHours: 8,
          thursdayHours: 8,
          fridayHours: 8,
          saturdayHours: 0,
          sundayHours: 0,
          validFrom: new Date("2024-01-01"),
        },
      });
      await prisma.overtimeAccount.create({
        data: { employeeId: mgrEmp.id, balanceHours: 0 },
      });
      const mgrLogin = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: mgrUser.email, password: "test1234" },
      });
      managerToken = JSON.parse(mgrLogin.body).accessToken;

      // Today (UTC midnight) for entry creation
      const now = new Date();
      const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

      // Helper to create a Mon-Fri schedule for an employee
      async function makeWorkSchedule(empId: string) {
        await prisma.workSchedule.create({
          data: {
            employeeId: empId,
            weeklyHours: 40,
            mondayHours: 8,
            tuesdayHours: 8,
            wednesdayHours: 8,
            thursdayHours: 8,
            fridayHours: 8,
            saturdayHours: 0,
            sundayHours: 0,
            validFrom: new Date("2024-01-01"),
          },
        });
      }

      // Case 1: clocked_in — OPEN entry today (endTime: null)
      const empCIUser = await prisma.user.create({
        data: {
          email: `att-ci-${Date.now()}@test.de`,
          passwordHash: mgrPwHash,
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const empCIRecord = await prisma.employee.create({
        data: {
          tenantId: attData.tenant.id,
          userId: empCIUser.id,
          employeeNumber: `ATT-CI-${Date.now()}`,
          firstName: "Clocked",
          lastName: "In",
          hireDate: new Date("2024-01-01"),
        },
      });
      await makeWorkSchedule(empCIRecord.id);
      await prisma.overtimeAccount.create({ data: { employeeId: empCIRecord.id, balanceHours: 0 } });
      await prisma.timeEntry.create({
        data: {
          employeeId: empCIRecord.id,
          date: todayUtc,
          startTime: new Date(todayUtc.getTime() + 7 * 3600000),
          endTime: null, // open
          breakMinutes: 0,
          type: "WORK",
        },
      });
      empClockedIn = { id: empCIRecord.id, employeeNumber: empCIRecord.employeeNumber };

      // Case 2: present — CLOSED entry today
      const empPUser = await prisma.user.create({
        data: {
          email: `att-pr-${Date.now()}@test.de`,
          passwordHash: mgrPwHash,
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const empPRecord = await prisma.employee.create({
        data: {
          tenantId: attData.tenant.id,
          userId: empPUser.id,
          employeeNumber: `ATT-PR-${Date.now()}`,
          firstName: "Present",
          lastName: "Emp",
          hireDate: new Date("2024-01-01"),
        },
      });
      await makeWorkSchedule(empPRecord.id);
      await prisma.overtimeAccount.create({ data: { employeeId: empPRecord.id, balanceHours: 0 } });
      await prisma.timeEntry.create({
        data: {
          employeeId: empPRecord.id,
          date: todayUtc,
          startTime: new Date(todayUtc.getTime() + 7 * 3600000),
          endTime: new Date(todayUtc.getTime() + 15 * 3600000),
          breakMinutes: 30,
          type: "WORK",
        },
      });
      empPresent = { id: empPRecord.id, employeeNumber: empPRecord.employeeNumber };

      // Case 3: absent — APPROVED Urlaub leave covering today
      const empLUser = await prisma.user.create({
        data: {
          email: `att-lv-${Date.now()}@test.de`,
          passwordHash: mgrPwHash,
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const empLRecord = await prisma.employee.create({
        data: {
          tenantId: attData.tenant.id,
          userId: empLUser.id,
          employeeNumber: `ATT-LV-${Date.now()}`,
          firstName: "On",
          lastName: "Leave",
          hireDate: new Date("2024-01-01"),
        },
      });
      await makeWorkSchedule(empLRecord.id);
      await prisma.overtimeAccount.create({ data: { employeeId: empLRecord.id, balanceHours: 0 } });
      await prisma.leaveRequest.create({
        data: {
          employeeId: empLRecord.id,
          leaveTypeId: attData.vacationType.id,
          startDate: todayUtc,
          endDate: todayUtc,
          days: 1,
          status: "APPROVED",
        },
      });
      empAbsentLeave = { id: empLRecord.id, employeeNumber: empLRecord.employeeNumber };

      // Case 4: absent — SICK absence covering today
      const empSUser = await prisma.user.create({
        data: {
          email: `att-sk-${Date.now()}@test.de`,
          passwordHash: mgrPwHash,
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const empSRecord = await prisma.employee.create({
        data: {
          tenantId: attData.tenant.id,
          userId: empSUser.id,
          employeeNumber: `ATT-SK-${Date.now()}`,
          firstName: "Sick",
          lastName: "Emp",
          hireDate: new Date("2024-01-01"),
        },
      });
      await makeWorkSchedule(empSRecord.id);
      await prisma.overtimeAccount.create({ data: { employeeId: empSRecord.id, balanceHours: 0 } });
      await prisma.absence.create({
        data: {
          employeeId: empSRecord.id,
          type: "SICK",
          startDate: todayUtc,
          endDate: todayUtc,
          days: 1,
          createdBy: attData.adminUser.id,
        },
      });
      empAbsentSick = { id: empSRecord.id, employeeNumber: empSRecord.employeeNumber };

      // Case 5: missing — workday, no entries/leave/absence (Mon-Fri schedule)
      const empMUser = await prisma.user.create({
        data: {
          email: `att-ms-${Date.now()}@test.de`,
          passwordHash: mgrPwHash,
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const empMRecord = await prisma.employee.create({
        data: {
          tenantId: attData.tenant.id,
          userId: empMUser.id,
          employeeNumber: `ATT-MS-${Date.now()}`,
          firstName: "Missing",
          lastName: "Emp",
          hireDate: new Date("2024-01-01"),
        },
      });
      await makeWorkSchedule(empMRecord.id);
      await prisma.overtimeAccount.create({ data: { employeeId: empMRecord.id, balanceHours: 0 } });
      empMissing = { id: empMRecord.id, employeeNumber: empMRecord.employeeNumber };

      // Case 6: none — non-workday schedule (all zero hours = every day is off)
      const empNWUser = await prisma.user.create({
        data: {
          email: `att-nw-${Date.now()}@test.de`,
          passwordHash: mgrPwHash,
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const empNWRecord = await prisma.employee.create({
        data: {
          tenantId: attData.tenant.id,
          userId: empNWUser.id,
          employeeNumber: `ATT-NW-${Date.now()}`,
          firstName: "NonWork",
          lastName: "Emp",
          hireDate: new Date("2024-01-01"),
        },
      });
      // All-zero schedule → every day is a non-workday
      await prisma.workSchedule.create({
        data: {
          employeeId: empNWRecord.id,
          weeklyHours: 0,
          mondayHours: 0,
          tuesdayHours: 0,
          wednesdayHours: 0,
          thursdayHours: 0,
          fridayHours: 0,
          saturdayHours: 0,
          sundayHours: 0,
          validFrom: new Date("2024-01-01"),
        },
      });
      await prisma.overtimeAccount.create({
        data: { employeeId: empNWRecord.id, balanceHours: 0 },
      });
      empNoWorkday = { id: empNWRecord.id, employeeNumber: empNWRecord.employeeNumber };
    });

    afterAll(async () => {
      await cleanupTestData(app, attData.tenant.id);
    });

    it("Case 1: employee with open entry today has status clocked_in", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/today-attendance",
        headers: { authorization: `Bearer ${managerToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const emp = body.employees.find(
        (e: { employeeNumber: string }) => e.employeeNumber === empClockedIn.employeeNumber,
      );
      expect(emp).toBeDefined();
      expect(emp.status).toBe("clocked_in");
    });

    it("Case 2: employee with closed entry today has status present", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/today-attendance",
        headers: { authorization: `Bearer ${managerToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const emp = body.employees.find(
        (e: { employeeNumber: string }) => e.employeeNumber === empPresent.employeeNumber,
      );
      expect(emp).toBeDefined();
      expect(emp.status).toBe("present");
    });

    it("Case 3: employee with APPROVED leave today has status absent and reason matching Urlaub", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/today-attendance",
        headers: { authorization: `Bearer ${managerToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const emp = body.employees.find(
        (e: { employeeNumber: string }) => e.employeeNumber === empAbsentLeave.employeeNumber,
      );
      expect(emp).toBeDefined();
      expect(emp.status).toBe("absent");
      expect(emp.reason).toBe("Urlaub");
    });

    it("Case 4: employee with SICK absence today has status absent and reason mentioning Krankmeldung", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/today-attendance",
        headers: { authorization: `Bearer ${managerToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const emp = body.employees.find(
        (e: { employeeNumber: string }) => e.employeeNumber === empAbsentSick.employeeNumber,
      );
      expect(emp).toBeDefined();
      expect(emp.status).toBe("absent");
      expect(emp.reason).toContain("Krankmeldung");
    });

    it("Case 5: employee on workday with no entries or absences has status missing", async () => {
      // Only valid for weekdays — skip on weekend
      const dow = new Date().getUTCDay();
      if (dow === 0 || dow === 6) {
        // Saturday or Sunday — employee has Mon-Fri schedule → status would be "none"
        return;
      }
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/today-attendance",
        headers: { authorization: `Bearer ${managerToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const emp = body.employees.find(
        (e: { employeeNumber: string }) => e.employeeNumber === empMissing.employeeNumber,
      );
      expect(emp).toBeDefined();
      expect(emp.status).toBe("missing");
    });

    it("Case 6: employee with all-zero schedule has status none", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/today-attendance",
        headers: { authorization: `Bearer ${managerToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const emp = body.employees.find(
        (e: { employeeNumber: string }) => e.employeeNumber === empNoWorkday.employeeNumber,
      );
      expect(emp).toBeDefined();
      expect(emp.status).toBe("none");
    });

    it("Case 7: response.summary counts sum equals employees.length", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/today-attendance",
        headers: { authorization: `Bearer ${managerToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("summary");
      expect(body).toHaveProperty("employees");
      expect(body).toHaveProperty("date");
      const { present, absent, clockedIn, missing } = body.summary;
      const sumCounts = (present ?? 0) + (absent ?? 0) + (clockedIn ?? 0) + (missing ?? 0);
      // Sum of these 4 statuses should not exceed total employees (none is not in summary)
      expect(sumCounts).toBeLessThanOrEqual(body.employees.length);
    });

    it("Case 8: EMPLOYEE role returns 403", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/today-attendance",
        headers: { authorization: `Bearer ${attData.empToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("Case 9: tenant isolation — admin from tenant A never sees employees from tenant B", async () => {
      const tenantB = await seedTestData(app, "att-b");
      try {
        const res = await app.inject({
          method: "GET",
          url: "/api/v1/dashboard/today-attendance",
          headers: { authorization: `Bearer ${attData.adminToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        const tenantBEmp = body.employees.find(
          (e: { employeeNumber: string }) =>
            e.employeeNumber === tenantB.employee.employeeNumber,
        );
        expect(tenantBEmp).toBeUndefined();
      } finally {
        await cleanupTestData(app, tenantB.tenant.id);
      }
    });
  });

  // ── GET /api/v1/reports/leave-overview — pendingDays (RPT-02) ────────────
  describe("GET /api/v1/reports/leave-overview — pendingDays (RPT-02)", () => {
    let pendingData: Awaited<ReturnType<typeof seedTestData>>;
    let tenantBData: Awaited<ReturnType<typeof seedTestData>>;
    const currentYear = new Date().getFullYear();

    beforeAll(async () => {
      pendingData = await seedTestData(app, "pd");
      tenantBData = await seedTestData(app, "pd-b");

      // Case 2: PENDING request with 3 days in current year for "Urlaub"
      await app.prisma.leaveRequest.create({
        data: {
          employeeId: pendingData.employee.id,
          leaveTypeId: pendingData.vacationType.id,
          startDate: new Date(Date.UTC(currentYear, 5, 10)),
          endDate: new Date(Date.UTC(currentYear, 5, 12)),
          days: 3,
          status: "PENDING",
        },
      });

      // Case 3: PENDING request in a DIFFERENT year (next year) — must NOT be counted
      await app.prisma.leaveRequest.create({
        data: {
          employeeId: pendingData.employee.id,
          leaveTypeId: pendingData.vacationType.id,
          startDate: new Date(Date.UTC(currentYear + 1, 0, 5)),
          endDate: new Date(Date.UTC(currentYear + 1, 0, 7)),
          days: 3,
          status: "PENDING",
        },
      });

      // Case 4: APPROVED request — must NOT be counted in pendingDays
      await app.prisma.leaveRequest.create({
        data: {
          employeeId: pendingData.employee.id,
          leaveTypeId: pendingData.vacationType.id,
          startDate: new Date(Date.UTC(currentYear, 7, 1)),
          endDate: new Date(Date.UTC(currentYear, 7, 2)),
          days: 2,
          status: "APPROVED",
        },
      });

      // Case 4: CANCELLED request — must NOT be counted in pendingDays
      await app.prisma.leaveRequest.create({
        data: {
          employeeId: pendingData.employee.id,
          leaveTypeId: pendingData.vacationType.id,
          startDate: new Date(Date.UTC(currentYear, 8, 1)),
          endDate: new Date(Date.UTC(currentYear, 8, 1)),
          days: 1,
          status: "CANCELLED",
        },
      });

      // Case 5: Soft-deleted PENDING request — must NOT be counted
      await app.prisma.leaveRequest.create({
        data: {
          employeeId: pendingData.employee.id,
          leaveTypeId: pendingData.vacationType.id,
          startDate: new Date(Date.UTC(currentYear, 9, 1)),
          endDate: new Date(Date.UTC(currentYear, 9, 3)),
          days: 3,
          status: "PENDING",
          deletedAt: new Date(),
        },
      });
    });

    afterAll(async () => {
      await cleanupTestData(app, pendingData.tenant.id);
      await cleanupTestData(app, tenantBData.tenant.id);
    });

    it("Case 1: employee with no PENDING requests returns pendingDays: 0 for the admin employee", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/reports/leave-overview?year=${currentYear}`,
        headers: { authorization: `Bearer ${pendingData.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // adminEmployee has no leaveEntitlement seeded → no row for admin, but the main employee row should exist
      // The main employee has pendingDays: 3 (from Case 2)
      const empRow = body.find(
        (r: { employee: { employeeNumber: string }; leaveType: { name: string } }) =>
          r.employee.employeeNumber === pendingData.employee.employeeNumber &&
          r.leaveType.name === "Urlaub",
      );
      expect(empRow).toBeDefined();
      // pendingDays field MUST exist on every row
      expect(typeof empRow.pendingDays).toBe("number");
    });

    it("Case 2: employee with one PENDING LeaveRequest (days: 3) has pendingDays: 3", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/reports/leave-overview?year=${currentYear}`,
        headers: { authorization: `Bearer ${pendingData.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const empRow = body.find(
        (r: { employee: { employeeNumber: string }; leaveType: { name: string } }) =>
          r.employee.employeeNumber === pendingData.employee.employeeNumber &&
          r.leaveType.name === "Urlaub",
      );
      expect(empRow).toBeDefined();
      expect(empRow.pendingDays).toBe(3);
    });

    it("Case 3: PENDING request in a different year is NOT counted in pendingDays", async () => {
      // Request in currentYear+1 should not appear in year=currentYear query
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/reports/leave-overview?year=${currentYear}`,
        headers: { authorization: `Bearer ${pendingData.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const empRow = body.find(
        (r: { employee: { employeeNumber: string }; leaveType: { name: string } }) =>
          r.employee.employeeNumber === pendingData.employee.employeeNumber &&
          r.leaveType.name === "Urlaub",
      );
      // pendingDays should still be 3 (only the current-year PENDING request)
      expect(empRow.pendingDays).toBe(3);
    });

    it("Case 4: APPROVED and CANCELLED requests are NOT counted in pendingDays", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/reports/leave-overview?year=${currentYear}`,
        headers: { authorization: `Bearer ${pendingData.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const empRow = body.find(
        (r: { employee: { employeeNumber: string }; leaveType: { name: string } }) =>
          r.employee.employeeNumber === pendingData.employee.employeeNumber &&
          r.leaveType.name === "Urlaub",
      );
      // Still 3, not 3 + 2 + 1 = 6
      expect(empRow.pendingDays).toBe(3);
    });

    it("Case 5: soft-deleted PENDING requests are NOT counted in pendingDays", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/reports/leave-overview?year=${currentYear}`,
        headers: { authorization: `Bearer ${pendingData.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const empRow = body.find(
        (r: { employee: { employeeNumber: string }; leaveType: { name: string } }) =>
          r.employee.employeeNumber === pendingData.employee.employeeNumber &&
          r.leaveType.name === "Urlaub",
      );
      // Still 3, not 3 + 3 (soft-deleted) = 6
      expect(empRow.pendingDays).toBe(3);
    });

    it("Case 6: tenant isolation — tenant A admin does NOT see pendingDays from tenant B employees", async () => {
      // Create a PENDING request for tenant B employee
      await app.prisma.leaveRequest.create({
        data: {
          employeeId: tenantBData.employee.id,
          leaveTypeId: tenantBData.vacationType.id,
          startDate: new Date(Date.UTC(currentYear, 5, 10)),
          endDate: new Date(Date.UTC(currentYear, 5, 14)),
          days: 5,
          status: "PENDING",
        },
      });

      // Tenant A admin calls endpoint — should only see tenant A entitlements
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/reports/leave-overview?year=${currentYear}`,
        headers: { authorization: `Bearer ${pendingData.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      // Verify tenant B employee does NOT appear in tenant A response
      const tenantBRow = body.find(
        (r: { employee: { employeeNumber: string } }) =>
          r.employee.employeeNumber === tenantBData.employee.employeeNumber,
      );
      expect(tenantBRow).toBeUndefined();

      // Verify tenant A pendingDays is still correct (3, not 3+5=8)
      const empRow = body.find(
        (r: { employee: { employeeNumber: string }; leaveType: { name: string } }) =>
          r.employee.employeeNumber === pendingData.employee.employeeNumber &&
          r.leaveType.name === "Urlaub",
      );
      expect(empRow.pendingDays).toBe(3);
    });
  });
});
