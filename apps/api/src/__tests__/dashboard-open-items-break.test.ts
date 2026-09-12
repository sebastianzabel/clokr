/**
 * dashboard-open-items-break.test.ts — Phase 126 / GitHub issue #126.
 *
 * Pins the CONTRACT of `unconfirmedBreakDays` on GET /api/v1/dashboard/open-items: it is the
 * canonical detector's output (find-unconfirmed-break-days.ts) and nothing else.
 *
 * Before Phase 126 the dashboard computed this number client-side over a 12-MONTH window with
 * none of the detector's filters. The four divergent axes — window, type:"WORK", the
 * MONTHLY_HOURS/FLEXTIME exclusion, and the tenant opt-in — get one test each, so a future
 * re-widening of the window or a dropped filter fails here instead of in production.
 *
 * D-01 (deliberate, do not "fix"): a day in the PREVIOUS month is NOT reported. Such days trigger
 * no notification and block no Monatsabschluss; naming them would demand an action the system
 * nowhere enforces.
 *
 * Every fixture date is derived at run time from `todayInTz(TZ)` — hardcoded calendar dates are a
 * known time bomb in this repo (shifts.test.ts expired exactly that way).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, cleanupTestData } from "./setup";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { todayInTz } from "../utils/timezone";

const TZ = "Europe/Berlin";

/** TimeEntry.date is @db.Date — always UTC midnight. */
function dbDate(dateStr: string): Date {
  return new Date(dateStr + "T00:00:00Z");
}
function dayStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}
/** The 15th of the previous month in tenant TZ — always a real day, in every month. */
function prevMonth15th(): string {
  const t = todayInTz(TZ);
  const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 15));
  return dayStr(d);
}
const TODAY = dayStr(todayInTz(TZ));

const FIXED_SCHEDULE = {
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
};
const MONTHLY_HOURS_SCHEDULE = {
  type: "MONTHLY_HOURS",
  weeklyHours: 10,
  monthlyHours: 80,
  workDays: [1, 2, 3, 4, 5],
  mondayHours: 1,
  tuesdayHours: 1,
  wednesdayHours: 1,
  thursdayHours: 1,
  fridayHours: 1,
  saturdayHours: 1,
  sundayHours: 1,
};
const FLEXTIME_SCHEDULE = {
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
};

describe("GET /api/v1/dashboard/open-items — unconfirmedBreakDays contract (issue #126)", () => {
  let app: FastifyInstance;
  let tenantAId: string;
  let tenantBId: string;
  let suffix: string;

  const tokens: Record<string, string> = {};

  async function makeEmployee(
    key: string,
    tenantId: string,
    schedule: Record<string, unknown>,
  ): Promise<string> {
    const prisma = app.prisma;
    const email = `${key}-${suffix}@test.de`;
    // 200 days in the past — comfortably clear of the employment-span clamp.
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

  async function openItems(
    key: string,
  ): Promise<{ missingDays: string[]; unconfirmedBreakDays: string[]; total: number }> {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/open-items",
      headers: { authorization: `Bearer ${tokens[key]}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body);
  }

  /** Creates a minimal valid TimeEntry, defaulting to a WORK/AUTO/not-locked entry today. */
  async function makeEntry(
    employeeId: string,
    dateStr: string,
    over: Partial<{ type: string; breakStatus: string; isLocked: boolean }> = {},
  ) {
    await app.prisma.timeEntry.create({
      data: {
        employeeId,
        date: dbDate(dateStr),
        startTime: new Date(dateStr + "T08:00:00Z"),
        endTime: new Date(dateStr + "T17:00:00Z"),
        type: "WORK",
        breakStatus: "AUTO",
        isLocked: false,
        deletedAt: null,
        ...over,
      } as never,
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    suffix = "oi-126-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const tenantA = await prisma.tenant.create({
      data: { name: `OPEN-ITEMS-126-A ${suffix}`, slug: `oi-126-a-${suffix}` },
    });
    tenantAId = tenantA.id;
    await prisma.tenantConfig.create({
      data: {
        tenantId: tenantAId,
        defaultVacationDays: 30,
        timezone: TZ,
        enforceBreakConfirmation: true,
      },
    });

    const tenantB = await prisma.tenant.create({
      data: { name: `OPEN-ITEMS-126-B ${suffix}`, slug: `oi-126-b-${suffix}` },
    });
    tenantBId = tenantB.id;
    await prisma.tenantConfig.create({
      data: {
        tenantId: tenantBId,
        defaultVacationDays: 30,
        timezone: TZ,
        enforceBreakConfirmation: false,
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantAId);
      await cleanupTestData(app, tenantBId);
      await app.prisma.tenantConfig.deleteMany({
        where: { tenantId: { in: [tenantAId, tenantBId] } },
      });
      await app.prisma.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } });
    } catch (err) {
      console.error("OPEN-ITEMS-126 test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("positive control — FIXED_SCHEDULE, opted-in tenant, WORK/AUTO entry today → reported", async () => {
    const empId = await makeEmployee("c1today", tenantAId, FIXED_SCHEDULE);
    await makeEntry(empId, TODAY);

    const body = await openItems("c1today");
    expect(body.unconfirmedBreakDays).toEqual([TODAY]);
  });

  it("D-10 (a) — a day in the PREVIOUS month is never listed, even with an unconfirmed AUTO break", async () => {
    const empId = await makeEmployee("c2prevmonth", tenantAId, FIXED_SCHEDULE);
    await makeEntry(empId, TODAY);
    await makeEntry(empId, prevMonth15th());

    const body = await openItems("c2prevmonth");
    expect(body.unconfirmedBreakDays).toEqual([TODAY]);
    expect(body.unconfirmedBreakDays).not.toContain(prevMonth15th());
  });

  it("D-10 (b) — MONTHLY_HOURS receives an empty list", async () => {
    const empId = await makeEmployee("c3monthly", tenantAId, MONTHLY_HOURS_SCHEDULE);
    await makeEntry(empId, TODAY);

    const body = await openItems("c3monthly");
    expect(body.unconfirmedBreakDays).toEqual([]);
  });

  it("D-10 (b) — FLEXTIME receives an empty list", async () => {
    const empId = await makeEmployee("c4flex", tenantAId, FLEXTIME_SCHEDULE);
    await makeEntry(empId, TODAY);

    const body = await openItems("c4flex");
    expect(body.unconfirmedBreakDays).toEqual([]);
  });

  it("D-10 (c) — a non-WORK entry with breakStatus=AUTO is never listed", async () => {
    const empId = await makeEmployee("c5nonwork", tenantAId, FIXED_SCHEDULE);
    await makeEntry(empId, TODAY, { type: "OVERTIME" });

    const body = await openItems("c5nonwork");
    expect(body.unconfirmedBreakDays).toEqual([]);
  });

  it("locked control — an isLocked entry is never listed", async () => {
    const empId = await makeEmployee("c6locked", tenantAId, FIXED_SCHEDULE);
    await makeEntry(empId, TODAY, { isLocked: true });

    const body = await openItems("c6locked");
    expect(body.unconfirmedBreakDays).toEqual([]);
  });

  it("D-10 (d) — a tenant that has not opted into enforceBreakConfirmation receives an empty list", async () => {
    const empId = await makeEmployee("c7notoptin", tenantBId, FIXED_SCHEDULE);
    await makeEntry(empId, TODAY);

    const body = await openItems("c7notoptin");
    expect(body.unconfirmedBreakDays).toEqual([]);
  });
});
