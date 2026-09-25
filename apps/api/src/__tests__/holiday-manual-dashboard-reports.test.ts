/**
 * Phase 71b Plan 07 (issue #71), D-06/AC-10 — the composition layer's LAST two holiday readers.
 *
 * `composition/dashboard.ts` (my-week, team-week, today-attendance, open-items, the root Soll
 * card) and `composition/reports.ts` (the monthly Soll for MONTHLY_HOURS employees) have NEVER
 * read `PublicHoliday` — they only ever computed the STATUTORY set (`getHolidays()`), tenant-wide.
 * This is a CORRECTION, not a new rule: a manually-added holiday (a Betriebsfeiertag, say) has
 * always been silently ignored by these two files. `contexts/time-tracking/plugins/
 * attendance-checker.ts` is deliberately NOT covered here — Phase 71b Plan 05 confirmed it already
 * merged manual `PublicHoliday` rows before this phase; only its federal-state SOURCE changed
 * there, not its manual-holiday awareness.
 *
 * All fixture dates are pinned, past, fake instants (`vi.useFakeTimers`) — Fronleichnam 2026
 * (Thursday 2026-06-04, BAYERN only) and a manual holiday on Wednesday 2026-06-10 are used
 * throughout, mirroring the convention already established in
 * `holiday-work-location-close-month.test.ts` (Phase 71b Plan 05).
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";

async function loginAs(app: FastifyInstance, email: string, password = "test1234") {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
  });
  const { accessToken } = JSON.parse(res.body) as { accessToken: string };
  return accessToken;
}

async function createFixedEmployee(
  app: FastifyInstance,
  tenantId: string,
  salonId: string,
  label: string,
  hireDate: string,
) {
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
      lastName: "ManualHoliday",
      hireDate: new Date(`${hireDate}T00:00:00Z`),
    },
  });
  await app.prisma.workSchedule.create({
    data: {
      employeeId: employee.id,
      type: "FIXED_SCHEDULE",
      weeklyHours: 40,
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
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
  const token = await loginAs(app, email);
  return { id: employee.id, token };
}

async function createEntry(
  app: FastifyInstance,
  employeeId: string,
  dateStr: string,
  salonId: string,
) {
  await app.prisma.timeEntry.create({
    data: {
      employeeId,
      date: new Date(`${dateStr}T00:00:00Z`),
      startTime: new Date(`${dateStr}T08:00:00Z`),
      endTime: new Date(`${dateStr}T16:00:00Z`),
      breakMinutes: 0,
      type: "WORK",
      salonId,
    },
  });
}

describe("D-06 correction — dashboard.ts my-week/team-week/today-attendance/open-items honor a salon's manual holiday (Phase 71b Plan 07, issue #71)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let salonId: string;
  let adminToken: string;
  let fixedEmpId: string;
  let fixedEmpToken: string;

  const MANUAL_HOLIDAY_DATE = "2026-06-10"; // Wednesday, no statutory NI holiday this week
  const MANUAL_HOLIDAY_NAME = "Betriebsfeiertag NS";
  // Window/week workdays with a closed entry — every Mon-Fri in [06-06 .. 06-12] EXCEPT
  // the manual holiday itself, so it is the only candidate gap/holiday day in either window.
  const ENTRY_DAYS = ["2026-06-08", "2026-06-09", "2026-06-11", "2026-06-12"];

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-13T10:00:00.000Z"));

    app = await getTestApp();
    const seed = await seedTestData(app, "hmdr1", { withDefaultSalon: false });
    tenantId = seed.tenant.id;
    adminToken = seed.adminToken;

    const salon = await createTestSalon(app.prisma, tenantId, { federalState: "NIEDERSACHSEN" });
    salonId = salon.id;

    await app.prisma.publicHoliday.create({
      data: {
        tenantId,
        salonId,
        date: new Date(`${MANUAL_HOLIDAY_DATE}T00:00:00Z`),
        name: MANUAL_HOLIDAY_NAME,
        federalState: "NIEDERSACHSEN",
        year: 2026,
      },
    });

    const fixed = await createFixedEmployee(app, tenantId, salonId, "hmdr1fixed", "2026-06-01");
    fixedEmpId = fixed.id;
    fixedEmpToken = fixed.token;
    for (const d of ENTRY_DAYS) {
      await createEntry(app, fixedEmpId, d, salonId);
    }
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("holiday-manual-dashboard-reports (dashboard-1) cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("GET /dashboard/my-week: the manual holiday day shows status holiday with the manual name", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/dashboard/my-week?date=${MANUAL_HOLIDAY_DATE}`,
      headers: { authorization: `Bearer ${fixedEmpToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      days: Array<{ date: string; status: string; holidayName: string | null }>;
    };
    const day = body.days.find((d) => d.date === MANUAL_HOLIDAY_DATE);
    expect(day?.status).toBe("holiday");
    expect(day?.holidayName).toBe(MANUAL_HOLIDAY_NAME);
  });

  it("GET /dashboard/team-week: the manual holiday's salon employee shows status holiday with reason=name on that day", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/dashboard/team-week?date=${MANUAL_HOLIDAY_DATE}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      team: Array<{
        id: string;
        days: Array<{ date: string; status: string; reason: string | null }>;
      }>;
    };
    const emp = body.team.find((t) => t.id === fixedEmpId);
    const day = emp?.days.find((d) => d.date === MANUAL_HOLIDAY_DATE);
    expect(day?.status).toBe("holiday");
    expect(day?.reason).toBe(MANUAL_HOLIDAY_NAME);
  });

  it("GET /dashboard/today-attendance: with the clock pinned on the manual holiday, the employee shows status holiday", async () => {
    vi.setSystemTime(new Date(`${MANUAL_HOLIDAY_DATE}T10:00:00.000Z`));
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/today-attendance",
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        employees: Array<{ id: string; status: string; reason: string | null }>;
      };
      const row = body.employees.find((e) => e.id === fixedEmpId);
      expect(row?.status).toBe("holiday");
      expect(row?.reason).toBe(MANUAL_HOLIDAY_NAME);
    } finally {
      vi.setSystemTime(new Date("2026-06-13T10:00:00.000Z"));
    }
  });

  it("GET /dashboard/open-items: the manual holiday day is not reported as a missing workday", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/open-items",
      headers: { authorization: `Bearer ${fixedEmpToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { missingDays: string[] };
    expect(body.missingDays).not.toContain(MANUAL_HOLIDAY_DATE);
  });
});

describe("D-06 correction — dashboard.ts GET / and reports.ts GET /monthly deduct a MONTHLY_HOURS employee's Soll by a manual holiday (Phase 71b Plan 07, issue #71)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let salonId: string;
  let adminToken: string;
  let monthlyEmpId: string;
  let monthlyEmpToken: string;

  const MANUAL_HOLIDAY_DATE = "2026-06-10"; // Wednesday, configured workday (default day-hours > 0)
  const MANUAL_HOLIDAY_NAME = "Betriebsfeiertag NS Monatslohn";
  // June 2026 has 22 Mon-Fri workdays (the JUNE_WORKDAYS list established in Plan 05's own
  // fixture). monthlyHours=176 -> dailySoll = 176*60/22 = 480min (8h); one holiday deducts
  // exactly one daily share -> 168h (10080min) when the deduction is honored, 176h otherwise.
  const MONTHLY_HOURS = 176;
  const EXPECTED_TARGET_HOURS_WITH_DEDUCTION = 168;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-20T10:00:00.000Z"));

    app = await getTestApp();
    const seed = await seedTestData(app, "hmdr2", { withDefaultSalon: false });
    tenantId = seed.tenant.id;
    adminToken = seed.adminToken;

    await app.prisma.tenantConfig.update({
      where: { tenantId },
      data: { monthlyHoursHolidayDeduction: true },
    });

    const salon = await createTestSalon(app.prisma, tenantId, { federalState: "NIEDERSACHSEN" });
    salonId = salon.id;

    await app.prisma.publicHoliday.create({
      data: {
        tenantId,
        salonId,
        date: new Date(`${MANUAL_HOLIDAY_DATE}T00:00:00Z`),
        name: MANUAL_HOLIDAY_NAME,
        federalState: "NIEDERSACHSEN",
        year: 2026,
      },
    });

    const passwordHash = await bcrypt.hash("test1234", 10);
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const email = `hmdr2-monthly-${suffix}@test.de`;
    const user = await app.prisma.user.create({
      data: { email, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `HMDR2-${suffix}`,
        firstName: "Monthly",
        lastName: "ManualHoliday",
        hireDate: new Date("2025-01-01"),
      },
    });
    monthlyEmpId = employee.id;
    await app.prisma.workSchedule.create({
      data: {
        employeeId: monthlyEmpId,
        type: "MONTHLY_HOURS",
        monthlyHours: MONTHLY_HOURS,
        // mondayHours..fridayHours default to 8 (legacy 1/0-style flag, > 0 = configured
        // workday) — left at their schema default deliberately.
        validFrom: new Date("2025-01-01"),
      },
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId,
        employeeId: monthlyEmpId,
        salonId,
        kind: "HOME",
        validFrom: new Date("2025-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });
    await app.prisma.overtimeAccount.create({
      data: { employeeId: monthlyEmpId, balanceHours: 0 },
    });
    monthlyEmpToken = await loginAs(app, email);
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("holiday-manual-dashboard-reports (dashboard-2) cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("GET /dashboard/: month.targetHours is reduced by one daily share for the manual holiday", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/",
      headers: { authorization: `Bearer ${monthlyEmpToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { month?: { targetHours: number } };
    expect(body.month?.targetHours).toBe(EXPECTED_TARGET_HOURS_WITH_DEDUCTION);
  });

  it("GET /reports/monthly: shouldHours is reduced by one daily share for the manual holiday", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly?employeeId=${monthlyEmpId}&year=2026&month=6`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      rows: Array<{ employeeId: string; shouldHours: number }>;
    };
    const row = body.rows.find((r) => r.employeeId === monthlyEmpId);
    expect(row?.shouldHours).toBe(EXPECTED_TARGET_HOURS_WITH_DEDUCTION);
  });
});

describe("Work-location statutory holiday — dashboard.ts team-week honors the deployment pattern, not the tenant-wide state (Phase 71b Plan 07, issue #71)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let salonAId: string; // BAYERN
  let salonBId: string; // NIEDERSACHSEN — tenant default
  let depId: string; // HOME B + DEPLOYMENT A Thursdays, no entry on Fronleichnam
  let ctlId: string; // HOME B only, WORKS on Fronleichnam (control, unambiguously not a holiday)

  const FRONLEICHNAM = "2026-06-04"; // Thursday, BAYERN only

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-10T10:00:00.000Z"));

    app = await getTestApp();
    const seed = await seedTestData(app, "hmdr3", { withDefaultSalon: false });
    tenantId = seed.tenant.id;
    adminToken = seed.adminToken;

    const salonB = await createTestSalon(app.prisma, tenantId, { federalState: "NIEDERSACHSEN" });
    salonBId = salonB.id;
    const salonA = await createTestSalon(app.prisma, tenantId, { federalState: "BAYERN" });
    salonAId = salonA.id;

    const dep = await createFixedEmployee(app, tenantId, salonBId, "hmdr3dep", "2026-06-01");
    depId = dep.id;
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId,
        employeeId: depId,
        salonId: salonAId,
        kind: "DEPLOYMENT",
        validFrom: new Date("2026-06-01"),
        validUntil: null,
        weekdays: [3], // Thursday (0 = Monday)
      },
    });

    const ctl = await createFixedEmployee(app, tenantId, salonBId, "hmdr3ctl", "2026-06-01");
    ctlId = ctl.id;
    await createEntry(app, ctlId, FRONLEICHNAM, salonBId);
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("holiday-manual-dashboard-reports (dashboard-3) cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("the Thursday-deployed employee shows status holiday (Fronleichnam) on 2026-06-04; the HOME-B-only control does not", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/dashboard/team-week?date=${FRONLEICHNAM}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      team: Array<{
        id: string;
        days: Array<{ date: string; status: string; reason: string | null }>;
      }>;
    };
    const depDay = body.team.find((t) => t.id === depId)?.days.find((d) => d.date === FRONLEICHNAM);
    const ctlDay = body.team.find((t) => t.id === ctlId)?.days.find((d) => d.date === FRONLEICHNAM);
    expect(depDay?.status).toBe("holiday");
    expect(depDay?.reason).toBe("Fronleichnam");
    expect(ctlDay?.status).not.toBe("holiday");
  });
});
