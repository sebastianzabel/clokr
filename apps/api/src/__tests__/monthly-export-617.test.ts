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
import { getTestApp, closeTestApp, cleanupTestData, soleAuditRow, auditRowsFor } from "./setup";
import {
  seedMonthlyExportFixture,
  FAKE_NOW,
  EXPORT_YEAR,
  EXPORT_MONTH,
  type FixturePerson,
  type MonthlyExportFixture,
} from "./monthly-export-fixture-617";
import { computeMonthReportFigures, dayRangeUtc } from "../contexts/working-time-account";
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
  describe("section Urlaubsjahr (D-617-2, P-03)", () => {
    // Dedicated persons so the DATEV parity cases above keep their exact fixture: pv1 carries a
    // warned carry-over, a taken, an approved-upcoming and two pending requests; pv2 has no
    // VACATION entitlement; pva is anonymised with a stale stored usedDays.
    let pv1: FixturePerson;
    let pv2: FixturePerson;
    let pva: FixturePerson;
    let pv1Entitlement2026Id: string;
    let pvaEntitlementId: string;
    let pvaBefore: { updatedAt: Date; usedDays: number };

    async function mkPerson(
      key: string,
      names: { first: string; last: string },
    ): Promise<FixturePerson> {
      const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const user = await app.prisma.user.create({
        data: {
          email: `${key}-${unique}@example.invalid`,
          passwordHash: "x",
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const employeeNumber = `N617-${key}`;
      const hire = new Date("2025-06-01T00:00:00Z");
      const employee = await app.prisma.employee.create({
        data: {
          tenantId: fx.tenantId,
          userId: user.id,
          employeeNumber,
          firstName: names.first,
          lastName: names.last,
          hireDate: hire,
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
          validFrom: hire,
        },
      });
      await app.prisma.overtimeAccount.create({
        data: { employeeId: employee.id, balanceHours: 0 },
      });
      return { id: employee.id, employeeNumber, lastName: names.last };
    }

    async function request(
      employeeId: string,
      start: string,
      end: string,
      days: number,
      status: "APPROVED" | "PENDING",
      createdAt: string,
    ) {
      await app.prisma.leaveRequest.create({
        data: {
          employeeId,
          leaveTypeId: fx.seed.vacationType.id,
          status,
          startDate: new Date(`${start}T00:00:00Z`),
          endDate: new Date(`${end}T00:00:00Z`),
          days,
          createdAt: new Date(`${createdAt}T08:00:00Z`),
        },
      });
    }

    beforeAll(async () => {
      vi.setSystemTime(FAKE_NOW);
      pv1 = await mkPerson("pv1", { first: "Vorname", last: "P617pv1" });
      pv2 = await mkPerson("pv2", { first: "Vorname", last: "P617pv2" });
      pva = await mkPerson("pva", { first: "Gelöscht", last: "GELÖSCHT-pva" });

      const ent26 = await app.prisma.leaveEntitlement.create({
        data: {
          employeeId: pv1.id,
          leaveTypeId: fx.seed.vacationType.id,
          year: 2026,
          totalDays: 30,
          usedDays: 0,
          carriedOverDays: 4,
          carryOverDeadline: new Date("2026-10-10T00:00:00Z"),
          isAutoCalculated: true,
        },
      });
      pv1Entitlement2026Id = ent26.id;
      // The Hinweis was issued, so the carry-over really lapses after its deadline (EuGH C-684/16).
      await app.prisma.auditLog.create({
        data: {
          action: "CARRYOVER_WARNED",
          entity: "LeaveEntitlement",
          entityId: ent26.id,
          newValue: { year: 2026, carriedOverDays: 4 },
        },
      });
      await app.prisma.leaveEntitlement.create({
        data: {
          employeeId: pv1.id,
          leaveTypeId: fx.seed.vacationType.id,
          year: 2025,
          totalDays: 20,
          usedDays: 0,
          carriedOverDays: 0,
          isAutoCalculated: true,
        },
      });
      await request(pv1.id, "2026-03-02", "2026-03-03", 2, "APPROVED", "2026-02-20");
      await request(pv1.id, "2026-10-20", "2026-10-21", 2, "APPROVED", "2026-10-01");
      await request(pv1.id, "2026-11-02", "2026-11-03", 2, "PENDING", "2026-09-29");
      await request(pv1.id, "2026-11-09", "2026-11-09", 1, "PENDING", "2026-10-05");

      const entA = await app.prisma.leaveEntitlement.create({
        data: {
          employeeId: pva.id,
          leaveTypeId: fx.seed.vacationType.id,
          year: 2026,
          totalDays: 30,
          usedDays: 0, // stale on purpose: the approved request below makes the true figure 2
          carriedOverDays: 0,
          isAutoCalculated: true,
        },
      });
      pvaEntitlementId = entA.id;
      await request(pva.id, "2026-03-02", "2026-03-03", 2, "APPROVED", "2026-02-20");
      pvaBefore = { updatedAt: entA.updatedAt, usedDays: Number(entA.usedDays) };
    });

    /** An access token expires, so a request at another instant needs its own login (clock set). */
    async function adminTokenAt(): Promise<string> {
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: fx.seed.adminUser.email, password: "test1234" },
      });
      expect(login.statusCode).toBe(200);
      return JSON.parse(login.body).accessToken as string;
    }

    async function exportPayload(qs: string, now: Date = FAKE_NOW): Promise<ExportPayload> {
      vi.setSystemTime(now);
      const token = await adminTokenAt();
      const spy = vi.mocked(pdfUtils.generateMonthlyExportPdf);
      spy.mockClear();
      const res = await get(token, exportUrl(qs));
      vi.setSystemTime(FAKE_NOW);
      expect(res.statusCode).toBe(200);
      return spy.mock.calls[0][0] as ExportPayload;
    }

    const rowOf = (data: ExportPayload, p: { employeeNumber: string }) =>
      data.rows.find((r) => r.employeeNumber === p.employeeNumber)!;

    // Instants stay in the past of any real run: the heal and the export audit rows written under the
    // faked clock must never be dated after the real "now" (other tests count audit rows since
    // their own start). RUNNING_MONTH_NOW is inside October 2026, the month after FAKE_NOW's.
    const RUNNING_MONTH_NOW = new Date("2026-10-16T10:00:00.000Z");
    const EARLY_NOW = new Date("2026-10-05T10:00:00.000Z"); // before the carry-over deadline of pv1

    it("evaluates at the last day of a past month, yesterday in the running month, and in the exported year", async () => {
      const sept = await exportPayload(`year=${EXPORT_YEAR}&month=9`);
      expect(sept.vacationYear).toEqual({ year: 2026, asOf: "30.09.2026" });
      const running = await exportPayload(`year=${EXPORT_YEAR}&month=10`, RUNNING_MONTH_NOW);
      expect(running.vacationYear).toEqual({ year: 2026, asOf: "15.10.2026" });
      const december = await exportPayload(`year=2025&month=12`, RUNNING_MONTH_NOW);
      expect(december.vacationYear).toEqual({ year: 2025, asOf: "31.12.2025" });
      // The 2025 row of pv1 is the one printed in the December 2025 export.
      expect(rowOf(december, pv1).vacation).toMatchObject({
        entitlementDays: 20,
        availableDays: 20,
        takenDays: 0,
        approvedUpcomingDays: 0,
        remainingDays: 20,
      });
    });

    it("each row's vacation equals the facade at the end of the Stichtag after the shared heal", async () => {
      const data = await exportPayload(`year=${EXPORT_YEAR}&month=9`);
      const row = rowOf(data, pv1).vacation;
      expect(row).not.toBeNull();
      const entitlement = await app.prisma.leaveEntitlement.findUniqueOrThrow({
        where: { id: pv1Entitlement2026Id },
      });
      const tz = "Europe/Berlin";
      const balance = await app.vacationBalanceForRow(
        entitlement,
        fx.tenantId,
        dayRangeUtc("2026-09-30", tz).end,
        { asOf: "2026-09-30" },
      );
      expect(row).toEqual({
        entitlementDays: balance.entitlementDays,
        carriedOverEffectiveDays: balance.carriedOverEffectiveDays,
        availableDays: balance.availableDays,
        takenDays: balance.takenDays,
        approvedUpcomingDays: balance.approvedUpcomingDays,
        pendingDays: balance.pendingCreatedByAsOfDays,
        remainingDays: balance.remainingDays,
      });
      // Measured on the fixture: carry-over still effective at 30.09. (deadline 10.10.), March
      // taken, 20./21.10. approved after the Stichtag, only the request created by 30.09. is
      // Beantragt, and nothing pending is deducted.
      expect(row).toEqual({
        entitlementDays: 30,
        carriedOverEffectiveDays: 4,
        availableDays: 34,
        takenDays: 2,
        approvedUpcomingDays: 2,
        pendingDays: 2,
        remainingDays: 30,
      });
    });

    it("for the running month the row equals the in-app overview row of the same person", async () => {
      const now = RUNNING_MONTH_NOW;
      const data = await exportPayload(`year=${EXPORT_YEAR}&month=10`, now);
      vi.setSystemTime(now);
      const overviewToken = await adminTokenAt();
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/reports/leave-overview?year=${EXPORT_YEAR}`,
        headers: { authorization: `Bearer ${overviewToken}` },
      });
      vi.setSystemTime(FAKE_NOW);
      const overview = (
        JSON.parse(res.body) as Array<{
          employee: { id: string };
          totalDays: number;
          carriedOverEffectiveDays: number;
          availableDays: number;
          takenDays: number;
          approvedUpcomingDays: number;
          pendingDays: number;
          remainingDays: number;
          missingEntitlement: boolean;
        }>
      ).find((r) => r.employee.id === pv1.id && !r.missingEntitlement)!;
      expect(overview).toBeDefined();
      // No request of the fixture was created today, so Beantragt (created by the Stichtag) equals
      // the overview's pendingDays.
      expect(rowOf(data, pv1).vacation).toEqual({
        entitlementDays: overview.totalDays,
        carriedOverEffectiveDays: overview.carriedOverEffectiveDays,
        availableDays: overview.availableDays,
        takenDays: overview.takenDays,
        approvedUpcomingDays: overview.approvedUpcomingDays,
        pendingDays: overview.pendingDays,
        remainingDays: overview.remainingDays,
      });
    });

    it("a person without a VACATION entitlement row has vacation null", async () => {
      const data = await exportPayload(`year=${EXPORT_YEAR}&month=9`);
      expect(rowOf(data, pv2).vacation).toBeNull();
      expect(rowOf(data, fx.people.p3).vacation).toBeNull();
    });

    it("an anonymised person of the export shows figures and is never written by the heal", async () => {
      const data = await exportPayload(`year=${EXPORT_YEAR}&month=9`);
      const vacation = rowOf(data, pva).vacation;
      expect(vacation).toMatchObject({
        availableDays: 30,
        takenDays: 2,
        approvedUpcomingDays: 0,
        remainingDays: 28,
      });
      const after = await app.prisma.leaveEntitlement.findUniqueOrThrow({
        where: { id: pvaEntitlementId },
      });
      expect(after.updatedAt.getTime()).toBe(pvaBefore.updatedAt.getTime());
      expect(Number(after.usedDays)).toBe(pvaBefore.usedDays);
      expect(await auditRowsFor(app, "LeaveEntitlement", pvaEntitlementId)).toHaveLength(0);
    });

    it("a re-export of the same month on a later day prints the same vacation figures", async () => {
      // First on 05.10. (the carry-over deadline of 10.10. has not passed), then on 15.10. (it has).
      const first = await exportPayload(`year=${EXPORT_YEAR}&month=9`, EARLY_NOW);
      // In between a request is created (14.10.) that did not exist at the Stichtag.
      await request(pv1.id, "2026-12-14", "2026-12-14", 1, "PENDING", "2026-10-14");
      const second = await exportPayload(`year=${EXPORT_YEAR}&month=9`);
      expect(second.vacationYear).toEqual(first.vacationYear);
      expect(rowOf(second, pv1).vacation).toEqual(rowOf(first, pv1).vacation);
      // Genehmigt 20./21.10. in both; neither the request created 05.10. nor the one created 14.10.
      // is in Beantragt; the carry-over (deadline 10.10., Hinweis issued) is evaluated at 30.09. in
      // both, so it is effective in both although it has lapsed on the second day.
      for (const data of [first, second]) {
        expect(rowOf(data, pv1).vacation).toMatchObject({
          approvedUpcomingDays: 2,
          pendingDays: 2,
          carriedOverEffectiveDays: 4,
        });
      }
    });
  });
});
