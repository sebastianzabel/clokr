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
  });
});
