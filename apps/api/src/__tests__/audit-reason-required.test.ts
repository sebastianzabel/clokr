/**
 * Quick 260824-cjd — Begründung für Korrektur und Storno gesetzlich verpflichtend
 *
 * Dedicated coverage for the four true Korrektur/Storno write paths:
 *   1. PATCH /api/v1/leave/requests/:id/correct
 *   2. DELETE /api/v1/leave/requests/:id
 *   3. DELETE /api/v1/time-entries/:id
 *   4. PUT    /api/v1/time-entries/:id   (only when a manager corrects ANOTHER
 *      employee's entry)
 *
 * Asserts, per endpoint: (a) a missing/blank reason is rejected with 400, and
 * (b) a valid reason is persisted verbatim into AuditLog.newValue.auditReason.
 * Also pins the guard-ordering invariant (404/403/409 must still win over a
 * missing-reason 400) and the own-entry PUT regression guard (no reason demanded,
 * no auditReason key on the resulting UPDATE audit row).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { pastDateStr } from "./test-dates";
import type { FastifyInstance } from "fastify";

describe("Quick 260824-cjd: mandatory Begründung on Korrektur/Storno endpoints", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let other: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "arq");
    other = await seedTestData(app, "arq2");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    try {
      await cleanupTestData(app, other.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // ── 1. PATCH /leave/requests/:id/correct ──────────────────────────────────

  describe("PATCH /leave/requests/:id/correct", () => {
    async function createApprovedLeave(startDate: string, endDate: string) {
      return app.prisma.leaveRequest.create({
        data: {
          employeeId: data.employee.id,
          leaveTypeId: data.vacationType.id,
          startDate: new Date(startDate),
          endDate: new Date(endDate),
          days: 0,
          status: "APPROVED",
          reviewedBy: "system",
          reviewedAt: new Date(),
        },
      });
    }

    it("without reason → 400 Validierungsfehler", async () => {
      const req = await createApprovedLeave("2029-01-07", "2029-01-11");
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/requests/${req.id}/correct`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { startDate: "2029-01-07", endDate: "2029-01-09" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("with reason → 200 and AuditLog.newValue.auditReason equals the trimmed reason", async () => {
      const req = await createApprovedLeave("2029-02-05", "2029-02-09");
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/requests/${req.id}/correct`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          startDate: "2029-02-05",
          endDate: "2029-02-07",
          reason: "  Korrektur nach Rückfrage  ",
        },
      });
      expect(res.statusCode).toBe(200);

      const audit = await app.prisma.auditLog.findFirst({
        where: { action: "LEAVE_CORRECTED", entity: "LeaveRequest", entityId: req.id },
        orderBy: { createdAt: "desc" },
      });
      expect(audit).not.toBeNull();
      const newValue = audit?.newValue as { auditReason?: string } | null;
      expect(newValue?.auditReason).toBe("Korrektur nach Rückfrage");
    });
  });

  // ── 2. DELETE /leave/requests/:id ──────────────────────────────────────────

  describe("DELETE /leave/requests/:id", () => {
    async function createPendingLeave(startDate: string, endDate: string) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: { type: "VACATION", startDate, endDate },
      });
      expect(res.statusCode).toBe(201);
      return JSON.parse(res.body).id as string;
    }

    it("without reason → 400 Validierungsfehler", async () => {
      const id = await createPendingLeave("2029-03-05", "2029-03-06");
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/leave/requests/${id}`,
        headers: { authorization: `Bearer ${data.empToken}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it("with reason → success and AuditLog.newValue.auditReason equals the trimmed reason", async () => {
      const id = await createPendingLeave("2029-03-12", "2029-03-13");
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/leave/requests/${id}`,
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: { reason: "  Storno wegen Fehleingabe  " },
      });
      expect(res.statusCode).toBeLessThan(300);

      const audit = await app.prisma.auditLog.findFirst({
        where: { entity: "LeaveRequest", entityId: id },
        orderBy: { createdAt: "desc" },
      });
      expect(audit).not.toBeNull();
      const newValue = audit?.newValue as { auditReason?: string } | null;
      expect(newValue?.auditReason).toBe("Storno wegen Fehleingabe");
    });

    it("ordering guard: DELETE on a foreign-tenant leave request with NO reason → still 404 (not 400)", async () => {
      const foreign = await app.prisma.leaveRequest.create({
        data: {
          employeeId: other.employee.id,
          leaveTypeId: other.vacationType.id,
          startDate: new Date("2029-04-02"),
          endDate: new Date("2029-04-03"),
          days: 0,
          status: "PENDING",
        },
      });
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/leave/requests/${foreign.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        // No reason on purpose — the 404 tenant guard must win regardless.
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ── 3. DELETE /time-entries/:id ────────────────────────────────────────────

  describe("DELETE /time-entries/:id", () => {
    async function createEntry(dateStr: string) {
      return app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date(dateStr),
          startTime: new Date(`${dateStr}T08:00:00Z`),
          endTime: new Date(`${dateStr}T16:00:00Z`),
          breakMinutes: 30,
          source: "MANUAL",
        },
      });
    }

    it("without reason → 400 Validierungsfehler", async () => {
      const entry = await createEntry("2029-05-07");
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/time-entries/${entry.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it("with reason → 204 and a DELETE AuditLog row whose newValue.auditReason is set", async () => {
      const entry = await createEntry("2029-05-08");
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/time-entries/${entry.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { reason: "  Storno wegen Fehleingabe  " },
      });
      expect(res.statusCode).toBe(204);

      const audit = await app.prisma.auditLog.findFirst({
        where: { action: "DELETE", entity: "TimeEntry", entityId: entry.id },
        orderBy: { createdAt: "desc" },
      });
      expect(audit).not.toBeNull();
      const newValue = audit?.newValue as { auditReason?: string } | null;
      expect(newValue?.auditReason).toBe("Storno wegen Fehleingabe");
    });

    it("ordering guard: DELETE on an isLocked time entry with NO reason → still 403 (not 400)", async () => {
      const entry = await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date("2029-05-09"),
          startTime: new Date("2029-05-09T08:00:00Z"),
          endTime: new Date("2029-05-09T16:00:00Z"),
          breakMinutes: 30,
          source: "MANUAL",
          isLocked: true,
        },
      });
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/time-entries/${entry.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        // No reason on purpose — the isLocked guard must win regardless.
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ── 4. PUT /time-entries/:id (manager correcting ANOTHER employee) ────────

  describe("PUT /time-entries/:id — manager correcting another employee's entry", () => {
    async function createEntry(dateStr: string) {
      return app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date(dateStr),
          startTime: new Date(`${dateStr}T08:00:00Z`),
          endTime: new Date(`${dateStr}T16:00:00Z`),
          breakMinutes: 30,
          source: "MANUAL",
        },
      });
    }

    it("without reason → 400 Begründung-required message", async () => {
      const entry = await createEntry(pastDateStr(20));
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/time-entries/${entry.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { breakMinutes: 45 },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe(
        "Begründung ist erforderlich (revisionssicherheitspflichtig).",
      );
    });

    it("with reason → 200 and MANAGER_CORRECTION AuditLog.newValue.auditReason is set", async () => {
      const entry = await createEntry(pastDateStr(21));
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/time-entries/${entry.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { breakMinutes: 45, reason: "  Korrektur nach Rückfrage  " },
      });
      expect(res.statusCode).toBe(200);

      const audit = await app.prisma.auditLog.findFirst({
        where: { action: "MANAGER_CORRECTION", entity: "TimeEntry", entityId: entry.id },
        orderBy: { createdAt: "desc" },
      });
      expect(audit).not.toBeNull();
      const newValue = audit?.newValue as { auditReason?: string } | null;
      expect(newValue?.auditReason).toBe("Korrektur nach Rückfrage");
    });

    it("regression guard: employee PUTs their OWN entry with no reason → 200, action UPDATE, no auditReason key", async () => {
      const dateStr = pastDateStr(3);
      const entry = await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date(dateStr),
          startTime: new Date(`${dateStr}T08:00:00Z`),
          endTime: new Date(`${dateStr}T16:00:00Z`),
          breakMinutes: 30,
          source: "MANUAL",
        },
      });
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/time-entries/${entry.id}`,
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: { breakMinutes: 45 },
      });
      expect(res.statusCode).toBe(200);

      const audit = await app.prisma.auditLog.findFirst({
        where: { entity: "TimeEntry", entityId: entry.id },
        orderBy: { createdAt: "desc" },
      });
      expect(audit).not.toBeNull();
      expect(audit?.action).toBe("UPDATE");
      const newValue = audit?.newValue as { auditReason?: string } | null;
      expect(newValue?.auditReason).toBeUndefined();
    });
  });
});
