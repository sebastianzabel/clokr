/**
 * dashboard-week-target-451.test.ts
 *
 * Issue #451 point 5 / owner decision 5 (D-06): the dashboard week target is the Soll of the
 * WHOLE week (Mon-Sun, tenant timezone) after leave, absence, Berufsschule and holiday
 * reduction — the same saldo core (closeEmployeeMonth) the Monatsabschluss uses — never a
 * composition `{day}Hours` walk. Progress through the week compares worked vs. Soll through
 * YESTERDAY only (issue #438: today never counts).
 *
 * Plan 451-06, Task 1:
 *   FLEXTIME 40h Mon-Fri (workDays [1..5]), approved VACATION Mon 2026-08-10 - Fri 2026-08-14,
 *     fake clock Wed 2026-08-12T10:00Z -> week.targetHours 0 (RED before: 24, the composition
 *     Mon..today walk with no leave reduction); targetToDateHours 0; workedToDateHours 0.
 *   FIXED Mon-Fri 8h, week of Mon 2026-05-11 with Christi Himmelfahrt Thu 14.05., fake clock
 *     Wed 2026-05-13T10:00Z, entries Mon 8h / Tue 7h / Wed(today) 4h -> week.targetHours 32
 *     (RED before: 24, Soll Mon..today with no holiday reduction); targetToDateHours 16;
 *     workedToDateHours 15 (today excluded); workedHours stays 19 (whole-week Ist incl.
 *     today, unchanged).
 *   MONTHLY_HOURS employee: periodType "month", week.targetHours 0 (unchanged).
 *
 * Every date below is a FIXED fake clock (vi.useFakeTimers + vi.setSystemTime) — never a
 * date-relative fixture (CLAUDE.md, issues #394/#434). Tenant federalState NIEDERSACHSEN (2026
 * holiday used here: Christi Himmelfahrt 14.05. Thu).
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import bcrypt from "bcryptjs";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

async function loginAs(app: FastifyInstance, email: string, password = "test1234") {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
  });
  const { accessToken } = JSON.parse(res.body) as { accessToken: string };
  return accessToken;
}

async function createEmployee(
  app: FastifyInstance,
  tenantId: string,
  salonId: string,
  label: string,
  hireDate: string,
  scheduleType: "FIXED_SCHEDULE" | "FLEXTIME" | "MONTHLY_HOURS",
  opts: { weeklyHours?: number; dayHours?: number; monthlyHours?: number } = {},
): Promise<{ id: string; email: string }> {
  const passwordHash = await bcrypt.hash("test1234", 10);
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const email = `${label}-${suffix}@test.de`;
  const user = await app.prisma.user.create({
    data: { email, passwordHash, role: "EMPLOYEE", isActive: true },
  });
  const employee = await app.prisma.employee.create({
    data: {
      tenantId,
      userId: user.id,
      employeeNumber: `${label}-${suffix}`,
      firstName: label,
      lastName: "WeekTarget451",
      hireDate: new Date(`${hireDate}T00:00:00Z`),
    },
  });
  const dayHours = opts.dayHours ?? 8;
  await app.prisma.workSchedule.create({
    data: {
      employeeId: employee.id,
      type: scheduleType,
      weeklyHours: scheduleType === "MONTHLY_HOURS" ? null : (opts.weeklyHours ?? 40),
      monthlyHours: scheduleType === "MONTHLY_HOURS" ? (opts.monthlyHours ?? 80) : null,
      mondayHours: scheduleType === "MONTHLY_HOURS" ? 0 : dayHours,
      tuesdayHours: scheduleType === "MONTHLY_HOURS" ? 0 : dayHours,
      wednesdayHours: scheduleType === "MONTHLY_HOURS" ? 0 : dayHours,
      thursdayHours: scheduleType === "MONTHLY_HOURS" ? 0 : dayHours,
      fridayHours: scheduleType === "MONTHLY_HOURS" ? 0 : dayHours,
      saturdayHours: 0,
      sundayHours: 0,
      workDays: [1, 2, 3, 4, 5],
      validFrom: new Date(`${hireDate}T00:00:00Z`),
    },
  });
  await app.prisma.employeeSalonAssignment.create({
    data: {
      tenantId,
      employeeId: employee.id,
      salonId,
      kind: "HOME",
      validFrom: new Date(`${hireDate}T00:00:00Z`),
      validUntil: null,
      weekdays: [],
    },
  });
  await app.prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
  return { id: employee.id, email };
}

async function createEntry(
  app: FastifyInstance,
  employeeId: string,
  salonId: string,
  dateStr: string,
  startHour: number,
  endHour: number,
) {
  await app.prisma.timeEntry.create({
    data: {
      employeeId,
      date: new Date(`${dateStr}T00:00:00Z`),
      startTime: new Date(`${dateStr}T${String(startHour).padStart(2, "0")}:00:00Z`),
      endTime: new Date(`${dateStr}T${String(endHour).padStart(2, "0")}:00:00Z`),
      breakMinutes: 0,
      type: "WORK",
      salonId,
    },
  });
}

type DashboardWeekBody = {
  week: {
    workedHours: number;
    targetHours: number;
    workedToDateHours?: number;
    targetToDateHours?: number;
  };
  periodType: string;
};

async function getDashboard(app: FastifyInstance, token: string): Promise<DashboardWeekBody> {
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/dashboard/",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body) as DashboardWeekBody;
}

describe("Issue #451 Plan 06 — dashboard week target is the whole-week Soll from the saldo core (D-06)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "451wk");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("451-06 dashboard-week-target cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("FLEXTIME, full vacation week: week.targetHours 0, not a flat Mon..today walk (D-06 issue example)", async () => {
    const emp = await createEmployee(
      app,
      data.tenant.id,
      data.salonId,
      "flexvac",
      "2026-01-01",
      "FLEXTIME",
      { weeklyHours: 40, dayHours: 1 },
    );
    const token = await loginAs(app, emp.email);

    await app.prisma.leaveRequest.create({
      data: {
        employeeId: emp.id,
        leaveTypeId: data.vacationType.id,
        startDate: new Date("2026-08-10T00:00:00Z"),
        endDate: new Date("2026-08-14T00:00:00Z"),
        days: 5,
        status: "APPROVED",
      },
    });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-12T10:00:00.000Z"));

    const body = await getDashboard(app, token);

    expect(body.week.targetHours, "whole-week net Soll — a full vacation week is 0").toBe(0);
    expect(body.week.targetToDateHours).toBe(0);
    expect(body.week.workedToDateHours).toBe(0);
  });

  it("FIXED_SCHEDULE, holiday week: week.targetHours 32 (Mon-Sun minus Christi Himmelfahrt), to-date pair excludes today, workedHours unchanged at 19", async () => {
    const emp = await createEmployee(
      app,
      data.tenant.id,
      data.salonId,
      "fixedhol",
      "2026-01-01",
      "FIXED_SCHEDULE",
      { weeklyHours: 40, dayHours: 8 },
    );
    const token = await loginAs(app, emp.email);

    // Mon 11.05. 8h, Tue 12.05. 7h, Wed 13.05. (today) 4h.
    await createEntry(app, emp.id, data.salonId, "2026-05-11", 7, 15);
    await createEntry(app, emp.id, data.salonId, "2026-05-12", 7, 14);
    await createEntry(app, emp.id, data.salonId, "2026-05-13", 7, 11);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-13T10:00:00.000Z"));

    const body = await getDashboard(app, token);

    // 5 workdays * 8h = 40h, minus Christi Himmelfahrt (14.05., Thu, a workday) = 32h.
    expect(body.week.targetHours, "whole-week Soll minus the Thursday holiday").toBe(32);
    // Mon+Tue = 16h Soll through yesterday (12.05.); today (Wed) never counts.
    expect(body.week.targetToDateHours).toBe(16);
    // Mon(8) + Tue(7) = 15h Ist through yesterday; today's 4h excluded.
    expect(body.week.workedToDateHours).toBe(15);
    // whole-week Ist incl. today (8+7+4) — unchanged field, untouched by this plan.
    expect(body.week.workedHours).toBe(19);
  });

  it("MONTHLY_HOURS: keeps its month view — periodType month, week.targetHours 0 unchanged", async () => {
    const emp = await createEmployee(
      app,
      data.tenant.id,
      data.salonId,
      "mh",
      "2026-01-01",
      "MONTHLY_HOURS",
      { monthlyHours: 80 },
    );
    const token = await loginAs(app, emp.email);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-13T10:00:00.000Z"));

    const body = await getDashboard(app, token);

    expect(body.periodType).toBe("month");
    expect(body.week.targetHours).toBe(0);
  });

  // Plan 451-06, Task 2 — the to-date pair through Berufsschule and a Monday fake clock.
  it("Azubi (FIXED_SCHEDULE) with a BS day Mon-Tue, fake clock Wed: workedToDateHours - targetToDateHours is 0 (BS is balance-neutral)", async () => {
    const emp = await createEmployee(
      app,
      data.tenant.id,
      data.salonId,
      "azubibs",
      "2026-01-01",
      "FIXED_SCHEDULE",
      { weeklyHours: 40, dayHours: 8 },
    );
    const token = await loginAs(app, emp.email);

    // Mon 11.05. + Tue 12.05. Berufsschule, no entries at all this week.
    await app.prisma.absence.create({
      data: {
        employeeId: emp.id,
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        startDate: new Date("2026-05-11T00:00:00Z"),
        endDate: new Date("2026-05-12T00:00:00Z"),
        days: 2,
        createdBy: data.adminUser.id,
      },
    });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-13T10:00:00.000Z"));

    const body = await getDashboard(app, token);

    // BBiG §15: the saldo core credits a Berufsschultag to BOTH worked and expected with the
    // SAME value (bsWorkedMinutes === bsExpectedMinutes for FIXED_SCHEDULE — see
    // bs-day-saldo-parity.test.ts) — whatever the concrete BBiG §15 slot credit is, the two
    // BS days' contribution to (worked - target) is exactly 0.
    expect(
      (body.week.workedToDateHours ?? 0) - (body.week.targetToDateHours ?? 0),
      "a Berufsschultag is balance-neutral in the to-date pair",
    ).toBe(0);
  });

  it("fake clock on a Monday: workedToDateHours and targetToDateHours are both 0 (yesterday is last week)", async () => {
    const emp = await createEmployee(
      app,
      data.tenant.id,
      data.salonId,
      "monday",
      "2026-01-01",
      "FIXED_SCHEDULE",
      { weeklyHours: 40, dayHours: 8 },
    );
    const token = await loginAs(app, emp.email);

    // 2026-05-11 is a Monday; yesterday (2026-05-10, Sunday) is in the PREVIOUS week.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-11T10:00:00.000Z"));

    const body = await getDashboard(app, token);

    expect(body.week.workedToDateHours).toBe(0);
    expect(body.week.targetToDateHours).toBe(0);
  });

  // WR-01 (451-REVIEW.md): a hire date in the SECOND HALF of a month falls after that calendar
  // month's midpoint. computeWeekProgress resolved each week-piece's contract via
  // getEffectiveSchedule(app, employeeId, <that month's midpoint>) — for the hire month this
  // midpoint precedes the hire date, so getEffectiveSchedule finds no WorkSchedule row and
  // silently falls back to the tenant-default FIXED_SCHEDULE (40h/8h Mo-Fr) instead of the
  // employee's real 30h/6h contract. Fixed: resolve via the month's END (the same rule
  // month-saldo.ts already uses), so the hire-date row (validFrom 20.01. <= monthEnd 31.01.) is
  // found for every day from the hire date onward.
  it("WR-01: hire on the 20th (second half of January) — week tile uses the HIRE schedule (6h/day), not the tenant default (8h/day)", async () => {
    const emp = await createEmployee(
      app,
      data.tenant.id,
      data.salonId,
      "hire20",
      "2026-01-20",
      "FIXED_SCHEDULE",
      { weeklyHours: 30, dayHours: 6 },
    );
    const token = await loginAs(app, emp.email);

    // Week Mon 19.01. - Sun 25.01. Mon 19.01. is BEFORE the 20.01. hire date (not employed yet).
    // Fake clock Thu 22.01. -> yesterday = Wed 21.01.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-22T10:00:00.000Z"));

    const body = await getDashboard(app, token);

    // Whole week: Tue 20. - Fri 23. = 4 workdays (Mon 19. excluded, before hire) * 6h = 24h.
    // Before the fix: tenant-default fallback (8h) -> 32h (RED).
    expect(
      body.week.targetHours,
      "whole-week Soll on the HIRE schedule, not the tenant default",
    ).toBe(24);
    // To-date (through yesterday 21.01.): Tue 20. + Wed 21. = 2 workdays * 6h = 12h.
    // Before the fix: 2 * 8h = 16h (RED).
    expect(body.week.targetToDateHours).toBe(12);
    expect(body.week.workedToDateHours).toBe(0);
  });
});
