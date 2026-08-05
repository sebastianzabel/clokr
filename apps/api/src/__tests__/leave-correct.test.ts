import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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

/**
 * Phase 94-02 — reverse-OLD → apply-NEW recalc in the correction handler.
 *
 * Every correction REVERSES the old booking (dispatched on the OLD leaveType) and
 * then APPLIES the new booking (dispatched on the NEW leaveType). This makes every
 * type-change direction saldo-correct by construction and never leaves a day consumed.
 * Task 1 pins the reverse side + the pre-write guards + removed-day revalidation.
 */
describe("Leave correction — reverse-OLD/apply-NEW saldo (94-02)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let overtimeTypeId: string;
  let sickTypeId: string;
  let parentalTypeId: string;
  const YEAR = new Date().getFullYear();

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "lc3");
    overtimeTypeId = (
      await app.prisma.leaveType.create({
        data: {
          tenantId: data.tenant.id,
          name: "Überstundenausgleich",
          isPaid: true,
          requiresApproval: true,
        },
      })
    ).id;
    sickTypeId = (
      await app.prisma.leaveType.create({
        data: {
          tenantId: data.tenant.id,
          name: "Krankmeldung",
          isPaid: true,
          requiresApproval: false,
        },
      })
    ).id;
    parentalTypeId = (
      await app.prisma.leaveType.create({
        data: {
          tenantId: data.tenant.id,
          name: "Elternzeit",
          isPaid: false,
          requiresApproval: true,
        },
      })
    ).id;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // ── helpers ────────────────────────────────────────────────────────────────
  async function mkApproved(opts: {
    leaveTypeId: string;
    start: string;
    end: string;
    days: number;
    halfDay?: boolean;
  }) {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: opts.leaveTypeId,
        startDate: new Date(opts.start),
        endDate: new Date(opts.end),
        days: opts.days,
        halfDay: opts.halfDay ?? false,
        status: "APPROVED",
        reviewedBy: "system",
        reviewedAt: new Date(),
      },
    });
  }

  function correct(id: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${id}/correct`,
      headers: {
        authorization: `Bearer ${data.adminToken}`,
        "user-agent": "vitest-agent/1.0",
      },
      payload,
    });
  }

  async function setVacationUsed(n: number, year = YEAR) {
    await app.prisma.leaveEntitlement.updateMany({
      where: { employeeId: data.employee.id, leaveTypeId: data.vacationType.id, year },
      data: { usedDays: n },
    });
  }

  async function getVacationUsed(year = YEAR): Promise<number> {
    const e = await app.prisma.leaveEntitlement.findFirst({
      where: { employeeId: data.employee.id, leaveTypeId: data.vacationType.id, year },
    });
    return Number(e?.usedDays ?? -999);
  }

  async function getBalance(): Promise<number> {
    const a = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: data.employee.id },
    });
    return Number(a?.balanceHours ?? 0);
  }

  async function countTx(type: "CORRECTION" | "REDUCTION"): Promise<number> {
    const a = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: data.employee.id },
    });
    if (!a) return 0;
    return app.prisma.overtimeTransaction.count({
      where: { overtimeAccountId: a.id, type },
    });
  }

  // ── Task 1: reverse-OLD side + pre-write guards + revalidation ──────────────

  it("VACATION→SICK correction reverses the OLD usedDays back to baseline", async () => {
    const req = await mkApproved({
      leaveTypeId: data.vacationType.id,
      start: "2026-03-02",
      end: "2026-03-06",
      days: 5,
    });
    await setVacationUsed(5); // approval had consumed 5 days

    const res = await correct(req.id, {
      startDate: "2026-03-02",
      endDate: "2026-03-06",
      type: "SICK",
    });

    expect(res.statusCode).toBe(200);
    // OLD VACATION (5) fully reversed; new SICK side adds no entitlement
    expect(await getVacationUsed()).toBe(0);
  });

  it("OVERTIME_COMP→SICK correction credits back the OLD scheduled hours (+CORRECTION tx)", async () => {
    const req = await mkApproved({
      leaveTypeId: overtimeTypeId,
      start: "2026-03-09",
      end: "2026-03-13",
      days: 5,
    });
    const balBefore = await getBalance();
    const corrBefore = await countTx("CORRECTION");

    const res = await correct(req.id, {
      startDate: "2026-03-09",
      endDate: "2026-03-13",
      type: "SICK",
    });

    expect(res.statusCode).toBe(200);
    // 5 × 8h Mon–Fri credited back to the overtime balance
    expect(await getBalance()).toBeCloseTo(balBefore + 40, 5);
    expect(await countTx("CORRECTION")).toBe(corrBefore + 1);
  });

  it("PARENTAL (Elternzeit) tail-shorten stays entitlement-neutral", async () => {
    const req = await mkApproved({
      leaveTypeId: parentalTypeId,
      start: "2026-03-16",
      end: "2026-03-27",
      days: 10,
    });
    const usedBefore = await getVacationUsed();
    const corrBefore = await countTx("CORRECTION");
    const redBefore = await countTx("REDUCTION");

    const res = await correct(req.id, { startDate: "2026-03-16", endDate: "2026-03-20" });

    expect(res.statusCode).toBe(200);
    // Entitlement-neutral BOOKING: PARENTAL reverses/applies nothing on either side.
    // (The unconditional recalc tail still reconciles the saldo — expected minutes
    // change when an unpaid leave shortens — so balanceHours is NOT asserted here.)
    expect(await getVacationUsed()).toBe(usedBefore);
    expect(await countTx("CORRECTION")).toBe(corrBefore);
    expect(await countTx("REDUCTION")).toBe(redBefore);
  });

  it("halfDay:true with a SICK new type → 400 pre-write (no partial saldo write)", async () => {
    const req = await mkApproved({
      leaveTypeId: data.vacationType.id,
      start: "2026-05-04",
      end: "2026-05-08",
      days: 5,
    });
    await setVacationUsed(5);

    const res = await correct(req.id, {
      startDate: "2026-05-04",
      endDate: "2026-05-08",
      type: "SICK",
      halfDay: true,
    });

    expect(res.statusCode).toBe(400);
    // reverse never ran — the OLD booking is untouched
    expect(await getVacationUsed()).toBe(5);
  });

  it("changed range overlapping a DIFFERENT approved request → 409; self is excluded", async () => {
    const a = await mkApproved({
      leaveTypeId: data.vacationType.id,
      start: "2026-06-01",
      end: "2026-06-05",
      days: 5,
    });
    await mkApproved({
      leaveTypeId: data.vacationType.id,
      start: "2026-06-15",
      end: "2026-06-19",
      days: 5,
    });

    // extend A into B's range → overlap 409
    const res = await correct(a.id, { startDate: "2026-06-01", endDate: "2026-06-16" });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toContain("Überschneidung");

    // a changed range that does NOT collide with B must NOT flag self → 200
    const res2 = await correct(a.id, { startDate: "2026-06-01", endDate: "2026-06-03" });
    expect(res2.statusCode).toBe(200);
  });

  it("removed-day leave-caused isInvalid entries are revalidated; locked/soft-deleted untouched", async () => {
    const req = await mkApproved({
      leaveTypeId: data.vacationType.id,
      start: "2026-07-06",
      end: "2026-07-17",
      days: 10,
    });
    const mkEntry = (date: string, extra: Record<string, unknown>) =>
      app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date(date),
          startTime: new Date(`${date}T08:00:00Z`),
          isInvalid: true,
          invalidReason: "Urlaubsstornierung ausstehend",
          ...extra,
        },
      });
    const eOpen = await mkEntry("2026-07-15", { isLocked: false });
    const eLocked = await mkEntry("2026-07-16", { isLocked: true });
    const eDeleted = await mkEntry("2026-07-17", { isLocked: false, deletedAt: new Date() });

    const res = await correct(req.id, { startDate: "2026-07-06", endDate: "2026-07-10" });
    expect(res.statusCode).toBe(200);

    const openAfter = await app.prisma.timeEntry.findUnique({ where: { id: eOpen.id } });
    const lockedAfter = await app.prisma.timeEntry.findUnique({ where: { id: eLocked.id } });
    const deletedAfter = await app.prisma.timeEntry.findUnique({ where: { id: eDeleted.id } });

    expect(openAfter?.isInvalid).toBe(false);
    expect(openAfter?.invalidReason).toBeNull();
    expect(lockedAfter?.isInvalid).toBe(true); // locked month never mutated
    expect(deletedAfter?.isInvalid).toBe(true); // soft-deleted never touched
  });

  // ── Task 2: apply-NEW side (dispatch on NEW type) ───────────────────────────

  it("VACATION date-only change nets usedDays exactly (reverse N + apply M)", async () => {
    const req = await mkApproved({
      leaveTypeId: data.vacationType.id,
      start: "2026-08-03",
      end: "2026-08-07",
      days: 5,
    });
    await setVacationUsed(5); // approval consumed 5

    const res = await correct(req.id, { startDate: "2026-08-03", endDate: "2026-08-05" }); // → 3 days
    expect(res.statusCode).toBe(200);
    // OLD 5 fully reversed, NEW 3 applied → net baseline(0) + 3
    expect(await getVacationUsed()).toBe(3);
  });

  it("SICK→VACATION correction applies the NEW deduction (old SICK not reversed)", async () => {
    const req = await mkApproved({
      leaveTypeId: sickTypeId,
      start: "2026-09-07",
      end: "2026-09-11",
      days: 5,
    });
    await setVacationUsed(0);

    const res = await correct(req.id, {
      startDate: "2026-09-07",
      endDate: "2026-09-11",
      type: "VACATION",
    });
    expect(res.statusCode).toBe(200);
    // old SICK reverses nothing; new VACATION deducts 5
    expect(await getVacationUsed()).toBe(5);
  });

  it("cross-year VACATION correction recomputes next-year carry-over", async () => {
    const YEAR2 = YEAR + 1;
    await app.prisma.leaveEntitlement.upsert({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: data.employee.id,
          leaveTypeId: data.vacationType.id,
          year: YEAR2,
        },
      },
      create: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        year: YEAR2,
        totalDays: 30,
        usedDays: 0,
      },
      update: {},
    });
    await setVacationUsed(4);
    const req = await mkApproved({
      leaveTypeId: data.vacationType.id,
      start: `${YEAR}-12-28`,
      end: `${YEAR2}-01-08`,
      days: 6,
    });

    const res = await correct(req.id, {
      startDate: `${YEAR}-12-28`,
      endDate: `${YEAR2}-01-08`,
    });
    expect(res.statusCode).toBe(200);

    const ent1 = await app.prisma.leaveEntitlement.findFirst({
      where: { employeeId: data.employee.id, leaveTypeId: data.vacationType.id, year: YEAR },
    });
    const ent2 = await app.prisma.leaveEntitlement.findFirst({
      where: { employeeId: data.employee.id, leaveTypeId: data.vacationType.id, year: YEAR2 },
    });
    const expectedCarry = Math.max(
      0,
      Number(ent1!.totalDays) + Number(ent1!.carriedOverDays) - Number(ent1!.usedDays),
    );
    // carry-over row for YEAR2 was recomputed from YEAR1 remaining (T-94-07)
    expect(Number(ent2!.carriedOverDays)).toBeCloseTo(expectedCarry, 5);
  });

  it("OVERTIME_COMP date change nets balanceHours to old−new (CORRECTION + REDUCTION)", async () => {
    const req = await mkApproved({
      leaveTypeId: overtimeTypeId,
      start: "2026-10-05",
      end: "2026-10-09",
      days: 5,
    });
    const corrBefore = await countTx("CORRECTION");
    const redBefore = await countTx("REDUCTION");

    const res = await correct(req.id, { startDate: "2026-10-05", endDate: "2026-10-07" }); // 40h → 24h
    expect(res.statusCode).toBe(200);
    expect(await countTx("CORRECTION")).toBe(corrBefore + 1); // credit back OLD 40h
    expect(await countTx("REDUCTION")).toBe(redBefore + 1); // debit NEW 24h

    const acct = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: data.employee.id },
    });
    const reduction = await app.prisma.overtimeTransaction.findFirst({
      where: { overtimeAccountId: acct!.id, type: "REDUCTION" },
      orderBy: { createdAt: "desc" },
    });
    expect(Number(reduction!.hours)).toBeCloseTo(-24, 5);
  });

  it("SICK new type apply is a no-op (light) — no entitlement or overtime booking", async () => {
    const req = await mkApproved({
      leaveTypeId: parentalTypeId,
      start: "2026-11-02",
      end: "2026-11-06",
      days: 5,
    });
    const usedBefore = await getVacationUsed();
    const corrBefore = await countTx("CORRECTION");
    const redBefore = await countTx("REDUCTION");

    const res = await correct(req.id, {
      startDate: "2026-11-02",
      endDate: "2026-11-06",
      type: "SICK",
    });
    expect(res.statusCode).toBe(200);
    expect(await getVacationUsed()).toBe(usedBefore);
    expect(await countTx("CORRECTION")).toBe(corrBefore);
    expect(await countTx("REDUCTION")).toBe(redBefore);
  });

  // ── CR-01: the whole reverse-OLD → apply-NEW sequence is atomic ─────────────

  it("a mid-sequence failure inside the tx rolls back the OLD reversal — usedDays unchanged (94 CR-01)", async () => {
    const req = await mkApproved({
      leaveTypeId: data.vacationType.id,
      start: "2026-12-01",
      end: "2026-12-04",
      days: 4,
    });
    await setVacationUsed(4); // approval consumed 4

    // Force a failure at Step 9 (leaveRequest.update) INSIDE the transaction, AFTER
    // Step 8 already reversed usedDays (4 → 0). If the sequence is atomic, the failed
    // tx must roll back the reversal, leaving usedDays back at 4 and the row untouched.
    const orig = app.prisma.$transaction.bind(app.prisma);
    const spy = vi.spyOn(app.prisma, "$transaction").mockImplementation(((fn: unknown) =>
      orig(async (tx: unknown) => {
        const proxy = new Proxy(tx as object, {
          get(target, prop, receiver) {
            if (prop === "leaveRequest") {
              const real = Reflect.get(target, prop, receiver);
              return new Proxy(real as object, {
                get(t, p, r) {
                  if (p === "update") {
                    return () => {
                      throw new Error("forced mid-tx failure");
                    };
                  }
                  return Reflect.get(t, p, r);
                },
              });
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        return (fn as (client: unknown) => unknown)(proxy);
      })) as unknown as typeof app.prisma.$transaction);

    const res = await correct(req.id, { startDate: "2026-12-01", endDate: "2026-12-03" });
    spy.mockRestore();

    // The throw propagates out of the un-caught $transaction → Fastify 500.
    expect(res.statusCode).toBe(500);
    // Step 8 reverse (4 → 0) was rolled back together with the failed tx.
    expect(await getVacationUsed()).toBe(4);
    // The row itself was never mutated (still the original range).
    const row = await app.prisma.leaveRequest.findUnique({ where: { id: req.id } });
    expect(row?.endDate.toISOString().slice(0, 10)).toBe("2026-12-04");
  });
});
