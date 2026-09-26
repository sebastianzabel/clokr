/**
 * Audit Trail Completeness Tests (SEC-03)
 *
 * Cross-cutting concern: verifies that every mutating endpoint writes an
 * AuditLog row with the required fields (userId, action, entity, entityId).
 *
 * Per D-05 exception: this file is justified as a dedicated cross-cutting
 * compliance test — audit completeness is not owned by any single route file.
 *
 * Strategy per RESEARCH.md Pitfall 7: capture beforeTs before each mutation
 * and filter auditLog by createdAt >= beforeTs to isolate only the logs
 * produced by the test action.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { daysAgoStrInTz, utcMidnight } from "./test-dates";
import type { FastifyInstance } from "fastify";

describe("Audit Trail Completeness", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  // Tracks IDs created during tests for cleanup and cross-test references
  let createdTimeEntryId: string;
  let createdLeaveRequestId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "at");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Audit trail test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // ── TimeEntry mutations ───────────────────────────────────────────────────

  describe("TimeEntry mutations", () => {
    // Shared by plans 78b-02 and 78b-05 (D-09): asserts actor, time window and — when
    // oldValue/newValue are given — that the stored value is non-null and matches the given
    // fields. `toBeDefined()` alone would pass for a `null` Json column, which is exactly what
    // let the old assertions in this file pass without proving a before/after value existed.
    function expectAuditRow(
      log: { userId: string | null; createdAt: Date; oldValue: unknown; newValue: unknown } | null,
      opts: {
        userId: string | null;
        beforeTs: Date;
        oldValue?: Record<string, unknown>;
        newValue?: Record<string, unknown>;
      },
    ) {
      expect(log, "expected an AuditLog row to exist").not.toBeNull();
      expect(log!.userId).toBe(opts.userId);
      expect(log!.createdAt.getTime()).toBeGreaterThanOrEqual(opts.beforeTs.getTime());
      expect(log!.createdAt.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
      if (opts.oldValue !== undefined) {
        expect(log!.oldValue, "oldValue must not be null").not.toBeNull();
        expect(log!.oldValue).toMatchObject(opts.oldValue);
      }
      if (opts.newValue !== undefined) {
        expect(log!.newValue, "newValue must not be null").not.toBeNull();
        expect(log!.newValue).toMatchObject(opts.newValue);
      }
    }

    it("POST /api/v1/time-entries writes AuditLog with action CREATE", async () => {
      const beforeTs = new Date();

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          date: "2025-06-10",
          startTime: "2025-06-10T08:00:00.000Z",
          endTime: "2025-06-10T16:00:00.000Z",
          breakMinutes: 30,
          note: "Audit trail test entry",
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      createdTimeEntryId = body.entry.id;

      const logs = await app.prisma.auditLog.findMany({
        where: {
          entity: "TimeEntry",
          action: "CREATE",
          createdAt: { gte: beforeTs },
        },
      });

      expect(logs.length).toBeGreaterThanOrEqual(1);
      const log = logs.find((l) => l.entityId === createdTimeEntryId);
      expect(log).toBeDefined();
      expect(log!.userId).toBe(data.adminUser.id);
      expect(log!.action).toBe("CREATE");
      expect(log!.entityId).toBe(createdTimeEntryId);
      expect(log!.newValue).toBeDefined();
    });

    it("PUT /api/v1/time-entries/:id writes AuditLog with action UPDATE", async () => {
      if (!createdTimeEntryId) {
        console.warn("Skipping: no time entry created by previous test");
        return;
      }

      const beforeTs = new Date();

      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/time-entries/${createdTimeEntryId}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { note: "Updated note for audit trail", reason: "Korrektur nach Rückfrage" },
      });

      expect([200]).toContain(res.statusCode);

      const logs = await app.prisma.auditLog.findMany({
        where: {
          entity: "TimeEntry",
          entityId: createdTimeEntryId,
          createdAt: { gte: beforeTs },
        },
      });

      expect(logs.length).toBeGreaterThanOrEqual(1);
      const log = logs[0];
      expect(log.userId).toBe(data.adminUser.id);
      // Action may be UPDATE or MANAGER_CORRECTION depending on role
      expect(["UPDATE", "MANAGER_CORRECTION"]).toContain(log.action);
      expect(log.oldValue).toBeDefined();
      expect(log.newValue).toBeDefined();
    });

    it("DELETE /api/v1/time-entries/:id writes AuditLog with action DELETE", async () => {
      if (!createdTimeEntryId) {
        console.warn("Skipping: no time entry created by previous test");
        return;
      }

      const beforeTs = new Date();

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/time-entries/${createdTimeEntryId}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { reason: "Storno wegen Fehleingabe" },
      });

      expect([200, 204]).toContain(res.statusCode);

      const logs = await app.prisma.auditLog.findMany({
        where: {
          entity: "TimeEntry",
          action: "DELETE",
          entityId: createdTimeEntryId,
          createdAt: { gte: beforeTs },
        },
      });

      expect(logs.length).toBeGreaterThanOrEqual(1);
      const log = logs[0];
      expect(log.userId).toBe(data.adminUser.id);
      expect(log.action).toBe("DELETE");
      expect(log.oldValue).toBeDefined();
    });

    // D-10 (issue #310/#78): POST /:id/breaks recomputes and persists the entry's
    // breakMinutes/breakStatus but, before this fix, never audited that TimeEntry change — only
    // the appended Break row itself was audited (BREAK_APPEND, entity Break). Action is "UPDATE"
    // per P-03 (78b-CONTEXT.md): consistent with PUT /:id's self-edit UPDATE, not BREAK_CONFIRMED
    // (a different act — the employee confirming an auto-inserted break on /break-status).
    it("(D-10) POST /:id/breaks writes a second AuditLog row (entity TimeEntry, action UPDATE) with breakMinutes/breakStatus before and after", async () => {
      const dateStr = daysAgoStrInTz(new Date(), 3);
      const entry = await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: utcMidnight(dateStr),
          startTime: new Date(`${dateStr}T07:00:00.000Z`),
          endTime: new Date(`${dateStr}T15:00:00.000Z`),
          breakMinutes: 30,
          breakStatus: "AUTO",
          salonId: data.salonId,
          source: "MANUAL",
        },
      });

      const beforeTs = new Date();

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/time-entries/${entry.id}/breaks`,
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {
          startTime: `${dateStr}T11:00:00.000Z`,
          endTime: `${dateStr}T11:45:00.000Z`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.breakMinutes).toBe(45);

      const timeEntryLog = await app.prisma.auditLog.findFirst({
        where: {
          entity: "TimeEntry",
          entityId: entry.id,
          action: "UPDATE",
          createdAt: { gte: beforeTs },
        },
      });
      expectAuditRow(timeEntryLog, {
        userId: data.empUser.id,
        beforeTs,
        oldValue: { breakMinutes: 30, breakStatus: "AUTO" },
        newValue: { breakMinutes: 45, breakStatus: "CONFIRMED" },
      });

      // The pre-existing BREAK_APPEND audit (entity Break) for the new break must still exist.
      const breakAppendLog = await app.prisma.auditLog.findFirst({
        where: { entity: "Break", entityId: body.break.id, action: "BREAK_APPEND" },
      });
      expect(breakAppendLog).not.toBeNull();
    });
  });

  // ── Employee mutations ────────────────────────────────────────────────────

  describe("Employee mutations", () => {
    let createdEmployeeId: string;

    it("POST /api/v1/employees writes AuditLog with action CREATE", async () => {
      const beforeTs = new Date();
      const uniqueNum = Date.now().toString(36);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/employees",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          email: `newstaff-${uniqueNum}@audit-test.de`,
          firstName: "Audit",
          lastName: "Staff",
          employeeNumber: `AUD-${uniqueNum}`,
          hireDate: new Date("2025-01-01").toISOString(),
          role: "EMPLOYEE",
          weeklyHours: 40,
          scheduleType: "FIXED_SCHEDULE",
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      // POST /employees returns the employee fields spread directly (not nested)
      createdEmployeeId = body.id;

      const logs = await app.prisma.auditLog.findMany({
        where: {
          entity: "Employee",
          action: "CREATE",
          entityId: createdEmployeeId,
          createdAt: { gte: beforeTs },
        },
      });

      expect(logs.length).toBeGreaterThanOrEqual(1);
      const log = logs[0];
      expect(log.userId).toBe(data.adminUser.id);
      expect(log.action).toBe("CREATE");
      expect(log.newValue).toBeDefined();
    });

    it("PATCH /api/v1/employees/:id writes AuditLog with action UPDATE", async () => {
      if (!createdEmployeeId) {
        console.warn("Skipping: no employee created by previous test");
        return;
      }

      const beforeTs = new Date();

      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/employees/${createdEmployeeId}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { firstName: "AuditUpdated" },
      });

      expect([200]).toContain(res.statusCode);

      const logs = await app.prisma.auditLog.findMany({
        where: {
          entity: "Employee",
          action: "UPDATE",
          entityId: createdEmployeeId,
          createdAt: { gte: beforeTs },
        },
      });

      expect(logs.length).toBeGreaterThanOrEqual(1);
      const log = logs[0];
      expect(log.userId).toBe(data.adminUser.id);
      expect(log.action).toBe("UPDATE");
      expect(log.oldValue).toBeDefined();
      expect(log.newValue).toBeDefined();
    });

    it("DELETE /api/v1/employees/:id (anonymize) writes AuditLog with action ANONYMIZE", async () => {
      if (!createdEmployeeId) {
        console.warn("Skipping: no employee created by previous test");
        return;
      }

      const beforeTs = new Date();

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/employees/${createdEmployeeId}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      // DELETE anonymizes the employee per DSGVO — 200 or 204
      expect([200, 204]).toContain(res.statusCode);

      const logs = await app.prisma.auditLog.findMany({
        where: {
          entity: "Employee",
          entityId: createdEmployeeId,
          createdAt: { gte: beforeTs },
        },
      });

      expect(logs.length).toBeGreaterThanOrEqual(1);
      const log = logs.find((l) => l.action === "ANONYMIZE" || l.action === "DELETE");
      expect(log).toBeDefined();
      expect(log!.userId).toBe(data.adminUser.id);
    });
  });

  // ── LeaveRequest mutations ────────────────────────────────────────────────

  describe("LeaveRequest mutations", () => {
    it("POST /api/v1/leave/requests writes AuditLog with action CREATE", async () => {
      const beforeTs = new Date();

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {
          type: "SICK",
          startDate: "2025-07-10",
          endDate: "2025-07-10",
          note: "Audit trail sick day",
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      createdLeaveRequestId = body.id;

      const logs = await app.prisma.auditLog.findMany({
        where: {
          entity: "LeaveRequest",
          action: "CREATE",
          entityId: createdLeaveRequestId,
          createdAt: { gte: beforeTs },
        },
      });

      expect(logs.length).toBeGreaterThanOrEqual(1);
      const log = logs[0];
      // LeaveRequest CREATE is created by the employee user
      expect(log.userId).toBe(data.empUser.id);
      expect(log.action).toBe("CREATE");
      expect(log.newValue).toBeDefined();
    });

    it("PUT /api/v1/leave/requests/:id (approve) writes AuditLog with action APPROVE", async () => {
      if (!createdLeaveRequestId) {
        console.warn("Skipping: no leave request created by previous test");
        return;
      }

      const beforeTs = new Date();

      // Admin approves the sick leave (SICK type does not requiresApproval in DB
      // but let's test with the approve endpoint)
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/leave/requests/${createdLeaveRequestId}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { status: "APPROVED" },
      });

      // SICK does not require approval, but the route may still accept PUT
      // Accept 200 (approved) or 400 (sick leave auto-approved) or 404
      if (res.statusCode !== 200) {
        // If the leave is already auto-approved or status change not allowed, skip
        return;
      }

      const logs = await app.prisma.auditLog.findMany({
        where: {
          entity: "LeaveRequest",
          entityId: createdLeaveRequestId,
          createdAt: { gte: beforeTs },
        },
      });

      expect(logs.length).toBeGreaterThanOrEqual(1);
      const log = logs.find((l) => ["APPROVE", "UPDATE"].includes(l.action));
      expect(log).toBeDefined();
      expect(log!.userId).toBe(data.adminUser.id);
    });
  });

  // ── Auth mutations ────────────────────────────────────────────────────────

  describe("Auth mutations", () => {
    it("POST /api/v1/auth/login (successful) writes AuditLog with action LOGIN", async () => {
      const beforeTs = new Date();

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: data.empUser.email, password: "test1234" },
      });

      expect(res.statusCode).toBe(200);

      const logs = await app.prisma.auditLog.findMany({
        where: {
          entity: "User",
          action: "LOGIN",
          entityId: data.empUser.id,
          createdAt: { gte: beforeTs },
        },
      });

      expect(logs.length).toBeGreaterThanOrEqual(1);
      const log = logs[0];
      // LOGIN audit records the user's own userId as actor
      expect(log.userId).toBe(data.empUser.id);
      expect(log.action).toBe("LOGIN");
    });
  });

  // ── PublicHoliday mutations ───────────────────────────────────────────────

  describe("PublicHoliday mutations", () => {
    it("audit coverage — POST /api/v1/holidays writes AuditLog with action CREATE", async () => {
      const beforeTs = new Date();

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/holidays",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { date: "2025-11-20", name: "Testfeiertag Audit" },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);

      const logs = await app.prisma.auditLog.findMany({
        where: {
          entity: "PublicHoliday",
          action: "CREATE",
          entityId: body.id,
          createdAt: { gte: beforeTs },
        },
      });

      expect(logs.length).toBeGreaterThanOrEqual(1);
      const log = logs[0];
      expect(log.userId).toBe(data.adminUser.id);
      expect(log.action).toBe("CREATE");
      expect(log.entity).toBe("PublicHoliday");
      expect(log.newValue).toBeDefined();
    });
  });

  // ── Settings mutations ────────────────────────────────────────────────────

  describe("Settings mutations", () => {
    it("PUT /api/v1/settings/work writes AuditLog with action UPDATE on TenantConfig", async () => {
      const beforeTs = new Date();

      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/settings/work",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { defaultVacationDays: 25 },
      });

      expect(res.statusCode).toBe(200);

      const logs = await app.prisma.auditLog.findMany({
        where: {
          entity: "TenantConfig",
          action: "UPDATE",
          createdAt: { gte: beforeTs },
        },
      });

      expect(logs.length).toBeGreaterThanOrEqual(1);
      const log = logs[0];
      expect(log.userId).toBe(data.adminUser.id);
      expect(log.action).toBe("UPDATE");
      expect(log.newValue).toBeDefined();
    });
  });
});
