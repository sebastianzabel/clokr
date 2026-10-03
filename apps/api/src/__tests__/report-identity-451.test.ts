/**
 * Issue #451 (D-03), Plan 451-04 Task 2 — the page identity `Ist − Soll + Verrechnung =
 * Überstunden` for the two populations where the working-time-account's reconciliation item
 * (`balanceAdjustmentHours`) is non-zero: an approved Überstundenausgleich (OVERTIME_COMP) day,
 * and a SHIFT_BASED month worked below the roster. Plus the zero case (FIXED without
 * Überstundenausgleich), which must satisfy the simpler `Ist − Soll == Überstunden` exactly.
 *
 * Fake clock 2026-06-15T10:00:00Z (own tenant, NIEDERSACHSEN default salon), same construction
 * as report-monatsabschluss-parity-451.test.ts (451-03) — May 2026 is a fully elapsed, still-OPEN
 * month, so the JSON row's `fullMonth` figures and the closed-month SaldoSnapshot (after
 * POST /overtime/close-month) can both be exercised against the SAME fixture.
 *
 * This file builds its OWN tenant + employee fixtures rather than importing the sibling
 * report-monatsabschluss-parity-451.test.ts's local (non-exported) helpers — same reasoning
 * leave-overtime-comp-tolerance.test.ts's header gives for not reusing a sibling fixture.
 *
 * Both monthly PDF generators are spied the same way 451-03 did (vi.fn(actual.fn) wraps the REAL
 * generator so the byte content stays a valid PDF — RESEARCH.md's "never byte-search a PDF"
 * pitfall — while the test inspects the DATA payload handed to it).
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
import { leaveTypeFields } from "../contexts/absence/leave-type";
import * as pdfUtils from "../composition/pdf";

vi.mock("../composition/pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../composition/pdf")>();
  return {
    ...actual,
    generateMonthlyReportPdf: vi.fn(actual.generateMonthlyReportPdf),
    streamCompanyMonthlyReportPdf: vi.fn(actual.streamCompanyMonthlyReportPdf),
  };
});

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
      lastName: "Identity451",
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
      lastName: "Identity451Shift",
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
      // Issue #451 (D-03) — placeholders, NOT authoritative for SHIFT_BASED (see CLAUDE.md).
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

async function seedEntryFor(
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

/**
 * Issue #451 (D-03), Task 2 action 1 — the OVERTIME_COMP fixture, inserted directly via Prisma
 * (the plan's own documented fallback: "if the API path is impractical, insert the APPROVED
 * OVERTIME_COMP LeaveRequest via Prisma with `days` = 1 for its single date — consistent with its
 * range"). `days` covers exactly the one date, matching startDate == endDate.
 */
async function seedApprovedOvertimeCompDay(
  app: FastifyInstance,
  tenantId: string,
  employeeId: string,
  adminUserId: string,
  dateStr: string,
) {
  const leaveType = await app.prisma.leaveType.create({
    data: { tenantId, ...leaveTypeFields("OVERTIME_COMP"), color: "#9333ea" },
  });
  await app.prisma.leaveRequest.create({
    data: {
      employeeId,
      leaveTypeId: leaveType.id,
      startDate: new Date(`${dateStr}T00:00:00Z`),
      endDate: new Date(`${dateStr}T00:00:00Z`),
      days: 1,
      status: "APPROVED",
      reviewedBy: adminUserId,
      reviewedAt: new Date(),
    },
  });
}

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

/** All Mon-Fri dates of 2026-05 as "YYYY-MM-DD" (21 weekdays; NI holidays 01./14./25.05. fall on
 *  three of them, leaving 18 contract workdays — same construction as 451-03's test file). */
const MAY_2026_MON_FRI: string[] = [];
for (let d = 1; d <= 31; d++) {
  const dateStr = `2026-05-${String(d).padStart(2, "0")}`;
  const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  if (dow >= 1 && dow <= 5) MAY_2026_MON_FRI.push(dateStr);
}
const MAY_2026_HOLIDAYS = new Set(["2026-05-01", "2026-05-14", "2026-05-25"]);
const AUSGLEICHSTAG = "2026-05-04"; // Monday, 8h contract day, not a holiday

/** All Mon-Fri dates of 2026-04 — needed only to close April first (hireDate 2026-04-01's
 *  sequential-close guard demands a closed prior month before May can close). NI holidays
 *  Karfreitag 03.04. and Ostermontag 06.04. leave 20 contract workdays. */
const APRIL_2026_MON_FRI: string[] = [];
for (let d = 1; d <= 30; d++) {
  const dateStr = `2026-04-${String(d).padStart(2, "0")}`;
  const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  if (dow >= 1 && dow <= 5) APRIL_2026_MON_FRI.push(dateStr);
}
const APRIL_2026_HOLIDAYS = new Set(["2026-04-03", "2026-04-06"]);

type Oracle = {
  workedMinutes: number;
  expectedMinutes: number;
  balanceMinutes: number;
  closed: boolean;
};
type ReportRow = {
  employeeId: string;
  workedHours: number;
  shouldHours: number;
  overtimeHours?: number;
  overtimeConfirmed?: boolean | null;
  balanceAdjustmentHours?: number;
};

async function monthSaldoOracle(
  app: FastifyInstance,
  adminToken: string,
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

async function monthlyReportRow(
  app: FastifyInstance,
  adminToken: string,
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

async function singlePdfPayload(
  app: FastifyInstance,
  adminToken: string,
  employeeId: string,
  year: number,
  month: number,
) {
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

async function companyPdfRow(
  app: FastifyInstance,
  adminToken: string,
  employeeNumberNeedle: string,
  year: number,
  month: number,
) {
  const spy = vi.mocked(pdfUtils.streamCompanyMonthlyReportPdf);
  spy.mockClear();
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/reports/monthly/pdf/all?year=${year}&month=${month}`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  expect(res.statusCode).toBe(200);
  expect(spy).toHaveBeenCalledTimes(1);
  const companyData = spy.mock.calls[0][1];
  const row = companyData.rows.find((r) => r.employeeNumber.includes(employeeNumberNeedle));
  if (!row) throw new Error(`no company PDF row matching ${employeeNumberNeedle}`);
  return row;
}

// D-03's own consistency identity: Ist − Soll + Verrechnung == Überstunden, in hundredths.
function expectIdentity(row: {
  workedHours: number;
  shouldHours: number;
  overtimeHours?: number;
  balanceAdjustmentHours?: number;
}) {
  const diff =
    row.workedHours -
    row.shouldHours +
    (row.balanceAdjustmentHours ?? 0) -
    (row.overtimeHours ?? 0);
  expect(Math.abs(diff), `identity for row ${JSON.stringify(row)}`).toBeLessThan(0.005);
}

describe("Issue #451 (D-03) — page identity Ist - Soll + Verrechnung = Ueberstunden", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let salonId: string;
  let adminToken: string;
  let adminUserId: string;

  let fixedCompEmpId: string; // Case 1/2: FIXED with an approved Ueberstundenausgleich day
  let shiftEmpId: string; // Case 3: SHIFT_BASED worked below roster
  let fixedPlainEmpId: string; // Case 4: FIXED without Ueberstundenausgleich

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T10:00:00.000Z"));

    app = await getTestApp();
    const seed = await seedTestData(app, "ri451", { withDefaultSalon: false });
    tenantId = seed.tenant.id;
    adminToken = seed.adminToken;

    const salon = await createTestSalon(app.prisma, tenantId, { federalState: "NIEDERSACHSEN" });
    salonId = salon.id;

    const adminEmployee = await app.prisma.employee.findFirst({
      where: { tenantId, user: { role: "ADMIN" } },
      select: { userId: true },
    });
    adminUserId = adminEmployee?.userId ?? "";

    // ── Case 1/2: FIXED 40h, every other May workday fully worked (8h/day), one approved
    // OVERTIME_COMP day on AUSGLEICHSTAG. "Every other workday" = 18 contract workdays minus the
    // one Ausgleichstag = 17 worked days.
    const fixedCompEmp = await createFixedEmployee(app, tenantId, salonId, "ri451fc", "2026-04-01");
    fixedCompEmpId = fixedCompEmp.id;
    // April must be fully covered and closed first (sequential-close guard, hireDate 2026-04-01
    // leaves April as the first month) before the second test below can close May.
    for (const dateStr of APRIL_2026_MON_FRI) {
      if (APRIL_2026_HOLIDAYS.has(dateStr)) continue;
      await seedEntryFor(app, fixedCompEmpId, dateStr, "08:00", 480, 30);
    }
    const closeAprilRes = await closeMonth(app, adminToken, fixedCompEmpId, 2026, 4);
    if (closeAprilRes.statusCode !== 201) {
      throw new Error(`fixture setup: close April 2026 failed: ${closeAprilRes.body}`);
    }
    for (const dateStr of MAY_2026_MON_FRI) {
      if (MAY_2026_HOLIDAYS.has(dateStr) || dateStr === AUSGLEICHSTAG) continue;
      await seedEntryFor(app, fixedCompEmpId, dateStr, "08:00", 480, 30);
    }
    await seedApprovedOvertimeCompDay(app, tenantId, fixedCompEmpId, adminUserId, AUSGLEICHSTAG);

    // ── Case 3: SHIFT_BASED, rostered Mon-Fri 8h (480min) but worked only 360min (6h) each day —
    // "rostered above the hours actually worked" (undertime against the roster, §615 BGB).
    const shiftEmp = await createShiftBasedEmployee(
      app,
      tenantId,
      salonId,
      "ri451sh",
      "2026-04-01",
    );
    shiftEmpId = shiftEmp.id;
    for (const dateStr of MAY_2026_MON_FRI) {
      await seedShift(app, shiftEmpId, dateStr, "08:00", 480);
      await seedEntryFor(app, shiftEmpId, dateStr, "08:00", 360);
    }

    // ── Case 4: FIXED 40h, every contract May workday fully worked, no Ueberstundenausgleich.
    const fixedPlainEmp = await createFixedEmployee(
      app,
      tenantId,
      salonId,
      "ri451fp",
      "2026-04-01",
    );
    fixedPlainEmpId = fixedPlainEmp.id;
    for (const dateStr of MAY_2026_MON_FRI) {
      if (MAY_2026_HOLIDAYS.has(dateStr)) continue;
      await seedEntryFor(app, fixedPlainEmpId, dateStr, "08:00", 480, 30);
    }
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("report-identity-451 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("FIXED + approved OVERTIME_COMP day (open month): balanceAdjustmentHours == -8.00 and the identity holds in JSON + both PDF payloads", async () => {
    const row = await monthlyReportRow(app, adminToken, fixedCompEmpId, 2026, 5);
    expect(row.overtimeConfirmed).toBe(false); // May is open at fake-clock time
    expect(row.balanceAdjustmentHours).toBe(-8);
    expectIdentity(row);

    const pdfPayload = await singlePdfPayload(app, adminToken, fixedCompEmpId, 2026, 5);
    expect(pdfPayload.balanceAdjustmentHours).toBe(-8);
    expect(pdfPayload.workedHours).toBe(row.workedHours);
    expect(pdfPayload.targetHours).toBe(row.shouldHours);
    expect(pdfPayload.overtimeHours).toBe(row.overtimeHours);

    const companyRow = await companyPdfRow(app, adminToken, "ri451fc", 2026, 5);
    expect(companyRow.balanceAdjustmentHours).toBe(-8);
    expect(companyRow.workedHours).toBe(row.workedHours);
    expect(companyRow.targetHours).toBe(row.shouldHours);
    expect(companyRow.overtimeHours).toBe(row.overtimeHours);
  });

  it("FIXED + approved OVERTIME_COMP day, after POST /overtime/close-month: the closed figures (overtimeConfirmed true) still satisfy the identity", async () => {
    const closeRes = await closeMonth(app, adminToken, fixedCompEmpId, 2026, 5);
    expect(closeRes.statusCode, closeRes.body).toBe(201);

    const oracle = await monthSaldoOracle(app, adminToken, fixedCompEmpId, 2026, 5);
    expect(oracle.closed).toBe(true);

    const row = await monthlyReportRow(app, adminToken, fixedCompEmpId, 2026, 5);
    expect(row.overtimeConfirmed).toBe(true);
    expect(row.workedHours).toBe(Math.round((oracle.workedMinutes / 60) * 100) / 100);
    expect(row.shouldHours).toBe(Math.round((oracle.expectedMinutes / 60) * 100) / 100);
    expect(row.overtimeHours).toBe(Math.round((oracle.balanceMinutes / 60) * 100) / 100);
    expectIdentity(row);
  });

  it("SHIFT_BASED worked below the roster: balanceAdjustmentHours != 0, the identity holds, and overtimeHours equals GET /overtime/month-saldo balanceMinutes / 60", async () => {
    const oracle = await monthSaldoOracle(app, adminToken, shiftEmpId, 2026, 5);
    const row = await monthlyReportRow(app, adminToken, shiftEmpId, 2026, 5);

    expect(row.balanceAdjustmentHours).not.toBe(0);
    expect(row.overtimeHours).toBe(Math.round((oracle.balanceMinutes / 60) * 100) / 100);
    expectIdentity(row);
  });

  it("FIXED without Ueberstundenausgleich: balanceAdjustmentHours 0 and workedHours - shouldHours == overtimeHours", async () => {
    const row = await monthlyReportRow(app, adminToken, fixedPlainEmpId, 2026, 5);
    expect(row.balanceAdjustmentHours).toBe(0);
    expect(Math.abs(row.workedHours - row.shouldHours - (row.overtimeHours ?? 0))).toBeLessThan(
      0.005,
    );
    expectIdentity(row);
  });
});
