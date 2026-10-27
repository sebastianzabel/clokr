/**
 * Issue #780 - a person whose hireDate lies BEFORE the first WorkSchedule.validFrom: the period
 * report's month rows, the sum of the months and the live saldo (`GET /overtime/:id`) must state the
 * same figures. Before the fix the month rows carried no Soll for the contract-less months while
 * the live chain charged the tenant-default Soll for them (-298 h vs -154 h).
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { getTestApp, closeTestApp, cleanupTestData } from "./setup";
import { createPopulationPerson } from "./population-fixtures-613";
import { seedMonthlyExportFixture, type MonthlyExportFixture } from "./monthly-export-fixture-617";
import { computeMonthReportFigures } from "../contexts/working-time-account";

const NOW = new Date("2026-10-27T10:00:00.000Z");

type PeriodMonth = {
  year: number;
  month: number;
  workedMinutes: number;
  expectedMinutes: number | null;
  balanceMinutes: number | null;
  closingBalanceMinutes: number | null;
};
type PeriodRow = {
  employeeId: string;
  workedMinutes: number;
  expectedMinutes: number | null;
  balanceMinutes: number | null;
  closingBalanceMinutes: number | null;
  months: PeriodMonth[];
};

describe("Issue #780 - hireDate before the first contract", { timeout: 120_000 }, () => {
  let app: FastifyInstance;
  let fx: MonthlyExportFixture;
  let employeeId: string;

  const get = (url: string) =>
    app.inject({ method: "GET", url, headers: { authorization: `Bearer ${fx.adminToken}` } });

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    app = await getTestApp();
    fx = await seedMonthlyExportFixture(app, "hc780");
    const p = await createPopulationPerson(app, {
      tenantId: fx.tenantId,
      salonId: fx.salonId,
      tag: "HC",
      hireDate: new Date("2026-09-01T00:00:00Z"),
    });
    employeeId = p.employeeId;
    // The first (and only) contract starts on 26.10., after the hire date (set later by an admin).
    await app.prisma.workSchedule.updateMany({
      where: { employeeId },
      data: { validFrom: new Date("2026-10-26T00:00:00Z") },
    });
    for (const d of ["2026-10-22", "2026-10-23"]) {
      await app.prisma.timeEntry.create({
        data: {
          employeeId,
          salonId: fx.salonId,
          date: new Date(`${d}T00:00:00Z`),
          startTime: new Date(`${d}T08:00:00Z`),
          endTime: new Date(`${d}T16:00:00Z`),
          breakMinutes: 0,
          type: "WORK",
          source: "MANUAL",
        },
      });
    }
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, fx.tenantId);
    } catch (err) {
      console.error("hire-before-contract-780 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("period row = sum of the months = closing = live saldo", async () => {
    const res = await get(`/api/v1/reports/period?from=2026-09&to=2026-10`);
    expect(res.statusCode, res.body).toBe(200);
    const row = (JSON.parse(res.body) as { rows: PeriodRow[] }).rows.find(
      (r) => r.employeeId === employeeId,
    )!;
    expect(row).toBeDefined();

    // Row = sum of its months.
    expect(row.workedMinutes).toBe(row.months.reduce((s, m) => s + m.workedMinutes, 0));
    expect(row.expectedMinutes).toBe(row.months.reduce((s, m) => s + (m.expectedMinutes ?? 0), 0));
    expect(row.balanceMinutes).toBe(row.months.reduce((s, m) => s + (m.balanceMinutes ?? 0), 0));

    // Each month = the account's own month answer.
    for (const m of row.months) {
      const f = await computeMonthReportFigures(app, employeeId, m.year, m.month);
      expect(m.expectedMinutes ?? 0).toBe(f.expectedMinutes);
    }

    // The closing saldo = the live saldo, and the closing is built from the same Soll as the rows:
    // no Soll for September (no contract), the October contract Soll to yesterday.
    const live = JSON.parse((await get(`/api/v1/overtime/${employeeId}`)).body) as {
      balanceHours: number;
    };
    expect(Math.round(row.closingBalanceMinutes!) / 60).toBeCloseTo(live.balanceHours, 1);
    const september = row.months.find((m) => m.month === 9)!;
    expect(september.expectedMinutes ?? 0).toBe(0);
    // The October contract (valid at the month's end) prices October from 1.10. through yesterday
    // (18 workdays x 8 h = 144 h, unchanged convention); September carries nothing.
    // Old code: -304 h (September's tenant-default Soll of 176 h charged on top).
    expect(live.balanceHours).toBeCloseTo(16 - 144, 1);
  });

  it("the Monatsabschluss writer stores no Soll for the contract-less month, and the live saldo is unchanged by the close", async () => {
    const before = JSON.parse((await get(`/api/v1/overtime/${employeeId}`)).body) as {
      balanceHours: number;
    };
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/overtime/close-month",
      headers: { authorization: `Bearer ${fx.adminToken}` },
      payload: { employeeId, year: 2026, month: 9, confirmGaps: true },
    });
    expect(res.statusCode, res.body).toBe(201);
    const snap = await app.prisma.saldoSnapshot.findFirstOrThrow({
      where: { employeeId, periodType: "MONTHLY", superseded: false },
    });
    expect(snap.expectedMinutes).toBe(0);
    expect(snap.balanceMinutes).toBe(0);
    expect(snap.carryOver).toBe(0);
    const after = JSON.parse((await get(`/api/v1/overtime/${employeeId}`)).body) as {
      balanceHours: number;
    };
    expect(after.balanceHours).toBe(before.balanceHours);
  });
});
