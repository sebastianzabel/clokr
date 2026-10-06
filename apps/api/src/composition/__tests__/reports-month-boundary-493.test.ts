/**
 * Issue #493 (R1/R2/R3, D-05) — the Monatsbericht lists and counts only the days of its own month.
 *
 * Before the fix the report handlers passed `monthRangeUtc` INSTANTS to `@db.Date` filters and to a
 * JS day clip. For a Europe/Berlin tenant the instant of local Oct 1 00:00 is 2026-09-30T22:00Z; a
 * Date parameter compared with a date column is evaluated at UTC-calendar-date precision, so the
 * previous month's last day (30.09.) was admitted — measured in prod (Monatsbericht/PDF/DATEV of
 * October listed 30.09.).
 *
 * Fixture seasons — all dates fixed, nothing is "now"-relative:
 *   summer  30.09. / 01.10.2026 (CEST, UTC+2)
 *   winter  31.01. / 01.02.2026 (CET, UTC+1)
 *   DST     28.02. / 01.03. and 31.03. / 01.04.2026 (CET→CEST switch on 29.03.2026)
 *
 * Employees:
 *   U   untracked MONTHLY_HOURS (monthlyHours null) — the Ist-without-Soll path of
 *       computeMonthReportFigures reads TimeEntry.date directly (F-10)
 *   U2  same shape, DST months
 *   T   the seeded FIXED employee with APPROVED SICK leave 28.09.-02.10.2026 and 28.01.-04.02.2026
 *   T3  FIXED employee with VACATION 28.09.-02.10.2026, SICK 29.09.-01.10.2026 and a CONFIRMED
 *       § 9 credit 29.09.-01.10.2026
 *
 * The values each assertion showed red on the unfixed tree are listed in the 493-02 SUMMARY.
 * PDF bytes are Flate-compressed, so the PDF generators are spied and their payload is asserted.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../__tests__/setup";
import { leaveTypeFields } from "../../contexts/absence/leave-type";
import * as pdfUtils from "../pdf";

vi.mock("../pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pdf")>();
  return {
    ...actual,
    generateMonthlyReportPdf: vi.fn(actual.generateMonthlyReportPdf),
    streamCompanyMonthlyReportPdf: vi.fn(actual.streamCompanyMonthlyReportPdf),
  };
});

describe("Issue #493 — Monatsbericht month boundaries", () => {
  let app: FastifyInstance;
  let d: Awaited<ReturnType<typeof seedTestData>>;
  let U = "";
  let U2 = "";
  let T3 = "";

  async function createUntracked(label: string): Promise<string> {
    const prisma = app.prisma;
    const passwordHash = await bcrypt.hash("test1234", 10);
    const suffix = `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await prisma.user.create({
      data: { email: `${suffix}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const employee = await prisma.employee.create({
      data: {
        tenantId: d.tenant.id,
        userId: user.id,
        employeeNumber: `N-${suffix}`,
        firstName: label,
        lastName: "Rmb493",
        hireDate: new Date("2025-01-01T00:00:00Z"),
      },
    });
    await prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        type: "MONTHLY_HOURS",
        monthlyHours: null,
        weeklyHours: null,
        mondayHours: 0,
        tuesdayHours: 0,
        wednesdayHours: 0,
        thursdayHours: 0,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4, 5],
        validFrom: new Date("2025-01-01T00:00:00Z"),
      } as never,
    });
    await prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
    return employee.id;
  }

  async function entry(employeeId: string, day: string, start: string, end: string) {
    await app.prisma.timeEntry.create({
      data: {
        employeeId,
        date: new Date(`${day}T00:00:00Z`),
        startTime: new Date(`${day}T${start}:00Z`),
        endTime: new Date(`${day}T${end}:00Z`),
        breakMinutes: 0,
        type: "WORK",
        source: "MANUAL",
        salonId: d.salonId,
      },
    });
  }

  async function sick(employeeId: string, leaveTypeId: string, from: string, to: string) {
    await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId,
        startDate: new Date(`${from}T00:00:00Z`),
        endDate: new Date(`${to}T00:00:00Z`),
        days: 1,
        status: "APPROVED",
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    d = await seedTestData(app, "rmb493");

    const cfg = await app.prisma.tenantConfig.findUnique({ where: { tenantId: d.tenant.id } });
    expect(cfg?.timezone ?? "Europe/Berlin").toBe("Europe/Berlin");

    U = await createUntracked("untracked");
    await entry(U, "2026-01-31", "19:00", "20:00");
    await entry(U, "2026-02-01", "09:00", "10:00");
    await entry(U, "2026-09-30", "19:44", "20:42");
    await entry(U, "2026-10-01", "06:00", "08:00");

    U2 = await createUntracked("dstmonths");
    await entry(U2, "2026-02-28", "10:00", "11:00");
    await entry(U2, "2026-03-01", "10:00", "11:00");
    await entry(U2, "2026-03-31", "10:00", "11:00");
    await entry(U2, "2026-04-01", "10:00", "11:00");

    const sickType = await app.prisma.leaveType.create({
      data: { tenantId: d.tenant.id, ...leaveTypeFields("SICK"), color: "#EF4444" },
    });
    await sick(d.employee.id, sickType.id, "2026-09-28", "2026-10-02");
    await sick(d.employee.id, sickType.id, "2026-01-28", "2026-02-04");

    // T3: FIXED Mo-Fr, VACATION 28.09.-02.10., SICK 29.09.-01.10. and a CONFIRMED § 9 credit for
    // the sick days (29.09.-01.10.) — the credit and the sick request both cross the month end.
    T3 = await createUntracked("section9");
    await app.prisma.workSchedule.updateMany({
      where: { employeeId: T3 },
      data: {
        type: "FIXED_SCHEDULE",
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
      },
    });
    const vac = await app.prisma.leaveRequest.create({
      data: {
        employeeId: T3,
        leaveTypeId: d.vacationType.id,
        startDate: new Date("2026-09-28T00:00:00Z"),
        endDate: new Date("2026-10-02T00:00:00Z"),
        days: 5,
        status: "APPROVED",
      },
    });
    const sick3 = await app.prisma.leaveRequest.create({
      data: {
        employeeId: T3,
        leaveTypeId: sickType.id,
        startDate: new Date("2026-09-29T00:00:00Z"),
        endDate: new Date("2026-10-01T00:00:00Z"),
        days: 3,
        status: "APPROVED",
      },
    });
    await app.prisma.section9Credit.create({
      data: {
        employeeId: T3,
        sickRequestId: sick3.id,
        vacationRequestId: vac.id,
        overlapStart: new Date("2026-09-29T00:00:00Z"),
        overlapEnd: new Date("2026-10-01T00:00:00Z"),
        status: "CONFIRMED",
        creditedStart: new Date("2026-09-29T00:00:00Z"),
        creditedEnd: new Date("2026-10-01T00:00:00Z"),
        creditedDays: 3,
        attestSource: "PAPIER",
        attestValidFrom: new Date("2026-09-29T00:00:00Z"),
        attestValidTo: new Date("2026-10-01T00:00:00Z"),
        reason: "Attest liegt vor (Testfixture Issue 493)",
        reviewedAt: new Date("2026-10-05T10:00:00Z"),
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, d.tenant.id);
    } catch (err) {
      console.error("reports-month-boundary-493 cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function singlePdf(employeeId: string, year: number, month: number) {
    const spy = vi.mocked(pdfUtils.generateMonthlyReportPdf);
    spy.mockClear();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly/pdf?employeeId=${employeeId}&year=${year}&month=${month}`,
      headers: { authorization: `Bearer ${d.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    return spy.mock.calls[0][0];
  }

  describe("single PDF — entry dates (untracked MONTHLY_HOURS employee)", () => {
    it.each([
      ["U", 2026, 10, ["01.10.2026"]],
      ["U", 2026, 9, ["30.09.2026"]],
      ["U", 2026, 2, ["01.02.2026"]],
      ["U", 2026, 1, ["31.01.2026"]],
      ["U2", 2026, 3, ["01.03.2026", "31.03.2026"]],
      ["U2", 2026, 4, ["01.04.2026"]],
      ["U2", 2026, 2, ["28.02.2026"]],
    ] as const)("%s %i-%i lists only its own month's days", async (who, year, month, expected) => {
      const payload = await singlePdf(who === "U" ? U : U2, year, month);
      expect(payload.entries.map((e) => e.date)).toEqual(expected);
    });
  });

  describe("single PDF — sick days of a leave crossing a month end (seeded employee T)", () => {
    it.each([
      [2026, 9, 3],
      [2026, 10, 2],
      [2026, 1, 4],
      [2026, 2, 4],
    ] as const)("%i-%i sickDays = %i", async (year, month, expected) => {
      const payload = await singlePdf(d.employee.id, year, month);
      expect(payload.sickDays).toBe(expected);
    });
  });
  async function monthlyRow(employeeId: string, year: number, month: number) {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly?employeeId=${employeeId}&year=${year}&month=${month}`,
      headers: { authorization: `Bearer ${d.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const row = JSON.parse(res.body).rows.find(
      (r: { employeeId: string }) => r.employeeId === employeeId,
    );
    expect(row).toBeDefined();
    return row as {
      workedHours: number;
      sickDays: number;
      sickDaysWithAttest: number;
      sickDaysWithoutAttest: number;
      section9DaysThisMonth: number;
    };
  }

  describe("GET /reports/monthly — untracked Ist (workedHours) reads the month's own entries", () => {
    it.each([
      ["U", 2026, 10, 2],
      ["U", 2026, 9, 0.97],
      ["U", 2026, 2, 1],
      ["U", 2026, 1, 1],
      ["U2", 2026, 3, 2],
      ["U2", 2026, 4, 1],
      ["U2", 2026, 2, 1],
    ] as const)("%s %i-%i workedHours = %d", async (who, year, month, expected) => {
      const row = await monthlyRow(who === "U" ? U : U2, year, month);
      expect(row.workedHours).toBe(expected);
    });

    it("single PDF payload.workedHours of U in October = 2", async () => {
      const payload = await singlePdf(U, 2026, 10);
      expect(payload.workedHours).toBe(2);
    });
  });

  describe("GET /reports/monthly — sick days of a leave crossing a month end (seeded employee T)", () => {
    it.each([
      [2026, 9, 3],
      [2026, 10, 2],
      [2026, 1, 4],
      [2026, 2, 4],
    ] as const)(
      "%i-%i sickDays = %i and equals with + without attest",
      async (year, month, expected) => {
        const row = await monthlyRow(d.employee.id, year, month);
        expect(row.sickDays).toBe(expected);
        expect(row.sickDays).toBe(row.sickDaysWithAttest + row.sickDaysWithoutAttest);
      },
    );
  });

  describe("GET /reports/monthly — § 9 credit crossing a month end (T3)", () => {
    it.each([
      [2026, 9, 2],
      [2026, 10, 1],
    ] as const)("%i-%i: section9DaysThisMonth and sickDays = %i", async (year, month, expected) => {
      const row = await monthlyRow(T3, year, month);
      expect(row.section9DaysThisMonth).toBe(expected);
      expect(row.sickDays).toBe(expected);
      expect(row.sickDays).toBe(row.sickDaysWithAttest + row.sickDaysWithoutAttest);
    });
  });

  describe("GET /reports/monthly/pdf/all — company PDF rows", () => {
    async function companyRows(year: number, month: number) {
      const spy = vi.mocked(pdfUtils.streamCompanyMonthlyReportPdf);
      spy.mockClear();
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/reports/monthly/pdf/all?year=${year}&month=${month}`,
        headers: { authorization: `Bearer ${d.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      return spy.mock.calls[0][1].rows;
    }

    it("October: U lists only 01.10.2026 and counts 2 h", async () => {
      const num = (await app.prisma.employee.findUniqueOrThrow({ where: { id: U } }))
        .employeeNumber;
      const row = (await companyRows(2026, 10)).find((r) => r.employeeNumber === num);
      expect(row).toBeDefined();
      expect(row!.entries.map((e) => e.date)).toEqual(["01.10.2026"]);
      expect(row!.workedHours).toBe(2);
    });

    it("September: T counts 3 sick days (not 4)", async () => {
      const row = (await companyRows(2026, 9)).find(
        (r) => r.employeeNumber === d.employee.employeeNumber,
      );
      expect(row).toBeDefined();
      expect(row!.sickDaysWithAttest + row!.sickDaysWithoutAttest).toBe(3);
    });
  });
});
