/**
 * Issue #446 (G8, D-05..D-10) — no leave change in a closed (Monatsabschluss) month.
 *
 * One shared guard (`findClosedMonthsInRange`, built on the canonical `isMonthClosed`
 * signal) covers all four leave transitions that must be refused once a month is closed:
 * (a) POST /requests, (b) PENDING -> APPROVED review, (c) CANCELLATION_REQUESTED ->
 * CANCELLED review, (d) the cancellation request (DELETE on an APPROVED leave). Rejections
 * (PENDING -> REJECTED, cancellation rejection) and withdrawing a PENDING request stay
 * allowed — they are saldo-neutral (D-06). Task 3 adds the cancellation-rejection
 * recalculation (D-05) regression.
 *
 * Each `it` seeds its own tenant and cleans up in `finally` (no shared fixture state).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { getTenantTimezone, monthRangeUtc } from "../contexts/working-time-account";
import { leaveTypeFields } from "../contexts/absence/leave-type";
import type { FastifyInstance } from "fastify";

describe("Leave — closed-month guard (Issue #446, D-05..D-10)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterAll(async () => {
    await closeTestApp();
  });

  /** Creates a MONTHLY, superseded:false SaldoSnapshot — the canonical closed-month
   * signal `isMonthClosed` reads — exactly like leave-attest-late.test.ts:103-118. */
  async function closeMonth(
    employeeId: string,
    tenantId: string,
    year: number,
    month: number,
  ): Promise<void> {
    const tz = await getTenantTimezone(app.prisma, tenantId);
    const { start, end } = monthRangeUtc(year, month, tz);
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId,
        periodType: "MONTHLY",
        periodStart: start,
        periodEnd: end,
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date(),
        closedBy: "test-system",
      },
    });
  }

  describe("(a) POST /requests", () => {
    it("rejects a SICK request touching a closed month — 409 LEAVE_MONTH_CLOSED, no row created", async () => {
      const d = await seedTestData(app, "cmg-a1");
      try {
        await closeMonth(d.employee.id, d.tenant.id, 2026, 3);
        const before = await app.prisma.leaveRequest.count({
          where: { employeeId: d.employee.id },
        });

        const res = await app.inject({
          method: "POST",
          url: "/api/v1/leave/requests",
          headers: { authorization: `Bearer ${d.empToken}` },
          payload: { type: "SICK", startDate: "2026-03-09", endDate: "2026-03-13" },
        });

        expect(res.statusCode).toBe(409);
        const body = JSON.parse(res.body);
        expect(body.code).toBe("LEAVE_MONTH_CLOSED");
        expect(body.error).toContain("03/2026");

        const after = await app.prisma.leaveRequest.count({
          where: { employeeId: d.employee.id },
        });
        expect(after).toBe(before);
      } finally {
        await cleanupTestData(app, d.tenant.id);
      }
    });

    it("D-09: a range spanning a closed and an open month is rejected as a whole, naming only the closed month", async () => {
      const d = await seedTestData(app, "cmg-a2");
      try {
        await closeMonth(d.employee.id, d.tenant.id, 2026, 3);

        const res = await app.inject({
          method: "POST",
          url: "/api/v1/leave/requests",
          headers: { authorization: `Bearer ${d.empToken}` },
          payload: { type: "SICK", startDate: "2026-03-30", endDate: "2026-04-03" },
        });

        expect(res.statusCode).toBe(409);
        const body = JSON.parse(res.body);
        expect(body.code).toBe("LEAVE_MONTH_CLOSED");
        expect(body.error).toContain("03/2026");
        expect(body.error).not.toContain("04/2026");
      } finally {
        await cleanupTestData(app, d.tenant.id);
      }
    });

    it("D-09: a range spanning two closed months names both, plural wording", async () => {
      const d = await seedTestData(app, "cmg-a3");
      try {
        await closeMonth(d.employee.id, d.tenant.id, 2026, 3);
        await closeMonth(d.employee.id, d.tenant.id, 2026, 4);

        const res = await app.inject({
          method: "POST",
          url: "/api/v1/leave/requests",
          headers: { authorization: `Bearer ${d.empToken}` },
          payload: { type: "SICK", startDate: "2026-03-30", endDate: "2026-04-03" },
        });

        expect(res.statusCode).toBe(409);
        const body = JSON.parse(res.body);
        expect(body.error).toContain("03/2026");
        expect(body.error).toContain("04/2026");
        expect(body.error).toContain("Monate");
      } finally {
        await cleanupTestData(app, d.tenant.id);
      }
    });

    it("control: the same POST in an open month succeeds — 201", async () => {
      const d = await seedTestData(app, "cmg-a4");
      try {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/leave/requests",
          headers: { authorization: `Bearer ${d.empToken}` },
          payload: { type: "SICK", startDate: "2026-03-09", endDate: "2026-03-13" },
        });

        expect(res.statusCode).toBe(201);
      } finally {
        await cleanupTestData(app, d.tenant.id);
      }
    });
  });

  /** Creates (or reuses) a SICK LeaveType for the tenant — SICK requests have no lead time
   * and no entitlement check, matching the plan's guidance for the guard-point fixtures. */
  async function sickLeaveTypeId(tenantId: string): Promise<string> {
    const existing = await app.prisma.leaveType.findFirst({ where: { tenantId, code: "SICK" } });
    if (existing) return existing.id;
    const created = await app.prisma.leaveType.create({
      data: { tenantId, ...leaveTypeFields("SICK") },
    });
    return created.id;
  }

  async function auditCount(entityId: string): Promise<number> {
    return app.prisma.auditLog.count({ where: { entityId } });
  }

  describe("(b) PATCH /requests/:id/review — PENDING -> APPROVED", () => {
    it("rejects approval touching a closed month — 409, no partial write", async () => {
      const d = await seedTestData(app, "cmg-b1");
      try {
        const createRes = await app.inject({
          method: "POST",
          url: "/api/v1/leave/requests",
          headers: { authorization: `Bearer ${d.empToken}` },
          payload: { type: "SICK", startDate: "2026-03-09", endDate: "2026-03-13" },
        });
        expect(createRes.statusCode).toBe(201);
        const { id } = JSON.parse(createRes.body);

        await closeMonth(d.employee.id, d.tenant.id, 2026, 3);
        const auditBefore = await auditCount(id);

        const res = await app.inject({
          method: "PATCH",
          url: `/api/v1/leave/requests/${id}/review`,
          headers: { authorization: `Bearer ${d.adminToken}` },
          payload: { status: "APPROVED" },
        });

        expect(res.statusCode).toBe(409);
        const body = JSON.parse(res.body);
        expect(body.code).toBe("LEAVE_MONTH_CLOSED");

        const stored = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id } });
        expect(stored.status).toBe("PENDING");
        expect(stored.reviewedBy).toBeNull();
        expect(stored.reviewedAt).toBeNull();
        expect(await auditCount(id)).toBe(auditBefore);
      } finally {
        await cleanupTestData(app, d.tenant.id);
      }
    });

    it("control: the same approval with no closed month succeeds — 200", async () => {
      const d = await seedTestData(app, "cmg-b2");
      try {
        const createRes = await app.inject({
          method: "POST",
          url: "/api/v1/leave/requests",
          headers: { authorization: `Bearer ${d.empToken}` },
          payload: { type: "SICK", startDate: "2026-03-09", endDate: "2026-03-13" },
        });
        const { id } = JSON.parse(createRes.body);

        const res = await app.inject({
          method: "PATCH",
          url: `/api/v1/leave/requests/${id}/review`,
          headers: { authorization: `Bearer ${d.adminToken}` },
          payload: { status: "APPROVED" },
        });

        expect(res.statusCode).toBe(200);
      } finally {
        await cleanupTestData(app, d.tenant.id);
      }
    });

    it("allowed: PENDING -> REJECTED review stays allowed in a closed month — 200", async () => {
      const d = await seedTestData(app, "cmg-b3");
      try {
        const createRes = await app.inject({
          method: "POST",
          url: "/api/v1/leave/requests",
          headers: { authorization: `Bearer ${d.empToken}` },
          payload: { type: "SICK", startDate: "2026-03-09", endDate: "2026-03-13" },
        });
        const { id } = JSON.parse(createRes.body);

        await closeMonth(d.employee.id, d.tenant.id, 2026, 3);

        const res = await app.inject({
          method: "PATCH",
          url: `/api/v1/leave/requests/${id}/review`,
          headers: { authorization: `Bearer ${d.adminToken}` },
          payload: { status: "REJECTED" },
        });

        expect(res.statusCode).toBe(200);
        const stored = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id } });
        expect(stored.status).toBe("REJECTED");
      } finally {
        await cleanupTestData(app, d.tenant.id);
      }
    });
  });

  describe("(c) PATCH /requests/:id/review — CANCELLATION_REQUESTED -> CANCELLED", () => {
    it("rejects the cancellation approval touching a closed month — 409, no partial write", async () => {
      const d = await seedTestData(app, "cmg-c1");
      try {
        const typeId = await sickLeaveTypeId(d.tenant.id);
        const leave = await app.prisma.leaveRequest.create({
          data: {
            employeeId: d.employee.id,
            leaveTypeId: typeId,
            startDate: new Date("2026-03-09T00:00:00Z"),
            endDate: new Date("2026-03-13T00:00:00Z"),
            days: 5,
            halfDay: false,
            status: "CANCELLATION_REQUESTED",
            reviewedBy: null, // 4-eyes: must be null or the approver-identity check masks the guard
            cancellationRequestedBy: d.empUser.id,
          },
        });

        await closeMonth(d.employee.id, d.tenant.id, 2026, 3);
        const auditBefore = await auditCount(leave.id);

        const res = await app.inject({
          method: "PATCH",
          url: `/api/v1/leave/requests/${leave.id}/review`,
          headers: { authorization: `Bearer ${d.adminToken}` },
          payload: { status: "APPROVED" },
        });

        expect(res.statusCode).toBe(409);
        const body = JSON.parse(res.body);
        expect(body.code).toBe("LEAVE_MONTH_CLOSED");

        const stored = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: leave.id } });
        expect(stored.status).toBe("CANCELLATION_REQUESTED");
        expect(await auditCount(leave.id)).toBe(auditBefore);
      } finally {
        await cleanupTestData(app, d.tenant.id);
      }
    });

    it("control: the same cancellation approval with no closed month succeeds — 200", async () => {
      const d = await seedTestData(app, "cmg-c2");
      try {
        const typeId = await sickLeaveTypeId(d.tenant.id);
        const leave = await app.prisma.leaveRequest.create({
          data: {
            employeeId: d.employee.id,
            leaveTypeId: typeId,
            startDate: new Date("2026-03-09T00:00:00Z"),
            endDate: new Date("2026-03-13T00:00:00Z"),
            days: 5,
            halfDay: false,
            status: "CANCELLATION_REQUESTED",
            reviewedBy: null,
            cancellationRequestedBy: d.empUser.id,
          },
        });

        const res = await app.inject({
          method: "PATCH",
          url: `/api/v1/leave/requests/${leave.id}/review`,
          headers: { authorization: `Bearer ${d.adminToken}` },
          payload: { status: "APPROVED" },
        });

        expect(res.statusCode).toBe(200);
      } finally {
        await cleanupTestData(app, d.tenant.id);
      }
    });

    it("allowed: rejecting a cancellation stays allowed in a closed month — 200, back to APPROVED", async () => {
      const d = await seedTestData(app, "cmg-c3");
      try {
        const typeId = await sickLeaveTypeId(d.tenant.id);
        const leave = await app.prisma.leaveRequest.create({
          data: {
            employeeId: d.employee.id,
            leaveTypeId: typeId,
            startDate: new Date("2026-03-09T00:00:00Z"),
            endDate: new Date("2026-03-13T00:00:00Z"),
            days: 5,
            halfDay: false,
            status: "CANCELLATION_REQUESTED",
            reviewedBy: null,
            cancellationRequestedBy: d.empUser.id,
          },
        });

        await closeMonth(d.employee.id, d.tenant.id, 2026, 3);

        const res = await app.inject({
          method: "PATCH",
          url: `/api/v1/leave/requests/${leave.id}/review`,
          headers: { authorization: `Bearer ${d.adminToken}` },
          payload: { status: "REJECTED" },
        });

        expect(res.statusCode).toBe(200);
        const stored = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: leave.id } });
        expect(stored.status).toBe("APPROVED");
      } finally {
        await cleanupTestData(app, d.tenant.id);
      }
    });
  });

  describe("(d) DELETE /requests/:id — APPROVED -> CANCELLATION_REQUESTED", () => {
    it("rejects the cancellation request touching a closed month — 409, no partial write", async () => {
      const d = await seedTestData(app, "cmg-d1");
      try {
        const typeId = await sickLeaveTypeId(d.tenant.id);
        const leave = await app.prisma.leaveRequest.create({
          data: {
            employeeId: d.employee.id,
            leaveTypeId: typeId,
            startDate: new Date("2026-03-09T00:00:00Z"),
            endDate: new Date("2026-03-13T00:00:00Z"),
            days: 5,
            halfDay: false,
            status: "APPROVED",
            reviewedBy: null,
          },
        });

        await closeMonth(d.employee.id, d.tenant.id, 2026, 3);
        const auditBefore = await auditCount(leave.id);

        const res = await app.inject({
          method: "DELETE",
          url: `/api/v1/leave/requests/${leave.id}`,
          headers: { authorization: `Bearer ${d.empToken}` },
          payload: { reason: "Storno wegen Fehleingabe" },
        });

        expect(res.statusCode).toBe(409);
        const body = JSON.parse(res.body);
        expect(body.code).toBe("LEAVE_MONTH_CLOSED");

        const stored = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: leave.id } });
        expect(stored.status).toBe("APPROVED");
        expect(stored.cancellationRequestedBy).toBeNull();
        expect(await auditCount(leave.id)).toBe(auditBefore);
      } finally {
        await cleanupTestData(app, d.tenant.id);
      }
    });

    it("control: the same cancellation request with no closed month succeeds — 200", async () => {
      const d = await seedTestData(app, "cmg-d2");
      try {
        const typeId = await sickLeaveTypeId(d.tenant.id);
        const leave = await app.prisma.leaveRequest.create({
          data: {
            employeeId: d.employee.id,
            leaveTypeId: typeId,
            startDate: new Date("2026-03-09T00:00:00Z"),
            endDate: new Date("2026-03-13T00:00:00Z"),
            days: 5,
            halfDay: false,
            status: "APPROVED",
            reviewedBy: null,
          },
        });

        const res = await app.inject({
          method: "DELETE",
          url: `/api/v1/leave/requests/${leave.id}`,
          headers: { authorization: `Bearer ${d.empToken}` },
          payload: { reason: "Storno wegen Fehleingabe" },
        });

        expect(res.statusCode).toBe(200);
      } finally {
        await cleanupTestData(app, d.tenant.id);
      }
    });

    it("allowed: withdrawing a PENDING request stays allowed in a closed month — 204", async () => {
      const d = await seedTestData(app, "cmg-d3");
      try {
        const createRes = await app.inject({
          method: "POST",
          url: "/api/v1/leave/requests",
          headers: { authorization: `Bearer ${d.empToken}` },
          payload: { type: "SICK", startDate: "2026-03-09", endDate: "2026-03-13" },
        });
        const { id } = JSON.parse(createRes.body);

        await closeMonth(d.employee.id, d.tenant.id, 2026, 3);

        const res = await app.inject({
          method: "DELETE",
          url: `/api/v1/leave/requests/${id}`,
          headers: { authorization: `Bearer ${d.empToken}` },
          payload: { reason: "Storno wegen Fehleingabe" },
        });

        expect(res.statusCode).toBe(204);
        const stored = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id } });
        expect(stored.status).toBe("CANCELLED");
      } finally {
        await cleanupTestData(app, d.tenant.id);
      }
    });
  });
});
