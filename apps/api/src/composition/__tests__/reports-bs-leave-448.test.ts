/**
 * Issue #448 (D-05, plan 03) — the monthly report, the DATEV export and the Monatsexport all
 * exclude Berufsschultage from VACATION day counts.
 *
 * Issue #617: the Urlaubsliste PDF (whose periods named the excluded dates) was removed, and with it
 * its per-period note and the "a SICK period carries no note" case. `generateMonthlyExportPdf` is
 * spied — PDFKit Flate-compresses its content streams, so the only way to assert on the payload the
 * route built is to capture the argument before it reaches PDFKit (see `reports-salon-scope.test.ts`'s
 * header comment on why a byte-content substring search on the PDF payload is proven vacuous).
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
import { DATEV_TAGE_SATZ_ID } from "../reports";

vi.mock("../pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pdf")>();
  return {
    ...actual,
    generateMonthlyExportPdf: vi.fn(actual.generateMonthlyExportPdf),
  };
});

describe("Issue #448 — Berichte, DATEV und Monatsexport zählen Berufsschultage nicht als Urlaub", () => {
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
    //
    // Issue #451 (D-01, fixture correction): `days` here must be the PRICED value (the absence
    // context already excludes a Berufsschultag from a VACATION request's count, #448) — this
    // row is created directly via Prisma (bypassing the API's own resolveLeaveDays pricing), so
    // it has to state that priced value itself. The DATEV export now reads this stored `days`
    // through leaveDaysByCodeWithin's fully-inside branch instead of re-deriving it from the
    // date range via its own BS-aware subtraction (removed), so a `days: 5` here — correct only
    // for a calendar count that ignores the BS day on 2027-03-09 — would make the DATEV line
    // disagree with GET /reports/monthly's independently-computed 4,
    // which both stay unaffected by this field (see their own call sites). `controlData`'s
    // request below has no BS day inside its range, so its calendar count and priced count
    // already agree at 5 — unchanged.
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        startDate: new Date("2027-03-08"),
        endDate: new Date("2027-03-12"),
        days: 4,
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
        l.startsWith(`${DATEV_TAGE_SATZ_ID};${data.employee.employeeNumber};`) &&
        l.includes(";300;"),
    );
    expect(vacationLine).toBeDefined();
    expect(vacationLine!.endsWith(";300;4,0")).toBe(true);

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
        l.startsWith(`${DATEV_TAGE_SATZ_ID};${controlData.employee.employeeNumber};`) &&
        l.includes(";300;"),
    );
    expect(controlVacationLine).toBeDefined();
    expect(controlVacationLine!.endsWith(";300;5,0")).toBe(true);
  });

  // Issue #617: the Urlaubsliste PDF was replaced by the Monatsexport; the Berufsschule exclusion
  // is asserted on the export's month Urlaub (the number the DATEV U line carries).
  it("Monatsexport: the Urlaub count of the month is one lower than the control employee's identical week", async () => {
    const spy = vi.mocked(pdfUtils.generateMonthlyExportPdf);
    spy.mockClear();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/reports/monthly-export/pdf?year=2027&month=3",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const row = spy.mock.calls[0][0].rows.find(
      (r) => r.employeeNumber === data.employee.employeeNumber,
    );
    expect(row).toBeDefined();
    expect(row!.absenceDays.vacation).toBe(4);

    spy.mockClear();
    const controlRes = await app.inject({
      method: "GET",
      url: "/api/v1/reports/monthly-export/pdf?year=2027&month=3",
      headers: { authorization: `Bearer ${controlData.adminToken}` },
    });
    expect(controlRes.statusCode).toBe(200);
    const controlRow = spy.mock.calls[0][0].rows.find(
      (r) => r.employeeNumber === controlData.employee.employeeNumber,
    );
    expect(controlRow).toBeDefined();
    expect(controlRow!.absenceDays.vacation).toBe(5);
  });

  it("GET /reports/monthly: a soft-deleted BS absence does not reduce vacationDays (WR-02)", async () => {
    // Isolated to April 2027 so this doesn't interact with the March fixtures above.
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        startDate: new Date("2027-04-05"),
        endDate: new Date("2027-04-09"),
        days: 5,
        status: "APPROVED",
      },
    });
    const softDeletedBs = await app.prisma.absence.create({
      data: {
        employeeId: data.employee.id,
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        startDate: new Date("2027-04-06T00:00:00.000Z"),
        endDate: new Date("2027-04-06T00:00:00.000Z"),
        days: 1,
        halfDay: false,
        createdBy: "system",
      },
    });
    await app.prisma.absence.update({
      where: { id: softDeletedBs.id },
      data: { deletedAt: new Date() },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly?employeeId=${data.employee.id}&year=2027&month=4`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Were the soft-deleted BS row counted, this would be 4 (one day displaced) — it must stay 5.
    expect(Number(body.rows[0].vacationDays)).toBe(5);
  });
});
