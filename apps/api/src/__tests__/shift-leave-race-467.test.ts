/**
 * shift-leave-race-467.test.ts
 *
 * Issue #467 — price + insert of a SHIFT_BASED vacation request are serialised per employee
 * (Employee row lock). RED on the pre-fix code: both parallel requests priced the week in full (3 + 3).
 *
 * Two parallel POSTs for one ISO week must total at most the contract days (§ 13 BUrlG).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, cleanupTestData, createTestSalon, grantSystemRole } from "./setup";
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

// Ten SEQUENTIALLY built, holiday-free Mondays (each >= 14 days after the previous one) — one
// per test group, so no group's requests ever overlap another's (the overlap guard is scoped to
// the employee, shared across all groups). Built sequentially (not independent `daysOut` calls)
// so each group's own holiday-skip loop can never leapfrog the next group's base candidate.
const MONDAYS: string[] = [nextHolidayFreeMonday(14)];
for (let i = 1; i < 10; i++) {
  MONDAYS.push(holidayFreeMondayFrom(addDaysIso(MONDAYS[i - 1], 14)));
}

describe("Issue #467 — concurrent SHIFT_BASED vacation requests never deduct a week twice", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let empId: string;
  let empToken: string;

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const suffix = "u467-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const tenant = await prisma.tenant.create({
      data: { name: `U467 ${suffix}`, slug: `u467-${suffix}`, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    await createTestSalon(prisma, tenantId);
    await prisma.tenantConfig.create({ data: { tenantId } });

    const passwordHash = await bcrypt.hash("test1234", 10);

    async function makeUser(label: string, role: "EMPLOYEE" | "ADMIN") {
      const email = `u467-${label}-${suffix}@test.de`;
      const user = await prisma.user.create({
        data: { email, passwordHash, role, isActive: true },
      });
      const employee = await prisma.employee.create({
        data: {
          tenantId,
          userId: user.id,
          employeeNumber: `U467-${label.toUpperCase()}-${suffix}`,
          firstName: "U467",
          lastName: label,
          hireDate: PAST_ANCHOR,
        },
      });
      await grantSystemRole(prisma, { tenantId, userId: user.id, role });
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email, password: "test1234" },
      });
      return { employee, token: JSON.parse(login.body).accessToken as string };
    }

    await makeUser("admin", "ADMIN");

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
    await prisma.leaveType.create({
      data: { tenantId, code: "SICK", name: "Krankheit", isPaid: true, requiresApproval: true },
    });

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

  async function postVacation(startDate: string, endDate: string) {
    return app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${empToken}` },
      payload: { type: "VACATION", startDate, endDate, halfDay: false },
    });
  }

  it("two parallel requests for the same ISO week (Mo-Mi and Do-Sa) cost together at most the 4 contract days — every round", async () => {
    // Several rounds, one fresh week each: a race is probabilistic, serialisation must hold in all.
    for (let round = 0; round < 6; round++) {
      const monday = MONDAYS[round];
      const [a, b] = await Promise.all([
        postVacation(monday, addDaysIso(monday, 2)), // Mo-Mi
        postVacation(addDaysIso(monday, 3), addDaysIso(monday, 5)), // Do-Sa
      ]);
      expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
      const total = Number(JSON.parse(a.body).days) + Number(JSON.parse(b.body).days);
      expect(total).toBe(4);
    }
  });
});
