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

    it("hides DSGVO-anonymized employees by default, surfaces them with ?includeAnonymized=true", async () => {
      const uid = `anon-list-${Date.now().toString(36)}`;
      const user = await app.prisma.user.create({
        data: {
          email: `deleted-${uid}@anonymized.local`,
          passwordHash: "ANONYMIZED",
          role: "EMPLOYEE",
          isActive: false,
        },
      });
      const anon = await app.prisma.employee.create({
        data: {
          tenantId: data.tenant.id,
          userId: user.id,
          firstName: "Gelöscht",
          lastName: `GELÖSCHT-${uid}`,
          employeeNumber: `GELÖSCHT-${uid}`,
          hireDate: new Date("2024-01-01"),
        },
      });

      try {
        // Default: anonymized row is excluded.
        const defaultRes = await app.inject({
          method: "GET",
          url: "/api/v1/employees",
          headers: { authorization: `Bearer ${data.adminToken}` },
        });
        expect(defaultRes.statusCode).toBe(200);
        const defaultIds = (JSON.parse(defaultRes.body) as Array<{ id: string }>).map((e) => e.id);
        expect(defaultIds).not.toContain(anon.id);

        // ADMIN opt-in: anonymized row IS returned.
        const inclRes = await app.inject({
          method: "GET",
          url: "/api/v1/employees?includeAnonymized=true",
          headers: { authorization: `Bearer ${data.adminToken}` },
        });
        expect(inclRes.statusCode).toBe(200);
        const inclIds = (JSON.parse(inclRes.body) as Array<{ id: string }>).map((e) => e.id);
        expect(inclIds).toContain(anon.id);
      } finally {
        await app.prisma.employee.delete({ where: { id: anon.id } });
        await app.prisma.user.delete({ where: { id: user.id } });
      }
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

  // ── Personalstruktur (Phase 41) ─────────────────────────────────────────
  describe("POST/PATCH Personalstruktur fields (Phase 41)", () => {
    it("POST accepts classification + coverageWeight + requiresSupervision and persists them", async () => {
      const puid = `ps-c-${Date.now().toString(36)}`;
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/employees",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          email: `${puid}@test.de`,
          firstName: "Pers",
          lastName: "Struktur",
          employeeNumber: `PS-${puid}`,
          hireDate: new Date("2026-01-01").toISOString(),
          role: "EMPLOYEE",
          weeklyHours: 40,
          password: "Test@1234567!",
          classification: "MINIJOB",
          coverageWeight: 0.5,
          requiresSupervision: false,
        },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.classification).toBe("MINIJOB");
      expect(Number(body.coverageWeight)).toBe(0.5);
      expect(body.requiresSupervision).toBe(false);
    });

    it("POST without Personalstruktur fields falls back to schema defaults (VOLLZEIT / 1.00 / false)", async () => {
      const puid = `ps-d-${Date.now().toString(36)}`;
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/employees",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          email: `${puid}@test.de`,
          firstName: "Def",
          lastName: "Vollzeit",
          employeeNumber: `PSD-${puid}`,
          hireDate: new Date("2026-01-01").toISOString(),
          role: "EMPLOYEE",
          weeklyHours: 40,
          password: "Test@1234567!",
        },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.classification).toBe("VOLLZEIT");
      expect(Number(body.coverageWeight)).toBe(1.0);
      expect(body.requiresSupervision).toBe(false);
    });

    it("PATCH updates Personalstruktur fields and the AuditLog records the change", async () => {
      // Create a baseline employee
      const puid = `ps-u-${Date.now().toString(36)}`;
      const create = await app.inject({
        method: "POST",
        url: "/api/v1/employees",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          email: `${puid}@test.de`,
          firstName: "Patch",
          lastName: "Test",
          employeeNumber: `PSU-${puid}`,
          hireDate: new Date("2026-01-01").toISOString(),
          role: "EMPLOYEE",
          weeklyHours: 40,
          password: "Test@1234567!",
        },
      });
      const { id } = JSON.parse(create.body);

      // PATCH to AZUBI defaults
      const patch = await app.inject({
        method: "PATCH",
        url: `/api/v1/employees/${id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          classification: "AZUBI",
          coverageWeight: 0.0,
          requiresSupervision: true,
        },
      });
      expect(patch.statusCode).toBe(200);
      const patched = JSON.parse(patch.body);
      expect(patched.classification).toBe("AZUBI");
      expect(Number(patched.coverageWeight)).toBe(0);
      expect(patched.requiresSupervision).toBe(true);

      // AuditLog entry must contain the new Personalstruktur values
      const log = await app.prisma.auditLog.findFirst({
        where: { entity: "Employee", entityId: id, action: "UPDATE" },
        orderBy: { createdAt: "desc" },
      });
      expect(log).not.toBeNull();
      const newVal = log!.newValue as Record<string, unknown>;
      expect(newVal.classification).toBe("AZUBI");
      // coverageWeight is stringified Decimal in the audit log
      expect(String(newVal.coverageWeight)).toBe("0");
      expect(newVal.requiresSupervision).toBe(true);

      // oldValue must capture the prior (VOLLZEIT default) state
      const oldVal = log!.oldValue as Record<string, unknown>;
      expect(oldVal.classification).toBe("VOLLZEIT");
      expect(String(oldVal.coverageWeight)).toBe("1");
      expect(oldVal.requiresSupervision).toBe(false);
    });

    it("POST rejects an invalid classification (Zod enum guard)", async () => {
      const puid = `ps-x-${Date.now().toString(36)}`;
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/employees",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          email: `${puid}@test.de`,
          firstName: "Bad",
          lastName: "Class",
          employeeNumber: `PSX-${puid}`,
          hireDate: new Date("2026-01-01").toISOString(),
          role: "EMPLOYEE",
          weeklyHours: 40,
          password: "Test@1234567!",
          classification: "BOGUS_VALUE",
        },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    });

    it("POST rejects coverageWeight outside [0, 9.99]", async () => {
      const puid = `ps-r-${Date.now().toString(36)}`;
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/employees",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          email: `${puid}@test.de`,
          firstName: "Bad",
          lastName: "Range",
          employeeNumber: `PSR-${puid}`,
          hireDate: new Date("2026-01-01").toISOString(),
          role: "EMPLOYEE",
          weeklyHours: 40,
          password: "Test@1234567!",
          coverageWeight: 99,
        },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
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

    it("Test 1 — without forceDelete, returns 409 inside retention window (blocked by floor for recent employee)", async () => {
      // Recent employee (no exitDate → retentionStart = createdAt) hits the 2-year floor first
      const { emp } = await createAnonymizedEmployee("t1");

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/employees/${emp.id}/hard-delete`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      // Recent employees hit the §16 ArbZG floor first; older ones hit the retention window.
      // Either floorExpiresAt or retentionExpiresAt proves deletion is blocked.
      const expiryField = body.floorExpiresAt ?? body.retentionExpiresAt;
      expect(expiryField).toBeDefined();
      expect(new Date(expiryField).getTime()).toBeGreaterThan(Date.now());

      // Cleanup — employee still exists, clean via prisma
      await app.prisma.overtimeAccount.deleteMany({ where: { employeeId: emp.id } });
      await app.prisma.employee.deleteMany({ where: { id: emp.id } });
      await app.prisma.user.deleteMany({ where: { id: emp.userId } });
    });

    it("Test 2 — forceDelete: true is still blocked by §16 ArbZG 2-year floor (recently created employee)", async () => {
      // createAnonymizedEmployee uses hireDate=2024-01-01 but no exitDate, so retentionStart = createdAt (recent)
      // The 2-year floor = Dec 31 of (createdAt.year + 2) — always in the future for recently created employees
      const { emp, user } = await createAnonymizedEmployee("t2");

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/employees/${emp.id}/hard-delete`,
        headers: {
          authorization: `Bearer ${data.adminToken}`,
          "content-type": "application/json",
        },
        payload: { forceDelete: true },
      });

      // Cleanup — employee not deleted (blocked by floor)
      await app.prisma.overtimeAccount.deleteMany({ where: { employeeId: emp.id } });
      await app.prisma.employee.deleteMany({ where: { id: emp.id } });
      await app.prisma.user.deleteMany({ where: { id: user.id } });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      // Must be blocked by the ArbZG floor, not just the retention window
      expect(body.error).toContain("§ 16 Abs. 2 ArbZG");
      expect(body.floorExpiresAt).toBeDefined();
    });

    it("Test 3 — forceDelete inside floor: no HARD_DELETE audit entry is written (floor check is pre-audit)", async () => {
      // The floor check runs before the audit log write, so a blocked attempt must leave no trace
      const { emp, user } = await createAnonymizedEmployee("t3");

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

      // Cleanup — employee still exists (blocked)
      await app.prisma.overtimeAccount.deleteMany({ where: { employeeId: emp.id } });
      await app.prisma.employee.deleteMany({ where: { id: emp.id } });
      await app.prisma.user.deleteMany({ where: { id: user.id } });

      expect(log).toBeNull(); // No audit entry for a pre-audit blocked attempt
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

  // ── retention: config-driven years + §16 ArbZG 2-year floor + 4-eyes ──────
  describe("retention", () => {
    let admin2Token: string;
    let admin2UserId: string;
    let admin2EmployeeId: string;

    // Creates an anonymized employee with a specific exitDate (controls retentionStart)
    async function makeAnonymizedEmployee(exitDate: Date) {
      const uid = `ret-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
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
          hireDate: exitDate,
          exitDate,
        },
      });
      await app.prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });
      return { emp, user };
    }

    beforeAll(async () => {
      const uid = `ret-a2-${Date.now().toString(36)}`;
      const pwHash = await bcrypt.hash("test-admin2-pw", 10);
      const a2User = await app.prisma.user.create({
        data: {
          email: `admin2-${uid}@test.de`,
          passwordHash: pwHash,
          role: "ADMIN",
          isActive: true,
        },
      });
      admin2UserId = a2User.id;
      const a2Emp = await app.prisma.employee.create({
        data: {
          tenantId: data.tenant.id,
          userId: a2User.id,
          firstName: "Admin2",
          lastName: "Test",
          employeeNumber: `A2-${uid}`,
          hireDate: new Date("2024-01-01"),
        },
      });
      admin2EmployeeId = a2Emp.id;
      await app.prisma.overtimeAccount.create({ data: { employeeId: a2Emp.id, balanceHours: 0 } });
      const loginRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: `admin2-${uid}@test.de`, password: "test-admin2-pw" },
      });
      admin2Token = JSON.parse(loginRes.body).accessToken;
      void admin2EmployeeId;
    });

    it("retention — years from tenant config (6y config: employee who exited 7y ago can be hard-deleted without forceDelete)", async () => {
      // Set tenant dataRetentionYears = 6 (overrides hardcoded default of 10)
      await app.prisma.tenantConfig.update({
        where: { tenantId: data.tenant.id },
        data: { dataRetentionYears: 6 },
      });

      // Employee who exited 7 years ago — past both 2y floor and 6y config retention
      const exitDate = new Date();
      exitDate.setFullYear(exitDate.getFullYear() - 7);
      const { emp } = await makeAnonymizedEmployee(exitDate);

      let statusCode: number;
      try {
        const res = await app.inject({
          method: "DELETE",
          url: `/api/v1/employees/${emp.id}/hard-delete`,
          headers: { authorization: `Bearer ${data.adminToken}` },
        });
        statusCode = res.statusCode;
      } finally {
        await app.prisma.tenantConfig.update({
          where: { tenantId: data.tenant.id },
          data: { dataRetentionYears: 10 },
        });
      }

      // With 6y config the 7y-old employee is past retention → 204 (employee deleted)
      expect(statusCode!).toBe(204);
      const found = await app.prisma.employee.findUnique({ where: { id: emp.id } });
      expect(found).toBeNull();
    });

    it("retention — forceDelete below 2y floor blocked even with forceDelete=true", async () => {
      // Employee who exited 1 year ago — inside the §16 ArbZG 2-year mandatory floor
      const exitDate = new Date();
      exitDate.setFullYear(exitDate.getFullYear() - 1);
      const { emp, user } = await makeAnonymizedEmployee(exitDate);

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/employees/${emp.id}/hard-delete`,
        headers: { authorization: `Bearer ${data.adminToken}`, "content-type": "application/json" },
        payload: { forceDelete: true },
      });

      // Cleanup — employee may still exist (blocked) or be gone (if floor check missing); use deleteMany
      await app.prisma.overtimeAccount.deleteMany({ where: { employeeId: emp.id } });
      await app.prisma.employee.deleteMany({ where: { id: emp.id } });
      await app.prisma.user.deleteMany({ where: { id: user.id } });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.error).toContain("§ 16 Abs. 2 ArbZG");
    });

    it("retention — force-delete in window needs 4-eyes: forceDelete=true without prior authorization → 409", async () => {
      // exitDate 3 years ago: past 2y floor (Dec 31, 2023+2=2025 < 2026) but inside 10y retention
      const exitDate = new Date();
      exitDate.setFullYear(exitDate.getFullYear() - 3);
      const { emp, user } = await makeAnonymizedEmployee(exitDate);

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/employees/${emp.id}/hard-delete`,
        headers: { authorization: `Bearer ${data.adminToken}`, "content-type": "application/json" },
        payload: { forceDelete: true },
      });

      // Cleanup — employee still exists (no valid 4-eyes auth)
      await app.prisma.overtimeAccount.deleteMany({ where: { employeeId: emp.id } });
      await app.prisma.employee.deleteMany({ where: { id: emp.id } });
      await app.prisma.user.deleteMany({ where: { id: user.id } });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.error).toContain("4-Augen-Prinzip");
    });

    it("retention — self-authorize rejected: same admin who authorized cannot force-delete", async () => {
      const exitDate = new Date();
      exitDate.setFullYear(exitDate.getFullYear() - 3);
      const { emp, user } = await makeAnonymizedEmployee(exitDate);

      // Admin1 authorizes
      const authRes = await app.inject({
        method: "POST",
        url: `/api/v1/employees/${emp.id}/hard-delete/authorize`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      // Admin1 tries to force-delete using their own authorization → must be rejected
      const delRes = await app.inject({
        method: "DELETE",
        url: `/api/v1/employees/${emp.id}/hard-delete`,
        headers: { authorization: `Bearer ${data.adminToken}`, "content-type": "application/json" },
        payload: { forceDelete: true },
      });

      // Cleanup — employee still exists (self-auth rejected)
      await app.prisma.overtimeAccount.deleteMany({ where: { employeeId: emp.id } });
      await app.prisma.employee.deleteMany({ where: { id: emp.id } });
      await app.prisma.user.deleteMany({ where: { id: user.id } });

      expect(authRes.statusCode).toBe(200);
      expect(delRes.statusCode).toBe(409);
      const body = JSON.parse(delRes.body);
      expect(body.error).toContain("4-Augen-Prinzip");
    });

    it("retention — different admin authorization allows force-delete inside retention window", async () => {
      const exitDate = new Date();
      exitDate.setFullYear(exitDate.getFullYear() - 3);
      const { emp } = await makeAnonymizedEmployee(exitDate);

      // Admin2 (different admin) authorizes
      const authRes = await app.inject({
        method: "POST",
        url: `/api/v1/employees/${emp.id}/hard-delete/authorize`,
        headers: { authorization: `Bearer ${admin2Token}` },
      });

      // Admin1 force-deletes using Admin2's authorization → should succeed
      const delRes = await app.inject({
        method: "DELETE",
        url: `/api/v1/employees/${emp.id}/hard-delete`,
        headers: { authorization: `Bearer ${data.adminToken}`, "content-type": "application/json" },
        payload: { forceDelete: true },
      });

      expect(authRes.statusCode).toBe(200);
      const authBody = JSON.parse(authRes.body);
      expect(authBody.authorized).toBe(true);
      expect(authBody.expiresAt).toBeDefined();

      expect(delRes.statusCode).toBe(204);
      const found = await app.prisma.employee.findUnique({ where: { id: emp.id } });
      expect(found).toBeNull();
    });
  });
});
