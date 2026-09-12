/**
 * dashboard-open-items-window.test.ts — GitHub issue #141.
 *
 * `GET /api/v1/dashboard/open-items` used to hardwire a 7-day window while the
 * Cron (`checkMissingEntries` in `attendance-checker.ts`) answered the same
 * question from `TenantConfig.missingEntriesDays` — a card that talks about a
 * different period than the mechanism it claims to mirror (same defect class
 * as #114/#126).
 *
 * Test 1 pins acceptance criterion 1 (the route reads the configured value,
 * not a hardcoded 7) and is EXPECTED TO FAIL until the dashboard route is
 * rewired to use `resolveMissingEntriesDays()` — this is the RED half of the
 * change. Test 2 pins acceptance criterion 3 (a config change, made between
 * two calls to the SAME route with no restart, is honoured — also proving no
 * TTL cache exists). Test 3 pins acceptance criterion 4 (the single TS
 * default) directly against `resolveMissingEntriesDays()`.
 *
 * This deliberately does NOT touch the `findMissingWorkdays()` FIXED_SCHEDULE
 * / workDays-primary branch (issue #128): the fixture below uses a
 * NON-divergent FIXED_SCHEDULE (`workDays [1..5]` AND `{day}Hours = 8`
 * Mo-Fr), so it cannot accidentally depend on #128's behaviour either way.
 *
 * Every fixture date is derived at run time from `todayInTz(TZ)` via the
 * shared `test-dates.ts` helpers — hardcoded calendar dates are a known time
 * bomb in this repo (`shifts.test.ts` expired exactly that way).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, cleanupTestData } from "./setup";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { getHolidays, STATE_MAP } from "../utils/holidays";
import { resolveMissingEntriesDays } from "../utils/missing-entries-window";
import { TEST_TZ as TZ, pastDateStr, dowOf } from "./test-dates";

const FEDERAL_STATE = "NIEDERSACHSEN";

/** Public holidays covering both plausible years the [-14..-1] window can span. */
function holidaySet(days: string[]): Set<string> {
  const years = new Set(days.map((d) => Number(d.slice(0, 4))));
  const s = new Set<string>();
  for (const y of years) {
    for (const h of getHolidays(y, STATE_MAP[FEDERAL_STATE])) s.add(h.date);
  }
  return s;
}

/** Mo-Fr, non-holiday day strings for `daysAgo` in `[lo, hi]` (inclusive), oldest first. */
function weekdayCandidates(lo: number, hi: number): string[] {
  const days: string[] = [];
  for (let back = hi; back >= lo; back--) days.push(pastDateStr(back));
  const holidays = holidaySet(days);
  return days.filter((d) => dowOf(d) >= 1 && dowOf(d) <= 5 && !holidays.has(d));
}

describe("GET /api/v1/dashboard/open-items — configured window (issue #141)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let employeeId: string;
  let accessToken: string;
  let suffix: string;

  // FAR_DAY: newest Mo-Fr non-holiday in [today-14 .. today-8] — only reachable with a
  // 14-day window, not the old hardcoded 7-day one.
  const FAR_CANDIDATES = weekdayCandidates(8, 14);
  const FAR_DAY = FAR_CANDIDATES[FAR_CANDIDATES.length - 1];
  // NEAR_DAY: newest Mo-Fr non-holiday in [today-7 .. today-1] — inside BOTH a 7-day and a
  // 14-day window; a control day proving the narrowed window still reports recent gaps.
  const NEAR_CANDIDATES = weekdayCandidates(1, 7);
  const NEAR_DAY = NEAR_CANDIDATES[NEAR_CANDIDATES.length - 1];

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    suffix = "oi-win-141-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const tenant = await prisma.tenant.create({
      data: {
        name: `OPEN-ITEMS-WINDOW-141 Test ${suffix}`,
        slug: `oi-win-141-${suffix}`,
        federalState: FEDERAL_STATE,
      },
    });
    tenantId = tenant.id;
    await prisma.tenantConfig.create({
      data: { tenantId, defaultVacationDays: 30, timezone: TZ, missingEntriesDays: 14 },
    });

    // 200 days in the past — comfortably clear of the employment-span clamp, and clear of
    // both FAR_DAY/NEAR_DAY.
    const hireDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    const email = `oi-win-${suffix}@test.de`;
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
        employeeNumber: `oi-win-${suffix}`,
        firstName: "Case",
        lastName: "WINDOW",
        hireDate,
        exitDate: null,
        isTimeTrackingExempt: false,
      },
    });
    employeeId = emp.id;
    // Non-divergent FIXED_SCHEDULE on purpose (issue #128 out of scope): workDays [1..5]
    // AND {day}Hours = 8 Mo-Fr agree, so the workDays-primary branch cannot matter here.
    await prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
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
        validFrom: hireDate, // initial schedule is exempt from the month-1st rule (CLAUDE.md)
      } as never,
    });
    await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: "test1234" },
    });
    accessToken = JSON.parse(loginRes.body).accessToken;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
      await app.prisma.tenantConfig.deleteMany({ where: { tenantId } });
      await app.prisma.tenant.deleteMany({ where: { id: tenantId } });
    } catch (err) {
      console.error("OPEN-ITEMS-WINDOW-141 test cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function openItems(): Promise<{ missingDays: string[]; total: number }> {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/open-items",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode, `expected 200, got ${res.statusCode}: ${res.body}`).toBe(200);
    return JSON.parse(res.body);
  }

  it("reports a day 8-14 days back when missingEntriesDays=14 (AC-141-01)", async () => {
    const body = await openItems();
    expect(
      body.missingDays,
      `expected missingDays to contain FAR_DAY=${FAR_DAY} with a 14-day window; got ${JSON.stringify(body.missingDays)}`,
    ).toContain(FAR_DAY);
  });

  it("narrows to 7 days after the config is updated, without a restart (AC-141-03)", async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId },
      data: { missingEntriesDays: 7 },
    });
    const body = await openItems();
    expect(
      body.missingDays,
      `expected missingDays to NOT contain FAR_DAY=${FAR_DAY} after narrowing to 7 days; got ${JSON.stringify(body.missingDays)}`,
    ).not.toContain(FAR_DAY);
    expect(
      body.missingDays,
      `expected missingDays to still contain NEAR_DAY=${NEAR_DAY}; got ${JSON.stringify(body.missingDays)}`,
    ).toContain(NEAR_DAY);
  });

  it("resolveMissingEntriesDays() is the single source for the default (AC-141-04)", () => {
    expect(resolveMissingEntriesDays(null)).toBe(7);
    expect(resolveMissingEntriesDays(undefined)).toBe(7);
    expect(resolveMissingEntriesDays({ missingEntriesDays: 21 })).toBe(21);
  });
});
