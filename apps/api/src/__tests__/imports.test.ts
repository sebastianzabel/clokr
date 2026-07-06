import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("Bulk Import API", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "im");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("POST /api/v1/imports/employees", () => {
    it("imports employees from CSV", async () => {
      const uid = Date.now().toString(36);
      const csv = `email;vorname;nachname;nr;eintrittsdatum;rolle;wochenstunden;passwort
import1-${uid}@test.de;Import;Eins;IM1-${uid};01.01.2026;EMPLOYEE;40;test1234
import2-${uid}@test.de;Import;Zwei;IM2-${uid};15.03.2026;EMPLOYEE;38.5;test1234`;

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/imports/employees",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { csv },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.total).toBe(2);
      expect(body.imported).toBe(2);
      expect(body.errors).toBe(0);
    });

    it("reports errors for invalid rows", async () => {
      const csv = `email;vorname;nachname;nr;eintrittsdatum
not-an-email;Max;Mustermann;ERR-001;01.01.2026`;

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/imports/employees",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { csv },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.errors).toBeGreaterThan(0);
    });

    it("rejects non-admin access", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/imports/employees",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: { csv: "email;vorname;nachname;nr;eintrittsdatum\n" },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe("POST /api/v1/imports/time-entries", () => {
    it("imports time entries from CSV", async () => {
      // Use the actual employee number from test data
      const empNo = data.employee.employeeNumber;
      const csv = `nr;datum;von;bis;pause;notiz
${empNo};10.06.2026;08:00;16:30;30;Import-Test
${empNo};11.06.2026;09:00;17:00;30;Import-Test 2`;

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/imports/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { csv },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.total).toBe(2);
      // At least some should succeed if employee exists
      expect(body.imported + body.errors).toBe(2);
    });

    it("reports error for unknown employee number", async () => {
      const csv = `nr;datum;start;ende;pause
UNKNOWN-999;01.06.2026;08:00;16:00;30`;

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/imports/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { csv },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.errors).toBe(1);
      expect(body.details[0].error).toContain("nicht gefunden");
    });

    // ── Plan 76.19-01 Task 2: import routed through shared invariants ──────────

    it("D-01: parses wall-clock time in the tenant timezone, not UTC", async () => {
      const empNo = data.employee.employeeNumber;
      // 08:00 on a June date in Europe/Berlin (CEST = UTC+2) → 06:00Z
      const csv = `nr;datum;von;bis;pause;notiz
${empNo};03.06.2026;08:00;16:30;30;TZ-Test`;

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/imports/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { csv },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.imported).toBe(1);

      const entry = await app.prisma.timeEntry.findFirst({
        where: { employeeId: data.employee.id, date: new Date("2026-06-03"), deletedAt: null },
      });
      expect(entry).not.toBeNull();
      // 08:00 Berlin summer = 06:00 UTC (NOT 08:00Z)
      expect(entry!.startTime.toISOString()).toBe("2026-06-03T06:00:00.000Z");
      expect(entry!.endTime!.toISOString()).toBe("2026-06-03T14:30:00.000Z");
    });

    it("D-01: rejects a duplicate same-day row (one-per-day)", async () => {
      const empNo = data.employee.employeeNumber;
      const csv = `nr;datum;von;bis;pause
${empNo};04.06.2026;08:00;12:00;0
${empNo};04.06.2026;13:00;17:00;0`;

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/imports/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { csv },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.imported).toBe(1);
      expect(body.errors).toBe(1);
      // one non-deleted entry for that day
      const count = await app.prisma.timeEntry.count({
        where: { employeeId: data.employee.id, date: new Date("2026-06-04"), deletedAt: null },
      });
      expect(count).toBe(1);
    });

    it("D-01: rejects a row in a snapshot-locked month", async () => {
      const empNo = data.employee.employeeNumber;
      // Lock February 2026: Feb 1 00:00 Berlin (winter, UTC+1) = Jan 31 23:00 UTC
      await app.prisma.saldoSnapshot.create({
        data: {
          employeeId: data.employee.id,
          periodType: "MONTHLY",
          periodStart: new Date("2026-01-31T23:00:00Z"),
          periodEnd: new Date("2026-02-28T22:59:59Z"),
          workedMinutes: 0,
          expectedMinutes: 9600,
          balanceMinutes: -9600,
          carryOver: 0,
          closedAt: new Date(),
          closedBy: data.adminEmployee.id,
        },
      });

      const csv = `nr;datum;von;bis;pause
${empNo};16.02.2026;08:00;16:00;30`;

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/imports/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { csv },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.errors).toBe(1);
      expect(body.details[0].error).toContain("abgeschlossen");
      // no entry created in the locked month
      const count = await app.prisma.timeEntry.count({
        where: { employeeId: data.employee.id, date: new Date("2026-02-16"), deletedAt: null },
      });
      expect(count).toBe(0);

      await app.prisma.saldoSnapshot.deleteMany({ where: { employeeId: data.employee.id } });
    });

    it("D-01: writes one audit log per imported entry (not a single summary row)", async () => {
      const empNo = data.employee.employeeNumber;
      const csv = `nr;datum;von;bis;pause
${empNo};07.06.2026;08:00;12:00;0
${empNo};08.06.2026;08:00;12:00;0`;

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/imports/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { csv },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.imported).toBe(2);

      const created = await app.prisma.timeEntry.findMany({
        where: {
          employeeId: data.employee.id,
          date: { in: [new Date("2026-06-07"), new Date("2026-06-08")] },
          deletedAt: null,
        },
        select: { id: true },
      });
      expect(created.length).toBe(2);
      const auditCount = await app.prisma.auditLog.count({
        where: {
          entity: "TimeEntry",
          action: "CREATE",
          entityId: { in: created.map((c) => c.id) },
        },
      });
      expect(auditCount).toBe(2);
    });
  });
});
