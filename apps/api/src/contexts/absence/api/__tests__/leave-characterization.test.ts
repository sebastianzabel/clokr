/**
 * Phase 113b CHARACTERIZATION test, written before the #99 context split.
 *
 * Selected by docs/characterization-baseline.md § 6 "The D-06 shortlist" — `leave.ts` row:
 * below-average line coverage in its own area (abwesenheiten, 85.3% vs. 88.4%) AND named by
 * #100's cross-context-access list (`leave.ts` reads/writes `timeEntry` and `shift`).
 *
 * These tests pin TODAY's behavior of `PATCH /leave/requests/:id/review`'s CANCELLATION_REQUESTED
 * -> APPROVED branch (leave.ts:975-1064) — the "Rückbuchung" (roll-back) that runs when a
 * manager approves the CANCELLATION of an already-APPROVED leave request. Per
 * `docs/characterization-baseline.md`'s own coverage measurement this branch's OVERTIME_COMP arm
 * (leave.ts:1013-1048) had ZERO statement coverage before this file.
 *
 * A failure here after the #99/#100 rebuild means the rebuild changed observable behavior, which
 * the rebuild promised not to do (#99's own acceptance criteria call the move a "reine
 * Verschiebung: keine Verhaltensänderung").
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
} from "../../../../__tests__/setup";
import { holidayFreeMondayStr } from "../../../../__tests__/test-dates";
import { leaveTypeFields } from "../../leave-type";
import { computeOvertimeBalanceHours } from "../../../time-tracking/api/time-entries";
import type { FastifyInstance } from "fastify";

describe("leave.ts characterization — cancellation-approval Rückbuchung (Phase 113b)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "leave-char");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("approving a CANCELLATION_REQUESTED VACATION leave: status -> CANCELLED, invalidated TimeEntry rows are revalidated, and LeaveEntitlement.usedDays is decremented by the request's days", async () => {
    const dateIso = holidayFreeMondayStr(6);

    await app.prisma.leaveEntitlement.updateMany({
      where: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        year: new Date(dateIso).getFullYear(),
      },
      data: { usedDays: 5 },
    });

    const leave = await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        startDate: new Date(dateIso),
        endDate: new Date(dateIso),
        days: 1,
        status: "CANCELLATION_REQUESTED",
        cancellationRequestedBy: data.empUser.id,
      },
    });

    const timeEntry = await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: new Date(dateIso),
        startTime: new Date(`${dateIso}T08:00:00Z`),
        isInvalid: true,
        invalidReasonCode: "LEAVE_CANCELLATION_PENDING",
        invalidReason: "Urlaubsstornierung ausstehend",
      },
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${leave.id}/review`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { status: "APPROVED", reviewNote: "Storno OK" },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status, "pins CANCELLATION_REQUESTED -> CANCELLED on approval").toBe("CANCELLED");

    const reloadedEntry = await app.prisma.timeEntry.findUnique({ where: { id: timeEntry.id } });
    expect(
      reloadedEntry?.isInvalid,
      "pins that the pending-cancellation TimeEntry is revalidated",
    ).toBe(false);
    expect(reloadedEntry?.invalidReasonCode).toBeNull();

    const entitlement = await app.prisma.leaveEntitlement.findFirst({
      where: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        year: new Date(dateIso).getFullYear(),
      },
    });
    expect(
      Number(entitlement?.usedDays),
      "pins the VACATION-only usedDays roll-back on cancellation approval (5 - 1 day)",
    ).toBe(4);
  });

  it("approving a CANCELLATION_REQUESTED SICK leave: status -> CANCELLED, TimeEntry revalidated, no LeaveEntitlement or OvertimeAccount side effect ('entitlement-neutral on the apply side')", async () => {
    const dateIso = holidayFreeMondayStr(8);
    const sickType = await app.prisma.leaveType.create({
      data: { tenantId: data.tenant.id, ...leaveTypeFields("SICK"), color: "#EF4444" },
    });

    const leave = await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: sickType.id,
        startDate: new Date(dateIso),
        endDate: new Date(dateIso),
        days: 1,
        status: "CANCELLATION_REQUESTED",
        cancellationRequestedBy: data.empUser.id,
      },
    });

    const timeEntry = await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: new Date(dateIso),
        startTime: new Date(`${dateIso}T08:00:00Z`),
        isInvalid: true,
        invalidReasonCode: "LEAVE_CANCELLATION_PENDING",
        invalidReason: "Urlaubsstornierung ausstehend",
      },
    });

    const acctBefore = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: data.employee.id },
    });
    const txCountBefore = await app.prisma.overtimeTransaction.count({
      where: { overtimeAccountId: acctBefore!.id },
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${leave.id}/review`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { status: "APPROVED" },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe("CANCELLED");

    const reloadedEntry = await app.prisma.timeEntry.findUnique({ where: { id: timeEntry.id } });
    expect(reloadedEntry?.isInvalid).toBe(false);

    const txCountAfter = await app.prisma.overtimeTransaction.count({
      where: { overtimeAccountId: acctBefore!.id },
    });
    expect(
      txCountAfter,
      "pins that SICK cancellation approval writes NO OvertimeTransaction row (only VACATION/OVERTIME_COMP have apply-side effects)",
    ).toBe(txCountBefore);
  });

  it("D-12 (real defect, issue #220): approving a CANCELLATION_REQUESTED OVERTIME_COMP leave writes a CORRECTION OvertimeTransaction crediting the hours back, but OvertimeAccount.balanceHours is immediately overwritten by the SAME request's unconditional updateOvertimeAccount() recompute — the credit has no observable effect on the stored balance", async () => {
    const dateIso = holidayFreeMondayStr(10);
    const overtimeCompType = await app.prisma.leaveType.create({
      data: { tenantId: data.tenant.id, ...leaveTypeFields("OVERTIME_COMP"), color: "#8B5CF6" },
    });

    const leave = await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: overtimeCompType.id,
        startDate: new Date(dateIso),
        endDate: new Date(dateIso),
        days: 1,
        status: "CANCELLATION_REQUESTED",
        cancellationRequestedBy: data.empUser.id,
      },
    });

    const acctBefore = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: data.employee.id },
    });
    await app.prisma.overtimeTransaction.deleteMany({
      where: { overtimeAccountId: acctBefore!.id },
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${leave.id}/review`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { status: "APPROVED" },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe("CANCELLED");

    // The audit trail (Revisionssicherheit): a CORRECTION transaction WAS written, crediting
    // the employee's scheduled hours for that weekday (8h fixed-schedule fixture) back.
    const transactions = await app.prisma.overtimeTransaction.findMany({
      where: { overtimeAccountId: acctBefore!.id },
    });
    expect(
      transactions.length,
      "pins that a CORRECTION OvertimeTransaction row is written on OVERTIME_COMP cancellation approval",
    ).toBe(1);
    expect(transactions[0].type).toBe("CORRECTION");
    expect(
      Number(transactions[0].hours),
      "pins the credited amount: the fixture's Monday Soll (8h)",
    ).toBe(8);

    // Independently recompute what updateOvertimeAccount() would (and, per the code path, DID)
    // write as the stored balance — computeOvertimeBalanceHours() is the same pure function the
    // route calls; nothing in this test touches its inputs (TimeEntry / WorkSchedule) between the
    // two calls, so an unchanged result here is not a race — it is the same deterministic value.
    const recomputed = await computeOvertimeBalanceHours(app, data.employee.id);
    const finalAccount = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: data.employee.id },
    });
    expect(
      Number(finalAccount?.balanceHours),
      "wrong per #220 — fix the code (make the recompute additive with, or skip itself after, the manual OVERTIME_COMP credit) and this test together; today the stored balance is the independent Ist-Soll recompute, not `hrs` credited back",
    ).toBeCloseTo(recomputed!, 5);
    expect(
      Number(finalAccount?.balanceHours),
      "wrong per #220 — the manual +8h credit-back has NO observable effect: the stored balance never equals the naively-expected `previousBalance(0) + hrs(8)`",
    ).not.toBe(8);
  });
});
