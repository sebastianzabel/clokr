/**
 * Issue #835 (plan 835-02, D-835-12) — the leave-request decision core, called directly (no HTTP).
 *
 * `decidePendingLeaveRequest` / `leaveDecisionGuard` were lifted verbatim out of
 * `PATCH /api/v1/leave/requests/:id/review`. The route-level behaviour is pinned by the existing
 * `/leave/requests` test family, which runs unchanged; this file pins what only the core exposes:
 * the guard's refusals as data with a stable machine `reason`, an approval that needs no HTTP
 * request (the reviewer and the audit request meta are inputs), and the limit refusal returned as
 * raw data for the route to render.
 *
 * One fixture per case (own tenant, cleaned in `finally`), far-future dates (2029) so no case
 * depends on the calendar. Audits and notifications are read through the ordered helpers only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  seedEntitlementYears,
  soleAuditRow,
  soleNotification,
} from "../../../__tests__/setup";
import {
  approveLeaveRequestCore,
  decidePendingLeaveRequest,
  leaveDecisionGuard,
  loadLeaveRequestForReview,
} from "../leave-decision";

const REQUEST_META = { ip: "127.0.0.1", headers: {} } as const;
const LIMIT_REASON = "Teamabsprache Urlaubsplanung";

describe("leave-request decision core (Issue #835)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterAll(async () => {
    await closeTestApp();
  });

  type Fixture = Awaited<ReturnType<typeof seedTestData>>;

  /** Own tenant with a 2029 entitlement of 30 days; always cleaned up. */
  async function withFixture(suffix: string, run: (d: Fixture) => Promise<void>): Promise<void> {
    const d = await seedTestData(app, suffix);
    try {
      await seedEntitlementYears(app, {
        employeeId: d.employee.id,
        leaveTypeId: d.vacationType.id,
        years: [2029],
        totalDays: 30,
      });
      await run(d);
    } finally {
      await cleanupTestData(app, d.tenant.id);
    }
  }

  function pendingVacation(d: Fixture) {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId: d.employee.id,
        leaveTypeId: d.vacationType.id,
        startDate: new Date("2029-07-02"),
        endDate: new Date("2029-07-06"),
        days: 5,
        status: "PENDING",
      },
    });
  }

  async function loaded(id: string) {
    const existing = await loadLeaveRequestForReview(app, id);
    if (!existing) throw new Error("fixture request not found");
    return existing;
  }

  async function usedDays(d: Fixture) {
    const row = await app.prisma.leaveEntitlement.findFirstOrThrow({
      where: { employeeId: d.employee.id, leaveTypeId: d.vacationType.id, year: 2029 },
    });
    return Number(row.usedDays);
  }

  it("the guard refuses a reviewer who is the request's own employee: SELF_APPROVAL (403)", async () => {
    await withFixture("ldc835-a", async (d) => {
      const request = await pendingVacation(d);

      const refusal = await leaveDecisionGuard(app, {
        existing: await loaded(request.id),
        reviewerUserId: d.empUser.id,
      });

      expect(refusal).toMatchObject({ ok: false, statusCode: 403, reason: "SELF_APPROVAL" });
    });
  });

  it("the guard refuses a request that is no longer decidable: NOT_DECIDABLE (409)", async () => {
    await withFixture("ldc835-b", async (d) => {
      const request = await app.prisma.leaveRequest.create({
        data: {
          employeeId: d.employee.id,
          leaveTypeId: d.vacationType.id,
          startDate: new Date("2029-07-02"),
          endDate: new Date("2029-07-06"),
          days: 5,
          status: "APPROVED",
          reviewedBy: "system",
          reviewedAt: new Date(),
        },
      });

      const refusal = await leaveDecisionGuard(app, {
        existing: await loaded(request.id),
        reviewerUserId: d.adminUser.id,
      });

      expect(refusal).toMatchObject({ ok: false, statusCode: 409, reason: "NOT_DECIDABLE" });
    });
  });

  it("the guard lets a PENDING request of another person through (null)", async () => {
    await withFixture("ldc835-c", async (d) => {
      const request = await pendingVacation(d);

      const refusal = await leaveDecisionGuard(app, {
        existing: await loaded(request.id),
        reviewerUserId: d.adminUser.id,
      });

      expect(refusal).toBeNull();
    });
  });

  it("approveLeaveRequestCore without an HTTP request approves, audits with the reviewer, notifies and deducts", async () => {
    await withFixture("ldc835-d", async (d) => {
      const request = await pendingVacation(d);
      const before = await usedDays(d);

      const outcome = await approveLeaveRequestCore(app, {
        existing: await loaded(request.id),
        reviewerUserId: d.adminUser.id,
        reviewNote: "passt",
        request: REQUEST_META,
      });

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.updated.status).toBe("APPROVED");
      expect(outcome.updated.reviewedBy).toBe(d.adminUser.id);
      expect(outcome.responseExtras).toEqual({});

      const stored = await app.prisma.leaveRequest.findFirstOrThrow({
        where: { id: request.id, deletedAt: null },
      });
      expect(stored.status).toBe("APPROVED");
      expect(stored.reviewedBy).toBe(d.adminUser.id);
      expect(stored.reviewNote).toBe("passt");

      const audit = await soleAuditRow(app.prisma, {
        where: { entity: "LeaveRequest", entityId: request.id, action: "APPROVE" },
      });
      expect(audit.userId).toBe(d.adminUser.id);
      expect(audit.ipAddress).toBe("127.0.0.1");
      expect(audit.newValue).toMatchObject({ status: "APPROVED", reviewNote: "passt" });

      const notice = await soleNotification(app.prisma, {
        where: { type: "LEAVE_APPROVED", userId: d.empUser.id },
      });
      expect(notice.link).toBe(`/leave?request=${request.id}`);

      expect(await usedDays(d)).toBe(before + 5);
    });
  });

  it("decidePendingLeaveRequest with REJECTED rejects, deducts nothing and notifies LEAVE_REJECTED", async () => {
    await withFixture("ldc835-e", async (d) => {
      const request = await pendingVacation(d);
      const before = await usedDays(d);

      const outcome = await decidePendingLeaveRequest(app, {
        existing: await loaded(request.id),
        status: "REJECTED",
        reviewerUserId: d.adminUser.id,
        request: REQUEST_META,
      });

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.updated.status).toBe("REJECTED");
      expect(await usedDays(d)).toBe(before);
      await soleAuditRow(app.prisma, {
        where: { entity: "LeaveRequest", entityId: request.id, action: "REJECT" },
      });
      await soleNotification(app.prisma, {
        where: { type: "LEAVE_REJECTED", userId: d.empUser.id },
      });
    });
  });

  describe("a salon limit", () => {
    async function withLimit(suffix: string, run: (d: Fixture) => Promise<void>) {
      await withFixture(suffix, async (d) => {
        await app.prisma.employeeSalonAssignment.create({
          data: {
            tenantId: d.tenant.id,
            employeeId: d.employee.id,
            salonId: d.salonId,
            kind: "HOME",
            validFrom: new Date("2024-01-01T00:00:00Z"),
            validUntil: null,
            weekdays: [],
          },
        });
        await app.prisma.leaveLimitRule.create({
          data: {
            tenantId: d.tenant.id,
            salonId: d.salonId,
            groupKind: "ALL",
            maxPersons: 0,
            name: "Blackout fixture",
          },
        });
        await run(d);
      });
    }

    it("without an exception reason the approval is returned as data: LIMIT_EXCEPTION_REQUIRED, the row stays PENDING", async () => {
      await withLimit("ldc835-f", async (d) => {
        const request = await pendingVacation(d);

        const outcome = await approveLeaveRequestCore(app, {
          existing: await loaded(request.id),
          reviewerUserId: d.adminUser.id,
          request: REQUEST_META,
        });

        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.statusCode).toBe(409);
        expect(outcome.reason).toBe("LIMIT_EXCEPTION_REQUIRED");
        expect(outcome.limit?.exceedances.length).toBeGreaterThan(0);
        expect(outcome.limit?.personNames).toBeInstanceOf(Map);

        const stored = await app.prisma.leaveRequest.findFirstOrThrow({
          where: { id: request.id, deletedAt: null },
        });
        expect(stored.status).toBe("PENDING");
        expect(stored.reviewedAt).toBeNull();
      });
    });

    it("with an exception reason the approval goes through and the APPROVE audit carries the reason", async () => {
      await withLimit("ldc835-g", async (d) => {
        const request = await pendingVacation(d);

        const outcome = await approveLeaveRequestCore(app, {
          existing: await loaded(request.id),
          reviewerUserId: d.adminUser.id,
          limitException: { reason: LIMIT_REASON },
          request: REQUEST_META,
        });

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.updated.status).toBe("APPROVED");

        const audit = await soleAuditRow(app.prisma, {
          where: { entity: "LeaveRequest", entityId: request.id, action: "APPROVE" },
        });
        const exception = (audit.newValue as { leaveLimitException?: { reason: string } })
          .leaveLimitException;
        expect(exception?.reason).toBe(LIMIT_REASON);
      });
    });
  });
});
