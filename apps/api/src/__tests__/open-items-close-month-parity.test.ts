/**
 * open-items-close-month-parity.test.ts — Phase 128 (D-04).
 *
 * Pins that `GET /api/v1/dashboard/open-items` (the card) and
 * `GET /api/v1/overtime/close-month/status` (the Monatsabschluss) agree, day for day, on a
 * `FIXED_SCHEDULE` fixture whose `workDays` and `{day}Hours` deliberately diverge.
 *
 * Before Phase 128 the card was workDays-primary (via the now-deleted
 * `work-days-primary-schedule.ts` adapter) and the Monatsabschluss read `findMissingWorkdays()`
 * raw, which is `{day}Hours`-primary. On a divergent row the two disagreed on exactly the
 * divergent days. Phase 128 moved the rule into `findMissingWorkdays()` itself, so both readers
 * now call one function — this test pins that agreement as a property of the CODE, not of
 * today's clean production data (a 2026-08-30 rehearsal found 0 divergent FIXED_SCHEDULE rows,
 * which makes this outcome-neutral today but not structurally safe without this test).
 *
 * No production file is modified by this plan.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { pastDateStr, dowOf, utcMidnight } from "./test-dates";
import { getHolidays, STATE_MAP } from "../utils/holidays";

describe("open-items vs close-month/status parity on a divergent workDays/{day}Hours fixture (Phase 128, D-04)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let suffix: string;

  // ── Calendar-proof window derivation (issue #136) ─────────────────────────
  // 7 days, oldest first: [today-7 .. today-1] in tenant TZ. A 7-day window contains
  // each weekday exactly once, so OBLIGATED_DOW and DIVERGENT_DOW always exist and
  // always differ, whatever day the suite runs on. Never a hardcoded calendar date.
  const WINDOW = [7, 6, 5, 4, 3, 2, 1].map((n) => pastDateStr(n));
  const WINDOW_YEARS = [...new Set(WINDOW.map((d) => Number(d.slice(0, 4))))];
  const HOLIDAYS = new Set<string>(
    WINDOW_YEARS.flatMap((y) => getHolidays(y, STATE_MAP["NIEDERSACHSEN"]).map((h) => h.date)),
  );
  const NON_HOLIDAY = WINDOW.filter((d) => !HOLIDAYS.has(d));
  const OBLIGATED_DOW = dowOf(NON_HOLIDAY[0]);
  const DIVERGENT_DOW = dowOf(NON_HOLIDAY[NON_HOLIDAY.length - 1]);

  let divergentEmployeeId: string;
  let divergentToken: string;
  let controlEmployeeId: string;
  let controlToken: string;

  /** Distinct "YYYY-MM" months the window touches (it may straddle two calendar months). */
  const MONTHS = [...new Set(WINDOW.map((d) => d.slice(0, 7)))];

  async function makeFixedScheduleEmployee(
    key: string,
    workDays: number[],
    dayHours: {
      mondayHours: number;
      tuesdayHours: number;
      wednesdayHours: number;
      thursdayHours: number;
      fridayHours: number;
      saturdayHours: number;
      sundayHours: number;
    },
  ): Promise<{ employeeId: string; token: string }> {
    const prisma = app.prisma;
    const email = `${key}-${suffix}@test.de`;
    // 200 days in the past — comfortably clear of the employment-span clamp both endpoints apply.
    const hireDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `${key}-${suffix}`,
        firstName: "Parity",
        lastName: key.toUpperCase(),
        hireDate,
        // exitDate left null — only the card also clamps to it (window_alignment)
      },
    });
    await prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        type: "FIXED_SCHEDULE",
        // initial schedule on employee creation is exempt from the month-1st rule
        // (CLAUDE.md, Schedule Types) — validFrom = hireDate is correct here
        validFrom: hireDate,
        workDays,
        ...dayHours,
      },
    });
    await prisma.overtimeAccount.create({
      data: { employeeId: employee.id, balanceHours: 0 },
    });

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: "test1234" },
    });
    const { accessToken } = JSON.parse(loginRes.body);

    return { employeeId: employee.id, token: accessToken };
  }

  async function cardMissingDays(token: string): Promise<string[]> {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/open-items",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, `card /dashboard/open-items failed: ${res.body}`).toBe(200);
    const body = JSON.parse(res.body) as { missingDays: string[] };
    return [...body.missingDays].filter((d) => WINDOW.includes(d)).sort();
  }

  /**
   * Union of `missingDates` for `employeeId` across every month the window touches
   * (status runs to `monthLastDay` and therefore also reports days outside the
   * 7-day window — days before window start and, for the current month, days in the
   * future), intersected with WINDOW and sorted.
   */
  async function statusMissingDaysInWindow(employeeId: string): Promise<string[]> {
    const union = new Set<string>();
    for (const monthStr of MONTHS) {
      const [year, month] = monthStr.split("-").map(Number);
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/close-month/status?year=${year}&month=${month}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(
        res.statusCode,
        `Monatsabschluss close-month/status failed for ${monthStr}: ${res.body}`,
      ).toBe(200);
      const body = JSON.parse(res.body) as {
        employees: Array<{ employeeId: string; missingDates?: string[] }>;
      };
      const row = body.employees.find((e) => e.employeeId === employeeId);
      for (const d of row?.missingDates ?? []) union.add(d);
    }
    return [...union].filter((d) => WINDOW.includes(d)).sort();
  }

  beforeAll(async () => {
    app = await getTestApp();
    suffix = "parity128-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const seeded = await seedTestData(app, suffix);
    tenantId = seeded.tenant.id;
    adminToken = seeded.adminToken;

    // DIVERGENT: {day}Hours claims all seven days (7 obligated), workDays claims exactly ONE
    // (OBLIGATED_DOW) — maximum divergence in the direction {day}Hours-primary code could never
    // produce (it can only ever be a SUBSET of what workDays claims, never a superset - T2 of
    // 128-01 already pins that direction at the unit level; this fixture exercises the other
    // direction end-to-end: {day}Hours claims MORE than workDays).
    const divergent = await makeFixedScheduleEmployee("divergent", [OBLIGATED_DOW], {
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 8,
      sundayHours: 8,
    });
    divergentEmployeeId = divergent.employeeId;
    divergentToken = divergent.token;

    // CONTROL: consistent row (workDays ⊆ {day}Hours>0 and vice versa), unaffected by Phase 128 —
    // proves the parity equality below is not vacuous.
    const control = await makeFixedScheduleEmployee("control", [1, 2, 3, 4, 5], {
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
    });
    controlEmployeeId = control.employeeId;
    controlToken = control.token;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("P0: fixture sanity — the divergence exists and is provable, or nothing below is meaningful", async () => {
    expect(
      NON_HOLIDAY.length,
      "window must have at least 2 non-holiday days",
    ).toBeGreaterThanOrEqual(2);
    expect(OBLIGATED_DOW, "a 7-day window must contain each weekday exactly once").not.toBe(
      DIVERGENT_DOW,
    );

    const schedule = await app.prisma.workSchedule.findFirst({
      where: { employeeId: divergentEmployeeId },
    });
    expect(schedule, "DIVERGENT fixture must have a WorkSchedule row").not.toBeNull();
    expect(schedule!.workDays, "DIVERGENT workDays must be exactly [OBLIGATED_DOW]").toEqual([
      OBLIGATED_DOW,
    ]);
    for (const key of [
      "mondayHours",
      "tuesdayHours",
      "wednesdayHours",
      "thursdayHours",
      "fridayHours",
      "saturdayHours",
      "sundayHours",
    ] as const) {
      expect(
        Number(schedule![key]),
        `DIVERGENT ${key} must be > 0 (the {day}Hours-only claim)`,
      ).toBeGreaterThan(0);
    }
  });

  it("P1 (D-04, the pin): card and Monatsabschluss report the identical day set for DIVERGENT", async () => {
    const cardDays = await cardMissingDays(divergentToken);
    const statusDays = await statusMissingDaysInWindow(divergentEmployeeId);

    expect(
      cardDays,
      `card (/dashboard/open-items) = ${JSON.stringify(cardDays)} but ` +
        `Monatsabschluss (/overtime/close-month/status) = ${JSON.stringify(statusDays)} — they must agree`,
    ).toEqual(statusDays);
  });

  it("P2: the shared answer IS the workDays answer (exactly the OBLIGATED_DOW days)", async () => {
    const cardDays = await cardMissingDays(divergentToken);
    const expected = NON_HOLIDAY.filter((d) => dowOf(d) === OBLIGATED_DOW);

    expect(
      cardDays,
      "the shared gap set must be exactly the NON_HOLIDAY days whose weekday is OBLIGATED_DOW",
    ).toEqual(expected);
    expect(expected.length, "OBLIGATED_DOW must occur exactly once in a 7-day window").toBe(1);
  });

  it("P3: neither reader claims the {day}Hours-only day (DIVERGENT_DOW)", async () => {
    const divergentDay = NON_HOLIDAY.find((d) => dowOf(d) === DIVERGENT_DOW);
    expect(divergentDay, "a non-holiday DIVERGENT_DOW day must exist in the window").toBeDefined();

    const cardDays = await cardMissingDays(divergentToken);
    const statusDays = await statusMissingDaysInWindow(divergentEmployeeId);

    // Assert on BOTH sides separately — under the pre-128 code the card excluded this day
    // (workDays-primary via the adapter) and the Monatsabschluss included it ({day}Hours-primary
    // raw), and that asymmetry was the whole defect.
    expect(cardDays, "card must not report the {day}Hours-only day").not.toContain(divergentDay);
    expect(statusDays, "Monatsabschluss must not report the {day}Hours-only day").not.toContain(
      divergentDay,
    );
  });

  it("P4 (non-vacuity control): a consistent FIXED_SCHEDULE row still agrees and is Mon-Fri", async () => {
    const cardDays = await cardMissingDays(controlToken);
    const statusDays = await statusMissingDaysInWindow(controlEmployeeId);
    const expected = NON_HOLIDAY.filter((d) => [1, 2, 3, 4, 5].includes(dowOf(d)));

    expect(
      cardDays,
      `CONTROL card = ${JSON.stringify(cardDays)} vs Monatsabschluss = ${JSON.stringify(statusDays)}`,
    ).toEqual(statusDays);
    expect(cardDays, "CONTROL gap set must be exactly the Mon-Fri NON_HOLIDAY days").toEqual(
      expected,
    );
  });

  it("sanity: utcMidnight/dowOf round-trip matches WINDOW derivation", () => {
    // Guards against a silent regression in the shared test-dates.ts helpers this file relies on.
    for (const d of WINDOW) {
      expect(utcMidnight(d).toISOString().slice(0, 10)).toBe(d);
    }
  });
});
