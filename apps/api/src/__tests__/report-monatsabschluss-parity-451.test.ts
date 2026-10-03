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
