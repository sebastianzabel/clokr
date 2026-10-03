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
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  seedEntitlementYears,
} from "./setup";
import { leaveTypeFields } from "../contexts/absence/leave-type";
import type { FastifyInstance } from "fastify";

describe("Leave correction — Überstundenausgleich reverses the stored value (Issue #468, D-02/D-03/A-4)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let overtimeTypeId: string;
  const ENTITLEMENT_YEAR = 2027;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "co468");

    overtimeTypeId = (
      await app.prisma.leaveType.create({
        data: { tenantId: data.tenant.id, ...leaveTypeFields("OVERTIME_COMP"), color: "#8B5CF6" },
      })
    ).id;

    // Fixtures use fixed 2027 dates (CLAUDE.md: hardcoded-date test time-bombs) — seed the
    // vacation entitlement for that year explicitly; seedTestData only seeds the live year.
    await seedEntitlementYears(app, {
      employeeId: data.employee.id,
      leaveTypeId: data.vacationType.id,
      years: [ENTITLEMENT_YEAR],
    });
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

  it("K1: a date correction after a retroactive schedule edit reverses the stored 40h, not a recomputed 38h", async () => {
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
    } finally {
      await app.prisma.workSchedule.updateMany({
        where: { employeeId: data.employee.id },
        data: { mondayHours: 8 },
      });
    }
  });

  it("K1's LEAVE_CORRECTED audit carries old/new minutes, the signed delta and the reversal source (D-02)", async () => {
    const leaveId = await approveOt("2027-04-20", "2027-04-20"); // Tuesday, 8h = 480 min — own
    // fixture (same scenario shape, a different range) so this test does not depend on
    // execution order relative to the journal-rows test above.
    const approved = await app.prisma.leaveRequest.findUnique({ where: { id: leaveId } });
    expect(approved?.overtimeCompMinutes).toBe(480);

    await app.prisma.workSchedule.updateMany({
      where: { employeeId: data.employee.id },
      data: { tuesdayHours: 5 },
    });

    try {
      const res = await correct(leaveId, { startDate: "2027-04-20", endDate: "2027-04-20" });
      expect(res.statusCode, res.body).toBe(200);

      const audit = await lastCorrectedAudit(leaveId);
      expect(audit).not.toBeNull();
      const oldValue = audit!.oldValue as Record<string, unknown>;
      const newValue = audit!.newValue as Record<string, unknown>;
      expect(oldValue.overtimeCompMinutes).toBe(480);
      expect(newValue.overtimeCompMinutes).toBe(300);
      expect(newValue.overtimeCompDeltaMinutes).toBe(-180);
      expect(newValue.overtimeCompReversalSource).toBe("stored");
    } finally {
      await app.prisma.workSchedule.updateMany({
        where: { employeeId: data.employee.id },
        data: { tuesdayHours: 8 },
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

  // ── Task 2 ───────────────────────────────────────────────────────────────

  it("OT→SICK: reverses the stored booking exactly once, no new OT booking, column cleared, delta/source audited", async () => {
    const leaveId = await approveOt("2027-04-12", "2027-04-12"); // Monday, 8h = 480 min

    const corrBefore = await countTx("CORRECTION");
    const redBefore = await countTx("REDUCTION");

    const res = await correct(leaveId, {
      startDate: "2027-04-12",
      endDate: "2027-04-12",
      type: "SICK",
    });
    expect(res.statusCode, res.body).toBe(200);

    expect(await countTx("CORRECTION")).toBe(corrBefore + 1);
    expect(await countTx("REDUCTION"), "SICK apply books nothing").toBe(redBefore);

    const corrTx = await lastTx("CORRECTION");
    expect(Number(corrTx!.hours)).toBeCloseTo(8, 5);

    const finalRow = await app.prisma.leaveRequest.findUnique({ where: { id: leaveId } });
    expect(
      finalRow?.overtimeCompMinutes,
      "cleared once the request is no longer OVERTIME_COMP",
    ).toBeNull();

    const audit = await lastCorrectedAudit(leaveId);
    const newValue = audit!.newValue as Record<string, unknown>;
    expect(newValue.overtimeCompDeltaMinutes).toBe(-480);
    expect(newValue.overtimeCompReversalSource).toBe("stored");
  });

  it("VACATION→OT: reverses usedDays, books the new amount once (REDUCTION), audits delta with no reversal source", async () => {
    const vacLeave = await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        startDate: new Date("2027-04-19"), // Monday
        endDate: new Date("2027-04-19"),
        days: 1,
        status: "APPROVED",
        reviewedBy: data.adminUser.id,
        reviewedAt: new Date(),
      },
    });
    await app.prisma.leaveEntitlement.updateMany({
      where: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        year: ENTITLEMENT_YEAR,
      },
      data: { usedDays: 1 },
    });

    const corrBefore = await countTx("CORRECTION");
    const redBefore = await countTx("REDUCTION");

    const res = await correct(vacLeave.id, {
      startDate: "2027-04-19",
      endDate: "2027-04-19",
      type: "OVERTIME_COMP",
    });
    expect(res.statusCode, res.body).toBe(200);

    const entitlement = await app.prisma.leaveEntitlement.findFirst({
      where: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        year: ENTITLEMENT_YEAR,
      },
    });
    expect(Number(entitlement?.usedDays), "the old VACATION day is given back").toBe(0);

    expect(await countTx("CORRECTION"), "the OLD side was VACATION, not OT").toBe(corrBefore);
    expect(await countTx("REDUCTION")).toBe(redBefore + 1);

    const redTx = await lastTx("REDUCTION");
    expect(Number(redTx!.hours)).toBeCloseTo(-8, 5);

    const finalRow = await app.prisma.leaveRequest.findUnique({ where: { id: vacLeave.id } });
    expect(finalRow?.overtimeCompMinutes, "stores the newly booked amount").toBe(480);

    const audit = await lastCorrectedAudit(vacLeave.id);
    const newValue = audit!.newValue as Record<string, unknown>;
    expect(newValue.overtimeCompDeltaMinutes).toBe(480);
    expect(
      newValue.overtimeCompReversalSource,
      "the OLD side was not OVERTIME_COMP — no reversal source",
    ).toBeUndefined();
  });

  it("legacy row with no stored value recomputes under the CURRENT schedule and audits source 'recomputed' (A-4)", async () => {
    const leave = await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: overtimeTypeId,
        startDate: new Date("2027-04-26"), // Monday
        endDate: new Date("2027-04-26"),
        days: 1,
        status: "APPROVED",
        overtimeCompMinutes: null,
        reviewedBy: data.adminUser.id,
        reviewedAt: new Date(),
      },
    });

    // Schedule edited 8h -> 6h AFTER the (legacy, unstored) approval.
    await app.prisma.workSchedule.updateMany({
      where: { employeeId: data.employee.id },
      data: { mondayHours: 6 },
    });

    try {
      const corrBefore = await countTx("CORRECTION");

      const res = await correct(leave.id, {
        startDate: "2027-04-26",
        endDate: "2027-04-26",
        note: "Korrektur unter dem aktuellen Plan",
      });
      expect(res.statusCode, res.body).toBe(200);

      expect(await countTx("CORRECTION")).toBe(corrBefore + 1);
      const corrTx = await lastTx("CORRECTION");
      expect(
        Number(corrTx!.hours),
        "A-4 fallback: recomputed under the CURRENT (6h) schedule, not the original 8h",
      ).toBeCloseTo(6, 5);

      const finalRow = await app.prisma.leaveRequest.findUnique({ where: { id: leave.id } });
      expect(finalRow?.overtimeCompMinutes, "the correction now stores a value").toBe(360);

      const audit = await lastCorrectedAudit(leave.id);
      const newValue = audit!.newValue as Record<string, unknown>;
      expect(newValue.overtimeCompReversalSource).toBe("recomputed");
    } finally {
      await app.prisma.workSchedule.updateMany({
        where: { employeeId: data.employee.id },
        data: { mondayHours: 8 },
      });
    }
  });

  it("D-03: a correction touching a closed month is rejected 409 before any write — journal and stored value unchanged", async () => {
    const leaveId = await approveOt("2027-06-07", "2027-06-07"); // Monday, stored 480

    try {
      await app.prisma.saldoSnapshot.create({
        data: {
          employeeId: data.employee.id,
          periodType: "MONTHLY",
          periodStart: new Date("2027-06-01T00:00:00Z"),
          periodEnd: new Date("2027-06-30T00:00:00Z"),
          workedMinutes: 0,
          expectedMinutes: 0,
          balanceMinutes: 0,
          carryOver: 0,
          closedAt: new Date(),
          closedBy: "test-system",
        },
      });

      const corrBefore = await countTx("CORRECTION");
      const redBefore = await countTx("REDUCTION");

      const res = await correct(leaveId, { startDate: "2027-06-07", endDate: "2027-06-08" });
      expect(res.statusCode, res.body).toBe(409);
      expect(JSON.parse(res.body).error).toBe("Gesperrter Monat — Korrektur nicht möglich");

      expect(await countTx("CORRECTION"), "no write before the 409").toBe(corrBefore);
      expect(await countTx("REDUCTION")).toBe(redBefore);

      const finalRow = await app.prisma.leaveRequest.findUnique({ where: { id: leaveId } });
      expect(finalRow?.overtimeCompMinutes, "stored value unchanged").toBe(480);
    } finally {
      await app.prisma.saldoSnapshot.deleteMany({
        where: { employeeId: data.employee.id, periodStart: new Date("2027-06-01T00:00:00Z") },
      });
    }
  });
});
