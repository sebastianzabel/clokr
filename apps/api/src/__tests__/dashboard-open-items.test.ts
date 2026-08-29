/**
 * dashboard-open-items.test.ts — Phase 111 / GitHub issue #114.
 *
 * This is the FIRST API coverage `GET /api/v1/dashboard/open-items` has ever had. Before this
 * file, `grep -rn "open-items" apps/api/src` matched only `dashboard.ts` itself — the endpoint
 * that produced the reported prod false positive was completely untested.
 *
 * It guards the defect in BOTH directions:
 *   - case 1 = the reported FALSE POSITIVE: a SHIFT_BASED employee's contractually free day was
 *     nagged about every week, because the deleted inline predicate read `{day}Hours > 0` for
 *     every schedule type and a legacy `thursdayHours = 1` is a 1/0 flag, not hours.
 *   - case 2 = the FALSE NEGATIVE a naive over-correction ("just stop reporting SHIFT_BASED")
 *     would introduce: a rostered day with no time entry MUST still be reported.
 *
 * Every fixture date is derived at run time from `todayInTz(TZ)`. Hardcoded calendar dates are a
 * known time bomb in this repo (`shifts.test.ts` expired exactly that way).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, cleanupTestData } from "./setup";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { todayInTz } from "../utils/timezone";
import { getHolidays, STATE_MAP } from "../utils/holidays";

const TZ = "Europe/Berlin";

/**
 * The 7 window days, oldest first: [today-7 .. today-1] in tenant TZ.
 * Mirrors the route: `todayInTz(tz)` returns UTC midnight of the tenant's calendar today,
 * and the window end is yesterday (the replaced loop ran `cursor < today`).
 */
function windowDates(): string[] {
  const today = todayInTz(TZ);
  const out: string[] = [];
  for (let back = 7; back >= 1; back--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - back);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function holidaySet(days: string[]): Set<string> {
  const years = new Set(days.map((d) => Number(d.slice(0, 4))));
  const s = new Set<string>();
  for (const y of years) {
    for (const h of getHolidays(y, STATE_MAP["NIEDERSACHSEN"])) s.add(h.date);
  }
  return s;
}

/** 0=Sun..6=Sat for a "YYYY-MM-DD" string. */
function dowOf(dateStr: string): number {
  return new Date(dateStr + "T12:00:00Z").getUTCDay();
}

/** Shift.date / TimeEntry.date are @db.Date — always UTC midnight. */
function dbDate(dateStr: string): Date {
  return new Date(dateStr + "T00:00:00Z");
}

describe("GET /api/v1/dashboard/open-items — work obligation per schedule type (issue #114)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let leaveTypeId: string;

  const WINDOW = windowDates();
  const HOLIDAYS = holidaySet(WINDOW);
  /** Window days that are not public holidays — the only days that can ever be reported. */
  const NON_HOLIDAY = WINDOW.filter((d) => !HOLIDAYS.has(d));

  // Tokens, one per case-employee.
  const tokens: Record<string, string> = {};

  let suffix: string;

  async function makeEmployee(
    key: string,
    schedule: Record<string, unknown>,
    opts: { isTimeTrackingExempt?: boolean } = {},
  ): Promise<string> {
    const prisma = app.prisma;
    const email = `${key}-${suffix}@test.de`;
    // 200 days in the past — comfortably clear of the Phase 111 employment-span clamp.
    const hireDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const emp = await prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `${key}-${suffix}`,
        firstName: "Case",
        lastName: key.toUpperCase(),
        hireDate,
        isTimeTrackingExempt: opts.isTimeTrackingExempt ?? false,
      },
    });
    await prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
        validFrom: hireDate, // initial schedule is exempt from the month-1st rule (CLAUDE.md)
        ...schedule,
      } as never,
    });
    await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: "test1234" },
    });
    tokens[key] = JSON.parse(loginRes.body).accessToken;

    return emp.id;
  }

  async function openItems(key: string): Promise<{ missingDays: string[]; total: number }> {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/open-items",
      headers: { authorization: `Bearer ${tokens[key]}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body);
  }

  // Per-case employee ids.
  let shiftNoRoster: string;
  let shiftWithRoster: string;
  let shiftRosterEntry: string;
  let shiftRosterDeleted: string;
  let flextime: string;
  let monthlyHours: string;
  let fixedDivergent: string;
  let fixedDivergentEntry: string;
  let fixedHalfDay: string;
  let exempt: string;

  /** The rostered day used by cases 2/3/4 — first non-holiday day of the window. */
  const ROSTER_DAY = NON_HOLIDAY[0];
  /** Days a FIXED workDays [2,3,4] employee is obligated on. */
  const FIXED_EXPECTED = NON_HOLIDAY.filter((d) => [2, 3, 4].includes(dowOf(d)));

  const SHIFT_BASED_SCHEDULE = {
    type: "SHIFT_BASED",
    weeklyHours: 30,
    workDays: [1, 2, 3, 4, 5],
    // The legacy 1/0 flag that caused the prod bug — NOT hours.
    mondayHours: 1,
    tuesdayHours: 1,
    wednesdayHours: 1,
    thursdayHours: 1,
    fridayHours: 1,
    saturdayHours: 1,
    sundayHours: 1,
  };

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    suffix = "oi-111-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const tenant = await prisma.tenant.create({
      data: {
        name: `OPEN-ITEMS-111 Test ${suffix}`,
        slug: `oi-111-${suffix}`,
        federalState: "NIEDERSACHSEN",
      },
    });
    tenantId = tenant.id;
    await prisma.tenantConfig.create({
      data: { tenantId, defaultVacationDays: 30, timezone: TZ },
    });

    const leaveType = await prisma.leaveType.create({
      data: {
        tenantId,
        name: "Urlaub",
        isPaid: true,
        requiresApproval: true,
        color: "#3B82F6",
      },
    });
    leaveTypeId = leaveType.id;

    // ── Case 1: SHIFT_BASED, no Shift at all ────────────────────────────────
    shiftNoRoster = await makeEmployee("c1shiftfree", SHIFT_BASED_SCHEDULE);

    // ── Case 2: SHIFT_BASED, one Shift, no entry ────────────────────────────
    shiftWithRoster = await makeEmployee("c2shiftroster", SHIFT_BASED_SCHEDULE);
    await prisma.shift.create({
      data: {
        employeeId: shiftWithRoster,
        date: dbDate(ROSTER_DAY),
        startTime: "09:00",
        endTime: "17:00",
        origin: "MANUAL",
      },
    });

    // ── Case 3: SHIFT_BASED, Shift + time entry ─────────────────────────────
    shiftRosterEntry = await makeEmployee("c3shiftentry", SHIFT_BASED_SCHEDULE);
    await prisma.shift.create({
      data: {
        employeeId: shiftRosterEntry,
        date: dbDate(ROSTER_DAY),
        startTime: "09:00",
        endTime: "17:00",
        origin: "MANUAL",
      },
    });
    await prisma.timeEntry.create({
      data: {
        employeeId: shiftRosterEntry,
        date: dbDate(ROSTER_DAY),
        startTime: new Date(ROSTER_DAY + "T07:00:00Z"),
        endTime: new Date(ROSTER_DAY + "T15:00:00Z"),
        type: "WORK",
        isInvalid: false,
      },
    });

    // ── Case 4: SHIFT_BASED, soft-deleted Shift ─────────────────────────────
    shiftRosterDeleted = await makeEmployee("c4shiftdel", SHIFT_BASED_SCHEDULE);
    await prisma.shift.create({
      data: {
        employeeId: shiftRosterDeleted,
        date: dbDate(ROSTER_DAY),
        startTime: "09:00",
        endTime: "17:00",
        origin: "PHOREST",
        externalId: `phorest-${suffix}-c4`,
        deletedAt: new Date(),
        deletedReason: "PHOREST_REMOVED",
      },
    });

    // ── Case 5: FLEXTIME ────────────────────────────────────────────────────
    flextime = await makeEmployee("c5flex", {
      type: "FLEXTIME",
      weeklyHours: 40,
      workDays: [1, 2, 3, 4, 5],
      mondayHours: 1,
      tuesdayHours: 1,
      wednesdayHours: 1,
      thursdayHours: 1,
      fridayHours: 1,
      saturdayHours: 1,
      sundayHours: 1,
    });

    // ── Case 6: MONTHLY_HOURS ───────────────────────────────────────────────
    monthlyHours = await makeEmployee("c6monthly", {
      type: "MONTHLY_HOURS",
      weeklyHours: 10,
      monthlyHours: 40,
      workDays: [1, 2, 3, 4, 5],
      mondayHours: 1,
      tuesdayHours: 1,
      wednesdayHours: 1,
      thursdayHours: 1,
      fridayHours: 1,
      saturdayHours: 1,
      sundayHours: 1,
    });

    // ── Case 7: FIXED_SCHEDULE, legacy divergent row (workDays [2,3,4]) ─────
    fixedDivergent = await makeEmployee("c7fixeddiv", {
      type: "FIXED_SCHEDULE",
      weeklyHours: 24,
      workDays: [2, 3, 4],
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
    });

    // ── Case 8: same as 7 + an entry on the first expected day ──────────────
    fixedDivergentEntry = await makeEmployee("c8fixedentry", {
      type: "FIXED_SCHEDULE",
      weeklyHours: 24,
      workDays: [2, 3, 4],
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
    });
    if (FIXED_EXPECTED.length > 0) {
      const day = FIXED_EXPECTED[0];
      await prisma.timeEntry.create({
        data: {
          employeeId: fixedDivergentEntry,
          date: dbDate(day),
          startTime: new Date(day + "T07:00:00Z"),
          endTime: new Date(day + "T15:00:00Z"),
          type: "WORK",
          isInvalid: false,
        },
      });
    }

    // ── Case 9: FIXED_SCHEDULE Mon-Fri + half-day approved leave, no entry ──
    fixedHalfDay = await makeEmployee("c9halfday", {
      type: "FIXED_SCHEDULE",
      weeklyHours: 40,
      workDays: [1, 2, 3, 4, 5],
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
    });
    const halfDayTarget = NON_HOLIDAY.filter((d) => [1, 2, 3, 4, 5].includes(dowOf(d)))[0];
    if (halfDayTarget) {
      await prisma.leaveRequest.create({
        data: {
          employeeId: fixedHalfDay,
          leaveTypeId,
          startDate: dbDate(halfDayTarget),
          endDate: dbDate(halfDayTarget),
          days: 0.5,
          halfDay: true,
          status: "APPROVED",
          reviewedBy: "system",
          reviewedAt: new Date(),
        },
      });
    }

    // ── Case 10: isTimeTrackingExempt ───────────────────────────────────────
    exempt = await makeEmployee(
      "c10exempt",
      {
        type: "FIXED_SCHEDULE",
        weeklyHours: 40,
        workDays: [1, 2, 3, 4, 5],
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
      },
      { isTimeTrackingExempt: true },
    );
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
      await app.prisma.tenantConfig.deleteMany({ where: { tenantId } });
      await app.prisma.tenant.deleteMany({ where: { id: tenantId } });
    } catch (err) {
      console.error("OPEN-ITEMS-111 test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("sanity: the 7-day window contains at least one non-holiday day", () => {
    expect(WINDOW).toHaveLength(7);
    expect(NON_HOLIDAY.length).toBeGreaterThan(0);
    expect(shiftNoRoster).toBeTruthy();
    expect(flextime).toBeTruthy();
    expect(monthlyHours).toBeTruthy();
    expect(fixedDivergent).toBeTruthy();
    expect(exempt).toBeTruthy();
  });

  it("case 1 — SHIFT_BASED without any Shift reports NOTHING, even with every {day}Hours = 1 (the reported prod false positive)", async () => {
    const body = await openItems("c1shiftfree");
    expect(body.missingDays).toEqual([]);
  });

  it("case 2 — SHIFT_BASED WITH a Shift and no entry is STILL reported, and only on the rostered day (false-negative guard)", async () => {
    const body = await openItems("c2shiftroster");
    expect(body.missingDays).toEqual([ROSTER_DAY]);
  });

  it("case 3 — SHIFT_BASED with a Shift AND a time entry reports nothing", async () => {
    const body = await openItems("c3shiftentry");
    expect(body.missingDays).toEqual([]);
  });

  it("case 4 — a soft-deleted Shift creates no obligation", async () => {
    const body = await openItems("c4shiftdel");
    expect(body.missingDays).toEqual([]);
  });

  it("case 5 — FLEXTIME never reports a missing day", async () => {
    const body = await openItems("c5flex");
    expect(body.missingDays).toEqual([]);
  });

  it("case 6 — MONTHLY_HOURS never reports a missing day (Minijobber)", async () => {
    const body = await openItems("c6monthly");
    expect(body.missingDays).toEqual([]);
  });

  it("case 7 — FIXED_SCHEDULE is workDays-primary on a legacy divergent row: only Tue/Wed/Thu, never Mon/Fri", async () => {
    const body = await openItems("c7fixeddiv");
    expect(body.missingDays).toEqual(FIXED_EXPECTED);

    // Explicit: the {day}Hours placeholders claim Mon and Fri are 8h workdays.
    // workDays [2,3,4] is the source of truth, so neither may appear.
    const mondays = NON_HOLIDAY.filter((d) => dowOf(d) === 1);
    const fridays = NON_HOLIDAY.filter((d) => dowOf(d) === 5);
    for (const d of [...mondays, ...fridays]) {
      expect(body.missingDays).not.toContain(d);
    }
  });

  it("case 8 — an entry on an obligated day drops that day and leaves the rest reported", async () => {
    const body = await openItems("c8fixedentry");
    const covered = FIXED_EXPECTED[0];
    expect(body.missingDays).not.toContain(covered);
    expect(body.missingDays).toEqual(FIXED_EXPECTED.slice(1));
  });

  it("case 9 — a half-day approved leave with no entry is NOT nagged about (partial gaps are filtered)", async () => {
    const halfDayTarget = NON_HOLIDAY.filter((d) => [1, 2, 3, 4, 5].includes(dowOf(d)))[0];
    const body = await openItems("c9halfday");
    expect(body.missingDays).not.toContain(halfDayTarget);
  });

  it("case 10 — an isTimeTrackingExempt employee reports nothing (pre-existing guard, unchanged)", async () => {
    const body = await openItems("c10exempt");
    expect(body.missingDays).toEqual([]);
  });
});
