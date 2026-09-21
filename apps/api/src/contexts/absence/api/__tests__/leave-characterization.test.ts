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
  /** Second approver: the 4-eyes rule (COMP-V1814-02) blocks the manager who approved the leave
   *  from also approving its cancellation. */
  let secondManagerToken: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "leave-char");

    const mgrUser = await app.prisma.user.create({
      data: {
        email: `char-mgr2-${Date.now().toString(36)}@test.de`,
        passwordHash: data.adminUser.passwordHash,
        role: "MANAGER",
        isActive: true,
      },
    });
    await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: mgrUser.id,
        employeeNumber: `CM2-${Date.now().toString(36)}`,
        firstName: "Zweiter",
        lastName: "Pruefer",
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

  it("D-12 (issue #220, FIXED): a cancelled OVERTIME_COMP writes the CORRECTION row AND the stored balance moves with it — approval and cancellation are now two equal, opposite movements", async () => {
    // WHAT THIS TEST USED TO PIN, and why it was rewritten rather than deleted (issue #220's
    // own acceptance criteria require the rewrite):
    //
    // Until the #220 fix this case asserted that the CORRECTION credit had "NO observable
    // effect": the manual `reverseOvertimeCompensation()` write was overwritten microseconds
    // later by the same request's unconditional `updateOvertimeAccount()` recompute, and the
    // recompute knew nothing about Überstundenausgleich. Those assertions described a defect and
    // are gone; the audit-trail assertions they sat next to are kept verbatim.
    //
    // It ALSO used `holidayFreeMondayStr(10)` — a FUTURE Monday. That is outside the live
    // recompute window (which ends at today/yesterday), so the recompute could not have reacted
    // to this request whatever it contained, and the test would have stayed green through the
    // fix without measuring anything. The day is therefore moved into the PAST, and the request
    // now travels the real lifecycle (PENDING → APPROVED → CANCELLATION_REQUESTED → CANCELLED)
    // instead of being created mid-flow, so the balance movement is observable at all.
    //
    // The differential measurement of the withdrawal's SIZE lives in
    // `overtime-comp-saldo.test.ts`; this file keeps its own subject — the
    // CANCELLATION_REQUESTED → APPROVED branch of `PATCH /requests/:id/review`.
    const dateIso = holidayFreeMondayStr(-8);
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
        status: "PENDING",
      },
    });

    const acct = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: data.employee.id },
    });
    await app.prisma.overtimeTransaction.deleteMany({
      where: { overtimeAccountId: acct!.id },
    });

    // ── Approval ──────────────────────────────────────────────────────────────
    const approveRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${leave.id}/review`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { status: "APPROVED" },
    });
    expect(approveRes.statusCode).toBe(200);
    expect(JSON.parse(approveRes.body).status).toBe("APPROVED");

    const balanceAfterApproval = Number(
      (await app.prisma.overtimeAccount.findUnique({ where: { employeeId: data.employee.id } }))
        ?.balanceHours,
    );

    // ── Cancellation, approved by a DIFFERENT manager (4-eyes, COMP-V1814-02) ──
    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/leave/requests/${leave.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { reason: "Ausgleichstag wird nicht genommen" },
    });
    expect(delRes.statusCode).toBe(200);
    expect(JSON.parse(delRes.body).status).toBe("CANCELLATION_REQUESTED");

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${leave.id}/review`,
      headers: { authorization: `Bearer ${secondManagerToken}` },
      payload: { status: "APPROVED" },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body).status).toBe("CANCELLED");

    // The audit trail (Revisionssicherheit) — unchanged assertions, kept verbatim: a REDUCTION
    // on approval and a CORRECTION on cancellation, each for the employee's scheduled hours for
    // that weekday (8h fixed-schedule fixture).
    const transactions = await app.prisma.overtimeTransaction.findMany({
      where: { overtimeAccountId: acct!.id },
      orderBy: { createdAt: "asc" },
    });
    expect(
      transactions.map((t) => t.type),
      "pins that OVERTIME_COMP writes a REDUCTION on approval and a CORRECTION on cancellation approval",
    ).toEqual(["REDUCTION", "CORRECTION"]);
    expect(Number(transactions[0].hours)).toBe(-8);
    expect(
      Number(transactions[1].hours),
      "pins the credited amount: the fixture's Monday Soll (8h)",
    ).toBe(8);

    // `updateOvertimeAccount()` still REPLACES the stored balance with the independent Ist-Soll
    // recompute — that has not changed and is not a defect: for a non-exempt employee the
    // recompute is the single source of truth. What changed is that the recompute now carries
    // the Überstundenausgleich withdrawal, so the journal row above and the stored balance below
    // can no longer contradict each other.
    const recomputed = await computeOvertimeBalanceHours(app, data.employee.id);
    const finalAccount = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: data.employee.id },
    });
    expect(
      Number(finalAccount?.balanceHours),
      "the stored balance IS the recompute (unchanged by #220 — the recompute is the writer)",
    ).toBeCloseTo(recomputed!, 5);

    // The correct behaviour #220 asked for, and the assertion that fails against the pre-fix
    // code: the compensated day was never worked, so cancelling it releases the withdrawal
    // (+8h) exactly as the day's own Soll returns (−8h). Before the fix there was no withdrawal
    // to release and this delta was −8h.
    expect(
      Number(finalAccount?.balanceHours) - balanceAfterApproval,
      "cancellation releases the withdrawal while the unworked day's Soll returns — net zero",
    ).toBeCloseTo(0, 5);
  });
});
