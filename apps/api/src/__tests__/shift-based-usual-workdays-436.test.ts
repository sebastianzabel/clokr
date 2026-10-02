/**
 * shift-based-usual-workdays-436.test.ts
 *
 * Issue #436 (D-01/D-02/D-03, 436-AC-01/02/03/11) — tracer regression for the two owner-provided
 * issue examples plus the write-path validation gate:
 *
 *   (1) PUT /api/v1/settings/work/:employeeId stores WorkSchedule.usualWorkDays for a SHIFT_BASED
 *       employee.
 *   (2) A 4-day-contract employee with usual Di–Fr ([2,3,4,5]) requesting Mo–Mi costs 2 days
 *       (issue example 1).
 *   (3) The same employee requesting Do of one week through Mo of the next week costs 2 days —
 *       Do/Fr counted, Sa not usual, Mo of the following week not usual (issue example 2).
 *   (4) A PUT supplying fewer usualWorkDays than contractWorkDaysPerWeek is rejected with a German
 *       400 and writes nothing (436-AC-03).
 *
 * RED evidence (recorded before Steps B-F of plan 436-01 landed the schema/kernel/write-path
 * changes, against the Task-1 base commit a8e4d4b5): case (1)'s PUT returned 200 but the stored
 * row had no `usualWorkDays` field at all (column did not exist yet — Prisma rejected the unknown
 * key / the field was simply absent from the response); case (2) priced Mo–Mi at 3 days (the
 * pre-436 kernel has no usual-workday filter, so a fragment week counts every non-Sunday Mo-Sat
 * day up to the contract, i.e. Mo,Tu,We = 3); case (3) priced Do(w2)–Mo(w3) at 4 days (Do,Fr,Sa in
 * week 2 is capped at the 4-day contract = 3, wait — pre-fix this actually returned `min(3,4)=3`
 * for week 2's fragment plus `min(1,4)=1` for week 3's Monday-only fragment = 4 total); case (4)'s
 * PUT had no `usualWorkDays` field in its schema at all, so it was silently ignored and returned
 * 200 (no 400 — the validation this test pins did not exist).
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
 * leave-provisional-approval.test.ts / shift-leave-recalc.test.ts. */
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

// Widely spaced anchor Mondays so no overlap guard fires between cases.
const CASE2_MONDAY = nextHolidayFreeMonday(14); // Mo-Mi request
const CASE3_W2_MONDAY = nextHolidayFreeMonday(35, 2); // Do(w2)-Mo(w3) request, 2-week holiday-free span

describe("Issue #436 — SHIFT_BASED usual workdays (D-01/D-02/D-03)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let empId: string;
  let empToken: string;

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const suffix = "i436-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const tenant = await prisma.tenant.create({
      data: { name: `I436 ${suffix}`, slug: `i436-${suffix}`, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    await createTestSalon(prisma, tenantId);
    await prisma.tenantConfig.create({ data: { tenantId } });

    const passwordHash = await bcrypt.hash("test1234", 10);

    async function makeUser(label: string, role: "EMPLOYEE" | "ADMIN") {
      const email = `i436-${label}-${suffix}@test.de`;
      const user = await prisma.user.create({
        data: { email, passwordHash, role, isActive: true },
      });
      const employee = await prisma.employee.create({
        data: {
          tenantId,
          userId: user.id,
          employeeNumber: `I436-${label.toUpperCase()}-${suffix}`,
          firstName: "I436",
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

    // SHIFT_BASED, contract count 4, usualWorkDays starts empty (= keine Angabe) — case 1 sets it.
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
      console.error("shift-based-usual-workdays-436 cleanup failed:", err);
    }
  });

  async function putWork(payload: Record<string, unknown>) {
    return app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${empId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload,
    });
  }

  async function postVacation(startDate: string, endDate: string) {
    return app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${empToken}` },
      payload: { type: "VACATION", startDate, endDate },
    });
  }

  it("(1) PUT /settings/work stores usualWorkDays [2,3,4,5] (Di-Fr) for the SHIFT_BASED employee", async () => {
    const res = await putWork({
      type: "SHIFT_BASED",
      weeklyHours: 38,
      contractWorkDaysPerWeek: 4,
      usualWorkDays: [2, 3, 4, 5],
      validFrom: dbDateStr(PAST_ANCHOR),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.usualWorkDays).toEqual([2, 3, 4, 5]);

    const stored = await app.prisma.workSchedule.findUniqueOrThrow({ where: { id: body.id } });
    expect(stored.usualWorkDays).toEqual([2, 3, 4, 5]);
  });

  it("(2) Mo-Mi request on a 4-day contract with usual Di-Fr costs 2 days (issue example 1)", async () => {
    const monday = CASE2_MONDAY;
    const wednesday = addDaysIso(monday, 2);

    const res = await postVacation(monday, wednesday);
    expect(res.statusCode).toBe(201);
    const created = JSON.parse(res.body);
    expect(Number(created.days)).toBe(2);
  });

  it("(3) Do(week2)-Mo(week3) request costs 2 days — Do/Fr counted, Sa not usual, Mo(week3) not usual (issue example 2)", async () => {
    const thursday = addDaysIso(CASE3_W2_MONDAY, 3);
    const mondayWeek3 = addDaysIso(CASE3_W2_MONDAY, 7);

    const res = await postVacation(thursday, mondayWeek3);
    expect(res.statusCode).toBe(201);
    const created = JSON.parse(res.body);
    expect(Number(created.days)).toBe(2);
  });

  it("(4) PUT with usualWorkDays [2,3,4] (3 < contract 4) is rejected with a German 400 and writes nothing", async () => {
    const res = await putWork({
      type: "SHIFT_BASED",
      weeklyHours: 38,
      contractWorkDaysPerWeek: 4,
      usualWorkDays: [2, 3, 4],
      validFrom: dbDateStr(PAST_ANCHOR),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toContain("mindestens");

    const stored = await app.prisma.workSchedule.findFirst({
      where: { employeeId: empId, validFrom: PAST_ANCHOR },
    });
    expect(stored?.usualWorkDays).toEqual([2, 3, 4, 5]);
  });
});
