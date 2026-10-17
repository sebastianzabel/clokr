/**
 * Issue #617 (OD-617-1/2) - the Monatsexport: GET /api/v1/reports/monthly-export/pdf, the
 * human-readable twin of the DATEV export. Access, population (= the DATEV population of the same
 * month and scope), access and the audit row are proven by the top-level cases; every figure is pinned
 * to DATEV, `/reports/monthly` and `computeMonthReportFigures` in the nested describe.
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import iconv from "iconv-lite";
import bcrypt from "bcryptjs";
import { getTestApp, closeTestApp, cleanupTestData, soleAuditRow } from "./setup";
import {
  seedMonthlyExportFixture,
  FAKE_NOW,
  EXPORT_YEAR,
  EXPORT_MONTH,
  type MonthlyExportFixture,
} from "./monthly-export-fixture-617";
import { computeMonthReportFigures } from "../contexts/working-time-account";
import { SYSTEM_ROLE_IDS } from "../contexts/platform";
import * as pdfUtils from "../composition/pdf";

vi.mock("../composition/pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../composition/pdf")>();
  return {
    ...actual,
    generateMonthlyExportPdf: vi.fn(actual.generateMonthlyExportPdf),
  };
});

type ExportPayload = Parameters<typeof pdfUtils.generateMonthlyExportPdf>[0];

/** Parses the DATEV [Bewegungsdaten] lines of a file into rows. */
function parseDatev(
  text: string,
): Array<{ pnr: string; lna: number; hours: number; days: number }> {
  const body = text.split("[Bewegungsdaten]")[1] ?? "";
  const decimal = (value: string): number => (value === "" ? 0 : Number(value.replace(",", ".")));
  return body
    .split("\r\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const f = line.split(";");
      return { pnr: f[1], lna: Number(f[5]), hours: decimal(f[6]), days: decimal(f[7]) };
    });
}

describe("Issue #617 - Monatsexport", () => {
  let app: FastifyInstance;
  let fx: MonthlyExportFixture;
  let hrToken: string;

  const exportUrl = (qs = `year=${EXPORT_YEAR}&month=${EXPORT_MONTH}`) =>
    `/api/v1/reports/monthly-export/pdf?${qs}`;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FAKE_NOW);
    app = await getTestApp();
    fx = await seedMonthlyExportFixture(app, "tr617");

    // An HR principal: the shipped Personalabteilung template (report:read, never report:export).
    const hrEmail = `hr-tr617-${Date.now().toString(36)}@example.invalid`;
    const hrUser = await app.prisma.user.create({
      data: {
        email: hrEmail,
        passwordHash: await bcrypt.hash("test1234", 4),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    await app.prisma.employee.create({
      data: {
        tenantId: fx.tenantId,
        userId: hrUser.id,
        employeeNumber: "HR-617",
        firstName: "Hr",
        lastName: "P617hr",
        hireDate: new Date("2025-06-01T00:00:00Z"),
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: fx.tenantId,
        userId: hrUser.id,
        accessRoleId: SYSTEM_ROLE_IDS.HR,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: hrEmail, password: "test1234" },
    });
    expect(login.statusCode).toBe(200);
    hrToken = JSON.parse(login.body).accessToken;
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, fx.tenantId);
    } catch (err) {
      console.error("monthly-export-617 cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function get(token: string, url = exportUrl()) {
    return app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  }

  it("answers an ADMIN with an A4 PDF named after the month", async () => {
    const res = await get(fx.adminToken);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.rawPayload.subarray(0, 4).toString("latin1")).toBe("%PDF");
    expect(res.headers["content-disposition"]).toContain(
      `monatsexport-${EXPORT_YEAR}-${String(EXPORT_MONTH).padStart(2, "0")}.pdf`,
    );
  });

  it("lists exactly the persons of the DATEV file of the same month, in last-name order", async () => {
    const spy = vi.mocked(pdfUtils.generateMonthlyExportPdf);
    spy.mockClear();
    const res = await get(fx.adminToken);
    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    const data = spy.mock.calls[0][0] as ExportPayload;

    const datevRes = await app.inject({
      method: "GET",
      url: `/api/v1/reports/datev?year=${EXPORT_YEAR}&month=${EXPORT_MONTH}`,
      headers: { authorization: `Bearer ${fx.adminToken}` },
    });
    expect(datevRes.statusCode).toBe(200);
    const datevRows = parseDatev(iconv.decode(datevRes.rawPayload, "win1252"));
    const datevPnrs = [...new Set(datevRows.map((r) => r.pnr))];

    expect(datevPnrs.length).toBeGreaterThanOrEqual(9);
    expect(
      data.rows
        .map((r) => r.employeeNumber)
        .slice()
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual(datevPnrs.slice().sort((a, b) => a.localeCompare(b)));
    expect(data.rows.length).toBe(datevPnrs.length);

    const lastNames = data.rows.map((r) => r.employeeName);
    const sorted = lastNames.slice().sort((a, b) => a.localeCompare(b, "de"));
    expect(lastNames).toEqual(sorted);
  });

  it("carries the account's own time figures per row", async () => {
    const spy = vi.mocked(pdfUtils.generateMonthlyExportPdf);
    spy.mockClear();
    await get(fx.adminToken);
    const data = spy.mock.calls[0][0] as ExportPayload;
    const rowFor = (num: string) => data.rows.find((r) => r.employeeNumber === num);
    for (const person of Object.values(fx.people)) {
      const row = rowFor(person.employeeNumber);
      expect(row, person.employeeNumber).toBeDefined();
      const figures = await computeMonthReportFigures(app, person.id, EXPORT_YEAR, EXPORT_MONTH);
      expect(row!.workedMinutes).toBe(figures.workedMinutes);
      expect(row!.expectedMinutes).toBe(figures.expectedMinutes);
      expect(row!.balanceMinutes).toBe(figures.balanceMinutes);
      expect(row!.balanceAdjustmentMinutes).toBe(figures.balanceAdjustmentMinutes);
    }
  });

  it("takes the Urlaub count from the DATEV U-line of the person", async () => {
    const spy = vi.mocked(pdfUtils.generateMonthlyExportPdf);
    spy.mockClear();
    await get(fx.adminToken);
    const data = spy.mock.calls[0][0] as ExportPayload;
    const datevRes = await app.inject({
      method: "GET",
      url: `/api/v1/reports/datev?year=${EXPORT_YEAR}&month=${EXPORT_MONTH}`,
      headers: { authorization: `Bearer ${fx.adminToken}` },
    });
    const datevRows = parseDatev(iconv.decode(datevRes.rawPayload, "win1252"));
    const p3 = fx.people.p3;
    const datevUrlaub =
      datevRows.find((r) => r.pnr === p3.employeeNumber && r.lna === 300)?.days ?? 0;
    expect(datevUrlaub).toBeGreaterThan(0);
    expect(
      data.rows.find((r) => r.employeeNumber === p3.employeeNumber)!.absenceDays.vacation,
    ).toBe(datevUrlaub);
  });

  it("writes exactly one EXPORT audit row with type, period and person count", async () => {
    // August is requested by this test only, so the row is the sole one of its period.
    const res = await get(fx.adminToken, exportUrl(`year=${EXPORT_YEAR}&month=8`));
    expect(res.statusCode).toBe(200);
    const row = await soleAuditRow(app.prisma, {
      where: {
        action: "EXPORT",
        entity: "Report",
        userId: fx.adminUserId,
        AND: [
          { newValue: { path: ["type"], equals: "MONTHLY_EXPORT_PDF" } },
          { newValue: { path: ["month"], equals: 8 } },
        ],
      },
    });
    const nv = row.newValue as Record<string, unknown>;
    expect(nv.type).toBe("MONTHLY_EXPORT_PDF");
    expect(nv.year).toBe(EXPORT_YEAR);
    expect(nv.month).toBe(8);
    expect(nv.employeesIncluded).toBeGreaterThanOrEqual(9);
  });

  it("refuses a report:read principal (HR) and an EMPLOYEE with 403", async () => {
    expect((await get(hrToken)).statusCode).toBe(403);
    expect((await get(fx.seed.empToken)).statusCode).toBe(403);
  });

  it("rejects an invalid month with 400", async () => {
    const res = await get(fx.adminToken, exportUrl(`year=${EXPORT_YEAR}&month=13`));
    expect(res.statusCode).toBe(400);
  });

  describe("parity with DATEV and the monthly report", () => {
    // Lohnart numbers of the fixture tenant (TenantConfig defaults): the configurable ones are the
    // defaults 100/200/300/302, the rest are hardcoded in the DATEV export.
    const LNA = {
      sick: 200,
      sickChild: 201,
      vacation: 300,
      overtimeComp: 301,
      special: 302,
      education: 303,
      unpaid: 304,
      maternity: 310,
      parental: 320,
    } as const;
    const NORMAL_LNA = 100;
    const hours = (minutes: number): number => Math.round((minutes / 60) * 100) / 100;

    type MonthlyJsonRow = {
      employeeId: string;
      workedHours: number;
      shouldHours: number;
      overtimeHours: number;
      overtimeConfirmed: boolean | null;
      balanceAdjustmentHours: number;
      vacationDays: number;
    };

    async function exportRows(): Promise<ExportPayload["rows"]> {
      const spy = vi.mocked(pdfUtils.generateMonthlyExportPdf);
      spy.mockClear();
      const res = await get(fx.adminToken);
      expect(res.statusCode).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      return (spy.mock.calls[0][0] as ExportPayload).rows;
    }

    async function datev() {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/reports/datev?year=${EXPORT_YEAR}&month=${EXPORT_MONTH}`,
        headers: { authorization: `Bearer ${fx.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      return parseDatev(iconv.decode(res.rawPayload, "win1252"));
    }

    async function monthlyJsonRows(): Promise<Map<string, MonthlyJsonRow>> {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/reports/monthly?year=${EXPORT_YEAR}&month=${EXPORT_MONTH}`,
        headers: { authorization: `Bearer ${fx.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { rows: MonthlyJsonRow[] };
      return new Map(body.rows.map((row) => [row.employeeId, row]));
    }

    /** Every person of the tenant: the nine fixture persons and the two seed employees. */
    function everyone(): Array<{ id: string; employeeNumber: string }> {
      return [
        ...Object.values(fx.people),
        { id: fx.seed.adminEmployee.id, employeeNumber: fx.seed.adminEmployee.employeeNumber },
        { id: fx.seed.employee.id, employeeNumber: fx.seed.employee.employeeNumber },
      ];
    }

    it("pins every time figure to computeMonthReportFigures and to /reports/monthly", async () => {
      const rows = await exportRows();
      const json = await monthlyJsonRows();
      // the tenant also holds the HR principal's own employee row, so the export has at least these
      expect(rows.length).toBeGreaterThanOrEqual(everyone().length);
      for (const person of everyone()) {
        const row = rows.find((r) => r.employeeNumber === person.employeeNumber);
        expect(row, person.employeeNumber).toBeDefined();
        const figures = await computeMonthReportFigures(app, person.id, EXPORT_YEAR, EXPORT_MONTH);
        expect(row!.workedMinutes).toBe(figures.workedMinutes);
        expect(row!.expectedMinutes).toBe(figures.expectedMinutes);
        expect(row!.balanceMinutes).toBe(figures.balanceMinutes);
        expect(row!.balanceAdjustmentMinutes).toBe(figures.balanceAdjustmentMinutes);

        const jsonRow = json.get(person.id);
        expect(jsonRow, `${person.employeeNumber} in /reports/monthly`).toBeDefined();
        expect(hours(row!.workedMinutes)).toBe(jsonRow!.workedHours);
        expect(hours(row!.expectedMinutes)).toBe(jsonRow!.shouldHours);
        expect(hours(row!.balanceMinutes)).toBe(jsonRow!.overtimeHours);
        expect(hours(row!.balanceAdjustmentMinutes)).toBe(jsonRow!.balanceAdjustmentHours);
        const expectedStatus =
          jsonRow!.overtimeConfirmed === null
            ? "UNLABELLED"
            : jsonRow!.overtimeConfirmed
              ? "CONFIRMED"
              : "FORECAST";
        expect(row!.status).toBe(expectedStatus);
        expect(row!.absenceDays.vacation).toBe(jsonRow!.vacationDays);
      }
    });

    it("the fixture exercises closed, open and unlabelled months and a non-zero Verrechnung", async () => {
      const rows = await exportRows();
      const status = (p: { employeeNumber: string }) =>
        rows.find((r) => r.employeeNumber === p.employeeNumber)!.status;
      expect(status(fx.people.p1)).toBe("CONFIRMED");
      expect(status(fx.people.p2)).toBe("CONFIRMED");
      expect(status(fx.people.p3)).toBe("FORECAST");
      expect(status(fx.people.p5)).toBe("UNLABELLED");
      expect(rows.some((r) => r.balanceAdjustmentMinutes !== 0)).toBe(true);
    });

    it("pins each of the nine absence counts to the DATEV line of its Lohnart", async () => {
      const rows = await exportRows();
      const lines = await datev();
      let nonZero = 0;
      for (const person of everyone()) {
        const row = rows.find((r) => r.employeeNumber === person.employeeNumber)!;
        for (const [kind, lna] of Object.entries(LNA)) {
          const line = lines.find((l) => l.pnr === person.employeeNumber && l.lna === lna);
          const datevDays = line?.days ?? 0;
          const printed = row.absenceDays[kind as keyof typeof LNA];
          expect(printed, `${person.employeeNumber} ${kind}`).toBe(datevDays);
          if (datevDays > 0) nonZero++;
        }
      }
      // The comparison is not vacuous: the fixture produces a count on every Lohnart.
      expect(nonZero).toBeGreaterThanOrEqual(Object.keys(LNA).length);
    });

    it("sets the § 9 flag exactly for persons with a confirmed credit in the month", async () => {
      const rows = await exportRows();
      const flagged = rows.filter((r) => r.section9).map((r) => r.employeeNumber);
      expect(flagged.sort((a, b) => a.localeCompare(b))).toEqual(
        [fx.people.p6.employeeNumber, fx.people.p9.employeeNumber].sort((a, b) =>
          a.localeCompare(b),
        ),
      );
    });

    it("Gesamtsaldo is the account's own terminal cumulative value", async () => {
      const rows = await exportRows();
      const closing = (p: { employeeNumber: string }) =>
        rows.find((r) => r.employeeNumber === p.employeeNumber)!.closingBalanceMinutes;
      // Closed months: the stored carryOver, verbatim, in both snapshot period conventions.
      expect(closing(fx.people.p1)).toBe(fx.closedCarryOver.p1);
      expect(closing(fx.people.p2)).toBe(fx.closedCarryOver.p2);
      // Open months: the last computed day of GET /overtime/month-saldo.
      for (const person of [fx.people.p3, fx.people.p4]) {
        const res = await app.inject({
          method: "GET",
          url: `/api/v1/overtime/month-saldo/${person.id}?year=${EXPORT_YEAR}&month=${EXPORT_MONTH}`,
          headers: { authorization: `Bearer ${fx.adminToken}` },
        });
        expect(res.statusCode).toBe(200);
        const days = (JSON.parse(res.body) as { days: Array<{ cumulativeSaldoMinutes: number }> })
          .days;
        expect(days.length).toBeGreaterThan(0);
        expect(closing(person)).toBe(days[days.length - 1].cumulativeSaldoMinutes);
      }
      // Unlabelled: no Gesamtsaldo.
      expect(closing(fx.people.p5)).toBeNull();
    });

    it("DATEV-Std. is the Normalstunden of the DATEV file in decimal hours", async () => {
      const rows = await exportRows();
      const lines = await datev();
      for (const person of everyone()) {
        const row = rows.find((r) => r.employeeNumber === person.employeeNumber)!;
        const normal = lines.find((l) => l.pnr === person.employeeNumber && l.lna === NORMAL_LNA);
        expect(hours(row.datevWorkedMinutes), person.employeeNumber).toBe(normal?.hours ?? 0);
      }
    });

    it("Ist and DATEV-Std. differ where the account clamps or credits (measured causes)", async () => {
      const rows = await exportRows();
      const row = (p: { employeeNumber: string }) =>
        rows.find((r) => r.employeeNumber === p.employeeNumber)!;
      // P7: two entries after the exit day - DATEV sums them, the account clamps them away.
      expect(row(fx.people.p7).workedMinutes).toBeLessThan(row(fx.people.p7).datevWorkedMinutes);
      // P8: the Berufsschule credit raises the account's Ist above the sum of entries.
      expect(row(fx.people.p8).workedMinutes).toBeGreaterThan(row(fx.people.p8).datevWorkedMinutes);
      // P3 (open month, plain entries): both sources agree.
      expect(row(fx.people.p3).workedMinutes).toBe(row(fx.people.p3).datevWorkedMinutes);
    });
  });
});
