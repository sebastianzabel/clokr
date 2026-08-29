/**
 * shift-leave-recalc.test.ts
 *
 * Phase 107 Plan 05 — integration coverage for `recalcProvisionalLeaveForShiftChange()`
 * (D-14..D-21, `apps/api/src/utils/shift-leave-recalc-resolver.ts`) and its seven
 * `apps/api/src/routes/shifts.ts` call sites.
 *
 * Two complementary styles, chosen per what each case actually needs to prove:
 *  - HTTP-route cases (mirrors shifts-saldo-trigger.test.ts's "mutate a shift via app.inject,
 *    assert a downstream row changed" pattern) prove the WIRING — that a real route call, inside
 *    its own transaction, reaches the resolver and that the resolver's side effects (audit row,
 *    both notifications, entitlement correction) actually happen. Used for AC-RC-01/02/03, the
 *    no-roster no-op, AC-RC-06, the fail-closed rollback, and the three required transaction
 *    shapes (POST /, generate-week, DELETE /:id).
 *  - Direct resolver calls (own recalcDeps built from the SAME leave.ts exports shifts.ts uses,
 *    wrapped in `app.prisma.$transaction`) prove the GUARD CHAIN and the function's own return
 *    value in isolation — AC-RC-04, AC-RC-05, AC-RC-07's `direction` field, and the
 *    status/employee/soft-delete guards — decoupled from any one HTTP call site's own
 *    conflict/force/eligibility checks, which are not this file's concern.
 *
 * Fixture shape mirrors leave-provisional-approval.test.ts (Plan 04): contractual counts that
 * are not 5 (the cardinality the original guessing bug never manifested for), `workDays` seeded
 * to disagree with each count's naive Mo-Fr prefix, every date derived from test-dates.ts plus a
 * local holiday-free-week anchor helper (not exported from test-dates.ts — every SHIFT_BASED
 * leave-fixture file in this suite keeps its own copy of this composition).
 *
 * TWO distinct ADMIN users are used throughout: adminA always APPROVES leave requests
 * (`LeaveRequest.reviewedBy`), adminB always performs the shift mutation that triggers the
 * recompute. This is required, not cosmetic: `notifyLeaveDaysAdjusted()` in shifts.ts skips a
 * notification recipient that equals the acting user (the Phase-91 "except the actor"
 * convention) — if the SAME admin did both, the manager half of AC-RC-02 could never be
 * observed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { getTestApp, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { getHolidays, STATE_MAP } from "../utils/holidays";
import { utcMidnight, dbDateStr, todayStr, pastDateStr, dowOf } from "./test-dates";
import {
  resolveLeaveDays,
  getHolidayMap,
  deductVacationDays,
  reverseVacationDays,
} from "../routes/leave";
import {
  recalcProvisionalLeaveForShiftChange,
  type RecalcDeps,
  type AdjustmentRecord,
} from "../utils/shift-leave-recalc-resolver";
import * as ShiftLeaveRecalcModule from "../utils/shift-leave-recalc-resolver";

const DAY_MS = 24 * 60 * 60 * 1000;

function addDaysIso(iso: string, days: number): string {
  return dbDateStr(new Date(utcMidnight(iso).getTime() + days * DAY_MS));
}

/**
 * Mirrors leave-provisional-approval.test.ts's own helper verbatim (not exported from
 * test-dates.ts). Next Monday at least `daysOut` days out, advanced by whole weeks until
 * `weekSpan` consecutive weeks (7 * weekSpan days from that Monday) contain ZERO NIEDERSACHSEN
 * public holidays — so a manually-seeded holiday (the AC-RC-07 upward case) is the ONLY holiday
 * in range, and no real calendar holiday silently changes an expected day count anywhere else.
 */
function nextHolidayFreeMonday(daysOut: number, weekSpan = 1): string {
  const anchor = utcMidnight(todayStr());
  let candidateIso = dbDateStr(new Date(anchor.getTime() + daysOut * DAY_MS));
  const daysUntilMonday = (8 - utcMidnight(candidateIso).getUTCDay()) % 7;
  candidateIso = addDaysIso(candidateIso, daysUntilMonday);

  const spanDays = weekSpan * 7;
  const MAX_ADVANCES = 16;
  for (let i = 0; i < MAX_ADVANCES; i++) {
    const spanDates: string[] = [];
    for (let d = 0; d < spanDays; d++) spanDates.push(addDaysIso(candidateIso, d));

    const years = new Set(spanDates.map((iso) => Number(iso.slice(0, 4))));
    const holidayDates = new Set<string>();
    for (const y of years) {
      for (const h of getHolidays(y, STATE_MAP.NIEDERSACHSEN)) holidayDates.add(h.date);
    }
    if (!spanDates.some((iso) => holidayDates.has(iso))) return candidateIso;
    candidateIso = addDaysIso(candidateIso, 7);
  }
  throw new Error(
    `nextHolidayFreeMonday: exceeded MAX_ADVANCES without a holiday-free ${weekSpan}-week span`,
  );
}

/** Monday (UTC midnight Date) of the ISO week containing `iso`. Mirrors the Monday derivation
 *  `mondayOfWeekUtc()` (utils/vacation-calc.ts) and shifts.ts:709-718 already use. */
function mondayOfIsoWeek(iso: string): Date {
  const dow = dowOf(iso); // 0=Sun..6=Sat
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  return new Date(utcMidnight(iso).getTime() + mondayOffset * DAY_MS);
}

function weekBoundsFor(iso: string): { weekStart: Date; weekEnd: Date } {
  const weekStart = mondayOfIsoWeek(iso);
  const weekEnd = new Date(weekStart.getTime() + 6 * DAY_MS);
  return { weekStart, weekEnd };
}

const PAST_ANCHOR = new Date(Date.UTC(new Date().getUTCFullYear() - 2, 0, 1));

// Widely-spaced anchor weeks, one per scenario — mirrors leave-provisional-approval.test.ts's
// own spacing convention ("no realistic holiday-skip can make two collide"). Each case that
// creates a LeaveRequest via POST /requests uses its own anchor so the create-time overlap
// guard never fires between unrelated cases sharing the same employee.
const AC01_MONDAY = nextHolidayFreeMonday(14); // AC-RC-01 / 02 / 03, single-shift route (POST /)
const WHOLE_MONDAY = nextHolidayFreeMonday(126, 2); // AC-RC-06, 2 whole ISO weeks
const NOOP_MONDAY = nextHolidayFreeMonday(252); // genuine no-op (was a real candidate)
const GENWEEK_MONDAY = nextHolidayFreeMonday(42); // bulk-route shape (generate-week)
const DELETE_MONDAY = nextHolidayFreeMonday(70); // delete-route shape
const FAILCLOSED_MONDAY = nextHolidayFreeMonday(98); // fail-closed rollback proof
const LOCKED_MONDAY = nextHolidayFreeMonday(154); // AC-RC-05
const PENDING_MONDAY = nextHolidayFreeMonday(168); // wrong-status guard
const OTHEREMP_MONDAY = nextHolidayFreeMonday(182); // wrong-employee guard
const DELETED_MONDAY = nextHolidayFreeMonday(196); // soft-deleted guard
const NONPROV_MONDAY = nextHolidayFreeMonday(210); // non-provisional guard
const DOWN_MONDAY = nextHolidayFreeMonday(224); // AC-RC-07 downward, direct call
const UP_MONDAY = nextHolidayFreeMonday(238, 1); // AC-RC-07 upward, direct call
const PAST_DAY = pastDateStr(45); // AC-RC-04 — comfortably in the past

describe("Shift-leave-recalc resolver — D-14..D-21 (Phase 107 Plan 05)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let vacTypeId: string;
  let adminAToken: string;
  let adminAUserId: string;
  let adminBToken: string;
  let adminBUserId: string;
  let emp: { id: string };
  let empUserId: string;
  let empToken: string;
  let emp2: { id: string };

  let recalcDeps: RecalcDeps;

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const suffix = "slr-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const tenant = await prisma.tenant.create({
      data: { name: `SLR ${suffix}`, slug: `slr-${suffix}`, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    await prisma.tenantConfig.create({ data: { tenantId } });

    const passwordHash = await bcrypt.hash("test1234", 10);

    async function makeAdmin(label: string) {
      const email = `slr-${label}-${suffix}@test.de`;
      const user = await prisma.user.create({
        data: { email, passwordHash, role: "ADMIN", isActive: true },
      });
      await prisma.employee.create({
        data: {
          tenantId,
          userId: user.id,
          employeeNumber: `SLR-${label.toUpperCase()}-${suffix}`,
          firstName: "SLR",
          lastName: label,
          hireDate: PAST_ANCHOR,
        },
      });
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email, password: "test1234" },
      });
      return { userId: user.id, token: JSON.parse(login.body).accessToken as string };
    }

    async function makeShiftEmployee(
      label: string,
      contractWorkDaysPerWeek: number,
      workDays: number[],
    ) {
      const email = `slr-${label}-${suffix}@test.de`;
      const user = await prisma.user.create({
        data: { email, passwordHash, role: "EMPLOYEE", isActive: true },
      });
      const employee = await prisma.employee.create({
        data: {
          tenantId,
          userId: user.id,
          employeeNumber: `SLR-${label.toUpperCase()}-${suffix}`,
          firstName: "SLR",
          lastName: label,
          hireDate: PAST_ANCHOR,
        },
      });
      await prisma.workSchedule.create({
        data: {
          employeeId: employee.id,
          type: "SHIFT_BASED",
          weeklyHours: contractWorkDaysPerWeek * 8,
          contractWorkDaysPerWeek,
          workDays,
          validFrom: PAST_ANCHOR,
        },
      });
      await prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email, password: "test1234" },
      });
      return { employee, userId: user.id, token: JSON.parse(login.body).accessToken as string };
    }

    const adminA = await makeAdmin("admina");
    adminAToken = adminA.token;
    adminAUserId = adminA.userId;
    const adminB = await makeAdmin("adminb");
    adminBToken = adminB.token;
    adminBUserId = adminB.userId;

    // Tue-Fri — deliberately NOT the naive Mo-Fr prefix [1,2,3,4] a guess-from-count algorithm
    // would produce for count 4 (D-02: workDays is frozen and irrelevant to SHIFT_BASED
    // leave-day math post-Phase-107).
    const empPair = await makeShiftEmployee("emp", 4, [2, 3, 4, 5]);
    emp = empPair.employee;
    empUserId = empPair.userId;
    empToken = empPair.token;
    // Wed/Thu/Sat — disagrees with the naive Mo-Fr prefix [1,2,3] for count 3. Used only for the
    // wrong-employee guard case.
    const emp2Pair = await makeShiftEmployee("emp2", 3, [3, 4, 6]);
    emp2 = emp2Pair.employee;

    const vacType = await prisma.leaveType.create({
      data: { tenantId, name: "Urlaub", isPaid: true, requiresApproval: true },
    });
    vacTypeId = vacType.id;

    const thisYear = new Date().getUTCFullYear();
    for (const employeeId of [emp.id, emp2.id]) {
      for (const year of [thisYear - 1, thisYear, thisYear + 1]) {
        await prisma.leaveEntitlement.create({
          data: { employeeId, leaveTypeId: vacTypeId, year, totalDays: 200, usedDays: 0 },
        });
      }
    }

    // Same recalcDeps shape shifts.ts builds — real leave.ts exports, no test doubles, so a
    // direct resolver call below exercises the exact same D-04 chain the HTTP routes do.
    recalcDeps = {
      resolveLeaveDays,
      getHolidayMap,
      deductVacationDays,
      reverseVacationDays,
      audit: app.audit,
    };
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("shift-leave-recalc cleanup failed:", err);
    }
  });

  // ── Helpers ──────────────────────────────────────────────────────────────────────────────
  async function postVacation(token: string, startDate: string, endDate: string) {
    return app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${token}` },
      payload: { type: "VACATION", startDate, endDate },
    });
  }

  async function approve(id: string) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${id}/review`,
      headers: { authorization: `Bearer ${adminAToken}` },
      payload: { status: "APPROVED" },
    });
  }

  async function postShift(
    token: string,
    employeeId: string,
    dateIso: string,
    opts: { force?: boolean; startTime?: string; endTime?: string } = {},
  ) {
    const qs = opts.force ? "?force=true" : "";
    return app.inject({
      method: "POST",
      url: `/api/v1/shifts/${qs}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        employeeId,
        date: dateIso,
        startTime: opts.startTime ?? "09:00",
        endTime: opts.endTime ?? "17:00",
      },
    });
  }

  async function usedDaysFor(employeeId: string, dateIsoForYear: string): Promise<number> {
    const year = Number(dateIsoForYear.slice(0, 4));
    const ent = await app.prisma.leaveEntitlement.findUnique({
      where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId: vacTypeId, year } },
    });
    return Number(ent?.usedDays ?? 0);
  }

  async function directRecalc(
    employeeId: string,
    weekStart: Date,
    weekEnd: Date,
    actorUserId: string,
  ): Promise<AdjustmentRecord[]> {
    return app.prisma.$transaction((tx) =>
      recalcProvisionalLeaveForShiftChange(
        tx,
        recalcDeps,
        employeeId,
        tenantId,
        weekStart,
        weekEnd,
        actorUserId,
      ),
    );
  }

  async function auditCountFor(leaveRequestId: string): Promise<number> {
    return app.prisma.auditLog.count({
      where: { action: "LEAVE_DAYS_ADJUSTED", entityId: leaveRequestId },
    });
  }

  // ── AC-RC-01 / AC-RC-02 / AC-RC-03 (single-shift route shape) ──────────────────────────────
  it("AC-RC-01 / AC-RC-02 / AC-RC-03: planning the roster for a period with an approved provisional request recomputes its days, corrects the entitlement by the delta, audits and notifies both parties", async () => {
    const start = AC01_MONDAY;
    const tuesday = addDaysIso(AC01_MONDAY, 1);
    const end = tuesday; // Mon+Tue fragment, count 4 -> upper bound min(2,4)=2

    const createRes = await postVacation(empToken, start, end);
    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.body);
    expect(Number(created.days)).toBe(2);

    const approveRes = await approve(created.id);
    expect(approveRes.statusCode).toBe(200);
    const approved = JSON.parse(approveRes.body);
    expect(Number(approved.days)).toBe(2);
    expect(approved.daysProvisional).toBe(true); // still no roster

    const usedAfterApproval = await usedDaysFor(emp.id, start);

    // adminB (NOT the approver) plans ONLY Tuesday. force=true: the date already carries the
    // APPROVED leave this request created — an intentional roster decision, not a test
    // workaround (POST /shifts's own conflict guard exists for exactly this "override a leave
    // conflict" case).
    const shiftRes = await postShift(adminBToken, emp.id, tuesday, { force: true });
    expect(shiftRes.statusCode).toBe(201);

    const persisted = await app.prisma.leaveRequest.findUnique({ where: { id: created.id } });
    expect(Number(persisted!.days)).toBe(1); // roster-exact: only Tuesday is actually rostered
    expect(persisted!.daysProvisional).toBe(false);

    // AC-RC-03 / D-13
    expect(await usedDaysFor(emp.id, start)).toBe(usedAfterApproval - 1);
    const auditRow = await app.prisma.auditLog.findFirst({
      where: { action: "LEAVE_DAYS_ADJUSTED", entityId: created.id },
      orderBy: { createdAt: "desc" },
    });
    expect(auditRow).toBeTruthy();
    expect(auditRow!.createdAt).toBeTruthy();
    const oldVal = auditRow!.oldValue as { days: number };
    const newVal = auditRow!.newValue as { days: number; trigger: string };
    expect(oldVal.days).toBe(2);
    expect(newVal.days).toBe(1);
    expect(newVal.trigger).toBe("Roster-Planung");

    // AC-RC-02 / D-18
    const notifications = await app.prisma.notification.findMany({
      where: { relatedType: "LeaveRequest", relatedId: created.id, type: "LEAVE_DAYS_ADJUSTED" },
    });
    const recipients = notifications.map((n) => n.userId);
    expect(recipients).toContain(empUserId);
    expect(recipients).toContain(adminAUserId);
    expect(recipients).not.toContain(adminBUserId); // adminB is the acting user — skipped
  });

  // ── AC-RC-04 — period already past ──────────────────────────────────────────────────────
  it("AC-RC-04: a request whose period is already fully in the past is not adjusted", async () => {
    const req = await app.prisma.leaveRequest.create({
      data: {
        employeeId: emp.id,
        leaveTypeId: vacTypeId,
        startDate: utcMidnight(PAST_DAY),
        endDate: utcMidnight(PAST_DAY),
        days: 1,
        halfDay: false,
        daysProvisional: true,
        status: "APPROVED",
        reviewedBy: adminAUserId,
      },
    });
    const { weekStart, weekEnd } = weekBoundsFor(PAST_DAY);
    const adjustments = await directRecalc(emp.id, weekStart, weekEnd, adminBUserId);
    expect(adjustments).toEqual([]);

    const persisted = await app.prisma.leaveRequest.findUnique({ where: { id: req.id } });
    expect(Number(persisted!.days)).toBe(1);
    expect(await auditCountFor(req.id)).toBe(0);
  });

  // ── AC-RC-05 — locked month ──────────────────────────────────────────────────────────────
  it("AC-RC-05: a request in a month with at least one locked TimeEntry is not adjusted", async () => {
    const start = LOCKED_MONDAY;
    const end = addDaysIso(LOCKED_MONDAY, 1);
    const req = await app.prisma.leaveRequest.create({
      data: {
        employeeId: emp.id,
        leaveTypeId: vacTypeId,
        startDate: utcMidnight(start),
        endDate: utcMidnight(end),
        days: 2,
        halfDay: false,
        daysProvisional: true,
        status: "APPROVED",
        reviewedBy: adminAUserId,
      },
    });
    // isSnapshotLocked()'s ACTUAL signal is a locked TimeEntry, not a SaldoSnapshot flag — a
    // locked month containing ZERO time entries is that primitive's own documented, deliberately
    // NOT-worked-around limitation (see snapshot-lock.ts's docblock), so it is not exercised here.
    await app.prisma.timeEntry.create({
      data: {
        employeeId: emp.id,
        date: utcMidnight(start),
        startTime: new Date(`${start}T09:00:00Z`),
        isLocked: true,
      },
    });

    const { weekStart, weekEnd } = weekBoundsFor(start);
    const adjustments = await directRecalc(emp.id, weekStart, weekEnd, adminBUserId);
    expect(adjustments).toEqual([]);

    const persisted = await app.prisma.leaveRequest.findUnique({ where: { id: req.id } });
    expect(Number(persisted!.days)).toBe(2);
    expect(await auditCountFor(req.id)).toBe(0);
  });

  // ── AC-RC-06 — whole ISO weeks are roster-independent ───────────────────────────────────
  it("AC-RC-06: a request covering only whole ISO weeks is not adjusted after the roster is planned", async () => {
    const start = WHOLE_MONDAY;
    const end = addDaysIso(WHOLE_MONDAY, 13); // 2 whole ISO weeks

    const createRes = await postVacation(empToken, start, end);
    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.body);
    expect(Number(created.days)).toBe(8); // count 4 * 2 whole weeks

    const approveRes = await approve(created.id);
    expect(approveRes.statusCode).toBe(200);
    const approved = JSON.parse(approveRes.body);
    expect(Number(approved.days)).toBe(8);
    expect(approved.daysProvisional).toBe(false); // whole weeks are never provisional (D-06)

    const auditBefore = await auditCountFor(created.id);
    const shiftRes = await postShift(adminBToken, emp.id, addDaysIso(WHOLE_MONDAY, 2), {
      force: true,
    });
    expect(shiftRes.statusCode).toBe(201);

    const persisted = await app.prisma.leaveRequest.findUnique({ where: { id: created.id } });
    expect(Number(persisted!.days)).toBe(8); // unchanged — whole weeks ignore the roster (D-06)
    expect(await auditCountFor(created.id)).toBe(auditBefore);
  });

  // ── Genuine no-op: was a real candidate, recompute equals the stored value ─────────────────
  it("a genuine no-op recompute (recomputed value equals the stored value) writes no audit row, corrects no entitlement, and leaves daysProvisional untouched", async () => {
    const start = NOOP_MONDAY; // single-day fragment, count 4 -> upper bound min(1,4)=1

    const createRes = await postVacation(empToken, start, start);
    const created = JSON.parse(createRes.body);
    expect(Number(created.days)).toBe(1);
    const approveRes = await approve(created.id);
    const approved = JSON.parse(approveRes.body);
    expect(Number(approved.days)).toBe(1);
    expect(approved.daysProvisional).toBe(true);

    const usedBefore = await usedDaysFor(emp.id, start);
    // Roster exactly the ONE day the fragment already assumed -> roster-exact count = 1, SAME as
    // the stored upper bound. Step 5 ("skip that request entirely — no write, no audit, no
    // notification") means daysProvisional itself is untouched too, even though the week now
    // genuinely has a roster — a deliberate consequence of "no write at all" on a no-op, not a
    // bug: the plan's own Task 1 action text is explicit about this.
    const shiftRes = await postShift(adminBToken, emp.id, start, { force: true });
    expect(shiftRes.statusCode).toBe(201);

    const persisted = await app.prisma.leaveRequest.findUnique({ where: { id: created.id } });
    expect(Number(persisted!.days)).toBe(1);
    expect(persisted!.daysProvisional).toBe(true);
    expect(await usedDaysFor(emp.id, start)).toBe(usedBefore);
    expect(await auditCountFor(created.id)).toBe(0);
    const notifications = await app.prisma.notification.findMany({
      where: { relatedType: "LeaveRequest", relatedId: created.id, type: "LEAVE_DAYS_ADJUSTED" },
    });
    expect(notifications).toHaveLength(0);
  });

  // ── AC-RC-07 downward (direct call — inspects the returned `direction`) ────────────────────
  it("AC-RC-07 downward: the roster has fewer workdays in the fragment than the D-07 upper bound — days decreases, entitlement corrected by the delta, audit row exists, returned direction is 'down'", async () => {
    const start = DOWN_MONDAY;
    const end = addDaysIso(DOWN_MONDAY, 2); // Mon+Tue+Wed, count 4 -> upper bound min(3,4)=3

    const created = await app.prisma.leaveRequest.create({
      data: {
        employeeId: emp.id,
        leaveTypeId: vacTypeId,
        startDate: utcMidnight(start),
        endDate: utcMidnight(end),
        days: 3,
        halfDay: false,
        daysProvisional: true,
        status: "APPROVED",
        reviewedBy: adminAUserId,
      },
    });
    // Mirror what a real approve() would have booked, so the delta-correction below is
    // observable against a realistic baseline.
    await app.prisma.leaveEntitlement.updateMany({
      where: { employeeId: emp.id, leaveTypeId: vacTypeId, year: Number(start.slice(0, 4)) },
      data: { usedDays: { increment: 3 } },
    });
    const usedBefore = await usedDaysFor(emp.id, start);

    // Roster ONLY Monday -> roster-exact count = 1 < upper bound 3.
    await app.prisma.shift.create({
      data: { employeeId: emp.id, date: utcMidnight(start), startTime: "09:00", endTime: "17:00" },
    });

    const { weekStart, weekEnd } = weekBoundsFor(start);
    const adjustments = await directRecalc(emp.id, weekStart, weekEnd, adminBUserId);
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0].direction).toBe("down");
    expect(adjustments[0].oldDays).toBe(3);
    expect(adjustments[0].newDays).toBe(1);
    expect(adjustments[0].leaveRequestId).toBe(created.id);
    expect(adjustments[0].employeeUserId).toBe(empUserId);
    expect(adjustments[0].approverUserId).toBe(adminAUserId);

    const persisted = await app.prisma.leaveRequest.findUnique({ where: { id: created.id } });
    expect(Number(persisted!.days)).toBe(1);
    expect(persisted!.daysProvisional).toBe(false);
    expect(await usedDaysFor(emp.id, start)).toBe(usedBefore - 2); // delta = 1 - 3 = -2

    const auditRow = await app.prisma.auditLog.findFirst({
      where: { action: "LEAVE_DAYS_ADJUSTED", entityId: created.id },
    });
    expect(auditRow).toBeTruthy();
  });

  // ── AC-RC-07 upward (direct call) ───────────────────────────────────────────────────────
  it("AC-RC-07 upward: the roster ends up covering more non-holiday days in the fragment than the flat estimate assumed — days increases, entitlement corrected by the delta, audit row exists, returned direction is 'up'", async () => {
    const start = UP_MONDAY; // Monday
    const end = addDaysIso(UP_MONDAY, 4); // Mon-Fri, 5 calendar days, count 3
    const wednesday = addDaysIso(UP_MONDAY, 2);

    // A manually-seeded holiday: the flat (no-roster) estimate subtracts it
    // (min(5,3) - 1 = 2), but the roster-exact branch excludes that SAME date regardless of
    // rostering, so it does not cap the roster-exact count the same way — a fragment can be
    // rostered on MORE non-holiday days than the weekly contractual count assumed.
    await app.prisma.publicHoliday.create({
      data: {
        tenantId,
        date: utcMidnight(wednesday),
        name: "SLR Test-Feiertag",
        federalState: "NIEDERSACHSEN",
        year: Number(wednesday.slice(0, 4)),
      },
    });

    const created = await app.prisma.leaveRequest.create({
      data: {
        employeeId: emp.id,
        leaveTypeId: vacTypeId,
        startDate: utcMidnight(start),
        endDate: utcMidnight(end),
        days: 2,
        halfDay: false,
        daysProvisional: true,
        status: "APPROVED",
        reviewedBy: adminAUserId,
      },
    });
    await app.prisma.leaveEntitlement.updateMany({
      where: { employeeId: emp.id, leaveTypeId: vacTypeId, year: Number(start.slice(0, 4)) },
      data: { usedDays: { increment: 2 } },
    });
    const usedBefore = await usedDaysFor(emp.id, start);

    // Roster THREE non-holiday days (Mon, Tue, Thu) -> roster-exact = 3 > flat estimate 2.
    for (const dateIso of [start, addDaysIso(UP_MONDAY, 1), addDaysIso(UP_MONDAY, 3)]) {
      await app.prisma.shift.create({
        data: {
          employeeId: emp.id,
          date: utcMidnight(dateIso),
          startTime: "09:00",
          endTime: "17:00",
        },
      });
    }

    const { weekStart, weekEnd } = weekBoundsFor(start);
    const adjustments = await directRecalc(emp.id, weekStart, weekEnd, adminBUserId);
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0].direction).toBe("up");
    expect(adjustments[0].oldDays).toBe(2);
    expect(adjustments[0].newDays).toBe(3);

    const persisted = await app.prisma.leaveRequest.findUnique({ where: { id: created.id } });
    expect(Number(persisted!.days)).toBe(3);
    expect(persisted!.daysProvisional).toBe(false);
    expect(await usedDaysFor(emp.id, start)).toBe(usedBefore + 1); // delta = 3 - 2 = +1

    const auditRow = await app.prisma.auditLog.findFirst({
      where: { action: "LEAVE_DAYS_ADJUSTED", entityId: created.id },
    });
    expect(auditRow).toBeTruthy();
  });

  // ── Guard: non-provisional APPROVED request ─────────────────────────────────────────────
  it("a non-provisional APPROVED request (daysProvisional: false) is not adjusted", async () => {
    const start = NONPROV_MONDAY;
    const end = addDaysIso(NONPROV_MONDAY, 1);
    const req = await app.prisma.leaveRequest.create({
      data: {
        employeeId: emp.id,
        leaveTypeId: vacTypeId,
        startDate: utcMidnight(start),
        endDate: utcMidnight(end),
        days: 2,
        halfDay: false,
        daysProvisional: false,
        status: "APPROVED",
        reviewedBy: adminAUserId,
      },
    });
    const { weekStart, weekEnd } = weekBoundsFor(start);
    const adjustments = await directRecalc(emp.id, weekStart, weekEnd, adminBUserId);
    expect(adjustments).toEqual([]);
    const persisted = await app.prisma.leaveRequest.findUnique({ where: { id: req.id } });
    expect(Number(persisted!.days)).toBe(2);
  });

  // ── Guard: PENDING request ───────────────────────────────────────────────────────────────
  it("a PENDING request is not adjusted even if daysProvisional happens to be set", async () => {
    const start = PENDING_MONDAY;
    const end = addDaysIso(PENDING_MONDAY, 1);
    const req = await app.prisma.leaveRequest.create({
      data: {
        employeeId: emp.id,
        leaveTypeId: vacTypeId,
        startDate: utcMidnight(start),
        endDate: utcMidnight(end),
        days: 2,
        halfDay: false,
        daysProvisional: true,
        status: "PENDING",
      },
    });
    const { weekStart, weekEnd } = weekBoundsFor(start);
    const adjustments = await directRecalc(emp.id, weekStart, weekEnd, adminBUserId);
    expect(adjustments).toEqual([]);
    const persisted = await app.prisma.leaveRequest.findUnique({ where: { id: req.id } });
    expect(Number(persisted!.days)).toBe(2);
  });

  // ── Guard: a different employee's request ───────────────────────────────────────────────
  it("another employee's request is not adjusted", async () => {
    const start = OTHEREMP_MONDAY;
    const end = addDaysIso(OTHEREMP_MONDAY, 1);
    const req = await app.prisma.leaveRequest.create({
      data: {
        employeeId: emp2.id,
        leaveTypeId: vacTypeId,
        startDate: utcMidnight(start),
        endDate: utcMidnight(end),
        days: 2,
        halfDay: false,
        daysProvisional: true,
        status: "APPROVED",
        reviewedBy: adminAUserId,
      },
    });
    const { weekStart, weekEnd } = weekBoundsFor(start);
    // Recalc for emp (NOT emp2) over the SAME week — emp2's request must stay untouched.
    const adjustments = await directRecalc(emp.id, weekStart, weekEnd, adminBUserId);
    expect(adjustments).toEqual([]);
    const persisted = await app.prisma.leaveRequest.findUnique({ where: { id: req.id } });
    expect(Number(persisted!.days)).toBe(2);
  });

  // ── Guard: soft-deleted leave request ───────────────────────────────────────────────────
  it("a soft-deleted leave request is not adjusted", async () => {
    const start = DELETED_MONDAY;
    const end = addDaysIso(DELETED_MONDAY, 1);
    const req = await app.prisma.leaveRequest.create({
      data: {
        employeeId: emp.id,
        leaveTypeId: vacTypeId,
        startDate: utcMidnight(start),
        endDate: utcMidnight(end),
        days: 2,
        halfDay: false,
        daysProvisional: true,
        status: "APPROVED",
        reviewedBy: adminAUserId,
        deletedAt: new Date(),
      },
    });
    const { weekStart, weekEnd } = weekBoundsFor(start);
    const adjustments = await directRecalc(emp.id, weekStart, weekEnd, adminBUserId);
    expect(adjustments).toEqual([]);
    const persisted = await app.prisma.leaveRequest.findUnique({ where: { id: req.id } });
    expect(Number(persisted!.days)).toBe(2);
  });

  // ── Fail-closed: a shift mutation whose recalc throws leaves no Shift row behind ────────────
  it("fail-closed: a shift mutation whose recalc throws leaves no Shift row behind (not just an error response)", async () => {
    const dateIso = FAILCLOSED_MONDAY;
    const spy = vi
      .spyOn(ShiftLeaveRecalcModule, "recalcProvisionalLeaveForShiftChange")
      .mockImplementation(async () => {
        throw new Error("Injected recalc failure (Phase 107 Plan 05 fail-closed proof)");
      });
    try {
      const res = await postShift(adminBToken, emp.id, dateIso);
      expect(res.statusCode).toBeGreaterThanOrEqual(500);

      const count = await app.prisma.shift.count({
        where: { employeeId: emp.id, date: utcMidnight(dateIso) },
      });
      expect(count).toBe(0); // the transaction rolled back — proven by row count, not just the error
    } finally {
      spy.mockRestore();
    }
  });

  // ── Bulk-route transaction shape (generate-week) ────────────────────────────────────────
  it("bulk-route shape (POST /shifts/generate-week): planning the roster recomputes an overlapping provisional request from within the SAME transaction as the creates", async () => {
    const monday = GENWEEK_MONDAY;
    const tuesday = addDaysIso(GENWEEK_MONDAY, 1);
    const wednesday = addDaysIso(GENWEEK_MONDAY, 2);

    const template = await app.prisma.shiftTemplate.create({
      data: { tenantId, name: "SLR Frühschicht", startTime: "09:00", endTime: "17:00" },
    });
    // Pattern covers ONLY Wednesday (dayOfWeek 2 = We, Phase 43's Mo=0..So=6 convention) —
    // deliberately a day OUTSIDE the Mon-Tue leave fragment below, so generate-week's own
    // leave-conflict skip never fires, while still giving the WEEK a roster (resolveLeaveDays()
    // widens its Shift query to the ENCLOSING ISO week, not just [start,end] — that is exactly
    // what makes a Wednesday shift count for a Mon-Tue fragment).
    await app.prisma.employeeShiftPattern.create({
      data: {
        employeeId: emp.id,
        dayOfWeek: 2,
        templateId: template.id,
        validFrom: PAST_ANCHOR,
        isActive: true,
      },
    });

    const createRes = await postVacation(empToken, monday, tuesday); // count 4 -> upper bound 2
    const created = JSON.parse(createRes.body);
    expect(Number(created.days)).toBe(2);
    const approveRes = await approve(created.id);
    expect(JSON.parse(approveRes.body).daysProvisional).toBe(true);

    const genRes = await app.inject({
      method: "POST",
      url: "/api/v1/shifts/generate-week",
      headers: { authorization: `Bearer ${adminBToken}` },
      payload: { weekStart: monday, commit: true },
    });
    expect(genRes.statusCode).toBe(200);
    const genBody = JSON.parse(genRes.body);
    expect(
      (genBody.create as Array<{ employeeId: string; date: string }>).some(
        (c) => c.employeeId === emp.id && c.date === wednesday,
      ),
    ).toBe(true);

    const persisted = await app.prisma.leaveRequest.findUnique({ where: { id: created.id } });
    // The week now has a roster, but neither Monday nor Tuesday itself is on it.
    expect(Number(persisted!.days)).toBe(0);
    expect(persisted!.daysProvisional).toBe(false);
  });

  // ── Delete-route transaction shape ──────────────────────────────────────────────────────
  it("delete-route shape (DELETE /shifts/:id): removing a shift recomputes an overlapping provisional request", async () => {
    const monday = DELETE_MONDAY;
    const tuesday = addDaysIso(DELETE_MONDAY, 1);

    // Seed the request directly as an already-settled candidate: APPROVED, daysProvisional
    // true, days = the D-07 upper bound. Deliberately NOT built via postVacation()+approve()+
    // postShift() — the FIRST resolver-triggered settlement of a fragment's week flips
    // daysProvisional to false (D-11: false means "the week now has a roster", a one-way
    // transition out of this resolver's `daysProvisional: true` candidate gate), so a request
    // that had already been settled by an earlier HTTP-mediated shift call is no longer a
    // candidate for a LATER one — that is a real, separately-covered guard (see the
    // non-provisional case above), not this test's concern. Seeding both rows directly keeps
    // the request eligible right up to the DELETE call below, isolating THIS route's own
    // transaction wiring.
    const created = await app.prisma.leaveRequest.create({
      data: {
        employeeId: emp.id,
        leaveTypeId: vacTypeId,
        startDate: utcMidnight(monday),
        endDate: utcMidnight(tuesday),
        days: 2,
        halfDay: false,
        daysProvisional: true,
        status: "APPROVED",
        reviewedBy: adminAUserId,
      },
    });
    await app.prisma.leaveEntitlement.updateMany({
      where: { employeeId: emp.id, leaveTypeId: vacTypeId, year: Number(monday.slice(0, 4)) },
      data: { usedDays: { increment: 2 } },
    });
    await app.prisma.shift.create({
      data: { employeeId: emp.id, date: utcMidnight(monday), startTime: "09:00", endTime: "17:00" },
    });
    const tuesdayShift = await app.prisma.shift.create({
      data: {
        employeeId: emp.id,
        date: utcMidnight(tuesday),
        startTime: "09:00",
        endTime: "17:00",
      },
    });

    const auditBefore = await auditCountFor(created.id);
    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/shifts/${tuesdayShift.id}`,
      headers: { authorization: `Bearer ${adminBToken}` },
    });
    expect(delRes.statusCode).toBe(204);

    const persisted = await app.prisma.leaveRequest.findUnique({ where: { id: created.id } });
    expect(Number(persisted!.days)).toBe(1); // only Monday still rostered
    expect(persisted!.daysProvisional).toBe(false);
    expect(await auditCountFor(created.id)).toBe(auditBefore + 1);
  });
});
