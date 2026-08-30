/**
 * phorest-shift-leave-recalc.test.ts
 *
 * Phase 107 Plan 06 — cron-path integration coverage for the Phorest sync's own
 * `recalcProvisionalLeaveForShiftChange()` wiring (the eighth D-14 write path,
 * `apps/api/src/services/phorest/sync-shifts.ts`). Mirrors two existing suites rather than
 * inventing new mechanisms:
 *   - `shift-leave-recalc.test.ts` (Plan 05) for the fixture shape: contractual counts that are
 *     not 5, `workDays` seeded to disagree with each count's naive Mo-Fr prefix (so an accidental
 *     fall-back surfaces as a wrong number), every date routed through `test-dates.ts`, and the
 *     "seed the LeaveRequest directly as an already-settled/still-provisional candidate" idiom
 *     for cases that need precise control over the resolver's own guard state.
 *   - `services/phorest/__tests__/sync-shifts.test.ts` (Phase 85) for the Phorest fetch-stubbing
 *     harness: a `global.fetch` mock keyed on the URL containing "worktimetable", the static
 *     `staff.json` fixture, and `seedPhorestTenant()`/`cleanupPhorestTenant()` from that suite's
 *     own `helpers.ts` (tenant + three mapped/unmapped employees + `PhorestStaffMapping`,
 *     `MAPPED_STAFF_ID` / `MAPPED_STAFF_ID_2`). Neither the stubbing mechanism nor the seed
 *     helpers are duplicated here.
 *
 * Key semantics carried over from Plan 05 that shape several fixtures below: `daysProvisional`
 * is request-level, "true iff AT LEAST ONE fragment (partial ISO week) of the period lacks a
 * roster" (`countShiftBasedLeaveDays()`, `utils/vacation-calc.ts`). Once every fragment a request
 * touches has SOME roster, `daysProvisional` flips to `false` and the request permanently exits
 * the resolver's own candidate gate — a later roster change (e.g. a soft-cancel) no longer
 * recomputes it. Two cases below (the soft-cancel case and the de-dup case) deliberately use a
 * TWO-fragment period so one fragment can be repeatedly touched while the other stays
 * unrostered, keeping the request a valid candidate across multiple sync-triggered recomputes —
 * without this, a second touch to an already-settled single-fragment request would silently be a
 * guard no-op, not proof of anything.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp } from "./setup";
import { utcMidnight, dbDateStr, todayStr, pastDateStr, dowOf } from "./test-dates";
import { getHolidays, STATE_MAP } from "../utils/holidays";
import { syncPhorestShifts } from "../services/phorest/sync-shifts";
import * as ShiftLeaveRecalcModule from "../utils/shift-leave-recalc-resolver";
import {
  seedPhorestTenant,
  cleanupPhorestTenant,
  MAPPED_STAFF_ID,
  MAPPED_STAFF_ID_2,
} from "../services/phorest/__tests__/helpers";
import staffFixture from "../services/phorest/__tests__/fixtures/staff.json";

const originalFetch = global.fetch;
const DAY_MS = 24 * 60 * 60 * 1000;

function addDaysIso(iso: string, days: number): string {
  return dbDateStr(new Date(utcMidnight(iso).getTime() + days * DAY_MS));
}

/**
 * Mirrors `shift-leave-recalc.test.ts`'s own private helper verbatim (not exported from
 * `test-dates.ts` — every SHIFT_BASED leave-fixture file in this suite keeps its own copy). Next
 * Monday at least `daysOut` days out, advanced by whole weeks until `weekSpan` consecutive weeks
 * contain ZERO NIEDERSACHSEN public holidays, so no real calendar holiday silently changes an
 * expected day count anywhere in this file.
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

/** Monday (UTC midnight Date) of the ISO week containing `iso`. */
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

/** A `{ startDate, endDate }` SyncOpts window tightly scoped around the ISO week containing
 *  `mondayIso` — one day of slack on each side, never wide enough to reach another test's
 *  widely-spaced week. */
function windowAround(mondayIso: string): { startDate: string; endDate: string } {
  return { startDate: addDaysIso(mondayIso, -1), endDate: addDaysIso(mondayIso, 8) };
}

interface MockSlot {
  staffId: string;
  date: string;
  startTime?: string;
  endTime?: string;
}

/** Stubs the Phorest fetch layer exactly like `sync-shifts.test.ts`'s own `mockPhorest()` — a
 *  `global.fetch` mock keyed on the URL containing "worktimetable" — grouping the given flat
 *  slot list into the real `_embedded.workTimeTables[].timeSlots[]` v3 envelope shape. Does not
 *  introduce a new stubbing mechanism. */
function mockPhorestSlots(slots: MockSlot[]): void {
  const byStaff = new Map<string, MockSlot[]>();
  for (const s of slots) {
    if (!byStaff.has(s.staffId)) byStaff.set(s.staffId, []);
    byStaff.get(s.staffId)!.push(s);
  }
  const workTimeTables = [...byStaff.entries()].map(([staffId, staffSlots]) => ({
    staffId,
    branchId: "branch-1",
    timeSlots: staffSlots.map((s) => ({
      date: s.date,
      startTime: s.startTime ?? "09:00:00",
      endTime: s.endTime ?? "17:00:00",
      type: "WORKING",
    })),
  }));
  const body = {
    _embedded: { workTimeTables },
    page: { size: 200, totalElements: workTimeTables.length, totalPages: 1, number: 0 },
  };
  global.fetch = vi.fn(async (url: string | URL) => {
    const u = url.toString();
    const respBody = u.includes("worktimetable") ? body : staffFixture;
    return new Response(JSON.stringify(respBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("Phorest sync — shift-leave-recalc cron-path wiring (Phase 107 Plan 06)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedPhorestTenant>>;
  let tenantId: string;
  let vacTypeId: string;
  let managerUserId: string;
  let erikaId: string;
  let erikaUserId: string;
  let beaId: string;
  let beaUserId: string;

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    seed = await seedPhorestTenant(app, "recalc");
    tenantId = seed.tenantId;
    erikaId = seed.mappedEmployeeId;
    beaId = seed.mappedEmployeeId2;

    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const managerUser = await prisma.user.create({
      data: {
        email: `phorest-recalc-mgr-${suffix}@test.de`,
        passwordHash: "x",
        role: "MANAGER",
        isActive: true,
      },
    });
    managerUserId = managerUser.id;
    await prisma.employee.create({
      data: {
        tenantId,
        userId: managerUserId,
        employeeNumber: `PR-MGR-${suffix}`,
        firstName: "Recalc",
        lastName: "Manager",
        hireDate: new Date("2020-01-01"),
      },
    });

    // Erika (MAPPED_STAFF_ID): count 4, Tue-Fri — deliberately NOT the naive Mo-Fr prefix
    // [1,2,3,4] a guess-from-count algorithm would produce for count 4 (D-02: workDays is frozen
    // and irrelevant to SHIFT_BASED leave-day math post-Phase-107).
    await prisma.workSchedule.create({
      data: {
        employeeId: erikaId,
        type: "SHIFT_BASED",
        weeklyHours: 32,
        contractWorkDaysPerWeek: 4,
        workDays: [2, 3, 4, 5],
        validFrom: new Date("2020-01-01"),
      },
    });
    // Bea (MAPPED_STAFF_ID_2): count 3, Wed/Thu/Sat — disagrees with the naive Mo-Fr prefix
    // [1,2,3] for count 3.
    await prisma.workSchedule.create({
      data: {
        employeeId: beaId,
        type: "SHIFT_BASED",
        weeklyHours: 24,
        contractWorkDaysPerWeek: 3,
        workDays: [3, 4, 6],
        validFrom: new Date("2020-01-01"),
      },
    });

    const employees = await prisma.employee.findMany({
      where: { id: { in: [erikaId, beaId] } },
      select: { id: true, userId: true },
    });
    erikaUserId = employees.find((e) => e.id === erikaId)!.userId;
    beaUserId = employees.find((e) => e.id === beaId)!.userId;

    const vacType = await prisma.leaveType.create({
      data: { tenantId, name: "Urlaub", isPaid: true, requiresApproval: true },
    });
    vacTypeId = vacType.id;

    const thisYear = new Date().getUTCFullYear();
    for (const employeeId of [erikaId, beaId]) {
      for (const year of [thisYear - 1, thisYear, thisYear + 1]) {
        await prisma.leaveEntitlement.create({
          data: { employeeId, leaveTypeId: vacTypeId, year, totalDays: 200, usedDays: 0 },
        });
      }
    }
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    try {
      // TimeEntry.employee is onDelete: Restrict (CLAUDE.md) — cleanupPhorestTenant() does not
      // know about the AC-RC-05 fixture's locked TimeEntry, so it must be removed first or the
      // whole tenant cleanup below throws and silently leaks the fixture into clokr_test.
      await app.prisma.timeEntry.deleteMany({ where: { employeeId: { in: [erikaId, beaId] } } });
      await cleanupPhorestTenant(app, tenantId);
    } catch (err) {
      console.error("phorest-shift-leave-recalc cleanup failed:", err);
    }
  });

  // ── Helpers ──────────────────────────────────────────────────────────────────────────────

  async function usedDaysFor(employeeId: string, dateIsoForYear: string): Promise<number> {
    const year = Number(dateIsoForYear.slice(0, 4));
    const ent = await app.prisma.leaveEntitlement.findUnique({
      where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId: vacTypeId, year } },
    });
    return Number(ent?.usedDays ?? 0);
  }

  /** Seeds an APPROVED LeaveRequest directly (mirrors shift-leave-recalc.test.ts's own
   *  "delete-route shape" precedent) and bumps usedDays to match — bypassing the HTTP
   *  create+approve flow so the test controls `daysProvisional`/`days` precisely. */
  async function seedRequest(
    employeeId: string,
    startIso: string,
    endIso: string,
    days: number,
    daysProvisional: boolean,
  ): Promise<string> {
    const req = await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: vacTypeId,
        startDate: utcMidnight(startIso),
        endDate: utcMidnight(endIso),
        days,
        halfDay: false,
        daysProvisional,
        status: "APPROVED",
        reviewedBy: managerUserId,
      },
    });
    await app.prisma.leaveEntitlement.updateMany({
      where: { employeeId, leaveTypeId: vacTypeId, year: Number(startIso.slice(0, 4)) },
      data: { usedDays: { increment: days } },
    });
    return req.id;
  }

  async function auditRowsFor(leaveRequestId: string) {
    return app.prisma.auditLog.findMany({
      where: { action: "LEAVE_DAYS_ADJUSTED", entityId: leaveRequestId },
      orderBy: { createdAt: "asc" },
    });
  }

  async function notificationsFor(leaveRequestId: string) {
    return app.prisma.notification.findMany({
      where: {
        relatedType: "LeaveRequest",
        relatedId: leaveRequestId,
        type: "LEAVE_DAYS_ADJUSTED",
      },
    });
  }

  // ── Main case: adjustment fires, SYSTEM (null) audit userId, both recipients notified ──────
  it("cron path: planning the roster for a period with an approved provisional VACATION request recomputes its days, corrects the entitlement, audits with a SYSTEM (null) userId, and notifies employee + manager", async () => {
    const monday = nextHolidayFreeMonday(14);
    const tuesday = addDaysIso(monday, 1);

    const usedBefore = await usedDaysFor(erikaId, monday);
    const requestId = await seedRequest(erikaId, monday, tuesday, 2, true); // D-07 upper bound: min(2,4)=2

    mockPhorestSlots([{ staffId: MAPPED_STAFF_ID, date: tuesday }]); // plans ONLY Tuesday
    const res = await syncPhorestShifts(app, tenantId, windowAround(monday));
    expect(res.status).toBe("SUCCESS");

    const persisted = await app.prisma.leaveRequest.findUnique({ where: { id: requestId } });
    expect(Number(persisted!.days)).toBe(1); // roster-exact: only Tuesday is actually rostered
    expect(persisted!.daysProvisional).toBe(false);
    expect(await usedDaysFor(erikaId, monday)).toBe(usedBefore + 1); // 2 -> 1, delta -1

    const audits = await auditRowsFor(requestId);
    expect(audits.length).toBe(1);
    expect(audits[0].userId).toBeNull(); // the SYSTEM convention: never a literal "SYSTEM" string
    const oldVal = audits[0].oldValue as { days: number };
    const newVal = audits[0].newValue as { days: number; trigger: string; triggerSource: string };
    expect(oldVal.days).toBe(2);
    expect(newVal.days).toBe(1);
    expect(newVal.trigger).toBe("Roster-Planung");
    // Phase 120 (D-06/D-07): no request exists on the cron path — the row must carry no IP and no
    // invented substitute, and must SAY it is a sync so the empty IP is not ambiguous.
    expect(audits[0].ipAddress).toBeNull();
    expect(audits[0].userAgent).toBeNull();
    expect(newVal.triggerSource).toBe("SYNC");

    const notifications = await notificationsFor(requestId);
    const recipients = notifications.map((n) => n.userId);
    expect(recipients).toContain(erikaUserId);
    expect(recipients).toContain(managerUserId);
  });

  // ── AC-RC-04 — period already past ──────────────────────────────────────────────────────
  it("AC-RC-04 cron path: a request whose period is already fully in the past is not adjusted by the sync", async () => {
    const pastDay = pastDateStr(45);
    const pastMonday = dbDateStr(weekBoundsFor(pastDay).weekStart);

    const requestId = await seedRequest(erikaId, pastDay, pastDay, 1, true);

    mockPhorestSlots([{ staffId: MAPPED_STAFF_ID, date: pastDay }]);
    const res = await syncPhorestShifts(app, tenantId, windowAround(pastMonday));
    expect(res.status).toBe("SUCCESS");

    // The shift itself still gets written (the guard is scoped to the leave recompute only).
    const shiftCount = await app.prisma.shift.count({
      where: { employeeId: erikaId, date: utcMidnight(pastDay), deletedAt: null },
    });
    expect(shiftCount).toBe(1);

    const persisted = await app.prisma.leaveRequest.findUnique({ where: { id: requestId } });
    expect(Number(persisted!.days)).toBe(1);
    expect((await auditRowsFor(requestId)).length).toBe(0);
    expect((await notificationsFor(requestId)).length).toBe(0);
  });

  // ── AC-RC-05 — locked month ──────────────────────────────────────────────────────────────
  it("AC-RC-05 cron path: a request in a month with a locked TimeEntry is not adjusted by the sync", async () => {
    const monday = nextHolidayFreeMonday(28);
    const tuesday = addDaysIso(monday, 1);

    const requestId = await seedRequest(erikaId, monday, tuesday, 2, true);
    // isSnapshotLocked()'s actual signal is a locked TimeEntry, not a SaldoSnapshot flag.
    await app.prisma.timeEntry.create({
      data: {
        employeeId: erikaId,
        date: utcMidnight(monday),
        startTime: new Date(`${monday}T09:00:00Z`),
        isLocked: true,
      },
    });

    mockPhorestSlots([{ staffId: MAPPED_STAFF_ID, date: tuesday }]);
    const res = await syncPhorestShifts(app, tenantId, windowAround(monday));
    expect(res.status).toBe("SUCCESS");

    const persisted = await app.prisma.leaveRequest.findUnique({ where: { id: requestId } });
    expect(Number(persisted!.days)).toBe(2);
    expect((await auditRowsFor(requestId)).length).toBe(0);
    expect((await notificationsFor(requestId)).length).toBe(0);
  });

  // ── AC-RC-06 — whole ISO weeks are roster-independent ───────────────────────────────────
  it("AC-RC-06 cron path: a request covering only whole ISO weeks is unchanged after the sync plans the roster", async () => {
    const monday = nextHolidayFreeMonday(42, 2);
    const end = addDaysIso(monday, 13); // exactly 2 whole ISO weeks
    const midWeek = addDaysIso(monday, 2);

    // Whole-week-only periods are NEVER provisional by construction (countShiftBasedLeaveDays()
    // never consults the roster for a whole week) — daysProvisional=false is the REAL value the
    // approval-time recompute would have produced, not a simplification.
    const requestId = await seedRequest(erikaId, monday, end, 8, false); // 4/week * 2 weeks

    mockPhorestSlots([{ staffId: MAPPED_STAFF_ID, date: midWeek }]);
    const res = await syncPhorestShifts(app, tenantId, {
      startDate: addDaysIso(monday, -1),
      endDate: addDaysIso(monday, 15),
    });
    expect(res.status).toBe("SUCCESS");

    const persisted = await app.prisma.leaveRequest.findUnique({ where: { id: requestId } });
    expect(Number(persisted!.days)).toBe(8); // unchanged — whole weeks ignore the roster (D-06)
    expect((await auditRowsFor(requestId)).length).toBe(0);
  });

  // ── Soft-cancel (SS-04) mutation site also triggers a recompute ────────────────────────────
  it("soft-cancel (SS-04) mutation site also triggers the recompute for the affected employee/week", async () => {
    const monday = nextHolidayFreeMonday(56);
    const wednesday = addDaysIso(monday, 2);

    // Pre-seed the Wednesday shift directly (bypassing sync) so it is ALREADY the sole occupant
    // of this week's roster before the request is even created.
    await app.prisma.shift.create({
      data: {
        employeeId: erikaId,
        date: utcMidnight(wednesday),
        startTime: "09:00",
        endTime: "17:00",
        origin: "PHOREST",
        externalId: `presync-softcancel-${monday}`,
      },
    });
    // Mon-Wed fragment (3 calendar days, count 4): the roster-exact value with Wednesday alone
    // rostered is 1 — seeded to match, so this is a genuine candidate, not yet touched by any
    // resolver call in this test.
    const requestId = await seedRequest(erikaId, monday, wednesday, 1, true);

    // The fresh Phorest window does NOT include Erika's Wednesday slot at all (staffId absent)
    // — a filler slot for BEA on Friday of this SAME already-holiday-validated week keeps
    // freshExternalIds non-empty (GATE 3) without touching Erika's own roster: `weeksWithRoster`/
    // `rosteredDates` are computed per-employee, so Bea's filler shift cannot change Erika's own
    // recompute. Deliberately NOT a different week reached via a second nextHolidayFreeMonday-style
    // jump (e.g. "+7 days") — two INDEPENDENTLY holiday-adjusted weeks from two different tests can
    // land on the exact same calendar week (observed empirically: softcancel's own week here skips
    // past a NIEDERSACHSEN holiday to Nov 2, and a "+7" filler would have landed exactly on the
    // isolation case's own independently-computed week) — staying inside THIS test's own already-
    // validated 7-day span removes that risk structurally instead of by chance.
    mockPhorestSlots([{ staffId: MAPPED_STAFF_ID_2, date: addDaysIso(monday, 4) }]);
    const res = await syncPhorestShifts(app, tenantId, windowAround(monday));
    expect(res.status).toBe("SUCCESS");
    expect(res.cancelled).toBe(1);

    const cancelledShift = await app.prisma.shift.findFirst({
      where: { employeeId: erikaId, date: utcMidnight(wednesday) },
    });
    expect(cancelledShift?.deletedReason).toBe("PHOREST_REMOVED");

    // Week now has ZERO active shifts -> flat estimate: min(3 calendar days, count 4) = 3.
    const persisted = await app.prisma.leaveRequest.findUnique({ where: { id: requestId } });
    expect(Number(persisted!.days)).toBe(3);
    expect(persisted!.daysProvisional).toBe(true); // flat branch is always provisional

    const audits = await auditRowsFor(requestId);
    expect(audits.length).toBe(1);
    expect(audits[0].userId).toBeNull();
    expect((audits[0].oldValue as { days: number }).days).toBe(1);
    expect((audits[0].newValue as { days: number }).days).toBe(3);
  });

  // ── Per-shift transaction isolation ─────────────────────────────────────────────────────
  it("per-shift transaction isolation: one employee's recalc failure leaves their shift unwritten while the other employee's shift and adjustment persist; the run reports the failure", async () => {
    const monday = nextHolidayFreeMonday(70);
    const tuesday = addDaysIso(monday, 1);

    const beaRequestId = await seedRequest(beaId, monday, tuesday, 2, true); // min(2,3)=2

    // Capture the PLAIN function reference before spying — `vi.spyOn` mutates the module's own
    // `recalcProvisionalLeaveForShiftChange` property in place (ESM modules are singletons), so
    // `vi.importActual()` re-resolving the SAME specifier afterwards would hand back that very
    // mutated property (infinite recursion), not a pristine copy. Reading the property NOW, before
    // `.mockImplementation()` below reassigns it, is what actually gets the real implementation.
    const originalRecalc = ShiftLeaveRecalcModule.recalcProvisionalLeaveForShiftChange;
    const spy = vi
      .spyOn(ShiftLeaveRecalcModule, "recalcProvisionalLeaveForShiftChange")
      .mockImplementation(async (...args) => {
        const [, , employeeId] = args;
        if (employeeId === erikaId) {
          throw new Error("Injected recalc failure (Phase 107 Plan 06 isolation proof)");
        }
        return originalRecalc(...args);
      });

    try {
      mockPhorestSlots([
        { staffId: MAPPED_STAFF_ID, date: tuesday },
        { staffId: MAPPED_STAFF_ID_2, date: tuesday },
      ]);
      const res = await syncPhorestShifts(app, tenantId, windowAround(monday));
      expect(res.status).toBe("SUCCESS"); // one employee's failure does not poison the run
      expect(res.leaveRecalcFailures).toBeGreaterThanOrEqual(1);

      const erikaShiftCount = await app.prisma.shift.count({
        where: { employeeId: erikaId, date: utcMidnight(tuesday) },
      });
      expect(erikaShiftCount).toBe(0); // the transaction rolled back — proven by row count

      const beaShiftCount = await app.prisma.shift.count({
        where: { employeeId: beaId, date: utcMidnight(tuesday), deletedAt: null },
      });
      expect(beaShiftCount).toBe(1); // the healthy employee's shift persists

      const persisted = await app.prisma.leaveRequest.findUnique({
        where: { id: beaRequestId },
      });
      expect(Number(persisted!.days)).toBe(1); // Bea's request WAS adjusted (roster-exact)
      expect((await auditRowsFor(beaRequestId)).length).toBe(1);
      const beaNotifications = await notificationsFor(beaRequestId);
      expect(beaNotifications.map((n) => n.userId)).toContain(beaUserId);
    } finally {
      spy.mockRestore();
    }
  });

  // ── Notification de-dup ─────────────────────────────────────────────────────────────────
  it("notification de-dup: two mutation-site adjustments touching the same (employee, week) in one run send exactly one notification per recipient", async () => {
    const monday = nextHolidayFreeMonday(84);
    const thursday = addDaysIso(monday, 3);
    const friday = addDaysIso(monday, 4);
    // Second fragment (following week) deliberately left unrostered by this test, so the
    // request stays daysProvisional=true across BOTH adjustments below (see the file header).
    const followingWed = addDaysIso(monday, 9);

    const requestId = await seedRequest(erikaId, thursday, followingWed, 7, true); // min(4,4)+min(3,4)=4+3

    // Two WORKING slots for Erika in the SAME week (Thu + Fri) -> two separate per-shift
    // transactions, two separate recalcProvisionalLeaveForShiftChange() calls, same
    // (employeeId, weekStart).
    mockPhorestSlots([
      { staffId: MAPPED_STAFF_ID, date: thursday },
      { staffId: MAPPED_STAFF_ID, date: friday },
    ]);
    const res = await syncPhorestShifts(app, tenantId, windowAround(monday));
    expect(res.status).toBe("SUCCESS");

    const persisted = await app.prisma.leaveRequest.findUnique({ where: { id: requestId } });
    // Week 1 fragment settles to roster-exact (2: Thu+Fri); week 2 fragment stays flat (3).
    expect(Number(persisted!.days)).toBe(5);
    expect(persisted!.daysProvisional).toBe(true); // week 2 still has no roster

    const audits = await auditRowsFor(requestId);
    expect(audits.length).toBe(2); // both DB-level adjustments happened (7->4, then 4->5)

    const notifications = await notificationsFor(requestId);
    const employeeNotifs = notifications.filter((n) => n.userId === erikaUserId);
    const managerNotifs = notifications.filter((n) => n.userId === managerUserId);
    expect(employeeNotifs.length).toBe(1); // de-duped: not one per adjustment
    expect(managerNotifs.length).toBe(1);
  });

  // ── Manual-trigger actor path ────────────────────────────────────────────────────────────
  it("manual-trigger actor path: audits with the real acting user (not the SYSTEM sentinel) and still applies the except-the-actor notification skip", async () => {
    const monday = nextHolidayFreeMonday(98);
    const tuesday = addDaysIso(monday, 1);

    const requestId = await seedRequest(erikaId, monday, tuesday, 2, true);

    mockPhorestSlots([{ staffId: MAPPED_STAFF_ID, date: tuesday }]);
    // Simulates routes/integrations.ts POST /phorest/sync-shifts — actorUserId = the manager who
    // clicked "sync now", who is ALSO this request's own approver.
    const res = await syncPhorestShifts(app, tenantId, {
      ...windowAround(monday),
      actorUserId: managerUserId,
    });
    expect(res.status).toBe("SUCCESS");

    const audits = await auditRowsFor(requestId);
    expect(audits.length).toBe(1);
    expect(audits[0].userId).toBe(managerUserId); // a REAL actor, not the SYSTEM sentinel
    // Phase 120 (D-06): this pins that decision deliberately — a manual re-sync carries a real
    // acting user but is still a sync, and still gets no IP. Without this assertion, a future
    // reader could reasonably "fix" the manual path by threading a request into it and break
    // the decision silently.
    expect(audits[0].ipAddress).toBeNull();
    const newVal = audits[0].newValue as { triggerSource: string };
    expect(newVal.triggerSource).toBe("SYNC");

    const notifications = await notificationsFor(requestId);
    const recipients = notifications.map((n) => n.userId);
    expect(recipients).toContain(erikaUserId);
    expect(recipients).not.toContain(managerUserId); // manager is the acting user — skipped
  });
});
