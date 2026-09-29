/**
 * leave-days-by-contract-417.test.ts
 *
 * Issue #417 (2026-09-29 owner decision, supersedes Phase 107 D-06) — dedicated regression
 * coverage for the three scenarios named explicitly in the issue's acceptance criteria. All
 * three were RED against the pre-fix `countShiftBasedLeaveDays()` (Phase 107 roster-exact
 * model): a Salon does not plan a vacation day as a shift, so the old roster-exact formula
 * always ended at 0 days for exactly the case that matters — see the issue body's two failing
 * orderings (shift-then-request, request-then-planning). Confirmed red by running this file's
 * three cases against the commit immediately before this fix (the last commit touching
 * `vacation-calc.ts` before Issue #417): (a) and (c) failed with `days: 0`, (b) failed because
 * the later roster mutation zeroed out an already-approved request's `days`.
 *
 * Day counting is now BY CONTRACT (`countShiftBasedLeaveDays()` in
 * `contexts/absence/vacation-calc.ts`) — the roster is never consulted for SHIFT_BASED leave-day
 * counting any more, at creation, approval, or via any later roster mutation.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, cleanupTestData, createTestSalon } from "./setup";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { getHolidays, STATE_MAP } from "../contexts/platform/holidays";
import { utcMidnight, dbDateStr, todayStr } from "./test-dates";

const DAY_MS = 24 * 60 * 60 * 1000;

function addDaysIso(iso: string, days: number): string {
  return dbDateStr(new Date(utcMidnight(iso).getTime() + days * DAY_MS));
}

/** Mirrors the identical helper in leave-provisional-approval.test.ts / shift-leave-recalc.test.ts. */
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

const PAST_ANCHOR = new Date(Date.UTC(new Date().getUTCFullYear() - 2, 0, 1));

// One anchor Monday per scenario — widely spaced so no overlap guard fires between cases.
const CASE_A_MONDAY = nextHolidayFreeMonday(14); // (a) shift deleted, then request created
const CASE_B_MONDAY = nextHolidayFreeMonday(28); // (b) request created, then week planned around it
const CASE_C_MONDAY = nextHolidayFreeMonday(42, 1); // (c) whole vacation week on a 5-day contract

describe("Issue #417 — SHIFT_BASED leave days counted by contract, not roster", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let vacTypeId: string;
  let adminToken: string;
  let empId: string;
  let empToken: string;

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const suffix = "i417-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const tenant = await prisma.tenant.create({
      data: { name: `I417 ${suffix}`, slug: `i417-${suffix}`, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    await createTestSalon(prisma, tenantId);
    await prisma.tenantConfig.create({ data: { tenantId } });

    const passwordHash = await bcrypt.hash("test1234", 10);

    async function makeUser(label: string, role: "EMPLOYEE" | "ADMIN") {
      const email = `i417-${label}-${suffix}@test.de`;
      const user = await prisma.user.create({
        data: { email, passwordHash, role, isActive: true },
      });
      const employee = await prisma.employee.create({
        data: {
          tenantId,
          userId: user.id,
          employeeNumber: `I417-${label.toUpperCase()}-${suffix}`,
          firstName: "I417",
          lastName: label,
          hireDate: PAST_ANCHOR,
        },
      });
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email, password: "test1234" },
      });
      return { employee, token: JSON.parse(login.body).accessToken as string };
    }

    const admin = await makeUser("admin", "ADMIN");
    adminToken = admin.token;

    // SHIFT_BASED, contract count 5 — deliberately Tue-Sat (NOT the naive Mo-Fr prefix a
    // guess-from-count algorithm would produce), matching this suite's own file conventions.
    const emp = await makeUser("emp", "EMPLOYEE");
    empId = emp.employee.id;
    empToken = emp.token;
    await prisma.workSchedule.create({
      data: {
        employeeId: empId,
        type: "SHIFT_BASED",
        weeklyHours: 40,
        contractWorkDaysPerWeek: 5,
        workDays: [2, 3, 4, 5, 6],
        validFrom: PAST_ANCHOR,
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: empId, balanceHours: 0 } });

    const vacType = await prisma.leaveType.create({
      data: { tenantId, code: "VACATION", name: "Urlaub", isPaid: true, requiresApproval: true },
    });
    vacTypeId = vacType.id;

    const thisYear = new Date().getUTCFullYear();
    for (const year of [thisYear, thisYear + 1]) {
      await prisma.leaveEntitlement.create({
        data: { employeeId: empId, leaveTypeId: vacTypeId, year, totalDays: 200, usedDays: 0 },
      });
    }
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("leave-days-by-contract-417 cleanup failed:", err);
    }
  });

  async function postShift(token: string, employeeId: string, dateIso: string) {
    return app.inject({
      method: "POST",
      url: "/api/v1/shifts/",
      headers: { authorization: `Bearer ${token}` },
      payload: { employeeId, date: dateIso, startTime: "09:00", endTime: "17:00" },
    });
  }

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
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: "APPROVED" },
    });
  }

  // ── Regression (a): shift deleted via Phorest/manual, THEN request created → 1 day ────────
  it("(a) a shift on the requested day was deleted BEFORE the request is created (the rest of the week stays rostered) — costs 1 day, not 0", async () => {
    const monday = CASE_A_MONDAY;
    const wednesday = addDaysIso(CASE_A_MONDAY, 2);

    // The rest of the week stays actively rostered (Wednesday) — this is what makes the old
    // Phase 107 "roster-exact" formula treat the week as planned and count Monday's own removed
    // shift as an exact ZERO, rather than falling back to its "no roster at all this week" flat
    // estimate. Reproduces the issue body's real scenario precisely (a partially-planned week).
    const filler = await postShift(adminToken, empId, wednesday);
    expect(filler.statusCode).toBe(201);

    // A shift once existed on Monday and was removed (mirrors Phorest soft-cancel or a manual
    // delete) — deliberately BEFORE the leave request is even created.
    const created = await postShift(adminToken, empId, monday);
    expect(created.statusCode).toBe(201);
    const shiftId = JSON.parse(created.body).id as string;
    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/shifts/${shiftId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(delRes.statusCode).toBe(204);

    // The Salon never plans a vacation day — Monday now has NO active shift, while the rest of
    // the week (Wednesday) does. Pre-fix (Phase 107 roster-exact): this produced `days: 0`.
    const reqRes = await postVacation(empToken, monday, monday);
    expect(reqRes.statusCode).toBe(201);
    const created2 = JSON.parse(reqRes.body);
    expect(Number(created2.days)).toBe(1);

    const approveRes = await approve(created2.id);
    expect(approveRes.statusCode).toBe(200);
    const approved = JSON.parse(approveRes.body);
    expect(Number(approved.days)).toBe(1);
    expect(approved.daysProvisional).toBe(false);
  });

  // ── Regression (b): request created, THEN the week is planned WITHOUT that day → unchanged ─
  it("(b) the request is created and approved FIRST, then the Salon plans the week around it (never on the leave day) — days stay unchanged", async () => {
    const monday = CASE_B_MONDAY;
    const tuesday = addDaysIso(CASE_B_MONDAY, 1);
    const wednesday = addDaysIso(CASE_B_MONDAY, 2);

    const reqRes = await postVacation(empToken, monday, tuesday); // Mon+Tue, contract 5 -> min(2,5)=2
    expect(reqRes.statusCode).toBe(201);
    const created = JSON.parse(reqRes.body);
    expect(Number(created.days)).toBe(2);

    const approveRes = await approve(created.id);
    expect(approveRes.statusCode).toBe(200);
    const approved = JSON.parse(approveRes.body);
    expect(Number(approved.days)).toBe(2);
    expect(approved.daysProvisional).toBe(false);

    // The Salon plans the rest of the week (Wed) — deliberately NEVER on Monday or Tuesday,
    // the employee's actual leave days. Pre-fix (Phase 107 roster-exact), this kind of "week now
    // has a roster, but not on the leave days" planning zeroed the request's days out.
    const shiftRes = await postShift(adminToken, empId, wednesday);
    expect(shiftRes.statusCode).toBe(201);

    const persisted = await app.prisma.leaveRequest.findUnique({ where: { id: created.id } });
    expect(Number(persisted!.days)).toBe(2);
    expect(persisted!.daysProvisional).toBe(false);
  });

  // ── Regression (c): a whole vacation week on a 5-day contract costs 5 days ─────────────────
  it("(c) a whole calendar week of vacation on a 5-day contract costs 5 days", async () => {
    const monday = CASE_C_MONDAY;
    const sunday = addDaysIso(CASE_C_MONDAY, 6);

    const reqRes = await postVacation(empToken, monday, sunday);
    expect(reqRes.statusCode).toBe(201);
    const created = JSON.parse(reqRes.body);
    expect(Number(created.days)).toBe(5);

    const approveRes = await approve(created.id);
    expect(approveRes.statusCode).toBe(200);
    const approved = JSON.parse(approveRes.body);
    expect(Number(approved.days)).toBe(5);
    expect(approved.daysProvisional).toBe(false);
  });
});
