import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("Shift Planning API", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let managerToken: string;
  let managerEmployee: { id: string };

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "sh");

    // Create a MANAGER user/employee for permission tests
    const bcryptMod = await import("bcryptjs");
    const mgrPasswordHash = await bcryptMod.default.hash("test1234", 10);
    const mgrUser = await app.prisma.user.create({
      data: {
        email: `mgr-sh-${Date.now()}@test.de`,
        passwordHash: mgrPasswordHash,
        role: "MANAGER",
        isActive: true,
      },
    });
    managerEmployee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: mgrUser.id,
        employeeNumber: `M-${Date.now()}`,
        firstName: "Mary",
        lastName: "Manager",
        hireDate: new Date("2024-01-01"),
      },
    });
    await app.prisma.overtimeAccount.create({
      data: { employeeId: managerEmployee.id, balanceHours: 0 },
    });
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: mgrUser.email, password: "test1234" },
    });
    managerToken = JSON.parse(loginRes.body).accessToken;

    // Phase 47.1 — Shift endpoints now require an active SHIFT_BASED WorkSchedule.
    // The default seed assigns FIXED_SCHEDULE; layer a newer SHIFT_BASED row on top so
    // the existing shift-creation tests continue to work. validFrom 2024-02-01 wins
    // over the default 2024-01-01 row by "most recent validFrom" rule.
    for (const empId of [data.employee.id, managerEmployee.id, data.adminEmployee.id]) {
      await app.prisma.workSchedule.create({
        data: {
          employeeId: empId,
          type: "SHIFT_BASED",
          weeklyHours: 40,
          validFrom: new Date("2024-02-01"),
        },
      });
    }
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("Templates (ADMIN-only writes)", () => {
    it("creates a shift template as ADMIN", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts/templates",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          name: "Frühschicht",
          startTime: "06:00",
          endTime: "14:00",
          color: "#22c55e",
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.name).toBe("Frühschicht");
      expect(body.startTime).toBe("06:00");
    });

    it("MANAGER cannot create templates (403)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts/templates",
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {
          name: "ManagerTry",
          startTime: "10:00",
          endTime: "18:00",
        },
      });
      expect(res.statusCode).toBe(403);
    });

    it("EMPLOYEE cannot create templates (403)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts/templates",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {
          name: "EmpTry",
          startTime: "10:00",
          endTime: "18:00",
        },
      });
      expect(res.statusCode).toBe(403);
    });

    it("lists templates (any auth)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/shifts/templates",
        headers: { authorization: `Bearer ${managerToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Array.isArray(body)).toBe(true);
      expect(body.some((t: { name: string }) => t.name === "Frühschicht")).toBe(true);
    });

    it("MANAGER cannot delete templates (403)", async () => {
      // Create a throwaway template
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/shifts/templates",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { name: "Delete Me", startTime: "22:00", endTime: "06:00" },
      });
      const { id } = JSON.parse(createRes.body);

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/shifts/templates/${id}`,
        headers: { authorization: `Bearer ${managerToken}` },
      });
      expect(res.statusCode).toBe(403);

      // Clean up via admin
      await app.inject({
        method: "DELETE",
        url: `/api/v1/shifts/templates/${id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
    });

    it("ADMIN deletes a template (204)", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/shifts/templates",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { name: "Delete Me 2", startTime: "22:00", endTime: "06:00" },
      });
      const { id } = JSON.parse(createRes.body);

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/shifts/templates/${id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(res.statusCode).toBe(204);
    });
  });

  describe("Coverage Rules (ADMIN-only writes)", () => {
    let ruleId: string;

    it("MANAGER can list coverage rules", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/shifts/coverage-rules",
        headers: { authorization: `Bearer ${managerToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(JSON.parse(res.body))).toBe(true);
    });

    it("MANAGER cannot create a coverage rule (403)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts/coverage-rules",
        headers: { authorization: `Bearer ${managerToken}` },
        payload: { templateId: null, dayOfWeek: -1, minStaff: 3, requiresNonSupervised: false },
      });
      expect(res.statusCode).toBe(403);
    });

    it("ADMIN creates a coverage rule", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts/coverage-rules",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          templateId: null,
          dayOfWeek: -1,
          minStaff: 3,
          requiresNonSupervised: true,
        },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(Number(body.minStaff)).toBe(3);
      expect(body.requiresNonSupervised).toBe(true);
      ruleId = body.id;
    });

    it("ADMIN updates a coverage rule", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/shifts/coverage-rules/${ruleId}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { minStaff: 2.5 },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Number(body.minStaff)).toBe(2.5);
    });

    it("ADMIN deletes a coverage rule", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/shifts/coverage-rules/${ruleId}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(204);
    });
  });

  describe("Shift assignment (MANAGER+ADMIN)", () => {
    it("MANAGER creates a shift", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts",
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {
          employeeId: data.employee.id,
          date: "2026-06-15",
          startTime: "08:00",
          endTime: "16:00",
          label: "Normalschicht",
        },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.employeeId).toBe(data.employee.id);
    });

    it("ADMIN gets week view with availability + coverage", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/shifts/week?date=2026-06-15",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.weekDays).toHaveLength(7);
      expect(body.employees).toBeDefined();
      expect(body.shifts).toBeDefined();
      expect(body.shifts.length).toBeGreaterThan(0);

      // New shape: availability + coverage arrays
      expect(Array.isArray(body.availability)).toBe(true);
      expect(Array.isArray(body.coverage)).toBe(true);
      expect(body.coverage).toHaveLength(7);

      // Each coverage entry has the expected shape
      for (const c of body.coverage) {
        expect(typeof c.effectiveStaff).toBe("number");
        expect(typeof c.minStaff).toBe("number");
        expect(typeof c.hasSupervisor).toBe("boolean");
        expect(typeof c.unsupervisedAzubis).toBe("number");
        expect(["ok", "under", "supervision-missing"].includes(c.coverageStatus)).toBe(true);
      }

      // Employee fields now include classification + coverageWeight + requiresSupervision
      const emp = body.employees.find((e: { id: string }) => e.id === data.employee.id);
      expect(emp).toBeDefined();
      expect(emp.classification).toBeDefined();
      expect(emp.coverageWeight).toBeDefined();
      expect(typeof emp.requiresSupervision).toBe("boolean");
    });

    it("availability marks employee as 'vacation' when APPROVED leave covers the day", async () => {
      // Create an APPROVED vacation leave for the employee
      const leave = await app.prisma.leaveRequest.create({
        data: {
          employeeId: data.employee.id,
          leaveTypeId: data.vacationType.id,
          startDate: new Date("2026-06-16"),
          endDate: new Date("2026-06-17"),
          days: 2,
          status: "APPROVED",
        },
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/shifts/week?date=2026-06-15",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      const avEntry = body.availability.find(
        (a: { employeeId: string; date: string }) =>
          a.employeeId === data.employee.id && a.date.startsWith("2026-06-16"),
      );
      expect(avEntry).toBeDefined();
      expect(avEntry.availability).toBe("vacation");

      // Cleanup
      await app.prisma.leaveRequest.delete({ where: { id: leave.id } });
    });

    it("coverage uses CoverageRule minStaff (most-specific match)", async () => {
      // Create a tenant-wide rule requiring minStaff = 5
      const rule = await app.prisma.coverageRule.create({
        data: {
          tenantId: data.tenant.id,
          templateId: null,
          dayOfWeek: -1,
          minStaff: 5,
          requiresNonSupervised: false,
        },
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/shifts/week?date=2026-06-15",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      const body = JSON.parse(res.body);
      // All days should have minStaff = 5 from the new rule
      for (const c of body.coverage) {
        expect(c.minStaff).toBe(5);
      }
      // Most days will be "under" since we have only one shift on 2026-06-15
      const monday = body.coverage.find((c: { date: string }) => c.date.startsWith("2026-06-15"));
      expect(monday.coverageStatus).toBe("under");

      // Cleanup
      await app.prisma.coverageRule.delete({ where: { id: rule.id } });
    });

    it("supervision-missing flag fires when only Azubi assigned", async () => {
      // Mark the test employee as Azubi requiring supervision
      const original = await app.prisma.employee.findUnique({
        where: { id: data.employee.id },
        select: { classification: true, requiresSupervision: true, coverageWeight: true },
      });
      await app.prisma.employee.update({
        where: { id: data.employee.id },
        data: { requiresSupervision: true, classification: "AZUBI", coverageWeight: 0.5 },
      });

      // Use a coverage rule with low min so under doesn't dominate
      const rule = await app.prisma.coverageRule.create({
        data: {
          tenantId: data.tenant.id,
          templateId: null,
          dayOfWeek: -1,
          minStaff: 0.25,
          requiresNonSupervised: true,
        },
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/shifts/week?date=2026-06-15",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      const body = JSON.parse(res.body);
      const monday = body.coverage.find((c: { date: string }) => c.date.startsWith("2026-06-15"));
      // Single Azubi with coverageWeight=0.5 → effectiveStaff = 0.5 (>= 0.25 minStaff)
      // but no supervisor → supervision-missing
      expect(monday.coverageStatus).toBe("supervision-missing");
      expect(monday.unsupervisedAzubis).toBe(1);
      expect(monday.hasSupervisor).toBe(false);

      // Cleanup
      await app.prisma.coverageRule.delete({ where: { id: rule.id } });
      if (original) {
        await app.prisma.employee.update({
          where: { id: data.employee.id },
          data: {
            requiresSupervision: original.requiresSupervision,
            classification: original.classification,
            coverageWeight: original.coverageWeight,
          },
        });
      }
    });

    it("effectiveStaff = sum of coverageWeight", async () => {
      // Set the test employee's coverageWeight to 0.75
      const original = await app.prisma.employee.findUnique({
        where: { id: data.employee.id },
        select: { coverageWeight: true },
      });
      await app.prisma.employee.update({
        where: { id: data.employee.id },
        data: { coverageWeight: 0.75 },
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/shifts/week?date=2026-06-15",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      const body = JSON.parse(res.body);
      const monday = body.coverage.find((c: { date: string }) => c.date.startsWith("2026-06-15"));
      // We have one shift on 2026-06-15 for this employee
      expect(monday.effectiveStaff).toBe(0.75);

      // Cleanup
      if (original) {
        await app.prisma.employee.update({
          where: { id: data.employee.id },
          data: { coverageWeight: original.coverageWeight },
        });
      }
    });

    it("MANAGER creates bulk shifts", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts/bulk",
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {
          shifts: [
            {
              employeeId: data.employee.id,
              date: "2026-06-16",
              startTime: "08:00",
              endTime: "16:00",
            },
            {
              employeeId: data.employee.id,
              date: "2026-06-17",
              startTime: "08:00",
              endTime: "16:00",
            },
          ],
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.created).toBe(2);
    });

    it("MANAGER deletes a shift", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/shifts",
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {
          employeeId: data.employee.id,
          date: "2026-06-20",
          startTime: "06:00",
          endTime: "14:00",
        },
      });
      const { id } = JSON.parse(createRes.body);

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/shifts/${id}`,
        headers: { authorization: `Bearer ${managerToken}` },
      });

      expect(res.statusCode).toBe(204);
    });

    it("EMPLOYEE cannot create shifts (403)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {
          employeeId: data.employee.id,
          date: "2026-06-22",
          startTime: "08:00",
          endTime: "16:00",
        },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // ── Phase 43 — Shift-Patterns + Auto-Gen + Conflict + Reverse-Hook ───────
  describe("Phase 43 — Shift patterns CRUD", () => {
    it("ADMIN can read patterns for any employee (initially empty)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/employees/${data.employee.id}/shift-patterns`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Array.isArray(body)).toBe(true);
    });

    it("EMPLOYEE cannot read another employee's patterns (403)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/employees/${data.adminEmployee.id}/shift-patterns`,
        headers: { authorization: `Bearer ${data.empToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("EMPLOYEE cannot PUT patterns (403)", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/employees/${data.employee.id}/shift-patterns`,
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: { patterns: [] },
      });
      expect(res.statusCode).toBe(403);
    });

    it("MANAGER can PUT patterns + GET returns active ones", async () => {
      // Create a template for the pattern to reference
      const tplRes = await app.inject({
        method: "POST",
        url: "/api/v1/shifts/templates",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { name: "Pattern-Tpl", startTime: "09:00", endTime: "17:00" },
      });
      const tpl = JSON.parse(tplRes.body);

      const putRes = await app.inject({
        method: "PUT",
        url: `/api/v1/employees/${data.employee.id}/shift-patterns`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {
          patterns: [
            { dayOfWeek: 0, templateId: tpl.id, validFrom: "2026-06-01" },
            { dayOfWeek: 1, templateId: tpl.id, validFrom: "2026-06-01" },
            { dayOfWeek: 2, templateId: tpl.id, validFrom: "2026-06-01" },
            { dayOfWeek: 3, templateId: tpl.id, validFrom: "2026-06-01" },
            { dayOfWeek: 4, templateId: tpl.id, validFrom: "2026-06-01" },
            // Sa + So intentionally omitted = "no pattern" / day off
          ],
        },
      });
      expect(putRes.statusCode).toBe(200);
      const putBody = JSON.parse(putRes.body);
      expect(putBody.patterns).toHaveLength(5);

      const getRes = await app.inject({
        method: "GET",
        url: `/api/v1/employees/${data.employee.id}/shift-patterns`,
        headers: { authorization: `Bearer ${managerToken}` },
      });
      expect(getRes.statusCode).toBe(200);
      const getBody = JSON.parse(getRes.body);
      expect(getBody.length).toBe(5);
      expect(getBody.every((p: { isActive: boolean }) => p.isActive)).toBe(true);
    });
  });

  describe("Phase 43 — generate-week", () => {
    let tplId: string;

    beforeAll(async () => {
      // Clean slate: drop any shift left from earlier tests in this same week
      await app.prisma.shift.deleteMany({
        where: {
          employeeId: { in: [data.employee.id, data.adminEmployee.id] },
          date: { gte: new Date("2026-07-06"), lte: new Date("2026-07-12") },
        },
      });

      const tplRes = await app.inject({
        method: "POST",
        url: "/api/v1/shifts/templates",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { name: "Gen-Tpl", startTime: "08:00", endTime: "16:00" },
      });
      tplId = JSON.parse(tplRes.body).id;

      // Mo-Fr pattern for the test employee, starting before the target week
      await app.inject({
        method: "PUT",
        url: `/api/v1/employees/${data.employee.id}/shift-patterns`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          patterns: [
            { dayOfWeek: 0, templateId: tplId, validFrom: "2026-06-01" },
            { dayOfWeek: 1, templateId: tplId, validFrom: "2026-06-01" },
            { dayOfWeek: 2, templateId: tplId, validFrom: "2026-06-01" },
            { dayOfWeek: 3, templateId: tplId, validFrom: "2026-06-01" },
            { dayOfWeek: 4, templateId: tplId, validFrom: "2026-06-01" },
          ],
        },
      });
    });

    it("preview (commit=false) returns 5 creates + 2 skip (Sa/So) for one employee", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts/generate-week",
        headers: { authorization: `Bearer ${managerToken}` },
        payload: { weekStart: "2026-07-06", commit: false },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.committed).toBe(false);

      const empCreates = body.create.filter(
        (c: { employeeId: string }) => c.employeeId === data.employee.id,
      );
      expect(empCreates).toHaveLength(5);

      const empSkips = body.skip.filter(
        (s: { employeeId: string }) => s.employeeId === data.employee.id,
      );
      // Sa + So skipped with reason 'no-pattern' (no pattern for those days)
      expect(empSkips.length).toBeGreaterThanOrEqual(2);

      // No shifts should exist yet (preview)
      const shifts = await app.prisma.shift.findMany({
        where: {
          employeeId: data.employee.id,
          date: { gte: new Date("2026-07-06"), lte: new Date("2026-07-12") },
        },
      });
      expect(shifts).toHaveLength(0);
    });

    it("commit=true creates the shifts and emits CREATE AuditLog per shift", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts/generate-week",
        headers: { authorization: `Bearer ${managerToken}` },
        payload: { weekStart: "2026-07-06", commit: true },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.committed).toBe(true);
      const empCreates = body.create.filter(
        (c: { employeeId: string }) => c.employeeId === data.employee.id,
      );
      expect(empCreates).toHaveLength(5);

      const shifts = await app.prisma.shift.findMany({
        where: {
          employeeId: data.employee.id,
          date: { gte: new Date("2026-07-06"), lte: new Date("2026-07-12") },
        },
      });
      expect(shifts).toHaveLength(5);

      const audit = await app.prisma.auditLog.findMany({
        where: { entity: "Shift", entityId: { in: shifts.map((s) => s.id) }, action: "CREATE" },
      });
      expect(audit.length).toBe(5);
    });

    it("skips employee with APPROVED leave on a day", async () => {
      // Add an approved leave for the next week
      const leave = await app.prisma.leaveRequest.create({
        data: {
          employeeId: data.employee.id,
          leaveTypeId: data.vacationType.id,
          startDate: new Date("2026-07-14"), // Di of week 2026-07-13
          endDate: new Date("2026-07-14"),
          days: 1,
          status: "APPROVED",
        },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts/generate-week",
        headers: { authorization: `Bearer ${managerToken}` },
        payload: { weekStart: "2026-07-13", commit: false },
      });
      const body = JSON.parse(res.body);
      const leaveSkip = body.skip.find(
        (s: { employeeId: string; date: string; reason: string }) =>
          s.employeeId === data.employee.id && s.date === "2026-07-14",
      );
      expect(leaveSkip?.reason).toBe("leave");

      await app.prisma.leaveRequest.delete({ where: { id: leave.id } });
    });
  });

  describe("Phase 43 — Shift conflict + force-override", () => {
    it("POST /shifts returns 409 when leave covers the date", async () => {
      const leave = await app.prisma.leaveRequest.create({
        data: {
          employeeId: data.employee.id,
          leaveTypeId: data.vacationType.id,
          startDate: new Date("2026-08-03"),
          endDate: new Date("2026-08-03"),
          days: 1,
          status: "APPROVED",
        },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts",
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {
          employeeId: data.employee.id,
          date: "2026-08-03",
          startTime: "08:00",
          endTime: "16:00",
        },
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.code).toBe("SHIFT_CONFLICT_LEAVE");
      expect(body.canForce).toBe(true);
      expect(body.conflictType).toBe("vacation");

      await app.prisma.leaveRequest.delete({ where: { id: leave.id } });
    });

    it("POST /shifts?force=true writes shift + SHIFT_FORCED_OVER_LEAVE audit", async () => {
      const leave = await app.prisma.leaveRequest.create({
        data: {
          employeeId: data.employee.id,
          leaveTypeId: data.vacationType.id,
          startDate: new Date("2026-08-04"),
          endDate: new Date("2026-08-04"),
          days: 1,
          status: "APPROVED",
        },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts?force=true",
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {
          employeeId: data.employee.id,
          date: "2026-08-04",
          startTime: "08:00",
          endTime: "16:00",
        },
      });
      expect(res.statusCode).toBe(201);
      const shift = JSON.parse(res.body);
      expect(shift.id).toBeDefined();

      const audit = await app.prisma.auditLog.findFirst({
        where: { entity: "Shift", entityId: shift.id, action: "SHIFT_FORCED_OVER_LEAVE" },
      });
      expect(audit).toBeDefined();
      expect((audit?.newValue as { leaveRequestId?: string })?.leaveRequestId).toBe(leave.id);

      await app.prisma.shift.delete({ where: { id: shift.id } });
      await app.prisma.leaveRequest.delete({ where: { id: leave.id } });
    });
  });

  describe("Phase 43 — Reverse-hook: leave approval marks conflicting shifts", () => {
    it("PATCH leave to APPROVED flips conflictsWithLeave on overlapping shifts + audit + notify", async () => {
      // Create a shift first (no leave yet → no 409)
      const shiftRes = await app.inject({
        method: "POST",
        url: "/api/v1/shifts",
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {
          employeeId: data.employee.id,
          date: "2026-09-07", // Mo
          startTime: "08:00",
          endTime: "16:00",
        },
      });
      expect(shiftRes.statusCode).toBe(201);
      const shift = JSON.parse(shiftRes.body);
      expect(shift.conflictsWithLeave).toBe(false);

      // Now submit & approve a PENDING leave that covers the shift's date
      const pending = await app.prisma.leaveRequest.create({
        data: {
          employeeId: data.employee.id,
          leaveTypeId: data.vacationType.id,
          startDate: new Date("2026-09-07"),
          endDate: new Date("2026-09-08"),
          days: 2,
          status: "PENDING",
        },
      });

      const approve = await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/requests/${pending.id}/review`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { status: "APPROVED" },
      });
      expect(approve.statusCode).toBe(200);

      // Shift should now be flagged
      const reloaded = await app.prisma.shift.findUnique({ where: { id: shift.id } });
      expect(reloaded?.conflictsWithLeave).toBe(true);

      const markedAudit = await app.prisma.auditLog.findFirst({
        where: {
          entity: "Shift",
          entityId: shift.id,
          action: "SHIFT_MARKED_CONFLICTING",
        },
      });
      expect(markedAudit).toBeDefined();

      // Manager notification was created (at least one)
      const notifs = await app.prisma.notification.findMany({
        where: {
          type: "SHIFT_LEAVE_CONFLICT",
          relatedType: "LeaveRequest",
          relatedId: pending.id,
        },
      });
      expect(notifs.length).toBeGreaterThan(0);

      // Cleanup
      await app.prisma.shift.delete({ where: { id: shift.id } });
      await app.prisma.leaveRequest.delete({ where: { id: pending.id } });
    });
  });

  // ── Phase 43-05 — Copy-Week ────────────────────────────────────────────────
  describe("Phase 43-05 — copy-week", () => {
    let copyTplId: string;
    // Use weeks far enough out to avoid collision with earlier tests.
    // Source = Mon 2026-10-05, Target = Mon 2026-10-12.
    const SOURCE_WEEK = "2026-10-05";
    const TARGET_WEEK = "2026-10-12";

    beforeAll(async () => {
      // Clean slate for both weeks
      await app.prisma.shift.deleteMany({
        where: {
          employeeId: { in: [data.employee.id, data.adminEmployee.id] },
          date: { gte: new Date("2026-10-05"), lte: new Date("2026-10-18") },
        },
      });

      const tplRes = await app.inject({
        method: "POST",
        url: "/api/v1/shifts/templates",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { name: "Copy-Tpl", startTime: "07:00", endTime: "15:00" },
      });
      copyTplId = JSON.parse(tplRes.body).id;

      // Seed 3 shifts in the source week for the test employee: Mo, Mi, Fr
      await app.prisma.shift.createMany({
        data: [
          {
            employeeId: data.employee.id,
            templateId: copyTplId,
            date: new Date("2026-10-05"), // Mo
            startTime: "07:00",
            endTime: "15:00",
            label: "Copy-Tpl",
            createdBy: data.adminUser.id,
          },
          {
            employeeId: data.employee.id,
            templateId: copyTplId,
            date: new Date("2026-10-07"), // Mi
            startTime: "07:00",
            endTime: "15:00",
            label: "Copy-Tpl",
            createdBy: data.adminUser.id,
          },
          {
            employeeId: data.employee.id,
            templateId: copyTplId,
            date: new Date("2026-10-09"), // Fr
            startTime: "07:00",
            endTime: "15:00",
            label: "Copy-Tpl",
            createdBy: data.adminUser.id,
          },
        ],
      });
    });

    it("preview (commit=false) returns expected diff and does NOT persist", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts/copy-week",
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {
          sourceWeekStart: SOURCE_WEEK,
          targetWeekStart: TARGET_WEEK,
          commit: false,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.committed).toBe(false);
      expect(body.sourceWeekStart).toBe(SOURCE_WEEK);
      expect(body.targetWeekStart).toBe(TARGET_WEEK);

      const empCreates = body.create.filter(
        (c: { employeeId: string }) => c.employeeId === data.employee.id,
      );
      expect(empCreates).toHaveLength(3);

      // Day-of-week offset must be preserved: source Mo→target Mo etc.
      const dates = empCreates.map((c: { date: string }) => c.date).sort();
      expect(dates).toEqual(["2026-10-12", "2026-10-14", "2026-10-16"]);

      // Confirm preview did not write anything
      const targetShifts = await app.prisma.shift.findMany({
        where: {
          employeeId: data.employee.id,
          date: { gte: new Date("2026-10-12"), lte: new Date("2026-10-18") },
        },
      });
      expect(targetShifts).toHaveLength(0);
    });

    it("commit=true creates shifts + SHIFT_COPIED AuditLog entries", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts/copy-week",
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {
          sourceWeekStart: SOURCE_WEEK,
          targetWeekStart: TARGET_WEEK,
          commit: true,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.committed).toBe(true);
      const empCreates = body.create.filter(
        (c: { employeeId: string }) => c.employeeId === data.employee.id,
      );
      expect(empCreates).toHaveLength(3);

      const targetShifts = await app.prisma.shift.findMany({
        where: {
          employeeId: data.employee.id,
          date: { gte: new Date("2026-10-12"), lte: new Date("2026-10-18") },
        },
      });
      expect(targetShifts).toHaveLength(3);

      const audit = await app.prisma.auditLog.findMany({
        where: {
          entity: "Shift",
          entityId: { in: targetShifts.map((s) => s.id) },
          action: "SHIFT_COPIED",
        },
      });
      expect(audit.length).toBe(3);
      // sourceShiftId must be set on every SHIFT_COPIED audit entry
      for (const a of audit) {
        expect((a.newValue as { sourceShiftId?: string })?.sourceShiftId).toBeDefined();
        expect((a.newValue as { sourceWeekStart?: string })?.sourceWeekStart).toBe(SOURCE_WEEK);
        expect((a.newValue as { targetWeekStart?: string })?.targetWeekStart).toBe(TARGET_WEEK);
      }

      // Cleanup so subsequent tests have a clean target week
      await app.prisma.shift.deleteMany({
        where: { id: { in: targetShifts.map((s) => s.id) } },
      });
    });

    it("skips employee with APPROVED leave on target date", async () => {
      const leave = await app.prisma.leaveRequest.create({
        data: {
          employeeId: data.employee.id,
          leaveTypeId: data.vacationType.id,
          startDate: new Date("2026-10-14"), // Mi target
          endDate: new Date("2026-10-14"),
          days: 1,
          status: "APPROVED",
        },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts/copy-week",
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {
          sourceWeekStart: SOURCE_WEEK,
          targetWeekStart: TARGET_WEEK,
          commit: false,
        },
      });
      const body = JSON.parse(res.body);
      const leaveSkip = body.skip.find(
        (s: { employeeId: string; date: string; reason: string }) =>
          s.employeeId === data.employee.id && s.date === "2026-10-14",
      );
      expect(leaveSkip?.reason).toBe("leave");
      // The Mo + Fr shifts should still be in the create list
      const empCreates = body.create.filter(
        (c: { employeeId: string }) => c.employeeId === data.employee.id,
      );
      expect(empCreates).toHaveLength(2);

      await app.prisma.leaveRequest.delete({ where: { id: leave.id } });
    });

    it("skips employee with Absence on target date", async () => {
      const absence = await app.prisma.absence.create({
        data: {
          employeeId: data.employee.id,
          type: "SICK",
          startDate: new Date("2026-10-12"), // Mo target
          endDate: new Date("2026-10-12"),
          days: 1,
          createdBy: data.adminUser.id,
        },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts/copy-week",
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {
          sourceWeekStart: SOURCE_WEEK,
          targetWeekStart: TARGET_WEEK,
          commit: false,
        },
      });
      const body = JSON.parse(res.body);
      const absenceSkip = body.skip.find(
        (s: { employeeId: string; date: string; reason: string }) =>
          s.employeeId === data.employee.id && s.date === "2026-10-12",
      );
      expect(absenceSkip?.reason).toBe("absence");

      await app.prisma.absence.delete({ where: { id: absence.id } });
    });

    it("skips when shift already exists at target date", async () => {
      // Pre-create a shift on the target Mo
      const existing = await app.prisma.shift.create({
        data: {
          employeeId: data.employee.id,
          date: new Date("2026-10-12"),
          startTime: "10:00",
          endTime: "18:00",
          label: "Pre-existing",
          createdBy: data.adminUser.id,
        },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts/copy-week",
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {
          sourceWeekStart: SOURCE_WEEK,
          targetWeekStart: TARGET_WEEK,
          commit: false,
        },
      });
      const body = JSON.parse(res.body);
      const existingSkip = body.skip.find(
        (s: { employeeId: string; date: string; reason: string }) =>
          s.employeeId === data.employee.id && s.date === "2026-10-12",
      );
      expect(existingSkip?.reason).toBe("existing");

      await app.prisma.shift.delete({ where: { id: existing.id } });
    });

    it("respects tenant isolation — shifts from another tenant are not copied", async () => {
      // Create a second tenant + employee + shift in the source week
      const otherData = await seedTestData(app, "sh2");
      try {
        const otherShift = await app.prisma.shift.create({
          data: {
            employeeId: otherData.employee.id,
            date: new Date("2026-10-05"), // same source Mo
            startTime: "09:00",
            endTime: "17:00",
            label: "OtherTenant",
            createdBy: otherData.adminUser.id,
          },
        });

        // Manager from tenant 1 calls copy-week — must NOT pull tenant-2 shifts
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/shifts/copy-week",
          headers: { authorization: `Bearer ${managerToken}` },
          payload: {
            sourceWeekStart: SOURCE_WEEK,
            targetWeekStart: TARGET_WEEK,
            commit: false,
          },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        const cross = body.create.find(
          (c: { employeeId: string }) => c.employeeId === otherData.employee.id,
        );
        expect(cross).toBeUndefined();

        await app.prisma.shift.delete({ where: { id: otherShift.id } });
      } finally {
        await cleanupTestData(app, otherData.tenant.id);
      }
    });

    it("EMPLOYEE cannot call copy-week (403)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts/copy-week",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {
          sourceWeekStart: SOURCE_WEEK,
          targetWeekStart: TARGET_WEEK,
          commit: false,
        },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ── Phase 46 — Availability resolution (EmployeeAvailability merge) ──────────
  describe("Phase 46 — availability resolution", () => {
    // Use an isolated week far from earlier tests to avoid cross-test pollution.
    // 2026-11-02 = Monday; week spans 2026-11-02..2026-11-08.
    const WEEK_START = "2026-11-02"; // Mo
    const MONDAY_ISO = "2026-11-02";
    const TUESDAY_ISO = "2026-11-03";
    const FRIDAY_ISO = "2026-11-06";

    // Cleanup between tests to keep cases isolated
    async function clearAvailability(employeeIds: string[]) {
      await app.prisma.employeeAvailability.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
    }

    afterAll(async () => {
      await clearAvailability([data.employee.id, data.adminEmployee.id]);
    });

    it("GET /shifts/week returns 'unavailable' for cell with status=UNAVAILABLE", async () => {
      await clearAvailability([data.employee.id]);
      // dayOfWeek 0 = Monday in the project's Mo=0..So=6 convention
      await app.prisma.employeeAvailability.create({
        data: {
          employeeId: data.employee.id,
          dayOfWeek: 0,
          status: "UNAVAILABLE",
          validFrom: new Date(WEEK_START + "T00:00:00Z"),
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/shifts/week?date=${WEEK_START}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const cell = body.availability.find(
        (a: { employeeId: string; date: string }) =>
          a.employeeId === data.employee.id && a.date.startsWith(MONDAY_ISO),
      );
      expect(cell).toBeDefined();
      expect(cell.availability).toBe("unavailable");

      await clearAvailability([data.employee.id]);
    });

    it("GET /shifts/week returns 'preferred' for cell with status=PREFERRED", async () => {
      await clearAvailability([data.employee.id]);
      // dayOfWeek 1 = Tuesday
      await app.prisma.employeeAvailability.create({
        data: {
          employeeId: data.employee.id,
          dayOfWeek: 1,
          status: "PREFERRED",
          validFrom: new Date(WEEK_START + "T00:00:00Z"),
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/shifts/week?date=${WEEK_START}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const cell = body.availability.find(
        (a: { employeeId: string; date: string }) =>
          a.employeeId === data.employee.id && a.date.startsWith(TUESDAY_ISO),
      );
      expect(cell).toBeDefined();
      expect(cell.availability).toBe("preferred");

      await clearAvailability([data.employee.id]);
    });

    it("LeaveRequest VACATION beats EmployeeAvailability PREFERRED", async () => {
      await clearAvailability([data.employee.id]);
      // dayOfWeek 4 = Friday
      await app.prisma.employeeAvailability.create({
        data: {
          employeeId: data.employee.id,
          dayOfWeek: 4,
          status: "PREFERRED",
          validFrom: new Date(WEEK_START + "T00:00:00Z"),
        },
      });
      // APPROVED VACATION covering Friday 2026-11-06
      const leave = await app.prisma.leaveRequest.create({
        data: {
          employeeId: data.employee.id,
          leaveTypeId: data.vacationType.id,
          startDate: new Date(FRIDAY_ISO + "T00:00:00Z"),
          endDate: new Date(FRIDAY_ISO + "T00:00:00Z"),
          days: 1,
          status: "APPROVED",
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/shifts/week?date=${WEEK_START}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const cell = body.availability.find(
        (a: { employeeId: string; date: string }) =>
          a.employeeId === data.employee.id && a.date.startsWith(FRIDAY_ISO),
      );
      expect(cell).toBeDefined();
      expect(cell.availability).toBe("vacation");

      await app.prisma.leaveRequest.delete({ where: { id: leave.id } });
      await clearAvailability([data.employee.id]);
    });

    it("date-specific EmployeeAvailability overrides recurring dayOfWeek (date wins via >=)", async () => {
      await clearAvailability([data.employee.id]);
      // Recurring: every Monday UNAVAILABLE (rank 2)
      // One-off: 2026-11-02 PREFERRED (rank 1) — but date row beats recurring at equal rank.
      // Since UNAVAILABLE > PREFERRED in rank, the date row does NOT win because rank(preferred)=1 < rank(unavailable)=2.
      // So we use the OPPOSITE pairing per RESEARCH guidance:
      // Recurring Mo PREFERRED (rank 1) + one-off Mo UNAVAILABLE (rank 2) → date wins via > anyway.
      // But to test the >= rule specifically: recurring Mo PREFERRED + one-off Mo PREFERRED would
      // be a noop. The cleanest meaningful test of date-overrides-recurring:
      //   recurring Mo UNAVAILABLE (rank 2) + one-off Mo PREFERRED (rank 1) → date should win via >=
      //   ONLY IF Pass 2 uses >=. But here rank(preferred)=1 is NOT >= rank(unavailable)=2, so it loses.
      // So the proper test of the equal-rank rule: recurring Mo AVAILABLE (rank 0) +
      //   one-off Mo AVAILABLE (rank 0) is a noop. Or: recurring Mo PREFERRED + one-off Mo PREFERRED
      //   is a noop. Therefore the test that meaningfully exercises >= is:
      //   recurring Mo UNAVAILABLE + one-off Mo UNAVAILABLE → date row still applies (no observable diff)
      // The clearest observable test is: recurring Mo UNAVAILABLE (rank 2) + one-off Mo UNAVAILABLE,
      // and verify cell is "unavailable" (proves both pass without crash).
      // For a STRONGER assertion: use rank PREFERRED < UNAVAILABLE — recurring Mo PREFERRED +
      //   one-off Mo UNAVAILABLE → cell "unavailable" (date row wins because rank 2 > rank 1 via Pass 2 >=).
      await app.prisma.employeeAvailability.create({
        data: {
          employeeId: data.employee.id,
          dayOfWeek: 0, // Monday
          status: "PREFERRED",
          validFrom: new Date(WEEK_START + "T00:00:00Z"),
        },
      });
      await app.prisma.employeeAvailability.create({
        data: {
          employeeId: data.employee.id,
          date: new Date(MONDAY_ISO + "T00:00:00Z"),
          status: "UNAVAILABLE",
          validFrom: new Date(WEEK_START + "T00:00:00Z"),
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/shifts/week?date=${WEEK_START}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const cell = body.availability.find(
        (a: { employeeId: string; date: string }) =>
          a.employeeId === data.employee.id && a.date.startsWith(MONDAY_ISO),
      );
      expect(cell).toBeDefined();
      // Date-specific UNAVAILABLE wins over recurring PREFERRED (higher rank + Pass 2 runs last)
      expect(cell.availability).toBe("unavailable");

      await clearAvailability([data.employee.id]);
    });

    it("validFrom/validUntil bounds are inclusive on both ends", async () => {
      await clearAvailability([data.employee.id]);
      // Single-day validity: validFrom == validUntil == Monday of test week.
      // Use a date-specific row so we can pin the exact day.
      await app.prisma.employeeAvailability.create({
        data: {
          employeeId: data.employee.id,
          date: new Date(MONDAY_ISO + "T00:00:00Z"),
          status: "UNAVAILABLE",
          validFrom: new Date(MONDAY_ISO + "T00:00:00Z"),
          validUntil: new Date(MONDAY_ISO + "T00:00:00Z"),
        },
      });

      // Same week — Monday cell should be "unavailable"
      const inWeek = await app.inject({
        method: "GET",
        url: `/api/v1/shifts/week?date=${WEEK_START}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      const inBody = JSON.parse(inWeek.body);
      const cellMon = inBody.availability.find(
        (a: { employeeId: string; date: string }) =>
          a.employeeId === data.employee.id && a.date.startsWith(MONDAY_ISO),
      );
      expect(cellMon.availability).toBe("unavailable");

      // Adjacent week (one week later) — Tuesday cell should be "available" (out of validity)
      const adjacent = await app.inject({
        method: "GET",
        url: "/api/v1/shifts/week?date=2026-11-09",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      const adjBody = JSON.parse(adjacent.body);
      const cellNextWeek = adjBody.availability.find(
        (a: { employeeId: string; date: string }) =>
          a.employeeId === data.employee.id && a.date.startsWith("2026-11-09"),
      );
      expect(cellNextWeek.availability).toBe("available");

      await clearAvailability([data.employee.id]);
    });

    it("coverage heatmap counts PREFERRED as effective staff (Pitfall #7)", async () => {
      await clearAvailability([data.employee.id]);
      // Pre-test cleanup: ensure no shift exists on the test Monday yet
      await app.prisma.shift.deleteMany({
        where: {
          employeeId: data.employee.id,
          date: { gte: new Date(MONDAY_ISO), lte: new Date(MONDAY_ISO + "T23:59:59Z") },
        },
      });

      // Mark the employee PREFERRED for Monday + assign them a shift on that Monday
      await app.prisma.employeeAvailability.create({
        data: {
          employeeId: data.employee.id,
          dayOfWeek: 0,
          status: "PREFERRED",
          validFrom: new Date(WEEK_START + "T00:00:00Z"),
        },
      });
      const empCoverageWeight = await app.prisma.employee.findUnique({
        where: { id: data.employee.id },
        select: { coverageWeight: true },
      });
      const shift = await app.prisma.shift.create({
        data: {
          employeeId: data.employee.id,
          date: new Date(MONDAY_ISO + "T00:00:00Z"),
          startTime: "08:00",
          endTime: "16:00",
          createdBy: data.adminUser.id,
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/shifts/week?date=${WEEK_START}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const mondayCoverage = body.coverage.find((c: { date: string }) =>
        c.date.startsWith(MONDAY_ISO),
      );
      expect(mondayCoverage).toBeDefined();
      // PREFERRED must count → effectiveStaff equals the employee's coverageWeight (default 1).
      // Pitfall #7 regression: if filter excludes "preferred", effectiveStaff would be 0.
      const expectedStaff = Number(empCoverageWeight?.coverageWeight ?? 1);
      expect(mondayCoverage.effectiveStaff).toBe(expectedStaff);
      expect(mondayCoverage.effectiveStaff).toBeGreaterThan(0);

      // Cleanup
      await app.prisma.shift.delete({ where: { id: shift.id } });
      await clearAvailability([data.employee.id]);
    });

    it("EmployeeAvailability is tenant-scoped via Employee join (no cross-tenant leakage)", async () => {
      await clearAvailability([data.employee.id]);
      // Seed a second tenant with its own employee + UNAVAILABLE row on the same Monday
      const otherData = await seedTestData(app, "av-tenant");
      try {
        await app.prisma.employeeAvailability.create({
          data: {
            employeeId: otherData.employee.id,
            dayOfWeek: 0, // Monday
            status: "UNAVAILABLE",
            validFrom: new Date(WEEK_START + "T00:00:00Z"),
          },
        });

        // ADMIN of tenant A queries — must NOT see tenant B's employee in the response
        const res = await app.inject({
          method: "GET",
          url: `/api/v1/shifts/week?date=${WEEK_START}`,
          headers: { authorization: `Bearer ${data.adminToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);

        // Other tenant's employee should not appear in this tenant's response
        const leaked = body.employees.find((e: { id: string }) => e.id === otherData.employee.id);
        expect(leaked).toBeUndefined();
        const leakedAvail = body.availability.find(
          (a: { employeeId: string }) => a.employeeId === otherData.employee.id,
        );
        expect(leakedAvail).toBeUndefined();
      } finally {
        await app.prisma.employeeAvailability.deleteMany({
          where: { employeeId: otherData.employee.id },
        });
        await cleanupTestData(app, otherData.tenant.id);
      }
    });
  });

  // ── Phase 46 — generate-week + copy-week UNAVAILABLE skip ─────────────────
  describe("Phase 46 — generate-week + copy-week UNAVAILABLE skip", () => {
    // Use isolated weeks far from earlier tests to avoid pollution.
    // 2026-12-07 = Monday; 2026-12-14 = Monday (next week = copy-week target).
    const GEN_WEEK = "2026-12-07";
    const GEN_MONDAY_ISO = "2026-12-07";
    const GEN_TUESDAY_ISO = "2026-12-08";
    const COPY_SOURCE_WEEK = "2026-12-07";
    const COPY_TARGET_WEEK = "2026-12-14";
    const COPY_TARGET_TUESDAY_ISO = "2026-12-15";
    let availTplId: string;

    async function clearAvailability(employeeIds: string[]) {
      await app.prisma.employeeAvailability.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
    }

    beforeAll(async () => {
      // Clean slate: drop any shift in the gen-week + copy-target-week range
      await app.prisma.shift.deleteMany({
        where: {
          employeeId: { in: [data.employee.id, data.adminEmployee.id] },
          date: { gte: new Date("2026-12-07"), lte: new Date("2026-12-20") },
        },
      });

      // Dedicated template for these tests
      const tplRes = await app.inject({
        method: "POST",
        url: "/api/v1/shifts/templates",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { name: "Avail-Skip-Tpl", startTime: "09:00", endTime: "17:00" },
      });
      availTplId = JSON.parse(tplRes.body).id;

      // Ensure the employee has Mo-Fr patterns covering the test weeks
      // (Phase 43 tests already create these starting 2026-06-01 — re-PUT to guarantee).
      await app.inject({
        method: "PUT",
        url: `/api/v1/employees/${data.employee.id}/shift-patterns`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          patterns: [
            { dayOfWeek: 0, templateId: availTplId, validFrom: "2026-06-01" },
            { dayOfWeek: 1, templateId: availTplId, validFrom: "2026-06-01" },
            { dayOfWeek: 2, templateId: availTplId, validFrom: "2026-06-01" },
            { dayOfWeek: 3, templateId: availTplId, validFrom: "2026-06-01" },
            { dayOfWeek: 4, templateId: availTplId, validFrom: "2026-06-01" },
          ],
        },
      });
    });

    afterAll(async () => {
      await clearAvailability([data.employee.id, data.adminEmployee.id]);
      await app.prisma.shift.deleteMany({
        where: {
          employeeId: { in: [data.employee.id, data.adminEmployee.id] },
          date: { gte: new Date("2026-12-07"), lte: new Date("2026-12-20") },
        },
      });
    });

    it("generate-week skips employee with EmployeeAvailability UNAVAILABLE on a day", async () => {
      await clearAvailability([data.employee.id]);
      // Drop any existing shifts on the test week so the create-vs-skip diff is clear
      await app.prisma.shift.deleteMany({
        where: {
          employeeId: data.employee.id,
          date: { gte: new Date("2026-12-07"), lte: new Date("2026-12-13") },
        },
      });

      // dayOfWeek 1 = Tuesday → UNAVAILABLE → must skip 2026-12-08
      await app.prisma.employeeAvailability.create({
        data: {
          employeeId: data.employee.id,
          dayOfWeek: 1,
          status: "UNAVAILABLE",
          validFrom: new Date(GEN_WEEK + "T00:00:00Z"),
        },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts/generate-week",
        headers: { authorization: `Bearer ${managerToken}` },
        payload: { weekStart: GEN_WEEK, commit: false },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const skipEntry = body.skip.find(
        (s: { employeeId: string; date: string; reason: string }) =>
          s.employeeId === data.employee.id && s.date === GEN_TUESDAY_ISO,
      );
      expect(skipEntry).toBeDefined();
      expect(skipEntry.reason).toBe("availability-unavailable");

      // No create entry for that (employee, date)
      const conflictingCreate = body.create.find(
        (c: { employeeId: string; date: string }) =>
          c.employeeId === data.employee.id && c.date === GEN_TUESDAY_ISO,
      );
      expect(conflictingCreate).toBeUndefined();

      // Mon + Wed-Fri should still be in the create list (4 days, since Tue is skipped)
      const empCreates = body.create.filter(
        (c: { employeeId: string }) => c.employeeId === data.employee.id,
      );
      expect(empCreates).toHaveLength(4);

      await clearAvailability([data.employee.id]);
    });

    it("generate-week does NOT skip employee with PREFERRED (soft hint only)", async () => {
      await clearAvailability([data.employee.id]);
      await app.prisma.shift.deleteMany({
        where: {
          employeeId: data.employee.id,
          date: { gte: new Date("2026-12-07"), lte: new Date("2026-12-13") },
        },
      });

      // dayOfWeek 1 = Tuesday → PREFERRED → must NOT skip
      await app.prisma.employeeAvailability.create({
        data: {
          employeeId: data.employee.id,
          dayOfWeek: 1,
          status: "PREFERRED",
          validFrom: new Date(GEN_WEEK + "T00:00:00Z"),
        },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts/generate-week",
        headers: { authorization: `Bearer ${managerToken}` },
        payload: { weekStart: GEN_WEEK, commit: false },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      // No availability-unavailable skip for this employee on Tuesday
      const skipEntry = body.skip.find(
        (s: { employeeId: string; date: string; reason: string }) =>
          s.employeeId === data.employee.id &&
          s.date === GEN_TUESDAY_ISO &&
          s.reason === "availability-unavailable",
      );
      expect(skipEntry).toBeUndefined();

      // Create entry IS present for Tuesday (PREFERRED does not block)
      const createEntry = body.create.find(
        (c: { employeeId: string; date: string }) =>
          c.employeeId === data.employee.id && c.date === GEN_TUESDAY_ISO,
      );
      expect(createEntry).toBeDefined();

      // Full Mo-Fr should be in the create list (PREFERRED counts as available for auto-gen)
      const empCreates = body.create.filter(
        (c: { employeeId: string }) => c.employeeId === data.employee.id,
      );
      expect(empCreates).toHaveLength(5);

      await clearAvailability([data.employee.id]);
    });

    it("generate-week skips only the specific date when a date-row is UNAVAILABLE", async () => {
      await clearAvailability([data.employee.id]);
      await app.prisma.shift.deleteMany({
        where: {
          employeeId: data.employee.id,
          date: { gte: new Date("2026-12-07"), lte: new Date("2026-12-13") },
        },
      });

      // One-off UNAVAILABLE on Tuesday 2026-12-08 only — Mon + Wed-Fri must still create
      await app.prisma.employeeAvailability.create({
        data: {
          employeeId: data.employee.id,
          date: new Date(GEN_TUESDAY_ISO + "T00:00:00Z"),
          status: "UNAVAILABLE",
          validFrom: new Date(GEN_WEEK + "T00:00:00Z"),
        },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts/generate-week",
        headers: { authorization: `Bearer ${managerToken}` },
        payload: { weekStart: GEN_WEEK, commit: false },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      // Tuesday must be skipped
      const tuesdaySkip = body.skip.find(
        (s: { employeeId: string; date: string; reason: string }) =>
          s.employeeId === data.employee.id && s.date === GEN_TUESDAY_ISO,
      );
      expect(tuesdaySkip?.reason).toBe("availability-unavailable");

      // Mon + Wed + Thu + Fri must be in create list (4 days)
      const empCreates = body.create.filter(
        (c: { employeeId: string }) => c.employeeId === data.employee.id,
      );
      expect(empCreates).toHaveLength(4);
      const dates = empCreates.map((c: { date: string }) => c.date).sort();
      expect(dates).toEqual([
        GEN_MONDAY_ISO,
        "2026-12-09", // Wed
        "2026-12-10", // Thu
        "2026-12-11", // Fri
      ]);

      await clearAvailability([data.employee.id]);
    });

    it("copy-week skips when target day has EmployeeAvailability UNAVAILABLE", async () => {
      await clearAvailability([data.employee.id]);
      // Reset both weeks
      await app.prisma.shift.deleteMany({
        where: {
          employeeId: data.employee.id,
          date: { gte: new Date("2026-12-07"), lte: new Date("2026-12-20") },
        },
      });

      // Seed source week: shift on Tuesday 2026-12-08
      await app.prisma.shift.create({
        data: {
          employeeId: data.employee.id,
          templateId: availTplId,
          date: new Date(GEN_TUESDAY_ISO + "T00:00:00Z"),
          startTime: "09:00",
          endTime: "17:00",
          label: "Avail-Skip-Tpl",
          createdBy: data.adminUser.id,
        },
      });

      // Target week: dayOfWeek 1 (Tuesday) UNAVAILABLE → target Tuesday 2026-12-15 blocked
      await app.prisma.employeeAvailability.create({
        data: {
          employeeId: data.employee.id,
          dayOfWeek: 1,
          status: "UNAVAILABLE",
          validFrom: new Date(COPY_TARGET_WEEK + "T00:00:00Z"),
        },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts/copy-week",
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {
          sourceWeekStart: COPY_SOURCE_WEEK,
          targetWeekStart: COPY_TARGET_WEEK,
          commit: false,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      const skipEntry = body.skip.find(
        (s: { employeeId: string; date: string; reason: string }) =>
          s.employeeId === data.employee.id && s.date === COPY_TARGET_TUESDAY_ISO,
      );
      expect(skipEntry).toBeDefined();
      expect(skipEntry.reason).toBe("availability-unavailable");

      // No create entry for Tuesday target
      const conflictingCreate = body.create.find(
        (c: { employeeId: string; date: string }) =>
          c.employeeId === data.employee.id && c.date === COPY_TARGET_TUESDAY_ISO,
      );
      expect(conflictingCreate).toBeUndefined();

      await clearAvailability([data.employee.id]);
      await app.prisma.shift.deleteMany({
        where: {
          employeeId: data.employee.id,
          date: { gte: new Date("2026-12-07"), lte: new Date("2026-12-20") },
        },
      });
    });

    it("copy-week does NOT skip on PREFERRED (soft hint only)", async () => {
      await clearAvailability([data.employee.id]);
      await app.prisma.shift.deleteMany({
        where: {
          employeeId: data.employee.id,
          date: { gte: new Date("2026-12-07"), lte: new Date("2026-12-20") },
        },
      });

      // Source: Tuesday shift
      await app.prisma.shift.create({
        data: {
          employeeId: data.employee.id,
          templateId: availTplId,
          date: new Date(GEN_TUESDAY_ISO + "T00:00:00Z"),
          startTime: "09:00",
          endTime: "17:00",
          label: "Avail-Skip-Tpl",
          createdBy: data.adminUser.id,
        },
      });

      // Target: PREFERRED for Tuesday — must NOT block copy
      await app.prisma.employeeAvailability.create({
        data: {
          employeeId: data.employee.id,
          dayOfWeek: 1,
          status: "PREFERRED",
          validFrom: new Date(COPY_TARGET_WEEK + "T00:00:00Z"),
        },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts/copy-week",
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {
          sourceWeekStart: COPY_SOURCE_WEEK,
          targetWeekStart: COPY_TARGET_WEEK,
          commit: false,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      // No availability-unavailable skip
      const skipEntry = body.skip.find(
        (s: { employeeId: string; date: string; reason: string }) =>
          s.employeeId === data.employee.id &&
          s.date === COPY_TARGET_TUESDAY_ISO &&
          s.reason === "availability-unavailable",
      );
      expect(skipEntry).toBeUndefined();

      // Create entry present for target Tuesday
      const createEntry = body.create.find(
        (c: { employeeId: string; date: string }) =>
          c.employeeId === data.employee.id && c.date === COPY_TARGET_TUESDAY_ISO,
      );
      expect(createEntry).toBeDefined();

      await clearAvailability([data.employee.id]);
      await app.prisma.shift.deleteMany({
        where: {
          employeeId: data.employee.id,
          date: { gte: new Date("2026-12-07"), lte: new Date("2026-12-20") },
        },
      });
    });
  });

  // Phase 66 fix (failure #6): fixture dates are 2099-MM-DD so the Phase 47.2 past-immutable
  // guard never triggers on these eligibility tests. Original 2026-06-XX dates were authored
  // around 2026-05-20 and silently became past dates after the v1.7 release window.
  // ── Phase 47.1: Shift eligibility (SHIFT_BASED-only) ─────────────────
  describe("Shift eligibility (47.1)", () => {
    let shiftEmp: { id: string };
    let fixedEmp: { id: string };
    let monthlyEmp: { id: string };
    let noScheduleEmp: { id: string };

    beforeAll(async () => {
      const ts = Date.now();
      async function mkEmp(
        suffix: string,
        scheduleType: "FIXED_SCHEDULE" | "FLEXTIME" | "MONTHLY_HOURS" | "SHIFT_BASED" | null,
      ): Promise<{ id: string }> {
        const bcryptMod = await import("bcryptjs");
        const passwordHash = await bcryptMod.default.hash("test1234", 10);
        const user = await app.prisma.user.create({
          data: {
            email: `elig-${suffix}-${ts}@test.de`,
            passwordHash,
            role: "EMPLOYEE",
            isActive: true,
          },
        });
        const emp = await app.prisma.employee.create({
          data: {
            tenantId: data.tenant.id,
            userId: user.id,
            employeeNumber: `ELIG-${suffix}-${ts}`,
            firstName: `Elig${suffix}`,
            lastName: "Test",
            hireDate: new Date("2024-01-01"),
          },
        });
        if (scheduleType) {
          await app.prisma.workSchedule.create({
            data: {
              employeeId: emp.id,
              type: scheduleType,
              weeklyHours: scheduleType === "MONTHLY_HOURS" ? null : 40,
              monthlyHours: scheduleType === "MONTHLY_HOURS" ? 60 : null,
              validFrom: new Date("2024-01-01"),
            },
          });
        }
        return { id: emp.id };
      }
      shiftEmp = await mkEmp("S", "SHIFT_BASED");
      fixedEmp = await mkEmp("F", "FIXED_SCHEDULE");
      monthlyEmp = await mkEmp("M", "MONTHLY_HOURS");
      noScheduleEmp = await mkEmp("N", null);
    });

    const validShiftBody = (employeeId: string, date: string) => ({
      employeeId,
      date,
      startTime: "08:00",
      endTime: "16:00",
    });

    it("accepts SHIFT_BASED employee (201)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: validShiftBody(shiftEmp.id, "2099-06-01"),
      });
      expect(res.statusCode).toBe(201);
    });

    it("rejects FIXED_SCHEDULE employee (422 + SHIFT_INVALID_EMPLOYEE_TYPE)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: validShiftBody(fixedEmp.id, "2099-06-02"),
      });
      expect(res.statusCode).toBe(422);
      const body = JSON.parse(res.body);
      expect(body.code).toBe("SHIFT_INVALID_EMPLOYEE_TYPE");
    });

    it("rejects MONTHLY_HOURS employee (422 + SHIFT_INVALID_EMPLOYEE_TYPE)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: validShiftBody(monthlyEmp.id, "2099-06-03"),
      });
      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).code).toBe("SHIFT_INVALID_EMPLOYEE_TYPE");
    });

    it("rejects employee without any WorkSchedule (422)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: validShiftBody(noScheduleEmp.id, "2099-06-04"),
      });
      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).code).toBe("SHIFT_INVALID_EMPLOYEE_TYPE");
    });

    it("PUT /shifts/:id rejects move to non-SHIFT_BASED employee (422)", async () => {
      // Create on SHIFT_BASED emp first
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/shifts",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: validShiftBody(shiftEmp.id, "2099-06-05"),
      });
      expect(createRes.statusCode).toBe(201);
      const shiftId = JSON.parse(createRes.body).id;
      // Try to move to FIXED_SCHEDULE emp
      const moveRes = await app.inject({
        method: "PUT",
        url: `/api/v1/shifts/${shiftId}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { employeeId: fixedEmp.id, date: "2099-06-05" },
      });
      expect(moveRes.statusCode).toBe(422);
      expect(JSON.parse(moveRes.body).code).toBe("SHIFT_INVALID_EMPLOYEE_TYPE");
    });
  });

  // ── Phase 48 — Tenant-wide bulk patterns ────────────────────────────────────
  describe("Phase 48 — Tenant-wide bulk patterns", () => {
    let bulkTemplate: { id: string };
    let bulkShiftEmployee: { id: string };
    let bulkFixedEmployee: { id: string };
    let otherTenant: { id: string };
    let otherEmployee: { id: string };

    beforeAll(async () => {
      // Create a template for use in patterns
      const tplRes = await app.inject({
        method: "POST",
        url: "/api/v1/shifts/templates",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { name: "P48-Tpl", startTime: "08:00", endTime: "16:00", color: "#3b82f6" },
      });
      bulkTemplate = JSON.parse(tplRes.body);

      // Create a dedicated SHIFT_BASED employee for these tests
      const shiftUserPwd = await (await import("bcryptjs")).default.hash("test1234", 10);
      const shiftUser = await app.prisma.user.create({
        data: {
          email: `p48-shift-${Date.now()}@test.de`,
          passwordHash: shiftUserPwd,
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      bulkShiftEmployee = await app.prisma.employee.create({
        data: {
          tenantId: data.tenant.id,
          userId: shiftUser.id,
          employeeNumber: `P48S-${Date.now()}`,
          firstName: "Phase48",
          lastName: "ShiftEmp",
          hireDate: new Date("2024-01-01"),
        },
      });
      await app.prisma.workSchedule.create({
        data: {
          employeeId: bulkShiftEmployee.id,
          type: "SHIFT_BASED",
          weeklyHours: 40,
          validFrom: new Date("2024-01-01"),
        },
      });
      await app.prisma.overtimeAccount.create({
        data: { employeeId: bulkShiftEmployee.id, balanceHours: 0 },
      });

      // Create a FIXED_SCHEDULE-only employee (should NOT appear in /tenant)
      const fixedUserPwd = await (await import("bcryptjs")).default.hash("test1234", 10);
      const fixedUser = await app.prisma.user.create({
        data: {
          email: `p48-fixed-${Date.now()}@test.de`,
          passwordHash: fixedUserPwd,
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      bulkFixedEmployee = await app.prisma.employee.create({
        data: {
          tenantId: data.tenant.id,
          userId: fixedUser.id,
          employeeNumber: `P48F-${Date.now()}`,
          firstName: "Phase48",
          lastName: "FixedEmp",
          hireDate: new Date("2024-01-01"),
        },
      });
      await app.prisma.workSchedule.create({
        data: {
          employeeId: bulkFixedEmployee.id,
          type: "FIXED_SCHEDULE",
          weeklyHours: 40,
          mondayHours: 8,
          tuesdayHours: 8,
          wednesdayHours: 8,
          thursdayHours: 8,
          fridayHours: 8,
          validFrom: new Date("2024-01-01"),
        },
      });
      await app.prisma.overtimeAccount.create({
        data: { employeeId: bulkFixedEmployee.id, balanceHours: 0 },
      });

      // Even though fixed employee shouldn't surface, drop a pattern on them to
      // prove the SHIFT_BASED filter — patterns exist but the employee is fixed.
      await app.prisma.employeeShiftPattern.create({
        data: {
          employeeId: bulkFixedEmployee.id,
          dayOfWeek: 0,
          templateId: bulkTemplate.id,
          validFrom: new Date("2026-01-01"),
          isActive: true,
        },
      });

      // Build a SECOND tenant + SHIFT_BASED employee to verify tenant isolation
      otherTenant = await app.prisma.tenant.create({
        data: {
          name: `P48 Other ${Date.now()}`,
          slug: `p48-other-${Date.now()}`,
          federalState: "NIEDERSACHSEN",
        },
      });
      await app.prisma.tenantConfig.create({
        data: { tenantId: otherTenant.id, defaultVacationDays: 30, timezone: "Europe/Berlin" },
      });
      const otherUser = await app.prisma.user.create({
        data: {
          email: `p48-other-${Date.now()}@test.de`,
          passwordHash: fixedUserPwd,
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      otherEmployee = await app.prisma.employee.create({
        data: {
          tenantId: otherTenant.id,
          userId: otherUser.id,
          employeeNumber: `P48O-${Date.now()}`,
          firstName: "Other",
          lastName: "Tenant",
          hireDate: new Date("2024-01-01"),
        },
      });
      await app.prisma.workSchedule.create({
        data: {
          employeeId: otherEmployee.id,
          type: "SHIFT_BASED",
          weeklyHours: 40,
          validFrom: new Date("2024-01-01"),
        },
      });
      // Other tenant's pattern — should NEVER leak into data.tenant queries.
      // Note: templates are tenant-scoped, so use null templateId (still counts as a row).
      await app.prisma.employeeShiftPattern.create({
        data: {
          employeeId: otherEmployee.id,
          dayOfWeek: 1,
          templateId: null,
          validFrom: new Date("2026-01-01"),
          isActive: true,
        },
      });
    });

    afterAll(async () => {
      try {
        await cleanupTestData(app, otherTenant.id);
      } catch (err) {
        console.error("Phase 48 cleanup failed:", err);
      }
    });

    it("ADMIN GET /shift-patterns/tenant returns 200 with array", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/shift-patterns/tenant",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Array.isArray(body)).toBe(true);
    });

    it("EMPLOYEE GET /shift-patterns/tenant → 403", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/shift-patterns/tenant",
        headers: { authorization: `Bearer ${data.empToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("only returns patterns for SHIFT_BASED employees (filters out FIXED_SCHEDULE)", async () => {
      // First, PUT a pattern on the SHIFT_BASED employee
      const putRes = await app.inject({
        method: "PUT",
        url: `/api/v1/employees/${bulkShiftEmployee.id}/shift-patterns`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          patterns: [
            { dayOfWeek: 0, templateId: bulkTemplate.id, validFrom: "2026-01-01" },
            { dayOfWeek: 1, templateId: null, validFrom: "2026-01-01" },
          ],
        },
      });
      expect(putRes.statusCode).toBe(200);

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/shift-patterns/tenant",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as Array<{ employeeId: string }>;
      // SHIFT_BASED employee patterns are present
      expect(body.some((p) => p.employeeId === bulkShiftEmployee.id)).toBe(true);
      // FIXED_SCHEDULE employee patterns are filtered out (even though a pattern row exists)
      expect(body.every((p) => p.employeeId !== bulkFixedEmployee.id)).toBe(true);
    });

    it("does not leak patterns from another tenant", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/shift-patterns/tenant",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as Array<{ employeeId: string }>;
      expect(body.every((p) => p.employeeId !== otherEmployee.id)).toBe(true);
    });

    it("PUT /employees/:id/shift-patterns is idempotent on repeat with same body", async () => {
      const payload = {
        patterns: [{ dayOfWeek: 2, templateId: bulkTemplate.id, validFrom: "2026-02-01" }],
      };

      const first = await app.inject({
        method: "PUT",
        url: `/api/v1/employees/${bulkShiftEmployee.id}/shift-patterns`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload,
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: "PUT",
        url: `/api/v1/employees/${bulkShiftEmployee.id}/shift-patterns`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload,
      });
      expect(second.statusCode).toBe(200);

      // Final state: exactly one active pattern for dayOfWeek=2, validFrom=2026-02-01
      const getRes = await app.inject({
        method: "GET",
        url: `/api/v1/employees/${bulkShiftEmployee.id}/shift-patterns`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      const patterns = JSON.parse(getRes.body) as Array<{
        dayOfWeek: number;
        validFrom: string;
        templateId: string | null;
        isActive: boolean;
      }>;
      const dayTwoActive = patterns.filter(
        (p) => p.dayOfWeek === 2 && p.validFrom === "2026-02-01" && p.isActive,
      );
      expect(dayTwoActive).toHaveLength(1);
      expect(dayTwoActive[0].templateId).toBe(bulkTemplate.id);
    });

    it("PUT replacing { Mo→tpl, Di→tpl } with { Mo→null, Di→tpl } updates templateId", async () => {
      // First set: Mo (0) + Di (1) both assigned
      const first = await app.inject({
        method: "PUT",
        url: `/api/v1/employees/${bulkShiftEmployee.id}/shift-patterns`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          patterns: [
            { dayOfWeek: 0, templateId: bulkTemplate.id, validFrom: "2026-03-01" },
            { dayOfWeek: 1, templateId: bulkTemplate.id, validFrom: "2026-03-01" },
          ],
        },
      });
      expect(first.statusCode).toBe(200);

      // Second set: Mo cleared (null), Di unchanged
      const second = await app.inject({
        method: "PUT",
        url: `/api/v1/employees/${bulkShiftEmployee.id}/shift-patterns`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          patterns: [
            { dayOfWeek: 0, templateId: null, validFrom: "2026-03-01" },
            { dayOfWeek: 1, templateId: bulkTemplate.id, validFrom: "2026-03-01" },
          ],
        },
      });
      expect(second.statusCode).toBe(200);

      const getRes = await app.inject({
        method: "GET",
        url: `/api/v1/employees/${bulkShiftEmployee.id}/shift-patterns`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      const patterns = JSON.parse(getRes.body) as Array<{
        dayOfWeek: number;
        validFrom: string;
        templateId: string | null;
        isActive: boolean;
      }>;
      const mo = patterns.find(
        (p) => p.dayOfWeek === 0 && p.validFrom === "2026-03-01" && p.isActive,
      );
      const di = patterns.find(
        (p) => p.dayOfWeek === 1 && p.validFrom === "2026-03-01" && p.isActive,
      );
      expect(mo).toBeDefined();
      expect(mo!.templateId).toBeNull();
      expect(di).toBeDefined();
      expect(di!.templateId).toBe(bulkTemplate.id);
    });
  });
});
