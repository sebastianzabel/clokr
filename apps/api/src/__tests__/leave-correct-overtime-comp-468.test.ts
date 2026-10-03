/**
 * Issue #468, finding 1, the correction half of D-02: `PATCH /requests/:id/correct` reverses the
 * STORED Überstundenausgleich booking (never a recomputation), books the newly computed amount for
 * the corrected range, keeps `LeaveRequest.overtimeCompMinutes` current (null once the request is
 * no longer OVERTIME_COMP), and audits the delta — with the A-4 legacy fallback (no stored value ->
 * recompute under the CURRENT schedule, logged) and the existing D-03 closed-month guard.
 *
 * RED before this plan's leave.ts changes: `/correct`'s two OVERTIME_COMP call sites recompute
 * both sides fresh from the request's (possibly post-approval-edited) schedule instead of reading
 * back the stored `overtimeCompMinutes` — a retroactive schedule edit between approval and
 * correction silently changes what gets reversed, and the row's `overtimeCompMinutes` is never
 * updated to the new amount.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { leaveTypeFields } from "../contexts/absence/leave-type";
import type { FastifyInstance } from "fastify";

describe("Leave correction — Überstundenausgleich reverses the stored value (Issue #468, D-02/D-03/A-4)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let overtimeTypeId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "co468");

    overtimeTypeId = (
      await app.prisma.leaveType.create({
        data: { tenantId: data.tenant.id, ...leaveTypeFields("OVERTIME_COMP"), color: "#8B5CF6" },
      })
    ).id;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("leave-correct-overtime-comp-468 cleanup failed:", err);
    }
    await closeTestApp();
  });

  // ── helpers ──────────────────────────────────────────────────────────────

  function correct(id: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${id}/correct`,
      headers: {
        authorization: `Bearer ${data.adminToken}`,
        "user-agent": "vitest-agent/1.0",
      },
      payload: { reason: "Korrektur nach Rückfrage", ...payload },
    });
  }

  /** Creates a PENDING OVERTIME_COMP request and approves it through /review so the D-02 stored
   *  booking actually exists on the row (mirrors leave-overtime-comp-booking-468.test.ts#B1). */
  async function approveOt(start: string, end: string): Promise<string> {
    const leave = await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: overtimeTypeId,
        startDate: new Date(start),
        endDate: new Date(end),
        days: 1,
        status: "PENDING",
      },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${leave.id}/review`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { status: "APPROVED" },
    });
    expect(res.statusCode, res.body).toBe(200);
    return leave.id;
  }

  async function countTx(type: "CORRECTION" | "REDUCTION"): Promise<number> {
    const acct = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: data.employee.id },
    });
    if (!acct) return 0;
    return app.prisma.overtimeTransaction.count({ where: { overtimeAccountId: acct.id, type } });
  }

  async function lastTx(type: "CORRECTION" | "REDUCTION") {
    const acct = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: data.employee.id },
    });
    return app.prisma.overtimeTransaction.findFirst({
      where: { overtimeAccountId: acct!.id, type },
      orderBy: { createdAt: "desc" },
    });
  }

  async function lastCorrectedAudit(leaveRequestId: string) {
    return app.prisma.auditLog.findFirst({
      where: { action: "LEAVE_CORRECTED", entity: "LeaveRequest", entityId: leaveRequestId },
      orderBy: { createdAt: "desc" },
    });
  }

  // ── Task 1 ───────────────────────────────────────────────────────────────

  it("K1: a date correction after a retroactive schedule edit reverses the stored 40h, not a recomputed 38h, and audits the delta (D-02)", async () => {
    const leaveId = await approveOt("2027-04-05", "2027-04-09"); // Mon-Fri, 5 * 8h = 2400 min

    const approved = await app.prisma.leaveRequest.findUnique({ where: { id: leaveId } });
    expect(approved?.overtimeCompMinutes, "approval stores the full 5-day booking").toBe(2400);

    // Retroactive schedule edit — Monday now grants 6h instead of 8h.
    await app.prisma.workSchedule.updateMany({
      where: { employeeId: data.employee.id },
      data: { mondayHours: 6 },
    });

    try {
      const corrBefore = await countTx("CORRECTION");
      const redBefore = await countTx("REDUCTION");

      const res = await correct(leaveId, { startDate: "2027-04-05", endDate: "2027-04-07" }); // Mon-Wed
      expect(res.statusCode, res.body).toBe(200);

      expect(await countTx("CORRECTION")).toBe(corrBefore + 1);
      expect(await countTx("REDUCTION")).toBe(redBefore + 1);

      const corrTx = await lastTx("CORRECTION");
      expect(
        Number(corrTx!.hours),
        "reverses the STORED 40h booking, not a recomputed 38h",
      ).toBeCloseTo(40, 5);

      const redTx = await lastTx("REDUCTION");
      expect(Number(redTx!.hours), "6+8+8 under the edited schedule").toBeCloseTo(-22, 5);

      const finalRow = await app.prisma.leaveRequest.findUnique({ where: { id: leaveId } });
      expect(finalRow?.overtimeCompMinutes, "stores the new amount").toBe(1320);

      const audit = await lastCorrectedAudit(leaveId);
      expect(audit).not.toBeNull();
      const oldValue = audit!.oldValue as Record<string, unknown>;
      const newValue = audit!.newValue as Record<string, unknown>;
      expect(oldValue.overtimeCompMinutes).toBe(2400);
      expect(newValue.overtimeCompMinutes).toBe(1320);
      expect(newValue.overtimeCompDeltaMinutes).toBe(-1080);
      expect(newValue.overtimeCompReversalSource).toBe("stored");
    } finally {
      await app.prisma.workSchedule.updateMany({
        where: { employeeId: data.employee.id },
        data: { mondayHours: 8 },
      });
    }
  });

  it("identical-range correction with only a note change keeps the stored value current — no silent drift", async () => {
    const leaveId = await approveOt("2027-04-13", "2027-04-13"); // Tuesday, 8h = 480 min

    const corrBefore = await countTx("CORRECTION");
    const redBefore = await countTx("REDUCTION");

    const res = await correct(leaveId, {
      startDate: "2027-04-13",
      endDate: "2027-04-13",
      note: "aktualisierte Notiz",
    });
    expect(res.statusCode, res.body).toBe(200);

    expect(await countTx("CORRECTION")).toBe(corrBefore + 1);
    expect(await countTx("REDUCTION")).toBe(redBefore + 1);

    const corrTx = await lastTx("CORRECTION");
    expect(Number(corrTx!.hours)).toBeCloseTo(8, 5);
    const redTx = await lastTx("REDUCTION");
    expect(Number(redTx!.hours)).toBeCloseTo(-8, 5);

    const finalRow = await app.prisma.leaveRequest.findUnique({ where: { id: leaveId } });
    expect(finalRow?.overtimeCompMinutes, "no silent drift").toBe(480);

    const audit = await lastCorrectedAudit(leaveId);
    const newValue = audit!.newValue as Record<string, unknown>;
    expect(newValue.overtimeCompDeltaMinutes, "net movement is zero").toBe(0);
    expect(newValue.overtimeCompReversalSource).toBe("stored");
  });
});
