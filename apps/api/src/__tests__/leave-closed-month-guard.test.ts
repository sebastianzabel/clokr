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
});
