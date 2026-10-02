/**
 * leave-week-union-436.test.ts
 *
 * Issue #436 (D-04/D-09, 436-AC-04/436-AC-08) — per-ISO-week union pricing across SIBLING
 * vacation requests of the SAME SHIFT_BASED employee (owner Ergänzung 01.10.2026).
 *
 * Owner example (4-day contract, no Angabe, one ISO week): POST VACATION Mo-Mi costs 3, THEN
 * POST VACATION Do-Sa in the SAME week costs 1 (3 + 1 = 4, not 6). RED evidence (pre-436-04
 * base, before this plan's leave-days.ts/vacation-calc.ts changes landed): both requests priced
 * independently via `countShiftBasedLeaveDays` alone — Mo-Mi returned 3 (unaffected, no sibling
 * query existed at all), Do-Sa ALSO returned 3 (its own 3-day fragment, with no awareness of
 * Mo-Mi already occupying the week) — i.e. the pre-fix total was 3 + 3 = 6, not the owner's
 * required 3 + 1 = 4.
 *
 * Every other case in this file pins one of the per-call-site regressions D-04/D-09 require:
 * approval ordering (both directions), PENDING self-exclusion, correction, the never-rewritten
 * guarantee, § 9 credit-back, and non-VACATION isolation.
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

/** Mirrors the identical helper in leave-days-by-contract-417.test.ts /
 * shift-based-usual-workdays-436.test.ts / leave-provisional-approval.test.ts. */
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

/** Like `nextHolidayFreeMonday`, but anchored at an already-known Monday ISO string instead of
 * "today" — used to build a sequence of Mondays that is guaranteed MONOTONICALLY increasing
 * (each independent `nextHolidayFreeMonday(daysOut)` call could, after its own holiday-skip
 * loop, land AFTER a later group's unadjusted candidate, producing an overlap the per-employee
 * overlap guard then 409s on). */
function holidayFreeMondayFrom(fromMondayIso: string, weekSpan = 1): string {
  let candidateIso = fromMondayIso;
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
    `holidayFreeMondayFrom: exceeded MAX_ADVANCES without a holiday-free ${weekSpan}-week span`,
  );
}

const PAST_ANCHOR = new Date(Date.UTC(new Date().getUTCFullYear() - 2, 0, 1));

// Nine SEQUENTIALLY built, holiday-free Mondays (each >= 14 days after the previous one) — one
// per test group, so no group's requests ever overlap another's (the overlap guard is scoped to
// the employee, shared across all groups). Built sequentially (not independent `daysOut` calls)
// so each group's own holiday-skip loop can never leapfrog the next group's base candidate.
const MONDAYS: string[] = [nextHolidayFreeMonday(14)];
for (let i = 1; i < 9; i++) {
  MONDAYS.push(holidayFreeMondayFrom(addDaysIso(MONDAYS[i - 1], 14)));
}

describe("Issue #436 — per-ISO-week union pricing across sibling requests (D-04/D-09)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let empId: string;
  let empToken: string;
  let vacationTypeId: string;
  let sickTypeId: string;

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const suffix = "u436-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const tenant = await prisma.tenant.create({
      data: { name: `U436 ${suffix}`, slug: `u436-${suffix}`, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    await createTestSalon(prisma, tenantId);
    await prisma.tenantConfig.create({ data: { tenantId } });

    const passwordHash = await bcrypt.hash("test1234", 10);

    async function makeUser(label: string, role: "EMPLOYEE" | "ADMIN") {
      const email = `u436-${label}-${suffix}@test.de`;
      const user = await prisma.user.create({
        data: { email, passwordHash, role, isActive: true },
      });
      const employee = await prisma.employee.create({
        data: {
          tenantId,
          userId: user.id,
          employeeNumber: `U436-${label.toUpperCase()}-${suffix}`,
          firstName: "U436",
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

    // SHIFT_BASED, contract count 4, no usual-workday Angabe (keine Angabe — this plan's
    // marginal-cost rule applies regardless, see D-05).
    const emp = await makeUser("emp", "EMPLOYEE");
    empId = emp.employee.id;
    empToken = emp.token;
    await prisma.workSchedule.create({
      data: {
        employeeId: empId,
        type: "SHIFT_BASED",
        weeklyHours: 38,
        contractWorkDaysPerWeek: 4,
        workDays: [2, 3, 4, 5],
        validFrom: PAST_ANCHOR,
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: empId, balanceHours: 0 } });

    const vacType = await prisma.leaveType.create({
      data: { tenantId, code: "VACATION", name: "Urlaub", isPaid: true, requiresApproval: true },
    });
    vacationTypeId = vacType.id;
    const sickType = await prisma.leaveType.create({
      data: { tenantId, code: "SICK", name: "Krankheit", isPaid: true, requiresApproval: true },
    });
    sickTypeId = sickType.id;

    const thisYear = new Date().getUTCFullYear();
    for (const year of [thisYear, thisYear + 1]) {
      await prisma.leaveEntitlement.create({
        data: { employeeId: empId, leaveTypeId: vacType.id, year, totalDays: 200, usedDays: 0 },
      });
    }
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("leave-week-union-436 cleanup failed:", err);
    }
  });

  async function postVacation(startDate: string, endDate: string, halfDay = false) {
    return app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${empToken}` },
      payload: { type: "VACATION", startDate, endDate, halfDay },
    });
  }

  async function postSick(startDate: string, endDate: string) {
    return app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${empToken}` },
      payload: { type: "SICK", startDate, endDate },
    });
  }

  async function review(id: string, status: "APPROVED" | "REJECTED") {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${id}/review`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status },
    });
  }

  it("(owner example) POST VACATION Mo-Mi costs 3, THEN POST VACATION Do-Sa in the same ISO week costs 1 (3 + 1 = 4, not 6)", async () => {
    const monday = MONDAYS[0];
    const resA = await postVacation(monday, addDaysIso(monday, 2)); // Mo-Mi
    expect(resA.statusCode).toBe(201);
    expect(Number(JSON.parse(resA.body).days)).toBe(3);

    const resB = await postVacation(addDaysIso(monday, 3), addDaysIso(monday, 5)); // Do-Sa
    expect(resB.statusCode).toBe(201);
    expect(Number(JSON.parse(resB.body).days)).toBe(1);
  });

  it("Approval ordering: A=Mo-Mi then B=Do-Sa, both PENDING (3 and 1); approve A, then B -> stored A=3, B=1; entitlement usedDays increases by exactly 4", async () => {
    const monday = MONDAYS[1];
    const resA = await postVacation(monday, addDaysIso(monday, 2)); // Mo-Mi
    const idA = JSON.parse(resA.body).id as string;
    const resB = await postVacation(addDaysIso(monday, 3), addDaysIso(monday, 5)); // Do-Sa
    const idB = JSON.parse(resB.body).id as string;

    const year = Number(monday.slice(0, 4));
    const entBefore = await app.prisma.leaveEntitlement.findUniqueOrThrow({
      where: {
        employeeId_leaveTypeId_year: { employeeId: empId, leaveTypeId: vacationTypeId, year },
      },
    });

    const approveA = await review(idA, "APPROVED");
    expect(approveA.statusCode).toBe(200);
    expect(Number(JSON.parse(approveA.body).days)).toBe(3);

    const approveB = await review(idB, "APPROVED");
    expect(approveB.statusCode).toBe(200);
    expect(Number(JSON.parse(approveB.body).days)).toBe(1);

    const entAfter = await app.prisma.leaveEntitlement.findUniqueOrThrow({
      where: {
        employeeId_leaveTypeId_year: { employeeId: empId, leaveTypeId: vacationTypeId, year },
      },
    });
    expect(Number(entAfter.usedDays) - Number(entBefore.usedDays)).toBe(4);
  });

  it("Reverse creation order: B=Do-Sa created FIRST (costs 3 alone), A=Mo-Mi created SECOND (costs 1 against B); after approving both: B stays 3, A stays 1", async () => {
    const monday = MONDAYS[2];
    const resB = await postVacation(addDaysIso(monday, 3), addDaysIso(monday, 5)); // Do-Sa, FIRST
    expect(Number(JSON.parse(resB.body).days)).toBe(3);
    const idB = JSON.parse(resB.body).id as string;

    const resA = await postVacation(monday, addDaysIso(monday, 2)); // Mo-Mi, SECOND
    expect(Number(JSON.parse(resA.body).days)).toBe(1);
    const idA = JSON.parse(resA.body).id as string;

    const approveB = await review(idB, "APPROVED");
    expect(Number(JSON.parse(approveB.body).days)).toBe(3);
    const approveA = await review(idA, "APPROVED");
    expect(Number(JSON.parse(approveA.body).days)).toBe(1);
  });

  it("PENDING edit with self-exclusion: A approved Mo-Mi (3), B pending Do-Sa (1) edited to Fr-Sa -> 1 (cost {Mo,Di,Mi,Fr,Sa}=4 minus A's 3) — 0 would mean B priced against its own OLD dates", async () => {
    const monday = MONDAYS[3];
    const resA = await postVacation(monday, addDaysIso(monday, 2)); // Mo-Mi
    const idA = JSON.parse(resA.body).id as string;
    await review(idA, "APPROVED");

    const resB = await postVacation(addDaysIso(monday, 3), addDaysIso(monday, 5)); // Do-Sa
    expect(Number(JSON.parse(resB.body).days)).toBe(1);
    const idB = JSON.parse(resB.body).id as string;

    const edited = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${idB}`,
      headers: { authorization: `Bearer ${empToken}` },
      payload: {
        startDate: addDaysIso(monday, 4), // Fr
        endDate: addDaysIso(monday, 5), // Sa
        halfDay: false,
      },
    });
    expect(edited.statusCode).toBe(200);
    expect(Number(JSON.parse(edited.body).days)).toBe(1);
  });

  it("Correction: A approved Mo-Mi (3), B approved Do-Sa (1) corrected via PATCH /requests/:id/correct to Do-Fr -> 1, LEAVE_CORRECTED audit written, A untouched (stays 3)", async () => {
    const monday = MONDAYS[4];
    const resA = await postVacation(monday, addDaysIso(monday, 2)); // Mo-Mi
    const idA = JSON.parse(resA.body).id as string;
    await review(idA, "APPROVED");

    const resB = await postVacation(addDaysIso(monday, 3), addDaysIso(monday, 5)); // Do-Sa
    const idB = JSON.parse(resB.body).id as string;
    await review(idB, "APPROVED");

    const corrected = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${idB}/correct`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        startDate: addDaysIso(monday, 3), // Do
        endDate: addDaysIso(monday, 4), // Fr
        halfDay: false,
        reason: "Testkorrektur Issue #436",
      },
    });
    expect(corrected.statusCode).toBe(200);
    expect(Number(JSON.parse(corrected.body).days)).toBe(1);

    const auditRows = await app.prisma.auditLog.findMany({
      where: { action: "LEAVE_CORRECTED", entity: "LeaveRequest", entityId: idB },
    });
    expect(auditRows.length).toBeGreaterThanOrEqual(1);

    const freshA = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: idA } });
    expect(Number(freshA.days)).toBe(3);
  });

  it("Lone request (Pitfall 1): a single request's price at approval equals its price at creation — it is never priced against itself", async () => {
    const monday = MONDAYS[5];
    const res = await postVacation(monday, addDaysIso(monday, 2)); // Mo-Mi, lone request
    const createdDays = Number(JSON.parse(res.body).days);
    const id = JSON.parse(res.body).id as string;

    const approved = await review(id, "APPROVED");
    expect(Number(JSON.parse(approved.body).days)).toBe(createdDays);
  });

  it("Never silently rewritten (436-AC-04): A pending (3), B created after and approved (1); A rejected -> B's stored days stays 1, no new AuditLog row for B from the rejection", async () => {
    const monday = MONDAYS[6];
    const resA = await postVacation(monday, addDaysIso(monday, 2)); // Mo-Mi
    const idA = JSON.parse(resA.body).id as string;

    const resB = await postVacation(addDaysIso(monday, 3), addDaysIso(monday, 5)); // Do-Sa
    const idB = JSON.parse(resB.body).id as string;
    const approveB = await review(idB, "APPROVED");
    expect(Number(JSON.parse(approveB.body).days)).toBe(1);

    const auditCountBefore = await app.prisma.auditLog.count({
      where: { entity: "LeaveRequest", entityId: idB },
    });

    const rejectA = await review(idA, "REJECTED");
    expect(rejectA.statusCode).toBe(200);

    const freshB = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: idB } });
    expect(Number(freshB.days)).toBe(1);

    const auditCountAfter = await app.prisma.auditLog.count({
      where: { entity: "LeaveRequest", entityId: idB },
    });
    expect(auditCountAfter).toBe(auditCountBefore);
  });

  it("§ 9 credit-back: A approved Mo-Mi (3), B approved Do-Sa (1) created after A; confirmed sick credit covering Do-Fr of B -> credited days 1, never more than B's own 1", async () => {
    const monday = MONDAYS[7];
    const resA = await postVacation(monday, addDaysIso(monday, 2)); // Mo-Mi
    const idA = JSON.parse(resA.body).id as string;
    await review(idA, "APPROVED");

    const resB = await postVacation(addDaysIso(monday, 3), addDaysIso(monday, 5)); // Do-Sa
    const idB = JSON.parse(resB.body).id as string;
    await review(idB, "APPROVED");

    // Section9Credit is normally auto-detected on the SICK-review path (Phase 104-05) — created
    // directly here (the established pattern, see section9-credit.test.ts) because this test
    // pins the CONFIRM handler's pricing, not the detection step.
    const sick = await app.prisma.leaveRequest.create({
      data: {
        employeeId: empId,
        leaveTypeId: sickTypeId,
        startDate: new Date(addDaysIso(monday, 3)), // Do
        endDate: new Date(addDaysIso(monday, 4)), // Fr
        halfDay: false,
        status: "APPROVED",
        days: 2,
        reviewedBy: null,
      },
    });
    const credit = await app.prisma.section9Credit.create({
      data: {
        employeeId: empId,
        sickRequestId: sick.id,
        vacationRequestId: idB,
        overlapStart: new Date(addDaysIso(monday, 3)), // Do
        overlapEnd: new Date(addDaysIso(monday, 4)), // Fr
      },
    });

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/v1/leave/section9/${credit.id}/confirm`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        attestSource: "EAU",
        attestValidFrom: addDaysIso(monday, 3), // Do
        attestValidTo: addDaysIso(monday, 4), // Fr
        reason: "Testattest Issue #436",
      },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(Number(JSON.parse(confirmed.body).creditedDays)).toBe(1);
  });

  it("Non-VACATION: a SICK request in the same week as an approved VACATION Mo-Mi is priced exactly as countShiftBasedLeaveDays alone (isolated — no week-union)", async () => {
    const monday = MONDAYS[8];
    const resA = await postVacation(monday, addDaysIso(monday, 2)); // Mo-Mi
    const idA = JSON.parse(resA.body).id as string;
    await review(idA, "APPROVED");

    const sick = await postSick(addDaysIso(monday, 3), addDaysIso(monday, 4)); // Do-Fr
    expect(sick.statusCode).toBe(201);
    expect(Number(JSON.parse(sick.body).days)).toBe(2); // isolated fragment, min(2,4)=2 — unaffected by A
  });
});
