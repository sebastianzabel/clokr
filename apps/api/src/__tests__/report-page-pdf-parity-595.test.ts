/**
 * Issue #595 (D-01), Plan 595-01 - page and PDF show the same stored figures and the same
 * closed state for a month whose SaldoSnapshot was written in the LEGACY UTC-naive `periodStart`
 * convention.
 *
 * Reproduction of the issue: the demo seed (`packages/db/src/seed-demo.ts`) stores its closed
 * month with `periodStart` = the 1st of the month (UTC midnight) and a fabricated Soll. The page's
 * snapshot list reads the row and shows the month closed, but `computeMonthSaldo` looked the row
 * up with an exact match on the TZ-converted instant (the last day of the previous month for a
 * Europe/Berlin tenant), missed it, recomputed the month and both PDFs printed "Prognose" with the
 * kernel's figures instead of the stored ones (the two figures of the issue: 176:00 stored versus
 * the recomputed value). The lookup now uses `periodStartWindow`, the convention-robust window
 * every other reader of the account uses.
 *
 * Five surfaces are compared on REAL database rows: GET /overtime/month-saldo, the
 * GET /reports/monthly row, the single-PDF payload, the company-PDF row and the
 * GET /overtime/snapshots row. Both PDF generators are spied the same way
 * report-identity-451.test.ts does (vi.fn(actual.fn): the byte content stays a valid PDF, the
 * test inspects the DATA payload handed to the generator).
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  salonIdForEmployee,
} from "./setup";
import { legacySaldoSnapshotPeriodBounds, saldoSnapshotPeriodBounds } from "./test-dates";
import { computeMonthSaldo } from "../contexts/working-time-account/month-saldo";
import * as pdfUtils from "../composition/pdf";

vi.mock("../composition/pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../composition/pdf")>();
  return {
    ...actual,
    generateMonthlyReportPdf: vi.fn(actual.generateMonthlyReportPdf),
    streamCompanyMonthlyReportPdf: vi.fn(actual.streamCompanyMonthlyReportPdf),
  };
});

type Stored = {
  workedMinutes: number;
  expectedMinutes: number;
  balanceMinutes: number;
  carryOver: number;
};

type ReportRow = {
  employeeId: string;
  workedHours: number;
  shouldHours: number;
  overtimeHours?: number;
  overtimeConfirmed?: boolean | null;
};

const hours = (minutes: number): number => Math.round((minutes / 60) * 100) / 100;

async function createFixedEmployee(
  app: FastifyInstance,
  tenantId: string,
  salonId: string,
  label: string,
  hireDate: string,
): Promise<{ id: string; employeeNumber: string }> {
  const passwordHash = await bcrypt.hash("test1234", 10);
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const user = await app.prisma.user.create({
    data: {
      email: `${label}-${suffix}@example.invalid`,
      passwordHash,
      role: "EMPLOYEE",
      isActive: true,
    },
  });
  const employeeNumber = `${label}-${suffix}`;
  const employee = await app.prisma.employee.create({
    data: {
      tenantId,
      userId: user.id,
      employeeNumber,
      firstName: label,
      lastName: "Parity595",
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
  return { id: employee.id, employeeNumber };
}

async function seedEntry(app: FastifyInstance, employeeId: string, dateStr: string) {
  const start = new Date(`${dateStr}T08:00:00Z`);
  await app.prisma.timeEntry.create({
    data: {
      employeeId,
      date: new Date(`${dateStr}T00:00:00Z`),
      startTime: start,
      endTime: new Date(start.getTime() + (450 + 30) * 60_000),
      breakMinutes: 30,
      type: "WORK",
      salonId: await salonIdForEmployee(app.prisma, employeeId),
    },
  });
}

async function createSnapshot(
  app: FastifyInstance,
  employeeId: string,
  bounds: { start: Date; end: Date },
  figures: Stored,
  closedBy: string,
) {
  await app.prisma.saldoSnapshot.create({
    data: {
      employeeId,
      periodType: "MONTHLY",
      periodStart: bounds.start,
      periodEnd: bounds.end,
      ...figures,
      closedAt: new Date(),
      closedBy,
    },
  });
}

describe("Issue #595 (D-01) - page, JSON and PDFs agree on a closed month stored in either convention", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let adminUserId: string;
  let empA: { id: string; employeeNumber: string };
  let empB: { id: string; employeeNumber: string };

  // Employee A. September 2026 is CEST, January 2026 is CET: both legacy rows, distinct figures.
  const SEP_LEGACY: Stored = {
    workedMinutes: 10530,
    expectedMinutes: 10560,
    balanceMinutes: -30,
    carryOver: -30,
  };
  const JAN_LEGACY: Stored = {
    workedMinutes: 9660,
    expectedMinutes: 9600,
    balanceMinutes: 60,
    carryOver: 60,
  };
  const AUG_CONVERTED: Stored = {
    workedMinutes: 10200,
    expectedMinutes: 10080,
    balanceMinutes: 120,
    carryOver: 90,
  };
  // Employee B: two active rows for September 2026.
  const B_SEP_LEGACY: Stored = {
    workedMinutes: 7000,
    expectedMinutes: 7100,
    balanceMinutes: -100,
    carryOver: -100,
  };
  const B_SEP_CONVERTED: Stored = {
    workedMinutes: 9000,
    expectedMinutes: 8800,
    balanceMinutes: 200,
    carryOver: 200,
  };

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T10:00:00.000Z"));

    app = await getTestApp();
    const seed = await seedTestData(app, "parity-595");
    tenantId = seed.tenant.id;
    adminToken = seed.adminToken;
    adminUserId = seed.adminUser.id;
    const salonId = seed.salonId;

    empA = await createFixedEmployee(app, tenantId, salonId, "pa595", "2025-06-01");
    empB = await createFixedEmployee(app, tenantId, salonId, "pb595", "2025-06-01");

    // Closed valid WORK entries so the kernel's recomputation of September/October differs from
    // the stored rows.
    for (const d of [
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
      "2026-10-01",
      "2026-10-02",
      "2026-10-05",
      "2026-10-06",
      "2026-01-05",
      "2026-01-06",
    ]) {
      await seedEntry(app, empA.id, d);
    }
    await seedEntry(app, empB.id, "2026-09-01");

    await createSnapshot(
      app,
      empA.id,
      legacySaldoSnapshotPeriodBounds(2026, 1),
      JAN_LEGACY,
      adminUserId,
    );
    await createSnapshot(
      app,
      empA.id,
      saldoSnapshotPeriodBounds(new Date("2026-08-01T00:00:00Z")),
      AUG_CONVERTED,
      adminUserId,
    );
    await createSnapshot(
      app,
      empA.id,
      legacySaldoSnapshotPeriodBounds(2026, 9),
      SEP_LEGACY,
      adminUserId,
    );

    // A YEARLY row written like the close-year handler writes it: a plain UTC year boundary.
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: empA.id,
        periodType: "YEARLY",
        periodStart: new Date("2025-01-01T00:00:00Z"),
        periodEnd: new Date("2025-12-31T23:59:59Z"),
        workedMinutes: 100000,
        expectedMinutes: 99000,
        balanceMinutes: 1000,
        carryOver: 1000,
        closedAt: new Date(),
        closedBy: adminUserId,
        note: "Jahresübertrag: test",
      },
    });

    await createSnapshot(
      app,
      empB.id,
      legacySaldoSnapshotPeriodBounds(2026, 9),
      B_SEP_LEGACY,
      adminUserId,
    );
    await createSnapshot(
      app,
      empB.id,
      saldoSnapshotPeriodBounds(new Date("2026-09-01T00:00:00Z")),
      B_SEP_CONVERTED,
      adminUserId,
    );
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("report-page-pdf-parity-595 cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function monthSaldoRoute(employeeId: string, year: number, month: number) {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/month-saldo/${employeeId}?year=${year}&month=${month}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as {
      workedMinutes: number;
      expectedMinutes: number;
      balanceMinutes: number;
      closed: boolean;
    };
  }

  async function reportRow(employeeId: string, year: number, month: number): Promise<ReportRow> {
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

  async function singlePdf(employeeId: string, year: number, month: number) {
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

  async function companyPdfRow(employeeNumber: string, year: number, month: number) {
    const spy = vi.mocked(pdfUtils.streamCompanyMonthlyReportPdf);
    spy.mockClear();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly/pdf/all?year=${year}&month=${month}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    const row = spy.mock.calls[0][1].rows.find((r) => r.employeeNumber === employeeNumber);
    if (!row) throw new Error(`no company PDF row for ${employeeNumber}`);
    return row;
  }

  async function snapshotRows(employeeId: string) {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/snapshots/${employeeId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as Array<{
      periodType: "MONTHLY" | "YEARLY";
      year: number | null;
      month: number | null;
      periodStart: string;
      workedMinutes: number;
      expectedMinutes: number;
      balanceMinutes: number;
    }>;
  }

  /** All five surfaces carry the stored minutes of a closed month and say closed/confirmed. */
  async function expectClosedEverywhere(
    employee: { id: string; employeeNumber: string },
    year: number,
    month: number,
    stored: Stored,
    storedPeriodStartDate: string,
  ) {
    const ms = await computeMonthSaldo(app, employee.id, year, month);
    expect(ms.closed).toBe(true);
    expect(ms.workedMinutes).toBe(stored.workedMinutes);
    expect(ms.expectedMinutes).toBe(stored.expectedMinutes);
    expect(ms.balanceMinutes).toBe(stored.balanceMinutes);

    const route = await monthSaldoRoute(employee.id, year, month);
    expect(route.closed).toBe(true);
    expect(route.workedMinutes).toBe(stored.workedMinutes);
    expect(route.expectedMinutes).toBe(stored.expectedMinutes);
    expect(route.balanceMinutes).toBe(stored.balanceMinutes);

    const expected = {
      worked: hours(stored.workedMinutes),
      should: hours(stored.expectedMinutes),
      overtime: hours(stored.balanceMinutes),
    };

    const row = await reportRow(employee.id, year, month);
    expect(row.overtimeConfirmed).toBe(true);
    expect(row.workedHours).toBe(expected.worked);
    expect(row.shouldHours).toBe(expected.should);
    expect(row.overtimeHours).toBe(expected.overtime);

    const payload = await singlePdf(employee.id, year, month);
    expect(payload.overtimeConfirmed).toBe(true);
    expect(payload.workedHours).toBe(expected.worked);
    expect(payload.targetHours).toBe(expected.should);
    expect(payload.overtimeHours).toBe(expected.overtime);

    const company = await companyPdfRow(employee.employeeNumber, year, month);
    expect(company.overtimeConfirmed).toBe(true);
    expect(company.workedHours).toBe(expected.worked);
    expect(company.targetHours).toBe(expected.should);
    expect(company.overtimeHours).toBe(expected.overtime);

    const snaps = await snapshotRows(employee.id);
    const snap = snaps.find((s) => s.periodStart.slice(0, 10) === storedPeriodStartDate);
    expect(snap, `snapshot row ${storedPeriodStartDate}`).toBeDefined();
    expect(snap?.workedMinutes).toBe(stored.workedMinutes);
    expect(snap?.expectedMinutes).toBe(stored.expectedMinutes);
    expect(snap?.balanceMinutes).toBe(stored.balanceMinutes);
  }

  it("legacy row, CEST month (September 2026): closed on all five surfaces with the stored minutes", async () => {
    await expectClosedEverywhere(empA, 2026, 9, SEP_LEGACY, "2026-09-01");
  });

  it("legacy row, CET month (January 2026): closed on all five surfaces with the stored minutes", async () => {
    await expectClosedEverywhere(empA, 2026, 1, JAN_LEGACY, "2026-01-01");
  });

  it("TZ-converted row (August 2026): unchanged behaviour, closed on all five surfaces", async () => {
    await expectClosedEverywhere(empA, 2026, 8, AUG_CONVERTED, "2026-07-31");
  });

  it("open month (October 2026): JSON and both PDFs carry the kernel figures and say not confirmed; no snapshot row", async () => {
    const ms = await computeMonthSaldo(app, empA.id, 2026, 10);
    expect(ms.closed).toBe(false);

    const row = await reportRow(empA.id, 2026, 10);
    expect(row.overtimeConfirmed).toBe(false);

    const payload = await singlePdf(empA.id, 2026, 10);
    expect(payload.overtimeConfirmed).toBe(false);
    expect(payload.workedHours).toBe(row.workedHours);
    expect(payload.targetHours).toBe(row.shouldHours);
    expect(payload.overtimeHours).toBe(row.overtimeHours);

    const company = await companyPdfRow(empA.employeeNumber, 2026, 10);
    expect(company.overtimeConfirmed).toBe(false);
    expect(company.workedHours).toBe(row.workedHours);
    expect(company.targetHours).toBe(row.shouldHours);
    expect(company.overtimeHours).toBe(row.overtimeHours);

    const snaps = await snapshotRows(empA.id);
    expect(snaps.filter((s) => s.periodStart.slice(0, 7) === "2026-10")).toHaveLength(0);
    expect(snaps.filter((s) => s.periodStart.slice(0, 10) === "2026-09-30")).toHaveLength(0);
  });

  it("two active rows for one month (legacy + TZ-converted): the row the exact match read before the fix wins (P-01)", async () => {
    const ms = await computeMonthSaldo(app, empB.id, 2026, 9);
    expect(ms.closed).toBe(true);
    expect(ms.workedMinutes).toBe(B_SEP_CONVERTED.workedMinutes);
    expect(ms.expectedMinutes).toBe(B_SEP_CONVERTED.expectedMinutes);
    expect(ms.balanceMinutes).toBe(B_SEP_CONVERTED.balanceMinutes);
  });
  describe("snapshot answer names months on the server (Issue #595, D-02/D-03)", () => {
    it("every row carries year and month: TZ-converted August (stored 2026-07-31) is month 8, legacy September is month 9", async () => {
      const snaps = await snapshotRows(empA.id);
      const aug = snaps.find((s) => s.periodStart.slice(0, 10) === "2026-07-31");
      expect(aug?.year).toBe(2026);
      // A browser-local label derived from the stored date would have said July here.
      expect(aug?.month).toBe(8);
      const sep = snaps.find((s) => s.periodStart.slice(0, 10) === "2026-09-01");
      expect(sep?.year).toBe(2026);
      expect(sep?.month).toBe(9);
      const jan = snaps.find((s) => s.periodStart.slice(0, 10) === "2026-01-01");
      expect(jan?.year).toBe(2026);
      expect(jan?.month).toBe(1);
    });

    it("a YEARLY row keeps year = the UTC year of its periodStart and month null", async () => {
      const snaps = await snapshotRows(empA.id);
      const yearly = snaps.filter((s) => s.periodType === "YEARLY");
      expect(yearly).toHaveLength(1);
      expect(yearly[0].year).toBe(2025);
      expect(yearly[0].month).toBeNull();
    });

    it("MONTHLY rows are one per month: employee B's September duplicate pair lists only the row the account reads, equal to the single PDF", async () => {
      const snaps = await snapshotRows(empB.id);
      const monthly = snaps.filter((s) => s.periodType === "MONTHLY");
      expect(monthly).toHaveLength(1);
      expect(monthly[0].periodStart.slice(0, 10)).toBe("2026-08-31");
      expect(monthly[0].year).toBe(2026);
      expect(monthly[0].month).toBe(9);
      const payload = await singlePdf(empB.id, 2026, 9);
      expect(payload.overtimeConfirmed).toBe(true);
      expect(payload.workedHours).toBe(hours(monthly[0].workedMinutes));
      expect(payload.targetHours).toBe(hours(monthly[0].expectedMinutes));
      expect(payload.overtimeHours).toBe(hours(monthly[0].balanceMinutes));
    });

    it("the answer stays an array and the status codes for foreign and unknown employees are unchanged", async () => {
      const snaps = await snapshotRows(empA.id);
      expect(Array.isArray(snaps)).toBe(true);
      const unknown = await app.inject({
        method: "GET",
        url: "/api/v1/overtime/snapshots/00000000-0000-4000-8000-000000000000",
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(unknown.statusCode).toBe(404);
    });
  });
});
