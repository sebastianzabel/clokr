/**
 * Issue #468, finding 1 (D-02/D-03/A-4) — the minutes an approved `OVERTIME_COMP` request books
 * are persisted on `LeaveRequest.overtimeCompMinutes`, in the SAME transaction as the REDUCTION
 * journal row, and audited (`OVERTIME_COMP_BOOKED`). Storno/correction reverse exactly that
 * STORED value — never a recomputation — audited (`OVERTIME_COMP_REVERSED`) with the amount and
 * its `source` ("stored" vs. the legacy "recomputed" fallback for a pre-#468 row with no stored
 * value). D-03: a closed month still blocks the cancellation-approval review, writing no new
 * journal row.
 *
 * RED before the Task 1 schema + leave.ts review-path changes: `overtimeCompMinutes` does not
 * exist on `LeaveRequest` (no column to write to, no `OVERTIME_COMP_BOOKED` audit action), and a
 * retroactive schedule edit between approval and cancellation-approval changes the CORRECTION
 * amount (8h booked -> 6h reversed instead of 8h), because every call site recomputes from the
 * request's current dates/schedule instead of reading back what was actually booked.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { leaveTypeFields } from "../contexts/absence/leave-type";
import type { FastifyInstance } from "fastify";

describe("Überstundenausgleich — stored booking / stored reversal (Issue #468, D-02/D-03/A-4)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let overtimeCompTypeId: string;
  /** Second approver: the 4-eyes rule (COMP-V1814-02) blocks the manager who approved the leave
   *  (or who requested its cancellation) from also approving the cancellation. */
  let secondManagerToken: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "ot468b");

    const overtimeCompType = await app.prisma.leaveType.create({
      data: { tenantId: data.tenant.id, ...leaveTypeFields("OVERTIME_COMP"), color: "#8B5CF6" },
    });
    overtimeCompTypeId = overtimeCompType.id;

    const mgrUser = await app.prisma.user.create({
      data: {
        email: `ot468b-mgr2-${Date.now().toString(36)}@test.de`,
        passwordHash: data.adminUser.passwordHash,
        role: "MANAGER",
        isActive: true,
      },
    });
    await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: mgrUser.id,
        employeeNumber: `OT468-CM2-${Date.now().toString(36)}`,
        firstName: "ZW",
        lastName: "PR",
        hireDate: new Date("2024-01-01"),
      },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: mgrUser.email, password: "test1234" },
    });
    secondManagerToken = JSON.parse(login.body).accessToken;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("leave-overtime-comp-booking-468 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("B1: approval stores overtimeCompMinutes=480 and writes exactly one -8.00 REDUCTION + an OVERTIME_COMP_BOOKED audit; a retroactive schedule edit does NOT change what the cancellation reverses", async () => {
    const leave = await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: overtimeCompTypeId,
        startDate: new Date("2027-03-01"), // Monday — fixture schedule grants 8h
        endDate: new Date("2027-03-01"),
        days: 1,
        status: "PENDING",
      },
    });

    const acct = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: data.employee.id },
    });
    await app.prisma.overtimeTransaction.deleteMany({ where: { overtimeAccountId: acct!.id } });

    const approveRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${leave.id}/review`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { status: "APPROVED" },
    });
    expect(approveRes.statusCode, approveRes.body).toBe(200);
    const approveBody = JSON.parse(approveRes.body);
    expect(approveBody.overtimeCompMinutes, "stores the booked minutes on the row").toBe(480);

    const reloadedAfterApproval = await app.prisma.leaveRequest.findUnique({
      where: { id: leave.id },
    });
    expect(reloadedAfterApproval?.overtimeCompMinutes).toBe(480);

    const txsAfterApproval = await app.prisma.overtimeTransaction.findMany({
      where: { overtimeAccountId: acct!.id },
    });
    expect(txsAfterApproval).toHaveLength(1);
    expect(txsAfterApproval[0].type).toBe("REDUCTION");
    expect(Number(txsAfterApproval[0].hours)).toBe(-8);

    const bookedAudits = await app.prisma.auditLog.findMany({
      where: { entity: "LeaveRequest", entityId: leave.id, action: "OVERTIME_COMP_BOOKED" },
    });
    expect(bookedAudits).toHaveLength(1);
    expect((bookedAudits[0].newValue as Record<string, unknown>).overtimeCompMinutes).toBe(480);

    // ── then: a retroactive schedule edit must NOT change the stored booking's reversal ──
    await app.prisma.workSchedule.updateMany({
      where: { employeeId: data.employee.id },
      data: { mondayHours: 6 },
    });

    try {
      const delRes = await app.inject({
        method: "DELETE",
        url: `/api/v1/leave/requests/${leave.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { reason: "Ausgleichstag wird nicht genommen" },
      });
      expect(delRes.statusCode, delRes.body).toBe(200);
      expect(JSON.parse(delRes.body).status).toBe("CANCELLATION_REQUESTED");

      const cancelRes = await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/requests/${leave.id}/review`,
        headers: { authorization: `Bearer ${secondManagerToken}` },
        payload: { status: "APPROVED" },
      });
      expect(cancelRes.statusCode, cancelRes.body).toBe(200);
      expect(JSON.parse(cancelRes.body).status).toBe("CANCELLED");

      const txsAfterCancel = await app.prisma.overtimeTransaction.findMany({
        where: { overtimeAccountId: acct!.id },
        orderBy: { createdAt: "asc" },
      });
      expect(txsAfterCancel.map((t) => t.type)).toEqual(["REDUCTION", "CORRECTION"]);
      expect(
        Number(txsAfterCancel[1].hours),
        "reverses the STORED 480 min (8h) booking, not the schedule-edited 6h",
      ).toBe(8);

      const reversedAudits = await app.prisma.auditLog.findMany({
        where: { entity: "LeaveRequest", entityId: leave.id, action: "OVERTIME_COMP_REVERSED" },
      });
      expect(reversedAudits).toHaveLength(1);
      const reversedValue = reversedAudits[0].newValue as Record<string, unknown>;
      expect(reversedValue.overtimeCompMinutes).toBe(480);
      expect(reversedValue.source).toBe("stored");

      const finalRow = await app.prisma.leaveRequest.findUnique({ where: { id: leave.id } });
      expect(finalRow?.overtimeCompMinutes, "history is not overwritten").toBe(480);
    } finally {
      // revert the schedule edit so later tests in this file are unaffected
      await app.prisma.workSchedule.updateMany({
        where: { employeeId: data.employee.id },
        data: { mondayHours: 8 },
      });
    }
  });

  it("B2 (legacy): a cancellation of an APPROVED request with no stored value recomputes the reversal and audits source 'recomputed'", async () => {
    const leave = await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: overtimeCompTypeId,
        startDate: new Date("2027-03-08"), // Monday
        endDate: new Date("2027-03-08"),
        days: 1,
        status: "APPROVED",
        overtimeCompMinutes: null,
        reviewedBy: data.adminUser.id,
      },
    });

    const acct = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: data.employee.id },
    });
    await app.prisma.overtimeTransaction.deleteMany({ where: { overtimeAccountId: acct!.id } });

    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/leave/requests/${leave.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { reason: "Ausgleichstag wird nicht genommen" },
    });
    expect(delRes.statusCode, delRes.body).toBe(200);

    const cancelRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${leave.id}/review`,
      headers: { authorization: `Bearer ${secondManagerToken}` },
      payload: { status: "APPROVED" },
    });
    expect(cancelRes.statusCode, cancelRes.body).toBe(200);

    const txs = await app.prisma.overtimeTransaction.findMany({
      where: { overtimeAccountId: acct!.id },
    });
    expect(txs).toHaveLength(1);
    expect(txs[0].type).toBe("CORRECTION");
    expect(Number(txs[0].hours)).toBe(8);

    const reversedAudits = await app.prisma.auditLog.findMany({
      where: { entity: "LeaveRequest", entityId: leave.id, action: "OVERTIME_COMP_REVERSED" },
    });
    expect(reversedAudits).toHaveLength(1);
    expect((reversedAudits[0].newValue as Record<string, unknown>).source).toBe("recomputed");
  });

  it("rejecting a PENDING OVERTIME_COMP request writes no journal row and leaves overtimeCompMinutes null", async () => {
    const leave = await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: overtimeCompTypeId,
        startDate: new Date("2027-03-15"),
        endDate: new Date("2027-03-15"),
        days: 1,
        status: "PENDING",
      },
    });
    const acct = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: data.employee.id },
    });
    const before = await app.prisma.overtimeTransaction.count({
      where: { overtimeAccountId: acct!.id },
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${leave.id}/review`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { status: "REJECTED" },
    });
    expect(res.statusCode, res.body).toBe(200);

    const after = await app.prisma.overtimeTransaction.count({
      where: { overtimeAccountId: acct!.id },
    });
    expect(after).toBe(before);

    const reloaded = await app.prisma.leaveRequest.findUnique({ where: { id: leave.id } });
    expect(reloaded?.overtimeCompMinutes).toBeNull();
  });

  it("D-03: a cancellation-approval review touching a closed month answers 409 and writes NO new OvertimeTransaction row", async () => {
    const leave = await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: overtimeCompTypeId,
        startDate: new Date("2027-05-03"), // Monday
        endDate: new Date("2027-05-03"),
        days: 1,
        status: "PENDING",
      },
    });

    const approveRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${leave.id}/review`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { status: "APPROVED" },
    });
    expect(approveRes.statusCode, approveRes.body).toBe(200);

    const acct = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: data.employee.id },
    });
    const countAfterApproval = await app.prisma.overtimeTransaction.count({
      where: { overtimeAccountId: acct!.id },
    });

    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/leave/requests/${leave.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { reason: "Ausgleichstag wird nicht genommen" },
    });
    expect(delRes.statusCode, delRes.body).toBe(200);

    try {
      await app.prisma.saldoSnapshot.create({
        data: {
          employeeId: data.employee.id,
          periodType: "MONTHLY",
          periodStart: new Date("2027-05-01T00:00:00Z"),
          periodEnd: new Date("2027-05-31T00:00:00Z"),
          workedMinutes: 0,
          expectedMinutes: 0,
          balanceMinutes: 0,
          carryOver: 0,
          closedAt: new Date(),
          closedBy: "test-system",
        },
      });

      const cancelRes = await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/requests/${leave.id}/review`,
        headers: { authorization: `Bearer ${secondManagerToken}` },
        payload: { status: "APPROVED" },
      });
      expect(cancelRes.statusCode, cancelRes.body).toBe(409);

      const countAfterCancelAttempt = await app.prisma.overtimeTransaction.count({
        where: { overtimeAccountId: acct!.id },
      });
      expect(countAfterCancelAttempt).toBe(countAfterApproval);
    } finally {
      await app.prisma.saldoSnapshot.deleteMany({
        where: { employeeId: data.employee.id, periodStart: new Date("2027-05-01T00:00:00Z") },
      });
    }
  });
});
