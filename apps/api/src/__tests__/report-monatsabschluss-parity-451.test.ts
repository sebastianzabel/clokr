/**
 * Issue #451 (D-03) — "Bericht = Monatsabschluss": the monthly report's Soll, Ist and
 * Überstunden come from the working-time-account month result (the SaldoSnapshot for a closed
 * month, the saldo core otherwise) — never from a composition-layer `{day}Hours` walk.
 *
 * Plan 451-03:
 *   Task 1 — GET /reports/monthly (JSON): the issue's two literal examples.
 *     FIXED_SCHEDULE 40h Mon-Fri 8h, May 2026 (21 weekdays, 3 NI holidays 01./14./25.05.):
 *       old (bug) shouldHours = 168 (21 * 8, no holiday deduction)
 *       new (fixed) shouldHours = 144 (18 workdays * 8, holidays deducted — the Monatsabschluss
 *       value) — must equal GET /overtime/month-saldo's expectedMinutes / 60.
 *     SHIFT_BASED (contractWorkDaysPerWeek 5, weeklyHours 40, {day}Hours placeholders 8.00 for
 *     Mon-Sat): old (bug) shouldHours = 208 (26 Mon-Sat days in May 2026 * 8h placeholder walk)
 *       new (fixed) shouldHours = the saldo core's expectedMinutes / 60 (roster-based C_net,
 *       never the placeholder walk).
 *   Task 2 — both monthly PDFs read the same figures; composition Soll code deleted.
 *   Task 3 — report == Monatsabschluss per schedule type (closed / open complete / current month).
 *
 * Fake clock 2026-06-15T10:00:00Z throughout (own tenant, NIEDERSACHSEN default salon) — "today"
 * is mid-June, so May 2026 is a fully elapsed, still-OPEN (never closed) month: the per-day header
 * window [effectiveStart, yesterday] already covers the WHOLE of May, so the OPEN-month header and
 * the new `fullMonth` figure coincide for May — exactly what lets this test pin the issue's two
 * literal examples without first closing a month (Task 3 adds the closed-month and running-month
 * cases). GET /overtime/month-saldo/:employeeId?year=2026&month=5 is always used as the oracle:
 * the report must never print a number the saldo core itself would disagree with.
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
  salonIdForEmployee,
} from "./setup";
import * as pdfUtils from "../composition/pdf";

// Task 2 — both monthly PDFs read the SAME working-time-account figures the JSON row does.
// `vi.fn(actual.fn)` wraps the REAL generator (byte content stays a valid PDF — RESEARCH.md's
// own "never byte-search a PDF" pitfall) so the spy only lets the test inspect the DATA payload
// handed to it, mirroring reports-priced-leave-days-451.test.ts's established pattern.
vi.mock("../composition/pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../composition/pdf")>();
  return {
    ...actual,
    generateMonthlyReportPdf: vi.fn(actual.generateMonthlyReportPdf),
    streamCompanyMonthlyReportPdf: vi.fn(actual.streamCompanyMonthlyReportPdf),
  };
});

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
  scheduleType: "FIXED_SCHEDULE" | "FLEXTIME" = "FIXED_SCHEDULE",
): Promise<{ id: string }> {
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
      lastName: "Parity451",
      hireDate: new Date(`${hireDate}T00:00:00Z`),
    },
  });
  await app.prisma.workSchedule.create({
    data: {
      employeeId: employee.id,
      type: scheduleType,
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
  await app.prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
  return { id: employee.id };
}

async function createShiftBasedEmployee(
  app: FastifyInstance,
  tenantId: string,
  salonId: string,
  label: string,
  hireDate: string,
): Promise<{ id: string }> {
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
      lastName: "Parity451Shift",
      hireDate: new Date(`${hireDate}T00:00:00Z`),
      breakOver6hOverride: 0,
      breakOver9hOverride: 0,
    },
  });
  await app.prisma.workSchedule.create({
    data: {
      employeeId: employee.id,
      type: "SHIFT_BASED",
      weeklyHours: 40,
      contractWorkDaysPerWeek: 5,
      // Issue #451 (D-03) — these {day}Hours placeholders are NOT authoritative for SHIFT_BASED
      // (CLAUDE.md "`{day}Hours` is authoritative data only for FIXED_SCHEDULE"); the OLD reports.ts
      // bug summed them for every Mon-Sat calendar day (26 * 8h = 208 in May 2026) instead of
      // reading the roster-based contract Soll. They are set here, Mon-Sat 8.00, deliberately —
      // the fixed code must ignore them just as the saldo core always has.
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 8,
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
  return { id: employee.id };
}

async function createMonthlyHoursEmployee(
  app: FastifyInstance,
  tenantId: string,
  salonId: string,
  label: string,
  hireDate: string,
  monthlyHours: number,
): Promise<{ id: string }> {
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
      lastName: "Parity451MH",
      hireDate: new Date(`${hireDate}T00:00:00Z`),
    },
  });
  await app.prisma.workSchedule.create({
    data: {
      employeeId: employee.id,
      type: "MONTHLY_HOURS",
      monthlyHours,
      workDays: [1, 2, 3, 4, 5],
      overtimeMode: "TRACK_ONLY",
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
  return { id: employee.id };
}

async function seedEntry(
  app: FastifyInstance,
  employeeId: string,
  dateStr: string,
  startHHMM: string,
  netMinutes: number,
  breakMinutes = 0,
) {
  const start = new Date(`${dateStr}T${startHHMM}:00Z`);
  const end = new Date(start.getTime() + (netMinutes + breakMinutes) * 60_000);
  await app.prisma.timeEntry.create({
    data: {
      employeeId,
      date: new Date(`${dateStr}T00:00:00Z`),
      startTime: start,
      endTime: end,
      breakMinutes,
      type: "WORK",
      salonId: await salonIdForEmployee(app.prisma, employeeId),
    },
  });
}

async function seedShift(
  app: FastifyInstance,
  employeeId: string,
  dateStr: string,
  startHHMM: string,
  netMinutes: number,
) {
  const [sh, sm] = startHHMM.split(":").map(Number);
  const startTotal = sh * 60 + sm;
  const endTotal = startTotal + netMinutes;
  const endHHMM = `${String(Math.floor(endTotal / 60)).padStart(2, "0")}:${String(
    endTotal % 60,
  ).padStart(2, "0")}`;
  await app.prisma.shift.create({
    data: {
      employeeId,
      salonId: await salonIdForEmployee(app.prisma, employeeId),
      date: new Date(`${dateStr}T00:00:00Z`),
      startTime: startHHMM,
      endTime: endHHMM,
    },
  });
}

// All Mon-Fri dates in May 2026 as "YYYY-MM-DD" (21 weekdays; NI holidays 01./14./25.05. fall on
// three of them, leaving 18 contract workdays).
const MAY_2026_MON_FRI: string[] = [];
for (let d = 1; d <= 31; d++) {
  const dateStr = `2026-05-${String(d).padStart(2, "0")}`;
  const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  if (dow >= 1 && dow <= 5) MAY_2026_MON_FRI.push(dateStr);
}
const MAY_2026_HOLIDAYS = new Set(["2026-05-01", "2026-05-14", "2026-05-25"]);

// Task 3 — all Mon-Fri dates of a given 2026 month as "YYYY-MM-DD".
function monFriInMonth2026(month: number): string[] {
  const lastDay = new Date(Date.UTC(2026, month, 0)).getUTCDate();
  const out: string[] = [];
  for (let d = 1; d <= lastDay; d++) {
    const dateStr = `2026-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
    if (dow >= 1 && dow <= 5) out.push(dateStr);
  }
  return out;
}

// April 2026: 22 Mon-Fri weekdays; NI holidays Karfreitag 03.04. (Fri) and Ostermontag 06.04.
// (Mon) leave 20 contract workdays.
const APRIL_2026_MON_FRI = monFriInMonth2026(4);
const APRIL_2026_HOLIDAYS = new Set(["2026-04-03", "2026-04-06"]);
// June 2026: 22 Mon-Fri weekdays, no NI statutory holiday (context fact, plan Planner-measured
// facts section).
const JUNE_2026_MON_FRI = monFriInMonth2026(6);

async function closeMonth(
  app: FastifyInstance,
  adminToken: string,
  employeeId: string,
  year: number,
  month: number,
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/overtime/close-month",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { employeeId, year, month },
  });
}

/** Seed a WORK entry (08:00-16:30, 30min break = 480 net) for every date in `dates` not in `exclude`. */
async function seedWeekdayEntries(
  app: FastifyInstance,
  employeeId: string,
  dates: string[],
  exclude: Set<string> = new Set(),
) {
  for (const dateStr of dates) {
    if (exclude.has(dateStr)) continue;
    await seedEntry(app, employeeId, dateStr, "08:00", 480, 30);
  }
}

/** Seed a matching Shift + WORK entry (08:00-16:00, 480 net, no break) for every date not excluded. */
async function seedWeekdayShiftsAndEntries(
  app: FastifyInstance,
  employeeId: string,
  dates: string[],
  exclude: Set<string> = new Set(),
) {
  for (const dateStr of dates) {
    if (exclude.has(dateStr)) continue;
    await seedShift(app, employeeId, dateStr, "08:00", 480);
    await seedEntry(app, employeeId, dateStr, "08:00", 480);
  }
}

async function seedVocationalSchoolDay(app: FastifyInstance, employeeId: string, dateStr: string) {
  await app.prisma.absence.create({
    data: {
      employeeId,
      type: "VOCATIONAL_SCHOOL",
      source: "MANUAL",
      startDate: new Date(`${dateStr}T00:00:00Z`),
      endDate: new Date(`${dateStr}T00:00:00Z`),
      days: 1,
      createdBy: "test-fixture-451-03-t3",
    },
  });
}

describe("Issue #451 (D-03) — report == Monatsabschluss, Task 1 (issue examples 168->144, 208->core)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let salonId: string;
  let adminToken: string;

  let fixedEmpId: string;
  let shiftEmpId: string;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T10:00:00.000Z"));

    app = await getTestApp();
    const seed = await seedTestData(app, "rmp451", { withDefaultSalon: false });
    tenantId = seed.tenant.id;
    adminToken = seed.adminToken;

    const salon = await createTestSalon(app.prisma, tenantId, { federalState: "NIEDERSACHSEN" });
    salonId = salon.id;

    const fixedEmp = await createFixedEmployee(app, tenantId, salonId, "rmp451fix", "2025-01-01");
    fixedEmpId = fixedEmp.id;
    // A few 15-minute-grid worked entries in May 2026 — not every contract workday, deliberately
    // (only the Soll/shouldHours value is pinned to the issue's hand-derived 144; workedHours is
    // asserted only for parity with the oracle, never a fixed literal).
    await seedEntry(app, fixedEmpId, "2026-05-04", "08:00", 480, 30); // Mon
    await seedEntry(app, fixedEmpId, "2026-05-05", "08:00", 480, 30); // Tue
    await seedEntry(app, fixedEmpId, "2026-05-06", "08:00", 495, 30); // Wed, 15min over

    const shiftEmp = await createShiftBasedEmployee(
      app,
      tenantId,
      salonId,
      "rmp451shift",
      "2025-01-01",
    );
    shiftEmpId = shiftEmp.id;
    for (const dateStr of MAY_2026_MON_FRI) {
      await seedShift(app, shiftEmpId, dateStr, "08:00", 480);
      await seedEntry(app, shiftEmpId, dateStr, "08:00", 480);
    }
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("report-monatsabschluss-parity-451 cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function monthSaldoOracle(employeeId: string) {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/month-saldo/${employeeId}?year=2026&month=5`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as {
      workedMinutes: number;
      expectedMinutes: number;
      balanceMinutes: number;
    };
  }

  async function monthlyReportRow(employeeId: string) {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly?employeeId=${employeeId}&year=2026&month=5`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      rows: Array<{
        employeeId: string;
        workedHours: number;
        shouldHours: number;
        overtimeHours?: number;
        overtimeConfirmed?: boolean | null;
        balanceAdjustmentHours?: number;
      }>;
    };
    const row = body.rows.find((r) => r.employeeId === employeeId);
    if (!row) throw new Error(`no row for ${employeeId}`);
    return row;
  }

  it("FIXED_SCHEDULE: GET /reports/monthly shouldHours == 144 (Monatsabschluss: 18 workdays after 3 NI holidays), not 168", async () => {
    const row = await monthlyReportRow(fixedEmpId);
    expect(row.shouldHours).toBe(144);
  });

  it("FIXED_SCHEDULE: report workedHours/shouldHours/overtimeHours equal GET /overtime/month-saldo", async () => {
    const oracle = await monthSaldoOracle(fixedEmpId);
    const row = await monthlyReportRow(fixedEmpId);
    expect(row.workedHours).toBe(Math.round((oracle.workedMinutes / 60) * 100) / 100);
    expect(row.shouldHours).toBe(Math.round((oracle.expectedMinutes / 60) * 100) / 100);
    expect(row.overtimeHours).toBe(Math.round((oracle.balanceMinutes / 60) * 100) / 100);
  });

  it("FIXED_SCHEDULE: overtimeConfirmed is false (open month)", async () => {
    const row = await monthlyReportRow(fixedEmpId);
    expect(row.overtimeConfirmed).toBe(false);
  });

  it("FIXED_SCHEDULE: balanceAdjustmentHours == overtimeHours - (workedHours - shouldHours)", async () => {
    const row = await monthlyReportRow(fixedEmpId);
    expect(row.balanceAdjustmentHours).toBeDefined();
    const expected =
      Math.round(
        ((row.overtimeHours ?? 0) - ((row.workedHours ?? 0) - (row.shouldHours ?? 0))) * 100,
      ) / 100;
    expect(row.balanceAdjustmentHours).toBe(expected);
  });

  it("SHIFT_BASED: GET /reports/monthly shouldHours is NOT the {day}Hours-placeholder walk (208), and equals GET /overtime/month-saldo expectedMinutes", async () => {
    const oracle = await monthSaldoOracle(shiftEmpId);
    const row = await monthlyReportRow(shiftEmpId);
    expect(row.shouldHours).not.toBe(208);
    expect(row.shouldHours).toBe(Math.round((oracle.expectedMinutes / 60) * 100) / 100);
  });

  it("SHIFT_BASED: report workedHours/overtimeHours equal GET /overtime/month-saldo", async () => {
    const oracle = await monthSaldoOracle(shiftEmpId);
    const row = await monthlyReportRow(shiftEmpId);
    expect(row.workedHours).toBe(Math.round((oracle.workedMinutes / 60) * 100) / 100);
    expect(row.overtimeHours).toBe(Math.round((oracle.balanceMinutes / 60) * 100) / 100);
  });

  it("SHIFT_BASED: balanceAdjustmentHours is present and consistent", async () => {
    const row = await monthlyReportRow(shiftEmpId);
    expect(row.balanceAdjustmentHours).toBeDefined();
    const expected =
      Math.round(
        ((row.overtimeHours ?? 0) - ((row.workedHours ?? 0) - (row.shouldHours ?? 0))) * 100,
      ) / 100;
    expect(row.balanceAdjustmentHours).toBe(expected);
  });
});

describe("Issue #451 (D-03) — report == Monatsabschluss, Task 2 (both monthly PDFs on the same figures)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let salonId: string;
  let adminToken: string;

  let fixedEmpId: string;
  let shiftEmpId: string;
  let mhNoBudgetEmpId: string;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T10:00:00.000Z"));

    app = await getTestApp();
    const seed = await seedTestData(app, "rmp451t2", { withDefaultSalon: false });
    tenantId = seed.tenant.id;
    adminToken = seed.adminToken;

    const salon = await createTestSalon(app.prisma, tenantId, { federalState: "NIEDERSACHSEN" });
    salonId = salon.id;

    const fixedEmp = await createFixedEmployee(app, tenantId, salonId, "rmp451t2fix", "2025-01-01");
    fixedEmpId = fixedEmp.id;
    await seedEntry(app, fixedEmpId, "2026-05-04", "08:00", 480, 30);

    const shiftEmp = await createShiftBasedEmployee(
      app,
      tenantId,
      salonId,
      "rmp451t2shift",
      "2025-01-01",
    );
    shiftEmpId = shiftEmp.id;
    for (const dateStr of MAY_2026_MON_FRI) {
      await seedShift(app, shiftEmpId, dateStr, "08:00", 480);
      await seedEntry(app, shiftEmpId, dateStr, "08:00", 480);
    }

    // MONTHLY_HOURS employee with NO budget (pure tracking, D-01) — the resolver's own
    // "unlabelled" population: overtimeConfirmed must stay null (not relabelled false), never a
    // fabricated Soll, while workedHours still reflects the recorded entries (docs/saldo-anzeige.md).
    const mhEmp = await createMonthlyHoursEmployee(
      app,
      tenantId,
      salonId,
      "rmp451t2mh0",
      "2025-01-01",
      0,
    );
    mhNoBudgetEmpId = mhEmp.id;
    await seedEntry(app, mhNoBudgetEmpId, "2026-05-04", "08:00", 480, 30);
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("report-monatsabschluss-parity-451 Task2 cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function monthSaldoOracle(employeeId: string) {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/month-saldo/${employeeId}?year=2026&month=5`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as {
      workedMinutes: number;
      expectedMinutes: number;
      balanceMinutes: number;
    };
  }

  async function monthlyReportRow(employeeId: string) {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly?employeeId=${employeeId}&year=2026&month=5`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      rows: Array<{
        employeeId: string;
        workedHours: number;
        shouldHours: number;
        overtimeHours?: number;
        overtimeConfirmed?: boolean | null;
      }>;
    };
    const row = body.rows.find((r) => r.employeeId === employeeId);
    if (!row) throw new Error(`no row for ${employeeId}`);
    return row;
  }

  it("FIXED_SCHEDULE: GET /reports/monthly/pdf payload targetHours == 144, not 168; workedHours/overtimeHours equal the JSON row; overtimeConfirmed false", async () => {
    const spy = vi.mocked(pdfUtils.generateMonthlyReportPdf);
    spy.mockClear();

    const jsonRow = await monthlyReportRow(fixedEmpId);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly/pdf?employeeId=${fixedEmpId}&year=2026&month=5`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    const payload = spy.mock.calls[0][0];
    expect(payload.targetHours).toBe(144);
    expect(payload.workedHours).toBe(jsonRow.workedHours);
    expect(payload.overtimeHours).toBe(jsonRow.overtimeHours);
    expect(payload.overtimeConfirmed).toBe(false);
  });

  it("SHIFT_BASED: GET /reports/monthly/pdf/all company PDF row targetHours equals GET /overtime/month-saldo expectedMinutes", async () => {
    const spy = vi.mocked(pdfUtils.streamCompanyMonthlyReportPdf);
    spy.mockClear();

    const oracle = await monthSaldoOracle(shiftEmpId);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/reports/monthly/pdf/all?year=2026&month=5",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    const companyData = spy.mock.calls[0][1];
    const row = companyData.rows.find((r) => {
      // employeeNumber carries the fixture label — the shift employee's label contains "shift".
      return r.employeeNumber.includes("rmp451t2shift");
    });
    expect(row).toBeDefined();
    expect(row!.targetHours).toBe(Math.round((oracle.expectedMinutes / 60) * 100) / 100);
  });

  it("MONTHLY_HOURS without budget: JSON overtimeConfirmed null, overtimeHours 0, shouldHours 0, workedHours == recorded hours; PDF payload overtimeConfirmed null", async () => {
    const jsonRow = await monthlyReportRow(mhNoBudgetEmpId);
    expect(jsonRow.overtimeConfirmed).toBeNull();
    expect(jsonRow.overtimeHours).toBe(0);
    expect(jsonRow.shouldHours).toBe(0);
    expect(jsonRow.workedHours).toBe(8); // 480min / 60

    const spy = vi.mocked(pdfUtils.generateMonthlyReportPdf);
    spy.mockClear();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly/pdf?employeeId=${mhNoBudgetEmpId}&year=2026&month=5`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    const payload = spy.mock.calls[0][0];
    expect(payload.overtimeConfirmed).toBeNull();
  });
});

describe("Issue #451 (D-03) — report == Monatsabschluss, Task 3 (closed / open complete / current month per schedule type)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let salonId: string;
  let adminToken: string;

  let fixedEmpId: string;
  let flexEmpId: string;
  let mhEmpId: string;
  let shiftEmpId: string;
  let azubiEmpId: string;

  // Hired exactly on the 1st of April — closing April needs no prior month closed first
  // (the sequential-close guard has nothing before hireDate to demand).
  const HIRE = "2026-04-01";
  const APRIL_BS_DATE = "2026-04-09"; // Thursday, not a holiday
  const MAY_BS_DATE = "2026-05-07"; // Thursday, not a holiday
  const JUNE_BS_DATE = "2026-06-11"; // Thursday, before the 15.06. fake-clock cutoff

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T10:00:00.000Z"));

    app = await getTestApp();
    const seed = await seedTestData(app, "rmp451t3", { withDefaultSalon: false });
    tenantId = seed.tenant.id;
    adminToken = seed.adminToken;

    const salon = await createTestSalon(app.prisma, tenantId, { federalState: "NIEDERSACHSEN" });
    salonId = salon.id;

    const fixedEmp = await createFixedEmployee(app, tenantId, salonId, "rmp451t3fix", HIRE);
    fixedEmpId = fixedEmp.id;
    const flexEmp = await createFixedEmployee(
      app,
      tenantId,
      salonId,
      "rmp451t3flex",
      HIRE,
      "FLEXTIME",
    );
    flexEmpId = flexEmp.id;
    const mhEmp = await createMonthlyHoursEmployee(app, tenantId, salonId, "rmp451t3mh", HIRE, 160);
    mhEmpId = mhEmp.id;
    const shiftEmp = await createShiftBasedEmployee(app, tenantId, salonId, "rmp451t3shift", HIRE);
    shiftEmpId = shiftEmp.id;
    const azubiEmp = await createFixedEmployee(app, tenantId, salonId, "rmp451t3azubi", HIRE);
    azubiEmpId = azubiEmp.id;

    // ── April 2026 — will be closed. Full coverage (minus the 2 NI holidays, minus the Azubi's
    // BS day which the VOCATIONAL_SCHOOL absence already excuses) so POST /close-month never
    // hits the gaps gate.
    const aprilAzubiExclude = new Set([...APRIL_2026_HOLIDAYS, APRIL_BS_DATE]);
    await seedWeekdayEntries(app, fixedEmpId, APRIL_2026_MON_FRI, APRIL_2026_HOLIDAYS);
    await seedWeekdayEntries(app, flexEmpId, APRIL_2026_MON_FRI, APRIL_2026_HOLIDAYS);
    await seedWeekdayEntries(app, mhEmpId, APRIL_2026_MON_FRI, APRIL_2026_HOLIDAYS);
    await seedWeekdayShiftsAndEntries(app, shiftEmpId, APRIL_2026_MON_FRI, APRIL_2026_HOLIDAYS);
    await seedWeekdayEntries(app, azubiEmpId, APRIL_2026_MON_FRI, aprilAzubiExclude);
    await seedVocationalSchoolDay(app, azubiEmpId, APRIL_BS_DATE);

    // ── May 2026 — stays open (never closed). Same full-coverage pattern (not required by any
    // gate since May is never closed, but keeps every type's workedHours non-trivial).
    const mayAzubiExclude = new Set([...MAY_2026_HOLIDAYS, MAY_BS_DATE]);
    await seedWeekdayEntries(app, fixedEmpId, MAY_2026_MON_FRI, MAY_2026_HOLIDAYS);
    await seedWeekdayEntries(app, flexEmpId, MAY_2026_MON_FRI, MAY_2026_HOLIDAYS);
    await seedWeekdayEntries(app, mhEmpId, MAY_2026_MON_FRI, MAY_2026_HOLIDAYS);
    await seedWeekdayShiftsAndEntries(app, shiftEmpId, MAY_2026_MON_FRI, MAY_2026_HOLIDAYS);
    await seedWeekdayEntries(app, azubiEmpId, MAY_2026_MON_FRI, mayAzubiExclude);
    await seedVocationalSchoolDay(app, azubiEmpId, MAY_BS_DATE);

    // ── June 2026 — the running month (fake clock 15.06., so "yesterday" is 14.06.). June 2026
    // has no NI statutory holiday. Only through-yesterday days are seeded — June is never closed,
    // so the gaps gate never applies, and the report only ever prints entries through yesterday
    // anyway (issue #438).
    const juneToDate = JUNE_2026_MON_FRI.filter((d) => d <= "2026-06-14");
    await seedWeekdayEntries(app, fixedEmpId, juneToDate);
    await seedWeekdayEntries(app, flexEmpId, juneToDate);
    await seedWeekdayEntries(app, mhEmpId, juneToDate);
    await seedWeekdayShiftsAndEntries(app, shiftEmpId, JUNE_2026_MON_FRI); // full roster, incl. future shifts
    await seedWeekdayEntries(
      app,
      azubiEmpId,
      juneToDate.filter((d) => d !== JUNE_BS_DATE),
    );
    await seedVocationalSchoolDay(app, azubiEmpId, JUNE_BS_DATE);

    // Close April for all five schedule types.
    for (const id of [fixedEmpId, flexEmpId, mhEmpId, shiftEmpId, azubiEmpId]) {
      const res = await closeMonth(app, adminToken, id, 2026, 4);
      expect(res.statusCode, `close April 2026 for employee ${id}: ${res.body}`).toBe(201);
    }
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("report-monatsabschluss-parity-451 Task3 cleanup failed:", err);
    }
    await closeTestApp();
  });

  type Oracle = {
    workedMinutes: number;
    expectedMinutes: number;
    balanceMinutes: number;
    closed: boolean;
    monthSollMinutes?: number;
  };

  async function monthSaldoOracle(
    employeeId: string,
    year: number,
    month: number,
  ): Promise<Oracle> {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/month-saldo/${employeeId}?year=${year}&month=${month}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as Oracle;
  }

  type ReportRow = {
    employeeId: string;
    workedHours: number;
    shouldHours: number;
    overtimeHours?: number;
    overtimeConfirmed?: boolean | null;
    balanceAdjustmentHours?: number;
  };

  async function monthlyReportRow(
    employeeId: string,
    year: number,
    month: number,
  ): Promise<ReportRow> {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly?employeeId=${employeeId}&year=${year}&month=${month}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { rows: ReportRow[] };
    const row = body.rows.find((r) => r.employeeId === employeeId);
    if (!row) throw new Error(`no row for ${employeeId} ${year}-${month}`);
    return row;
  }

  async function pdfPayloadFor(employeeId: string, year: number, month: number) {
    const spy = vi.mocked(pdfUtils.generateMonthlyReportPdf);
    spy.mockClear();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly/pdf?employeeId=${employeeId}&year=${year}&month=${month}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    return spy.mock.calls[0][0];
  }

  // D-03's own consistency identity: balanceAdjustmentMinutes = balance - (worked - expected), so
  // this holds BY CONSTRUCTION for every labelled row — a sanity pin, not an independent proof.
  function expectConsistent(row: ReportRow) {
    if (row.overtimeConfirmed === null) return; // unlabelled rows carry no Soll to check against
    const diff =
      (row.workedHours ?? 0) -
      (row.shouldHours ?? 0) +
      (row.balanceAdjustmentHours ?? 0) -
      (row.overtimeHours ?? 0);
    expect(Math.abs(diff), `consistency identity for row ${JSON.stringify(row)}`).toBeLessThan(
      0.005,
    );
  }

  describe.each([
    ["FIXED_SCHEDULE", () => fixedEmpId],
    ["FLEXTIME", () => flexEmpId],
    ["Azubi (FIXED_SCHEDULE + VOCATIONAL_SCHOOL)", () => azubiEmpId],
  ] as const)("%s", (_label, getEmpId) => {
    it("April 2026 (closed): JSON row and single-PDF payload equal the SaldoSnapshot", async () => {
      const empId = getEmpId();
      const oracle = await monthSaldoOracle(empId, 2026, 4);
      expect(oracle.closed).toBe(true);
      const row = await monthlyReportRow(empId, 2026, 4);
      expect(row.workedHours).toBe(Math.round((oracle.workedMinutes / 60) * 100) / 100);
      expect(row.shouldHours).toBe(Math.round((oracle.expectedMinutes / 60) * 100) / 100);
      expect(row.overtimeHours).toBe(Math.round((oracle.balanceMinutes / 60) * 100) / 100);
      expect(row.overtimeConfirmed).toBe(true);
      expectConsistent(row);

      const payload = await pdfPayloadFor(empId, 2026, 4);
      expect(payload.workedHours).toBe(row.workedHours);
      expect(payload.targetHours).toBe(row.shouldHours);
      expect(payload.overtimeHours).toBe(row.overtimeHours);
      expect(payload.overtimeConfirmed).toBe(true);
    });

    it("May 2026 (open, fully elapsed): JSON row equals GET /overtime/month-saldo (header)", async () => {
      const empId = getEmpId();
      const oracle = await monthSaldoOracle(empId, 2026, 5);
      expect(oracle.closed).toBe(false);
      const row = await monthlyReportRow(empId, 2026, 5);
      expect(row.workedHours).toBe(Math.round((oracle.workedMinutes / 60) * 100) / 100);
      expect(row.shouldHours).toBe(Math.round((oracle.expectedMinutes / 60) * 100) / 100);
      expect(row.overtimeHours).toBe(Math.round((oracle.balanceMinutes / 60) * 100) / 100);
      expect(row.overtimeConfirmed).toBe(false);
      expectConsistent(row);
    });

    it("June 2026 (running): shouldHours equals the hand-derived full-month value (22 workdays * 8h = 176, no NI holiday)", async () => {
      const empId = getEmpId();
      const row = await monthlyReportRow(empId, 2026, 6);
      expect(row.shouldHours).toBe(176);
      expect(row.overtimeConfirmed).toBe(false);
      expectConsistent(row);
    });
  });

  describe("MONTHLY_HOURS (budget 160h)", () => {
    it("April 2026 (closed): JSON row and single-PDF payload equal the SaldoSnapshot", async () => {
      const oracle = await monthSaldoOracle(mhEmpId, 2026, 4);
      expect(oracle.closed).toBe(true);
      const row = await monthlyReportRow(mhEmpId, 2026, 4);
      expect(row.workedHours).toBe(Math.round((oracle.workedMinutes / 60) * 100) / 100);
      expect(row.shouldHours).toBe(Math.round((oracle.expectedMinutes / 60) * 100) / 100);
      expect(row.overtimeHours).toBe(Math.round((oracle.balanceMinutes / 60) * 100) / 100);
      expect(row.overtimeConfirmed).toBe(true);
      expectConsistent(row);

      const payload = await pdfPayloadFor(mhEmpId, 2026, 4);
      expect(payload.workedHours).toBe(row.workedHours);
      expect(payload.targetHours).toBe(row.shouldHours);
      expect(payload.overtimeHours).toBe(row.overtimeHours);
      expect(payload.overtimeConfirmed).toBe(true);
    });

    it("May 2026 (open, fully elapsed): JSON row equals GET /overtime/month-saldo (header)", async () => {
      const oracle = await monthSaldoOracle(mhEmpId, 2026, 5);
      expect(oracle.closed).toBe(false);
      const row = await monthlyReportRow(mhEmpId, 2026, 5);
      expect(row.workedHours).toBe(Math.round((oracle.workedMinutes / 60) * 100) / 100);
      expect(row.shouldHours).toBe(Math.round((oracle.expectedMinutes / 60) * 100) / 100);
      expect(row.overtimeHours).toBe(Math.round((oracle.balanceMinutes / 60) * 100) / 100);
      expect(row.overtimeConfirmed).toBe(false);
      expectConsistent(row);
    });

    it("June 2026 (running): shouldHours equals GET /overtime/month-saldo's own monthSollMinutes / 60", async () => {
      const oracle = await monthSaldoOracle(mhEmpId, 2026, 6);
      expect(oracle.monthSollMinutes).toBeDefined();
      const row = await monthlyReportRow(mhEmpId, 2026, 6);
      expect(row.shouldHours).toBe(Math.round((oracle.monthSollMinutes! / 60) * 100) / 100);
      expect(row.overtimeConfirmed).toBe(false);
      expectConsistent(row);
    });
  });

  describe("SHIFT_BASED", () => {
    it("April 2026 (closed): JSON row and single-PDF payload equal the SaldoSnapshot", async () => {
      const oracle = await monthSaldoOracle(shiftEmpId, 2026, 4);
      expect(oracle.closed).toBe(true);
      const row = await monthlyReportRow(shiftEmpId, 2026, 4);
      expect(row.workedHours).toBe(Math.round((oracle.workedMinutes / 60) * 100) / 100);
      expect(row.shouldHours).toBe(Math.round((oracle.expectedMinutes / 60) * 100) / 100);
      expect(row.overtimeHours).toBe(Math.round((oracle.balanceMinutes / 60) * 100) / 100);
      expect(row.overtimeConfirmed).toBe(true);
      expectConsistent(row);

      const payload = await pdfPayloadFor(shiftEmpId, 2026, 4);
      expect(payload.workedHours).toBe(row.workedHours);
      expect(payload.targetHours).toBe(row.shouldHours);
      expect(payload.overtimeHours).toBe(row.overtimeHours);
      expect(payload.overtimeConfirmed).toBe(true);
    });

    it("May 2026 (open, fully elapsed): JSON row equals GET /overtime/month-saldo (header)", async () => {
      const oracle = await monthSaldoOracle(shiftEmpId, 2026, 5);
      expect(oracle.closed).toBe(false);
      const row = await monthlyReportRow(shiftEmpId, 2026, 5);
      expect(row.workedHours).toBe(Math.round((oracle.workedMinutes / 60) * 100) / 100);
      expect(row.shouldHours).toBe(Math.round((oracle.expectedMinutes / 60) * 100) / 100);
      expect(row.overtimeHours).toBe(Math.round((oracle.balanceMinutes / 60) * 100) / 100);
      expect(row.overtimeConfirmed).toBe(false);
      expectConsistent(row);
    });

    it("June 2026 (running): JSON row equals GET /overtime/month-saldo's to-date header — never the full, not-yet-worked roster", async () => {
      const oracle = await monthSaldoOracle(shiftEmpId, 2026, 6);
      expect(oracle.closed).toBe(false);
      const row = await monthlyReportRow(shiftEmpId, 2026, 6);
      expect(row.workedHours).toBe(Math.round((oracle.workedMinutes / 60) * 100) / 100);
      expect(row.shouldHours).toBe(Math.round((oracle.expectedMinutes / 60) * 100) / 100);
      expect(row.overtimeHours).toBe(Math.round((oracle.balanceMinutes / 60) * 100) / 100);
      expect(row.overtimeConfirmed).toBe(false);
      expectConsistent(row);
    });
  });
});
