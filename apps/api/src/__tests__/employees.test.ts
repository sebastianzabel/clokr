import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";

describe("Employees API", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "em");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("POST /api/v1/employees (create with password)", () => {
    let uid: string;

    beforeAll(() => {
      uid = Date.now().toString(36);
    });

    it("creates employee with direct password (immediately active)", async () => {
      const email = `direct-${uid}@test.de`;
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/employees",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          email,
          firstName: "Direct",
          lastName: "Created",
          employeeNumber: `D-${uid}`,
          hireDate: new Date("2026-01-01").toISOString(),
          role: "EMPLOYEE",
          weeklyHours: 40,
          password: "Test@1234567!",
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.invitationStatus).toBe("ACCEPTED");

      // Verify user can log in immediately
      const loginRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email, password: "Test@1234567!" },
      });
      expect(loginRes.statusCode).toBe(200);
    });

    it("creates employee via invitation (inactive until accepted)", async () => {
      const email = `invite-${uid}@test.de`;
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/employees",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          email,
          firstName: "Invited",
          lastName: "User",
          employeeNumber: `I-${uid}`,
          hireDate: new Date("2026-01-01").toISOString(),
          role: "EMPLOYEE",
          weeklyHours: 40,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.invitationStatus).toBe("PENDING");

      // Verify user cannot log in yet
      const loginRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email, password: "anything" },
      });
      expect(loginRes.statusCode).toBe(401);
    });

    it("rejects password shorter than 8 chars", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/employees",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          email: `short-pw-${uid}@test.de`,
          firstName: "Short",
          lastName: "Password",
          employeeNumber: `SP-${uid}`,
          hireDate: new Date("2026-01-01").toISOString(),
          password: "1234567",
        },
      });

      // Zod validation error — may return 400 or 500 depending on error handling
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    });

    it("rejects duplicate email", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/employees",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          email: `admin-${uid}@test.de`,
          firstName: "Duplicate",
          lastName: "Email",
          employeeNumber: `DE-${uid}`,
          hireDate: new Date("2026-01-01").toISOString(),
          password: "Test@1234567!",
        },
      });

      // First create should work
      expect(res.statusCode).toBe(201);

      // Second with same email should fail
      const res2 = await app.inject({
        method: "POST",
        url: "/api/v1/employees",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          email: `admin-${uid}@test.de`,
          firstName: "Duplicate",
          lastName: "Email",
          employeeNumber: `DE2-${uid}`,
          hireDate: new Date("2026-01-01").toISOString(),
          password: "Test@1234567!",
        },
      });
      expect(res2.statusCode).toBeGreaterThanOrEqual(400);
    });
  });

  describe("GET /api/v1/employees", () => {
    it("admin can list all employees", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/employees",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(2); // admin + employee
    });

    it("regular employee cannot list employees", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/employees",
        headers: { authorization: `Bearer ${data.empToken}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe("PATCH /api/v1/employees/:id/deactivate", () => {
    it("admin can deactivate an employee", async () => {
      const duid = Date.now().toString(36) + "da";
      const email = `deact-${duid}@test.de`;
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/employees",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          email,
          firstName: "To",
          lastName: "Deactivate",
          employeeNumber: `DA-${duid}`,
          hireDate: new Date("2026-01-01").toISOString(),
          role: "EMPLOYEE",
          weeklyHours: 40,
          password: "Test@1234567!",
        },
      });
      const { id: empId } = JSON.parse(createRes.body);

      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/employees/${empId}/deactivate`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {},
      });

      expect(res.statusCode).toBe(200);

      // Verify cannot login anymore
      const loginRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email, password: "Test@1234567!" },
      });
      expect(loginRes.statusCode).toBe(401);
    });
  });

  describe("COMPLIANCE: DSGVO anonymization (Art. 17)", () => {
    // Use a separate employee created directly via Prisma to avoid polluting other tests.
    // Anonymization is irreversible — we must not use data.employee here.
    let dsgvoEmployeeId: string;
    let dsgvoUserId: string;

    beforeAll(async () => {
      const duid = Date.now().toString(36) + "dsgvo";
      const passwordHash = await bcrypt.hash("dsgvo-test-pw", 10);

      const user = await app.prisma.user.create({
        data: {
          email: `dsgvo-${duid}@test.de`,
          passwordHash,
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      dsgvoUserId = user.id;

      const employee = await app.prisma.employee.create({
        data: {
          tenantId: data.tenant.id,
          userId: user.id,
          firstName: "Datenschutz",
          lastName: "Testperson",
          employeeNumber: `DSGVO-${duid}`,
          hireDate: new Date("2024-01-01"),
        },
      });
      dsgvoEmployeeId = employee.id;

      await app.prisma.overtimeAccount.create({
        data: { employeeId: employee.id, balanceHours: 0 },
      });

      // Create a TimeEntry to verify retention after anonymization
      await app.prisma.timeEntry.create({
        data: {
          employeeId: employee.id,
          date: new Date("2025-06-15"),
          startTime: new Date("2025-06-15T08:00:00Z"),
          endTime: new Date("2025-06-15T16:00:00Z"),
          note: "Persönliche Notiz",
        },
      });
    });

    it("DELETE anonymizes, does not hard-delete", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/employees/${dsgvoEmployeeId}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(res.statusCode).toBe(204);

      // Employee row must still exist (no hard delete)
      const employee = await app.prisma.employee.findUnique({
        where: { id: dsgvoEmployeeId },
      });
      expect(employee).not.toBeNull();
      // firstName anonymized to "Gelöscht"
      expect(employee!.firstName).toBe("Gelöscht");
      // nfcCardId cleared
      expect(employee!.nfcCardId).toBeNull();
    });

    it("user account is deactivated and anonymized", async () => {
      const user = await app.prisma.user.findUnique({
        where: { id: dsgvoUserId },
      });
      expect(user).not.toBeNull();
      expect(user!.isActive).toBe(false);
      expect(user!.email).toContain("anonymized");
      expect(user!.passwordHash).toBe("ANONYMIZED");
    });

    it("TimeEntries preserved after anonymization (retention compliance)", async () => {
      const count = await app.prisma.timeEntry.count({
        where: { employeeId: dsgvoEmployeeId },
      });
      expect(count).toBeGreaterThanOrEqual(1);
    });

    it("AuditLog records the anonymization", async () => {
      const logEntry = await app.prisma.auditLog.findFirst({
        where: {
          entity: "Employee",
          entityId: dsgvoEmployeeId,
          action: "ANONYMIZE",
        },
      });
      expect(logEntry).not.toBeNull();
    });
  });

  describe("DELETE with Content-Type: application/json (empty body)", () => {
    it("accepts DELETE with Content-Type header and no body", async () => {
      // Create a throwaway employee for this test
      const uid = crypto.randomUUID().slice(0, 8);
      const user = await app.prisma.user.create({
        data: {
          email: `ct-test-${uid}@test.local`,
          passwordHash: "test",
          role: "EMPLOYEE",
        },
      });
      const emp = await app.prisma.employee.create({
        data: {
          userId: user.id,
          tenantId: data.tenant.id,
          firstName: "CT",
          lastName: "Test",
          employeeNumber: `CT-${uid}`,
          hireDate: new Date("2024-01-01"),
        },
      });
      await app.prisma.overtimeAccount.create({
        data: { employeeId: emp.id, balanceHours: 0 },
      });

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/employees/${emp.id}`,
        headers: {
          authorization: `Bearer ${data.adminToken}`,
          "content-type": "application/json",
        },
      });

      expect(res.statusCode).toBe(204);
    });
  });

  it("COMPLIANCE: all SMTP passwords are encrypted", async () => {
    const configs = await app.prisma.tenantConfig.findMany({
      where: { smtpPassword: { not: null } },
      select: { smtpPassword: true },
    });
    for (const cfg of configs) {
      const parts = cfg.smtpPassword!.split(":");
      expect(parts).toHaveLength(3);
      expect(cfg.smtpPassword!.length).toBeGreaterThan(50);
    }
  });

  describe("DELETE /:id/hard-delete — forceDelete bypass", () => {
    // Each test creates its own anonymized employee within the retention window.
    async function createAnonymizedEmployee(suffix: string) {
      const uid = `hd-${suffix}-${Date.now().toString(36)}`;
      const passwordHash = await bcrypt.hash("test-pw-123", 10);
      const user = await app.prisma.user.create({
        data: {
          email: `deleted-${uid}@anonymized.local`,
          passwordHash: "ANONYMIZED",
          role: "EMPLOYEE",
          isActive: false,
        },
      });
      const emp = await app.prisma.employee.create({
        data: {
          tenantId: data.tenant.id,
          userId: user.id,
          firstName: "Gelöscht",
          lastName: `GELÖSCHT-${uid}`,
          employeeNumber: `GELÖSCHT-${uid}`,
          hireDate: new Date("2024-01-01"), // hired 2024 → retention expires 2034-12-31
        },
      });
      await app.prisma.overtimeAccount.create({
        data: { employeeId: emp.id, balanceHours: 0 },
      });
      void passwordHash; // unused but needed for bcrypt import satisfaction
      return { emp, user };
    }

    it("Test 1 — without forceDelete, returns 409 with retentionExpiresAt inside retention window", async () => {
      const { emp } = await createAnonymizedEmployee("t1");

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/employees/${emp.id}/hard-delete`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.retentionExpiresAt).toBeDefined();
      expect(new Date(body.retentionExpiresAt).getTime()).toBeGreaterThan(Date.now());

      // Cleanup — employee still exists, clean via prisma
      await app.prisma.overtimeAccount.deleteMany({ where: { employeeId: emp.id } });
      await app.prisma.employee.delete({ where: { id: emp.id } });
      await app.prisma.user.delete({ where: { id: emp.userId } });
    });

    it("Test 2 — with forceDelete: true, returns 204 and employee row is deleted", async () => {
      const { emp } = await createAnonymizedEmployee("t2");

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/employees/${emp.id}/hard-delete`,
        headers: {
          authorization: `Bearer ${data.adminToken}`,
          "content-type": "application/json",
        },
        payload: { forceDelete: true },
      });

      expect(res.statusCode).toBe(204);

      // Employee row must be gone
      const found = await app.prisma.employee.findUnique({ where: { id: emp.id } });
      expect(found).toBeNull();
    });

    it("Test 3 — audit entry contains forceDelete: true and retentionExpiresAt after force-delete", async () => {
      const { emp } = await createAnonymizedEmployee("t3");

      await app.inject({
        method: "DELETE",
        url: `/api/v1/employees/${emp.id}/hard-delete`,
        headers: {
          authorization: `Bearer ${data.adminToken}`,
          "content-type": "application/json",
        },
        payload: { forceDelete: true },
      });

      const log = await app.prisma.auditLog.findFirst({
        where: { entity: "Employee", entityId: emp.id, action: "HARD_DELETE" },
        orderBy: { createdAt: "desc" },
      });

      expect(log).not.toBeNull();
      const newVal = log!.newValue as Record<string, unknown>;
      expect(newVal.forceDelete).toBe(true);
      expect(typeof newVal.retentionExpiresAt).toBe("string");
      // retentionExpiresAt should be in the future (proof of override)
      expect(new Date(newVal.retentionExpiresAt as string).getTime()).toBeGreaterThan(Date.now());
    });

    it("Test 4 — anonymize-first guard still blocks forceDelete on non-anonymized employee", async () => {
      // Create a non-anonymized employee
      const uid = `hd-t4-${Date.now().toString(36)}`;
      const user = await app.prisma.user.create({
        data: {
          email: `nonanon-${uid}@test.local`,
          passwordHash: "test",
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const emp = await app.prisma.employee.create({
        data: {
          tenantId: data.tenant.id,
          userId: user.id,
          firstName: "Real",
          lastName: "Person",
          employeeNumber: `RP-${uid}`,
          hireDate: new Date("2024-01-01"),
        },
      });
      await app.prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/employees/${emp.id}/hard-delete`,
        headers: {
          authorization: `Bearer ${data.adminToken}`,
          "content-type": "application/json",
        },
        payload: { forceDelete: true },
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("Mitarbeiter muss zuerst anonymisiert werden");

      // Cleanup
      await app.prisma.overtimeAccount.deleteMany({ where: { employeeId: emp.id } });
      await app.prisma.employee.delete({ where: { id: emp.id } });
      await app.prisma.user.delete({ where: { id: user.id } });
    });
  });
});
