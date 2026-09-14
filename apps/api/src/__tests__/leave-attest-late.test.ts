/**
 * Phase 201 / Issue #201 — PIN tests for the attest handler's deliberate lack of guards.
 *
 * These are characterisation tests, not feature tests: 4 of the 5 `it` blocks below are
 * green BEFORE Task 1's edits — that is the point. They pin a deliberate ABSENCE of a status
 * guard and a deliberate ABSENCE of a Monatsabschluss (locked-month) guard on
 * `PATCH /api/v1/leave/requests/:id/attest`, so a future "defensive" commit that adds either
 * guard turns one of these tests red instead of silently shipping a regression. Only Test 3
 * (the hardened audit shape) is red before Task 1 — it measures the production change Task 1
 * makes.
 *
 * See `.planning/phases/201-krankheitsfall-attest-nachtragbar-halbtag/201-CONTEXT.md`
 * ("Attest after Monatsabschluss — LOCKED") and the decision comment directly above
 * `leave.ts`'s attest handler `update()` call for the reasoning this file pins.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { monthRangeUtc } from "../utils/timezone";
import type { FastifyInstance } from "fastify";

describe("Leave / Attest — late (post-approval, post-Monatsabschluss) recording", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterAll(async () => {
    await closeTestApp();
  });

  /** Creates a SICK request for the given employee/token and approves it as admin. */
  async function createApprovedSickRequest(
    empToken: string,
    adminToken: string,
    startDate: string,
    endDate: string,
  ): Promise<string> {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${empToken}` },
      payload: { type: "SICK", startDate, endDate },
    });
    expect(createRes.statusCode).toBe(201);
    const { id: requestId } = JSON.parse(createRes.body);

    // Requests are created PENDING regardless of LeaveType.requiresApproval (leave.ts:674-688
    // sets no status) — an explicit review call is required, auto-approval cannot be assumed.
    const reviewRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${requestId}/review`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: "APPROVED" },
    });
    expect(reviewRes.statusCode).toBe(200);

    return requestId;
  }

  it("Test 1 (PIN): a manager can set an Attest on an APPROVED request — 200, persisted", async () => {
    const d = await seedTestData(app, "at1");
    try {
      const requestId = await createApprovedSickRequest(
        d.empToken,
        d.adminToken,
        "2027-03-15",
        "2027-03-17",
      );

      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/requests/${requestId}/attest`,
        headers: { authorization: `Bearer ${d.adminToken}` },
        payload: {
          attestPresent: true,
          attestValidFrom: "2027-03-15",
          attestValidTo: "2027-03-17",
        },
      });
      expect(res.statusCode).toBe(200);

      const stored = await app.prisma.leaveRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
      expect(stored.attestPresent).toBe(true);
    } finally {
      await cleanupTestData(app, d.tenant.id);
    }
  });

  it("Test 2 (PIN): a manager can set an Attest after Monatsabschluss (closed month) — 200, persisted", async () => {
    const d = await seedTestData(app, "at2");
    try {
      const requestId = await createApprovedSickRequest(
        d.empToken,
        d.adminToken,
        "2027-04-10",
        "2027-04-12",
      );

      // Close the month AFTER approval, mirroring auto-close-month.test.ts:513-533 — a
      // MONTHLY, superseded:false SaldoSnapshot is the canonical closed-month signal
      // (leave.ts:1745-1755, the correction handler's own guard uses this exact check).
      const { start, end } = monthRangeUtc(2027, 4, "Europe/Berlin");
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

      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/requests/${requestId}/attest`,
        headers: { authorization: `Bearer ${d.adminToken}` },
        payload: {
          attestPresent: true,
          attestValidFrom: "2027-04-10",
          attestValidTo: "2027-04-12",
        },
      });
      expect(res.statusCode).toBe(200);

      const stored = await app.prisma.leaveRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
      expect(stored.attestPresent).toBe(true);
      expect(stored.attestValidFrom?.toISOString().split("T")[0]).toBe("2027-04-10");
      expect(stored.attestValidTo?.toISOString().split("T")[0]).toBe("2027-04-12");
    } finally {
      await cleanupTestData(app, d.tenant.id);
    }
  });

  it("Test 3: the audit entry carries before/after attestPresent and a non-null ipAddress", async () => {
    const d = await seedTestData(app, "at3");
    try {
      const requestId = await createApprovedSickRequest(
        d.empToken,
        d.adminToken,
        "2027-05-05",
        "2027-05-06",
      );

      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/requests/${requestId}/attest`,
        headers: { authorization: `Bearer ${d.adminToken}` },
        payload: {
          attestPresent: true,
          attestValidFrom: "2027-05-05",
          attestValidTo: "2027-05-06",
        },
      });
      expect(res.statusCode).toBe(200);

      const audit = await app.prisma.auditLog.findFirst({
        where: { entity: "LeaveRequest", entityId: requestId, action: "UPDATE" },
        orderBy: { createdAt: "desc" },
      });
      expect(audit).not.toBeNull();

      const oldValue = audit!.oldValue as unknown as { attestPresent: boolean };
      const newValue = audit!.newValue as unknown as { attestPresent: boolean };
      expect(oldValue.attestPresent).toBe(false);
      expect(newValue.attestPresent).toBe(true);
      expect(audit!.ipAddress).not.toBeNull();
    } finally {
      await cleanupTestData(app, d.tenant.id);
    }
  });

  it("Test 4: an EMPLOYEE cannot set an Attest — 403, unchanged in the DB", async () => {
    const d = await seedTestData(app, "at4");
    try {
      const requestId = await createApprovedSickRequest(
        d.empToken,
        d.adminToken,
        "2027-06-01",
        "2027-06-02",
      );

      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/requests/${requestId}/attest`,
        headers: { authorization: `Bearer ${d.empToken}` },
        payload: { attestPresent: true },
      });
      expect(res.statusCode).toBe(403);

      const stored = await app.prisma.leaveRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
      expect(stored.attestPresent).toBe(false);
    } finally {
      await cleanupTestData(app, d.tenant.id);
    }
  });

  it("Test 5 (PIN): clearing a wrongly recorded Attest works on a closed month too — 200, dates nulled", async () => {
    const d = await seedTestData(app, "at5");
    try {
      const requestId = await createApprovedSickRequest(
        d.empToken,
        d.adminToken,
        "2027-07-20",
        "2027-07-21",
      );

      const { start, end } = monthRangeUtc(2027, 7, "Europe/Berlin");
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

      // First set it (wrongly), then clear it — the correction direction matters just as
      // much as the initial recording: a false "mit Attest" line in an issued report must
      // also be correctable, not just an initially-missing one fillable.
      const setRes = await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/requests/${requestId}/attest`,
        headers: { authorization: `Bearer ${d.adminToken}` },
        payload: {
          attestPresent: true,
          attestValidFrom: "2027-07-20",
          attestValidTo: "2027-07-21",
        },
      });
      expect(setRes.statusCode).toBe(200);

      const clearRes = await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/requests/${requestId}/attest`,
        headers: { authorization: `Bearer ${d.adminToken}` },
        payload: { attestPresent: false },
      });
      expect(clearRes.statusCode).toBe(200);

      const stored = await app.prisma.leaveRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
      expect(stored.attestPresent).toBe(false);
      expect(stored.attestValidFrom).toBeNull();
      expect(stored.attestValidTo).toBeNull();
    } finally {
      await cleanupTestData(app, d.tenant.id);
    }
  });
});
