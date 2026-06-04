import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("Employee Availability API (Phase 46)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  // Second tenant (for cross-tenant 404 test)
  let otherData: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "av");
    otherData = await seedTestData(app, "av-other");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed (tenant A):", err);
    }
    try {
      await cleanupTestData(app, otherData.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed (tenant B):", err);
    }
    await closeTestApp();
  });

  // ── REPLACE semantics ──────────────────────────────────────────────────────

  describe("PUT /employees/:id/availability — REPLACE semantics", () => {
    it("old rows removed and new rows created in one transaction (ADMIN)", async () => {
      // Seed two initial rows
      const r1 = await app.inject({
        method: "PUT",
        url: `/api/v1/employees/${data.employee.id}/availability`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          entries: [
            {
              dayOfWeek: 0,
              status: "AVAILABLE",
              validFrom: "2026-01-01",
            },
            {
              dayOfWeek: 1,
              status: "PREFERRED",
              validFrom: "2026-01-01",
            },
          ],
        },
      });
      expect(r1.statusCode).toBe(200);
      const b1 = JSON.parse(r1.body);
      expect(b1.entries).toHaveLength(2);

      // REPLACE with a different set
      const r2 = await app.inject({
        method: "PUT",
        url: `/api/v1/employees/${data.employee.id}/availability`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          entries: [
            {
              dayOfWeek: 5,
              status: "UNAVAILABLE",
              note: "Wochenende frei",
              validFrom: "2026-01-01",
              validUntil: "2026-12-31",
            },
          ],
        },
      });
      expect(r2.statusCode).toBe(200);
      const b2 = JSON.parse(r2.body);
      expect(b2.entries).toHaveLength(1);
      expect(b2.entries[0].dayOfWeek).toBe(5);
      expect(b2.entries[0].status).toBe("UNAVAILABLE");
      expect(b2.entries[0].note).toBe("Wochenende frei");

      // DB confirms old rows gone
      const rows = await app.prisma.employeeAvailability.findMany({
        where: { employeeId: data.employee.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].dayOfWeek).toBe(5);
    });
  });

  // ── GET ─────────────────────────────────────────────────────────────────────

  describe("GET /employees/:id/availability", () => {
    it("returns entries with ISO-formatted dates", async () => {
      // Seed
      await app.inject({
        method: "PUT",
        url: `/api/v1/employees/${data.employee.id}/availability`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          entries: [
            {
              date: "2026-06-15",
              status: "UNAVAILABLE",
              validFrom: "2026-06-15",
              validUntil: "2026-06-15",
            },
          ],
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/employees/${data.employee.id}/availability`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0].date).toBe("2026-06-15");
      expect(body.entries[0].validFrom).toBe("2026-06-15");
      expect(body.entries[0].validUntil).toBe("2026-06-15");
      expect(typeof body.entries[0].date).toBe("string");
    });
  });

  // ── EMPLOYEE permission carve-out ──────────────────────────────────────────

  describe("EMPLOYEE permission carve-out", () => {
    it("EMPLOYEE can GET own availability (200)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/employees/${data.employee.id}/availability`,
        headers: { authorization: `Bearer ${data.empToken}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it("EMPLOYEE can PUT own availability (200)", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/employees/${data.employee.id}/availability`,
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {
          entries: [{ dayOfWeek: 2, status: "PREFERRED", validFrom: "2026-01-01" }],
        },
      });
      expect(res.statusCode).toBe(200);
    });

    it("EMPLOYEE gets 403 on GET another employee", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/employees/${data.adminEmployee.id}/availability`,
        headers: { authorization: `Bearer ${data.empToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("EMPLOYEE gets 403 on PUT to another employee", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/employees/${data.adminEmployee.id}/availability`,
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {
          entries: [{ dayOfWeek: 0, status: "UNAVAILABLE", validFrom: "2026-01-01" }],
        },
      });
      expect(res.statusCode).toBe(403);
    });

    it("ADMIN can PUT any employee in own tenant (200)", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/employees/${data.adminEmployee.id}/availability`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          entries: [{ dayOfWeek: 6, status: "AVAILABLE", validFrom: "2026-01-01" }],
        },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  // ── Cross-tenant ───────────────────────────────────────────────────────────

  describe("Cross-tenant isolation", () => {
    it("ADMIN of tenant A cannot GET employee in tenant B (404)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/employees/${otherData.employee.id}/availability`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("Mitarbeiter nicht gefunden");
    });
  });

  // ── Zod validation ─────────────────────────────────────────────────────────

  describe("Zod validation", () => {
    it("rejects when dayOfWeek AND date both set (400)", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/employees/${data.employee.id}/availability`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          entries: [
            {
              dayOfWeek: 1,
              date: "2026-06-15",
              status: "AVAILABLE",
              validFrom: "2026-06-15",
            },
          ],
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.message).toMatch(/Entweder dayOfWeek ODER date angeben/);
    });

    it("rejects when neither dayOfWeek nor date is set (400)", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/employees/${data.employee.id}/availability`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          entries: [
            {
              status: "AVAILABLE",
              validFrom: "2026-01-01",
            },
          ],
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.message).toMatch(/Entweder dayOfWeek ODER date angeben/);
    });

    it("rejects when validUntil < validFrom (400)", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/employees/${data.employee.id}/availability`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          entries: [
            {
              dayOfWeek: 1,
              status: "AVAILABLE",
              validFrom: "2026-06-30",
              validUntil: "2026-06-01",
            },
          ],
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.message).toMatch(/validUntil muss nach validFrom/);
    });

    it("rejects when note > 200 chars (400)", async () => {
      const longNote = "x".repeat(201);
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/employees/${data.employee.id}/availability`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          entries: [
            {
              dayOfWeek: 1,
              status: "AVAILABLE",
              note: longNote,
              validFrom: "2026-01-01",
            },
          ],
        },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ── Audit logging ──────────────────────────────────────────────────────────

  describe("Audit logging", () => {
    it("PUT writes ONE audit entry with REPLACE action + old/new entries", async () => {
      // Get a clean MA for this test to isolate audit-log query
      const empPasswordHash = await bcrypt.hash("test1234", 10);
      const emp2User = await app.prisma.user.create({
        data: {
          email: `emp2-audit-${Date.now()}@test.de`,
          passwordHash: empPasswordHash,
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const emp2 = await app.prisma.employee.create({
        data: {
          tenantId: data.tenant.id,
          userId: emp2User.id,
          employeeNumber: `E2-AUD-${Date.now()}`,
          firstName: "Audit",
          lastName: "Test",
          hireDate: new Date("2024-01-01"),
        },
      });
      await app.prisma.overtimeAccount.create({
        data: { employeeId: emp2.id, balanceHours: 0 },
      });

      // Pre-state: empty
      // First PUT: 2 entries
      await app.inject({
        method: "PUT",
        url: `/api/v1/employees/${emp2.id}/availability`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          entries: [
            { dayOfWeek: 0, status: "AVAILABLE", validFrom: "2026-01-01" },
            { dayOfWeek: 1, status: "PREFERRED", validFrom: "2026-01-01" },
          ],
        },
      });

      // Second PUT: 1 entry (REPLACE)
      await app.inject({
        method: "PUT",
        url: `/api/v1/employees/${emp2.id}/availability`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          entries: [{ dayOfWeek: 6, status: "UNAVAILABLE", validFrom: "2026-01-01" }],
        },
      });

      // Get latest audit entry for this MA
      const audit = await app.prisma.auditLog.findFirst({
        where: {
          entity: "EmployeeAvailability",
          entityId: emp2.id,
          action: "REPLACE",
        },
        orderBy: { createdAt: "desc" },
      });
      expect(audit).not.toBeNull();
      expect(audit!.action).toBe("REPLACE");
      expect(audit!.entity).toBe("EmployeeAvailability");
      expect(audit!.entityId).toBe(emp2.id);
      const oldValue = audit!.oldValue as { entries: unknown[] };
      const newValue = audit!.newValue as { entries: unknown[] };
      expect(Array.isArray(oldValue.entries)).toBe(true);
      expect(Array.isArray(newValue.entries)).toBe(true);
      expect(oldValue.entries).toHaveLength(2); // pre-state of second PUT
      expect(newValue.entries).toHaveLength(1);
    });
  });

  // ── /me/availability shortcut ──────────────────────────────────────────────

  describe("/me/availability shortcut", () => {
    it("GET /me/availability returns JWT-resolved entries", async () => {
      // First seed via PUT /me/availability
      const seedRes = await app.inject({
        method: "PUT",
        url: `/api/v1/me/availability`,
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {
          entries: [{ dayOfWeek: 3, status: "PREFERRED", validFrom: "2026-01-01" }],
        },
      });
      expect(seedRes.statusCode).toBe(200);

      // GET /me/availability
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/me/availability`,
        headers: { authorization: `Bearer ${data.empToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0].dayOfWeek).toBe(3);
      expect(body.entries[0].status).toBe("PREFERRED");
    });

    it("PUT /me/availability replaces own entries + writes audit log", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/me/availability`,
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {
          entries: [
            {
              date: "2026-07-04",
              status: "UNAVAILABLE",
              note: "Geburtstag",
              validFrom: "2026-07-04",
              validUntil: "2026-07-04",
            },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0].date).toBe("2026-07-04");

      // Audit log was written
      const audit = await app.prisma.auditLog.findFirst({
        where: {
          entity: "EmployeeAvailability",
          entityId: data.employee.id,
          action: "REPLACE",
        },
        orderBy: { createdAt: "desc" },
      });
      expect(audit).not.toBeNull();
      expect(audit!.userId).toBe(data.empUser.id);
    });
  });
});
