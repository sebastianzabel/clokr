import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import { computeAffectedMonths } from "../utils/correction-lock";

/**
 * Phase 94-01 — Manager/Admin DIRECT-correction of an already-APPROVED LeaveRequest.
 *
 * PATCH /api/v1/leave/requests/:id/correct
 *   - Manager/Admin only (requireRole)
 *   - only APPROVED requests are correctable (no second approval, per CONTEXT)
 *   - tenant isolation (404 + CROSS_TENANT_ACCESS_DENIED audit)
 *   - LEAVE_CORRECTED audit before/after
 *   - DELTA-based locked-month protection (Task 2)
 */
describe("Leave correction (PATCH /requests/:id/correct)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let other: Awaited<ReturnType<typeof seedTestData>>;
  let parentalTypeId: string;
  let otherParentalTypeId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "lc");
    other = await seedTestData(app, "lc2");
    const pt = await app.prisma.leaveType.create({
      data: { tenantId: data.tenant.id, name: "Elternzeit", isPaid: false, requiresApproval: true },
    });
    parentalTypeId = pt.id;
    const opt = await app.prisma.leaveType.create({
      data: {
        tenantId: other.tenant.id,
        name: "Elternzeit",
        isPaid: false,
        requiresApproval: true,
      },
    });
    otherParentalTypeId = opt.id;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    try {
      await cleanupTestData(app, other.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function createApproved(opts: {
    employeeId?: string;
    leaveTypeId?: string;
    startDate: string;
    endDate: string;
    status?: "APPROVED" | "PENDING";
    halfDay?: boolean;
  }) {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId: opts.employeeId ?? data.employee.id,
        leaveTypeId: opts.leaveTypeId ?? parentalTypeId,
        startDate: new Date(opts.startDate),
        endDate: new Date(opts.endDate),
        days: 0,
        halfDay: opts.halfDay ?? false,
        status: opts.status ?? "APPROVED",
        reviewedBy: opts.status === "PENDING" ? null : "system",
        reviewedAt: opts.status === "PENDING" ? null : new Date(),
      },
    });
  }

  it("manager shortens an APPROVED Elternzeit (200 + LEAVE_CORRECTED audit)", async () => {
    const req = await createApproved({ startDate: "2027-06-07", endDate: "2027-06-18" });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${req.id}/correct`,
      headers: {
        authorization: `Bearer ${data.adminToken}`,
        "user-agent": "vitest-agent/1.0",
      },
      payload: { startDate: "2027-06-07", endDate: "2027-06-11" },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.endDate).toBe("2027-06-11");
    expect(body.startDate).toBe("2027-06-07");
    // Mon 07 – Fri 11 = 5 working days (no NDS holidays that week)
    expect(Number(body.days)).toBe(5);

    const audit = await app.prisma.auditLog.findFirst({
      where: { action: "LEAVE_CORRECTED", entity: "LeaveRequest", entityId: req.id },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.userId).toBeTruthy();
    expect(audit?.ipAddress).toBeTruthy();
    expect(audit?.userAgent).toBe("vitest-agent/1.0");
    const oldVal = audit?.oldValue as { endDate?: string } | null;
    const newVal = audit?.newValue as { endDate?: string } | null;
    expect(oldVal).toBeTruthy();
    expect(newVal).toBeTruthy();
  });

  it("employee token → 403 (requireRole rejects before handler)", async () => {
    const req = await createApproved({ startDate: "2027-07-05", endDate: "2027-07-16" });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${req.id}/correct`,
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { startDate: "2027-07-05", endDate: "2027-07-09" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("cross-tenant request → 404 + CROSS_TENANT_ACCESS_DENIED audit", async () => {
    const req = await createApproved({
      employeeId: other.employee.id,
      leaveTypeId: otherParentalTypeId,
      startDate: "2027-08-02",
      endDate: "2027-08-13",
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${req.id}/correct`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { startDate: "2027-08-02", endDate: "2027-08-06" },
    });

    expect(res.statusCode).toBe(404);
    const audit = await app.prisma.auditLog.findFirst({
      where: { action: "CROSS_TENANT_ACCESS_DENIED", entity: "LeaveRequest", entityId: req.id },
    });
    expect(audit).not.toBeNull();
  });

  it("non-APPROVED (PENDING) request → 409", async () => {
    const req = await createApproved({
      startDate: "2027-09-06",
      endDate: "2027-09-17",
      status: "PENDING",
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${req.id}/correct`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { startDate: "2027-09-06", endDate: "2027-09-10" },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toContain("Nur genehmigte Anträge");
  });

  it("startDate > endDate → 400 (correctSchema.refine)", async () => {
    const req = await createApproved({ startDate: "2027-10-04", endDate: "2027-10-15" });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${req.id}/correct`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { startDate: "2027-10-15", endDate: "2027-10-04" },
    });
    expect(res.statusCode).toBe(400);
  });

  // ── Delta-based locked-month protection (EDIT-03 / T-94-01) ───────────────

  /** Seed a MONTHLY superseded:false SaldoSnapshot = "month is closed/locked". */
  async function lockMonth(employeeId: string, year: number, month: number) {
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId,
        periodType: "MONTHLY",
        // UTC-naive convention (matches periodStartWindow's 2-day window)
        periodStart: new Date(Date.UTC(year, month - 1, 1)),
        periodEnd: new Date(Date.UTC(year, month, 0)),
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date(),
      },
    });
  }

  it("shortening Elternzeit at its unlocked tail is allowed even when early months are locked (200)", async () => {
    const req = await createApproved({ startDate: "2025-01-01", endDate: "2027-12-31" });
    // Jan 2025 is closed — but it stays in the RETAINED overlap, so untouched.
    await lockMonth(data.employee.id, 2025, 1);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${req.id}/correct`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { startDate: "2025-01-01", endDate: "2026-07-31" },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).endDate).toBe("2026-07-31");
  });

  it("moving endDate INTO an already-locked month → 409", async () => {
    const req = await createApproved({ startDate: "2025-05-01", endDate: "2025-05-09" });
    await lockMonth(data.employee.id, 2025, 5);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${req.id}/correct`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { startDate: "2025-05-01", endDate: "2025-05-20" },
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe("Gesperrter Monat — Korrektur nicht möglich");
  });

  it("halfDay change on a leave overlapping a locked month → 409 (retained day)", async () => {
    const req = await createApproved({ startDate: "2025-06-02", endDate: "2025-06-13" });
    await lockMonth(data.employee.id, 2025, 6);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${req.id}/correct`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { startDate: "2025-06-02", endDate: "2025-06-13", halfDay: true },
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe("Gesperrter Monat — Korrektur nicht möglich");
  });

  it("identical range with no type/halfDay change is a no-op → allowed even in a locked month (200)", async () => {
    const req = await createApproved({ startDate: "2025-11-03", endDate: "2025-11-14" });
    await lockMonth(data.employee.id, 2025, 11);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${req.id}/correct`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { startDate: "2025-11-03", endDate: "2025-11-14" },
    });

    expect(res.statusCode).toBe(200);
  });
});

describe("computeAffectedMonths (pure delta helper)", () => {
  const has = (arr: { year: number; month: number }[], y: number, m: number) =>
    arr.some((x) => x.year === y && x.month === m);

  it("shorten (no type/halfDay change) → only the removed tail months", () => {
    const months = computeAffectedMonths({
      oldStart: new Date("2025-01-01"),
      oldEnd: new Date("2027-12-31"),
      newStart: new Date("2025-01-01"),
      newEnd: new Date("2026-07-31"),
      typeChanged: false,
      halfDayChanged: false,
    });
    expect(has(months, 2026, 8)).toBe(true);
    expect(has(months, 2027, 12)).toBe(true);
    // retained overlap must NOT appear
    expect(has(months, 2025, 1)).toBe(false);
    expect(has(months, 2026, 7)).toBe(false);
  });

  it("extend into a month → that month is affected", () => {
    const months = computeAffectedMonths({
      oldStart: new Date("2025-05-01"),
      oldEnd: new Date("2025-05-09"),
      newStart: new Date("2025-05-01"),
      newEnd: new Date("2025-05-20"),
      typeChanged: false,
      halfDayChanged: false,
    });
    expect(months).toEqual([{ year: 2025, month: 5 }]);
  });

  it("halfDay change on identical range → retained days included", () => {
    const months = computeAffectedMonths({
      oldStart: new Date("2025-06-02"),
      oldEnd: new Date("2025-06-13"),
      newStart: new Date("2025-06-02"),
      newEnd: new Date("2025-06-13"),
      typeChanged: false,
      halfDayChanged: true,
    });
    expect(months).toEqual([{ year: 2025, month: 6 }]);
  });

  it("identical range, no flags → empty affected set", () => {
    const months = computeAffectedMonths({
      oldStart: new Date("2025-11-03"),
      oldEnd: new Date("2025-11-14"),
      newStart: new Date("2025-11-03"),
      newEnd: new Date("2025-11-14"),
      typeChanged: false,
      halfDayChanged: false,
    });
    expect(months).toEqual([]);
  });
});
