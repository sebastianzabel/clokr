/**
 * Issue #617 (OD-617-1/2) - the Monatsexport: GET /api/v1/reports/monthly-export/pdf, the
 * human-readable twin of the DATEV export. Access, population (= the DATEV population of the same
 * month and scope) and the audit row are proven here (describe "tracer"); every figure is pinned to
 * DATEV, `/reports/monthly` and `computeMonthReportFigures` in the second describe.
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

describe("Issue #617 - Monatsexport tracer", () => {
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
});
