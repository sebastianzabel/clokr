/**
 * Issue #448 (D-05, plan 03) — the monthly report, the DATEV export and the Urlaubsliste PDF all
 * exclude Berufsschultage from VACATION day counts, with the PDF period naming the excluded dates.
 *
 * `streamLeaveListPdf` is spied the same way `reports.test.ts` already spies
 * `streamVacationOverviewPdf` — PDFKit Flate-compresses its content streams, so the only way to
 * assert on the `LeaveListData` the route built is to capture the argument before it reaches
 * PDFKit (see that file's and `reports-salon-scope.test.ts`'s own header comments on why a
 * byte-content substring search on the PDF payload is proven vacuous).
 *
 * Every date is a fixed 2027 calendar literal — 2027-03-08..12 is a Monday-Friday week with no
 * German statutory holiday (NIEDERSACHSEN, the seedTestData default federal state).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import iconv from "iconv-lite";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  seedEntitlementYears,
  cleanupTestData,
  configureDatevKanzlei,
} from "../../__tests__/setup";
import * as pdfUtils from "../pdf";
import { DATEV_BWD_SATZ_ID } from "../reports";

vi.mock("../pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pdf")>();
  return {
    ...actual,
    streamLeaveListPdf: vi.fn(actual.streamLeaveListPdf),
  };
});

describe("Issue #448 — Berichte, DATEV und Urlaubsliste zählen Berufsschultage nicht als Urlaub", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let controlData: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "rbs448");
    controlData = await seedTestData(app, "rbs448ctrl");
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { classification: "AZUBI", birthDate: new Date("2010-06-01") },
    });
    await seedEntitlementYears(app, {
      employeeId: data.employee.id,
      leaveTypeId: data.vacationType.id,
      years: [2027],
    });
    await seedEntitlementYears(app, {
      employeeId: controlData.employee.id,
      leaveTypeId: controlData.vacationType.id,
      years: [2027],
    });
    await configureDatevKanzlei(app, data.tenant.id);
    await configureDatevKanzlei(app, controlData.tenant.id);

    await app.prisma.absence.create({
      data: {
        employeeId: data.employee.id,
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        startDate: new Date("2027-03-09T00:00:00.000Z"),
        endDate: new Date("2027-03-09T00:00:00.000Z"),
        days: 1,
        halfDay: false,
        createdBy: "system",
      },
    });

    // Same Mo-Fr VACATION week for both employees — `data` has the BS row, `controlData` does
    // not, so the control employee's figures are the "without BS" baseline.
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        startDate: new Date("2027-03-08"),
        endDate: new Date("2027-03-12"),
        days: 5,
        status: "APPROVED",
      },
    });
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: controlData.employee.id,
        leaveTypeId: controlData.vacationType.id,
        startDate: new Date("2027-03-08"),
        endDate: new Date("2027-03-12"),
        days: 5,
        status: "APPROVED",
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, controlData.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("GET /reports/monthly: vacationDays is one lower than the control employee's (no BS row)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly?employeeId=${data.employee.id}&year=2027&month=3`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    const controlRes = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly?employeeId=${controlData.employee.id}&year=2027&month=3`,
      headers: { authorization: `Bearer ${controlData.adminToken}` },
    });
    expect(controlRes.statusCode).toBe(200);
    const controlBody = JSON.parse(controlRes.body);

    expect(Number(controlBody.rows[0].vacationDays)).toBe(5);
    expect(Number(body.rows[0].vacationDays)).toBe(4);
  });

  it("DATEV export: the Urlaub (U) line carries one day fewer than the control employee's identical week", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/reports/datev?year=2027&month=3",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = iconv.decode(res.rawPayload, "win1252");
    const lines = body.split(/\r\n/);
    const vacationLine = lines.find(
      (l) =>
        l.startsWith(`${DATEV_BWD_SATZ_ID};${data.employee.employeeNumber};`) &&
        l.includes(";U;300;"),
    );
    expect(vacationLine).toBeDefined();
    expect(vacationLine).toContain(";4,0;");

    const controlRes = await app.inject({
      method: "GET",
      url: "/api/v1/reports/datev?year=2027&month=3",
      headers: { authorization: `Bearer ${controlData.adminToken}` },
    });
    expect(controlRes.statusCode).toBe(200);
    const controlBody = iconv.decode(controlRes.rawPayload, "win1252");
    const controlLines = controlBody.split(/\r\n/);
    const controlVacationLine = controlLines.find(
      (l) =>
        l.startsWith(`${DATEV_BWD_SATZ_ID};${controlData.employee.employeeNumber};`) &&
        l.includes(";U;300;"),
    );
    expect(controlVacationLine).toBeDefined();
    expect(controlVacationLine).toContain(";5,0;");
  });

  it("Urlaubsliste PDF: the period's days is one lower and carries the BS note; the control employee's period is byte-identical to its day count with no note", async () => {
    const spy = vi.mocked(pdfUtils.streamLeaveListPdf);
    spy.mockClear();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/reports/leave-list/pdf?year=2027",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    const leaveListData = spy.mock.calls[0][1];
    const empData = leaveListData.employees.find(
      (e) => e.employeeNumber === data.employee.employeeNumber,
    );
    expect(empData).toBeDefined();
    expect(empData!.periods).toHaveLength(1);
    expect(empData!.periods[0].days).toBe(4);
    expect(empData!.periods[0].note).toBe("Berufsschule – kein Urlaub: 09.03.");

    spy.mockClear();
    const controlRes = await app.inject({
      method: "GET",
      url: "/api/v1/reports/leave-list/pdf?year=2027",
      headers: { authorization: `Bearer ${controlData.adminToken}` },
    });
    expect(controlRes.statusCode).toBe(200);
    const controlLeaveListData = spy.mock.calls[0][1];
    const controlEmpData = controlLeaveListData.employees.find(
      (e) => e.employeeNumber === controlData.employee.employeeNumber,
    );
    expect(controlEmpData).toBeDefined();
    expect(controlEmpData!.periods[0].days).toBe(5);
    expect(controlEmpData!.periods[0].note).toBeUndefined();
  });

  it("a SICK period over a BS day carries no note and the old count", async () => {
    const sickType = await app.prisma.leaveType.create({
      data: {
        tenantId: data.tenant.id,
        code: "SICK",
        name: "Krankheit",
        isPaid: true,
        requiresApproval: false,
        color: "#EF4444",
      },
    });
    // A fresh, non-overlapping BS date + SICK request (Issue #436 week-union is irrelevant to
    // SICK, but keeping the range isolated avoids any interaction with the VACATION fixture above).
    await app.prisma.absence.create({
      data: {
        employeeId: data.employee.id,
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        startDate: new Date("2027-03-16T00:00:00.000Z"),
        endDate: new Date("2027-03-16T00:00:00.000Z"),
        days: 1,
        halfDay: false,
        createdBy: "system",
      },
    });
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: sickType.id,
        startDate: new Date("2027-03-16"),
        endDate: new Date("2027-03-16"),
        days: 1,
        status: "APPROVED",
      },
    });

    const spy = vi.mocked(pdfUtils.streamLeaveListPdf);
    spy.mockClear();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/reports/leave-list/pdf?year=2027",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const leaveListData = spy.mock.calls[0][1];
    const empData = leaveListData.employees.find(
      (e) => e.employeeNumber === data.employee.employeeNumber,
    );
    const sickPeriod = empData!.periods.find((p) => p.leaveTypeName === "Krankheit");
    expect(sickPeriod).toBeDefined();
    expect(sickPeriod!.days).toBe(1);
    expect(sickPeriod!.note).toBeUndefined();
  });
});
