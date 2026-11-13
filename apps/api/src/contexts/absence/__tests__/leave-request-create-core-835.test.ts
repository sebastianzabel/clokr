/**
 * Issue #835 (plan 835-01, D-835-12) — the leave-request create core, called directly (no HTTP).
 *
 * `createLeaveRequestCore` was lifted verbatim out of `POST /api/v1/leave/requests`. The route-level
 * behaviour is pinned by the existing `/leave/requests` test family, which runs unchanged; this
 * file pins what only the core exposes: a refusal returned as data with a stable machine `reason`,
 * and the three additive, default-off options (`auditExtra`, `notifyApprovers`,
 * `hooks.inTransaction`).
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
} from "../../../__tests__/setup";
import { getTenantTimezone, monthRangeUtc } from "../../working-time-account";
import { LEAVE_OVERLAP_ERROR } from "../leave-overlap";
import { createLeaveRequestCore, type CreateLeaveRequestInput } from "../leave-request-create";

describe("leave-request create core (Issue #835)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterAll(async () => {
    await closeTestApp();
  });

  type Fixture = Awaited<ReturnType<typeof seedTestData>>;

  /** Own tenant with a 2029 entitlement of `totalDays`; always cleaned up. */
  async function withFixture(
    suffix: string,
    totalDays: number,
    run: (d: Fixture) => Promise<void>,
  ): Promise<void> {
    const d = await seedTestData(app, suffix);
    try {
      await seedEntitlementYears(app, {
        employeeId: d.employee.id,
        leaveTypeId: d.vacationType.id,
        years: [2029],
        totalDays,
      });
      await run(d);
    } finally {
      await cleanupTestData(app, d.tenant.id);
    }
  }

  function input(d: Fixture, overrides: Partial<CreateLeaveRequestInput> = {}) {
    return {
      tenantId: d.tenant.id,
      employeeId: d.employee.id,
      actorUserId: d.empUser.id,
      isOnBehalfOf: false,
      body: {
        type: "VACATION" as const,
        startDate: "2029-07-02",
        endDate: "2029-07-06",
        halfDay: false,
      },
      ...overrides,
    } satisfies CreateLeaveRequestInput;
  }

  async function createRows(d: Fixture) {
    return app.prisma.leaveRequest.count({ where: { employeeId: d.employee.id } });
  }

  async function createAudits(d: Fixture, actor: string) {
    return app.prisma.auditLog.count({
      where: { entity: "LeaveRequest", action: "CREATE", userId: actor },
    });
  }

  it("a request in a closed month is refused CLOSED_MONTH (409) as data; no row, no CREATE audit", async () => {
    await withFixture("lrc835-a", 30, async (d) => {
      const tz = await getTenantTimezone(app.prisma, d.tenant.id);
      const { start, end } = monthRangeUtc(2029, 3, tz);
      await app.prisma.saldoSnapshot.create({
        data: {
          employeeId: d.employee.id,
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

      const outcome = await createLeaveRequestCore(
        app,
        input(d, {
          body: { type: "SICK", startDate: "2029-03-12", endDate: "2029-03-16", halfDay: false },
        }),
      );

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.statusCode).toBe(409);
      expect(outcome.reason).toBe("CLOSED_MONTH");
      expect(outcome.body.code).toBe("LEAVE_MONTH_CLOSED");
      expect(await createRows(d)).toBe(0);
      expect(await createAudits(d, d.empUser.id)).toBe(0);
    });
  });

  it("a request overlapping an APPROVED vacation of the same person is refused OVERLAP", async () => {
    await withFixture("lrc835-b", 30, async (d) => {
      await app.prisma.leaveRequest.create({
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

      const outcome = await createLeaveRequestCore(
        app,
        input(d, {
          body: {
            type: "VACATION",
            startDate: "2029-07-04",
            endDate: "2029-07-10",
            halfDay: false,
          },
        }),
      );

      expect(outcome).toEqual({
        ok: false,
        statusCode: 409,
        body: { error: LEAVE_OVERLAP_ERROR },
        reason: "OVERLAP",
      });
      expect(await createRows(d)).toBe(1);
    });
  });

  it("a vacation larger than the remaining entitlement is refused INSUFFICIENT_DAYS_YEAR_1 with available and requested", async () => {
    await withFixture("lrc835-c", 2, async (d) => {
      const outcome = await createLeaveRequestCore(app, input(d));

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.statusCode).toBe(400);
      expect(outcome.reason).toBe("INSUFFICIENT_DAYS_YEAR_1");
      expect(outcome.body.error).toBe("Nicht genug Urlaubstage in 2029");
      expect(outcome.body.available).toBe(2);
      expect(outcome.body.requested).toBe(5);
      expect(await createRows(d)).toBe(0);
    });
  });

  it("success without options: one row, the standard CREATE audit keys, one approver notification", async () => {
    await withFixture("lrc835-d", 30, async (d) => {
      const outcome = await createLeaveRequestCore(app, input(d));

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.pricedDays).toBe(5);
      expect(outcome.request.employeeId).toBe(d.employee.id);
      expect(outcome.request.status).toBe("PENDING");
      expect(await createRows(d)).toBe(1);

      const audit = await soleAuditRow(app.prisma, {
        where: { entity: "LeaveRequest", entityId: outcome.request.id, action: "CREATE" },
      });
      expect(audit.userId).toBe(d.empUser.id);
      expect(Object.keys(audit.newValue as Record<string, unknown>).sort()).toEqual([
        "days",
        "endDate",
        "startDate",
        "type",
      ]);
      expect(audit.newValue).toMatchObject({
        type: "VACATION",
        startDate: "2029-07-02",
        endDate: "2029-07-06",
        days: 5,
      });

      const notices = await app.prisma.notification.findMany({
        where: { type: "LEAVE_REQUEST", relatedId: outcome.request.id },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      expect(notices.map((n) => n.userId)).toEqual([d.adminUser.id]);
    });
  });

  it("a request filed on behalf of someone carries source and targetEmployeeId in the CREATE audit", async () => {
    await withFixture("lrc835-e", 30, async (d) => {
      const outcome = await createLeaveRequestCore(
        app,
        input(d, { actorUserId: d.adminUser.id, isOnBehalfOf: true }),
      );

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const audit = await soleAuditRow(app.prisma, {
        where: { entity: "LeaveRequest", entityId: outcome.request.id, action: "CREATE" },
      });
      expect(audit.userId).toBe(d.adminUser.id);
      expect(Object.keys(audit.newValue as Record<string, unknown>).sort()).toEqual([
        "days",
        "endDate",
        "source",
        "startDate",
        "targetEmployeeId",
        "type",
      ]);
      expect(audit.newValue).toMatchObject({
        source: "MANAGER_CREATED",
        targetEmployeeId: d.employee.id,
      });
    });
  });

  it("notifyApprovers: false creates no LEAVE_REQUEST notification for the new request", async () => {
    await withFixture("lrc835-f", 30, async (d) => {
      const outcome = await createLeaveRequestCore(app, input(d, { notifyApprovers: false }));

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const notices = await app.prisma.notification.findMany({
        where: { type: "LEAVE_REQUEST", relatedId: outcome.request.id },
      });
      expect(notices).toHaveLength(0);
    });
  });

  it("auditExtra adds its keys to the CREATE audit newValue next to the standard ones", async () => {
    await withFixture("lrc835-g", 30, async (d) => {
      const outcome = await createLeaveRequestCore(
        app,
        input(d, {
          auditExtra: { trigger: "LEAVE_PLAN", leavePlanId: "p", leavePlanWishId: "w" },
        }),
      );

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const audit = await soleAuditRow(app.prisma, {
        where: { entity: "LeaveRequest", entityId: outcome.request.id, action: "CREATE" },
      });
      // jsonb does not keep key order, so only the key set and the values are observable.
      expect(Object.keys(audit.newValue as Record<string, unknown>).sort()).toEqual([
        "days",
        "endDate",
        "leavePlanId",
        "leavePlanWishId",
        "startDate",
        "trigger",
        "type",
      ]);
      expect(audit.newValue).toMatchObject({
        type: "VACATION",
        days: 5,
        trigger: "LEAVE_PLAN",
        leavePlanId: "p",
        leavePlanWishId: "w",
      });
    });
  });

  it("an inTransaction hook that throws rolls the create back; the error reaches the caller", async () => {
    await withFixture("lrc835-h", 30, async (d) => {
      await expect(
        createLeaveRequestCore(app, input(d), {
          inTransaction: async (tx, row) => {
            // A write inside the transaction first, so the rollback has something to undo.
            await tx.leaveRequest.update({ where: { id: row.id }, data: { note: "hooked" } });
            throw new Error("hook boom");
          },
        }),
      ).rejects.toThrow("hook boom");

      expect(await createRows(d)).toBe(0);
      expect(await createAudits(d, d.empUser.id)).toBe(0);
    });
  });

  it("an inTransaction hook receives the new row id and its write commits with the row", async () => {
    await withFixture("lrc835-i", 30, async (d) => {
      let seenId: string | null = null;
      const outcome = await createLeaveRequestCore(app, input(d), {
        inTransaction: async (tx, row) => {
          seenId = row.id;
          await tx.leaveRequest.update({ where: { id: row.id }, data: { note: "hooked" } });
        },
      });

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(seenId).toBe(outcome.request.id);
      const stored = await app.prisma.leaveRequest.findFirstOrThrow({
        where: { id: outcome.request.id, deletedAt: null },
      });
      expect(stored.note).toBe("hooked");
    });
  });
});
