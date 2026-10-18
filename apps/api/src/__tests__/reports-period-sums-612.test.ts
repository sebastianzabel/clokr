/**
 * Issue #612 (AC-612-2, D-612-8, P-02, P-08, P-13) — the period report is a SUM of the months and
 * states exactly what the account, `/reports/monthly` and the Monatsexport state.
 *
 * Fixture: the #617 nine-person fixture (`seedMonthlyExportFixture`, `Date` faked to 2026-10-15T10:00Z,
 * September closed for p1 and p2 in the two snapshot conventions, every leave kind, a SHIFT_BASED
 * person, an unlabelled MONTHLY_HOURS contract, a confirmed § 9 credit, an exit inside September)
 * plus two persons of this file:
 *   pX  July closed (stored carry-over), August, September and October unclosed — the open chain
 *   pB  an approved sick request over the month boundary (28.8.-3.9.) with a confirmed § 9 credit on
 *       31.8. and 1.9.
 *
 * Mutation proofs (done on copies, recorded in the plan SUMMARY, the module restored byte-identical):
 * see the docblock at the end of the file.
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { getTestApp, closeTestApp, cleanupTestData } from "./setup";
import { createPopulationPerson } from "./population-fixtures-613";
import { saldoSnapshotPeriodBounds } from "./test-dates";
import {
  seedMonthlyExportFixture,
  FAKE_NOW,
  type MonthlyExportFixture,
} from "./monthly-export-fixture-617";
import { computeMonthReportFigures } from "../contexts/working-time-account";
import * as pdfUtils from "../composition/pdf";

vi.mock("../composition/pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../composition/pdf")>();
  return {
    ...actual,
    generateMonthlyExportPdf: vi.fn(actual.generateMonthlyExportPdf),
  };
});

type ExportPayload = Parameters<typeof pdfUtils.generateMonthlyExportPdf>[0];

type MonthEntry = {
  year: number;
  month: number;
  workedMinutes: number;
  expectedMinutes: number | null;
  balanceMinutes: number | null;
  closingBalanceMinutes: number | null;
  confirmed: boolean;
  labelled: boolean;
  sickDays: number;
};
type Row = {
  employeeId: string;
  employeeNumber: string;
  workedMinutes: number;
  expectedMinutes: number | null;
  balanceMinutes: number | null;
  openingBalanceMinutes: number | null;
  closingBalanceMinutes: number | null;
  closingConfirmedMinutes: number | null;
  closingOpenMinutes: number | null;
  unconfirmedMonths: number | null;
  monthCount: number;
  confirmedMonthCount: number;
  labelled: boolean;
  sickDays: number;
  months: MonthEntry[];
};
type Period = {
  months: Array<{ year: number; month: number }>;
  kpis: {
    personCount: number;
    workedMinutes: number;
    expectedMinutes: number | null;
    balanceMinutes: number | null;
    closingBalanceMinutes: number | null;
    sickDays: number;
  };
  rows: Row[];
};
type MonthlyRow = {
  employeeId: string;
  workedHours: number;
  shouldHours: number;
  overtimeHours: number;
  overtimeConfirmed: boolean | null;
  sickDays: number;
};

const hours = (minutes: number): number => Math.round((minutes / 60) * 100) / 100;
const PRINT = process.env.CLOKR_PRINT_PERIOD_TABLE === "1";

// These fixtures are mostly open months, which still walk the account kernel per person and month
// (#696); under CI coverage a single case exceeds the global 30 s budget. Back to the default once
// #696 bundles the open-month carry-in. Assertions are unchanged.
describe("Issue #612 — period sums (AC-612-2)", { timeout: 120_000 }, () => {
  let app: FastifyInstance;
  let fx: MonthlyExportFixture;
  let pX: { employeeId: string; employeeNumber: string };
  let pB: { employeeId: string; employeeNumber: string };
  let julyCarryOver = 0;
  const monthlyCache = new Map<string, Map<string, MonthlyRow>>();

  const get = (url: string) =>
    app.inject({ method: "GET", url, headers: { authorization: `Bearer ${fx.adminToken}` } });

  async function period(from: string, to: string): Promise<Period> {
    const res = await get(`/api/v1/reports/period?from=${from}&to=${to}`);
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as Period;
  }

  async function monthly(year: number, month: number): Promise<Map<string, MonthlyRow>> {
    const key = `${year}-${month}`;
    const cached = monthlyCache.get(key);
    if (cached) return cached;
    const res = await get(`/api/v1/reports/monthly?year=${year}&month=${month}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as { rows: MonthlyRow[] };
    const byId = new Map(body.rows.map((r) => [r.employeeId, r]));
    monthlyCache.set(key, byId);
    return byId;
  }

  async function exportRows(month: number): Promise<ExportPayload["rows"]> {
    const spy = vi.mocked(pdfUtils.generateMonthlyExportPdf);
    spy.mockClear();
    const res = await get(`/api/v1/reports/monthly-export/pdf?year=2026&month=${month}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    return (spy.mock.calls[0][0] as ExportPayload).rows;
  }

  const rowOf = (p: Period, id: string): Row => {
    const row = p.rows.find((r) => r.employeeId === id);
    if (!row) throw new Error(`row ${id} missing`);
    return row;
  };

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FAKE_NOW);
    app = await getTestApp();
    fx = await seedMonthlyExportFixture(app, "ps612");

    const hire = new Date("2025-01-01T00:00:00Z");
    const entry = (employeeId: string, date: string) =>
      app.prisma.timeEntry.create({
        data: {
          employeeId,
          salonId: fx.salonId,
          date: new Date(`${date}T00:00:00Z`),
          startTime: new Date(`${date}T08:00:00Z`),
          endTime: new Date(`${date}T16:00:00Z`),
          breakMinutes: 0,
          type: "WORK",
          source: "MANUAL",
        },
      });

    // pX: July closed (converted convention), everything after it unclosed.
    const x = await createPopulationPerson(app, {
      tenantId: fx.tenantId,
      salonId: fx.salonId,
      tag: "X",
      hireDate: hire,
    });
    pX = { employeeId: x.employeeId, employeeNumber: x.employeeNumber };
    for (const d of ["2026-08-03", "2026-08-04", "2026-08-05"]) await entry(pX.employeeId, d);
    for (const d of ["2026-09-01", "2026-09-02", "2026-09-03"]) await entry(pX.employeeId, d);
    for (const d of ["2026-10-01", "2026-10-02"]) await entry(pX.employeeId, d);
    julyCarryOver = 300;
    const july = saldoSnapshotPeriodBounds(new Date("2026-07-01T00:00:00Z"));
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: pX.employeeId,
        periodType: "MONTHLY",
        periodStart: july.start,
        periodEnd: july.end,
        workedMinutes: 10380,
        expectedMinutes: 10080,
        balanceMinutes: 300,
        carryOver: julyCarryOver,
        closedAt: new Date(),
        closedBy: fx.adminUserId,
      },
    });

    // pB: a sick request over the month boundary with a confirmed § 9 credit on both sides of it.
    const b = await createPopulationPerson(app, {
      tenantId: fx.tenantId,
      salonId: fx.salonId,
      tag: "B",
      hireDate: hire,
    });
    pB = { employeeId: b.employeeId, employeeNumber: b.employeeNumber };
    for (const d of ["2026-08-03", "2026-09-07"]) await entry(pB.employeeId, d);
    const sickType = await app.prisma.leaveType.findFirstOrThrow({
      where: { tenantId: fx.tenantId, code: "SICK" },
    });
    const sick = await app.prisma.leaveRequest.create({
      data: {
        employeeId: pB.employeeId,
        leaveTypeId: sickType.id,
        startDate: new Date("2026-08-28T00:00:00Z"),
        endDate: new Date("2026-09-03T00:00:00Z"),
        days: 5,
        status: "APPROVED",
        attestPresent: false,
      },
    });
    const vacation = await app.prisma.leaveRequest.create({
      data: {
        employeeId: pB.employeeId,
        leaveTypeId: fx.seed.vacationType.id,
        startDate: new Date("2026-08-31T00:00:00Z"),
        endDate: new Date("2026-09-01T00:00:00Z"),
        days: 2,
        status: "APPROVED",
      },
    });
    await app.prisma.section9Credit.create({
      data: {
        employeeId: pB.employeeId,
        sickRequestId: sick.id,
        vacationRequestId: vacation.id,
        overlapStart: new Date("2026-08-31T00:00:00Z"),
        overlapEnd: new Date("2026-09-01T00:00:00Z"),
        status: "CONFIRMED",
        creditedStart: new Date("2026-08-31T00:00:00Z"),
        creditedEnd: new Date("2026-09-01T00:00:00Z"),
        creditedDays: 2,
        attestSource: "EAU",
        attestValidFrom: new Date("2026-08-31T00:00:00Z"),
        attestValidTo: new Date("2026-09-01T00:00:00Z"),
        reason: "fixture 612",
        reviewedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, fx.tenantId);
    } catch (err) {
      console.error("reports-period-sums-612 cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("AC-612-2: sums = months = /reports/monthly = account", () => {
    it("every period month equals the account's month answer and the /monthly row of that month", async () => {
      const p = await period("2026-07", "2026-10");
      expect(p.months).toHaveLength(4);
      // The nine fixture persons plus pX and pB plus the two seeded employees.
      expect(p.rows.length).toBeGreaterThanOrEqual(11);

      const lines: string[] = [];
      for (const ym of p.months) {
        const monthlyRows = await monthly(ym.year, ym.month);
        // Presence parity: a person is listed for a month iff /monthly lists the person that month.
        const listed = new Set(
          p.rows.filter((r) => r.months.some((m) => m.month === ym.month)).map((r) => r.employeeId),
        );
        expect([...listed].sort((a, b) => a.localeCompare(b))).toEqual(
          [...monthlyRows.keys()].sort((a, b) => a.localeCompare(b)),
        );
      }
      for (const row of p.rows) {
        for (const m of row.months) {
          const f = await computeMonthReportFigures(app, row.employeeId, m.year, m.month);
          expect(m.workedMinutes, `${row.employeeNumber} ${m.month} worked`).toBe(f.workedMinutes);
          expect(m.expectedMinutes, `${row.employeeNumber} ${m.month} expected`).toBe(
            f.expectedMinutes,
          );
          expect(m.balanceMinutes, `${row.employeeNumber} ${m.month} balance`).toBe(
            f.balanceMinutes,
          );
          expect(m.closingBalanceMinutes, `${row.employeeNumber} ${m.month} closing`).toBe(
            f.closingBalanceMinutes,
          );
          expect(m.confirmed).toBe(f.confirmed);
          expect(m.labelled).toBe(f.labelled);

          const j = (await monthly(m.year, m.month)).get(row.employeeId);
          expect(j, `${row.employeeNumber} ${m.month} in /monthly`).toBeDefined();
          expect(hours(m.workedMinutes), `${row.employeeNumber} ${m.month} workedHours`).toBe(
            j!.workedHours,
          );
          expect(
            hours(m.expectedMinutes ?? 0),
            `${row.employeeNumber} ${m.month} shouldHours`,
          ).toBe(j!.shouldHours);
          expect(
            hours(m.balanceMinutes ?? 0),
            `${row.employeeNumber} ${m.month} overtimeHours`,
          ).toBe(j!.overtimeHours);
          expect(m.labelled ? m.confirmed : null).toBe(j!.overtimeConfirmed);
          expect(m.sickDays, `${row.employeeNumber} ${m.month} sickDays`).toBe(j!.sickDays);
          lines.push(
            `${row.employeeNumber};${m.year}-${m.month};${m.workedMinutes};${m.expectedMinutes};${m.balanceMinutes};${m.closingBalanceMinutes};${j!.workedHours};${j!.shouldHours};${j!.overtimeHours};${j!.sickDays}`,
          );
        }
      }
      if (PRINT) process.stdout.write(`PERIOD_TABLE\n${lines.join("\n")}\n`);
    });

    it("each row is the sum of its months and the KPIs are the sum of the rows", async () => {
      const p = await period("2026-07", "2026-10");
      for (const row of p.rows) {
        const sum = (pick: (m: MonthEntry) => number | null) =>
          row.months.reduce((s, m) => s + (pick(m) ?? 0), 0);
        expect(row.workedMinutes, row.employeeNumber).toBe(sum((m) => m.workedMinutes));
        expect(row.expectedMinutes, row.employeeNumber).toBe(sum((m) => m.expectedMinutes));
        expect(row.balanceMinutes, row.employeeNumber).toBe(sum((m) => m.balanceMinutes));
        expect(row.sickDays, row.employeeNumber).toBe(sum((m) => m.sickDays));
        expect(row.monthCount).toBe(row.months.length);
        expect(row.closingBalanceMinutes).toBe(
          row.months[row.months.length - 1].closingBalanceMinutes,
        );
      }
      expect(p.kpis.personCount).toBe(p.rows.length);
      expect(p.kpis.workedMinutes).toBe(p.rows.reduce((s, r) => s + r.workedMinutes, 0));
      expect(p.kpis.expectedMinutes).toBe(p.rows.reduce((s, r) => s + (r.expectedMinutes ?? 0), 0));
      expect(p.kpis.balanceMinutes).toBe(p.rows.reduce((s, r) => s + (r.balanceMinutes ?? 0), 0));
      expect(p.kpis.closingBalanceMinutes).toBe(
        p.rows.reduce((s, r) => s + (r.closingBalanceMinutes ?? 0), 0),
      );
      expect(p.kpis.sickDays).toBe(
        Math.round(p.rows.reduce((s, r) => s + r.sickDays, 0) * 100) / 100,
      );
    });

    it("the four single-month periods summed per person equal the four-month period", async () => {
      const whole = await period("2026-07", "2026-10");
      const singles = [
        await period("2026-07", "2026-07"),
        await period("2026-08", "2026-08"),
        await period("2026-09", "2026-09"),
        await period("2026-10", "2026-10"),
      ];
      for (const row of whole.rows) {
        let worked = 0;
        let expected = 0;
        let balance = 0;
        let sick = 0;
        for (const single of singles) {
          const part = single.rows.find((r) => r.employeeId === row.employeeId);
          if (!part) continue;
          worked += part.workedMinutes;
          expected += part.expectedMinutes ?? 0;
          balance += part.balanceMinutes ?? 0;
          sick += part.sickDays;
          // The month entry itself is the same whether it was asked alone or inside the period.
          expect(part.months).toHaveLength(1);
          const inWhole = row.months.find((m) => m.month === part.months[0].month);
          expect(inWhole, `${row.employeeNumber} month in the whole period`).toEqual(
            part.months[0],
          );
        }
        expect(worked, row.employeeNumber).toBe(row.workedMinutes);
        expect(expected, row.employeeNumber).toBe(row.expectedMinutes);
        expect(balance, row.employeeNumber).toBe(row.balanceMinutes);
        expect(Math.round(sick * 100) / 100, row.employeeNumber).toBe(row.sickDays);
      }
    });
  });

  describe("page = PDF: open and closed months equal the Monatsexport", () => {
    it.each([
      ["September (p1/p2 closed, the others open)", 9],
      ["October (the running month, everything open)", 10],
    ])("%s", async (_label, month) => {
      const rows = await exportRows(month);
      const p = await period(
        `2026-${String(month).padStart(2, "0")}`,
        `2026-${String(month).padStart(2, "0")}`,
      );
      const byNumber = new Map(p.rows.map((r) => [r.employeeNumber, r]));
      expect(rows.length).toBeGreaterThanOrEqual(9);
      // The export and the period list the same persons for a single month.
      expect(rows.map((r) => r.employeeNumber).sort((a, b) => a.localeCompare(b))).toEqual(
        p.rows.map((r) => r.employeeNumber).sort((a, b) => a.localeCompare(b)),
      );
      for (const e of rows) {
        const row = byNumber.get(e.employeeNumber);
        expect(row, e.employeeNumber).toBeDefined();
        const m = row!.months[0];
        expect(m.workedMinutes, `${e.employeeNumber} Ist`).toBe(e.workedMinutes);
        expect(m.expectedMinutes, `${e.employeeNumber} Soll`).toBe(e.expectedMinutes);
        expect(m.balanceMinutes, `${e.employeeNumber} Saldo`).toBe(e.balanceMinutes);
        expect(m.closingBalanceMinutes, `${e.employeeNumber} Gesamtsaldo`).toBe(
          e.closingBalanceMinutes,
        );
        const status = !m.labelled ? "UNLABELLED" : m.confirmed ? "CONFIRMED" : "FORECAST";
        expect(status, `${e.employeeNumber} status`).toBe(e.status);
      }
    });
  });

  describe("sick days per month (§ 9 is not additive across windows)", () => {
    it("a request over the month boundary is clipped per month and counted once in the row", async () => {
      const p = await period("2026-08", "2026-09");
      const row = rowOf(p, pB.employeeId);
      expect(row.months.map((m) => m.sickDays)).toEqual([4, 3]);
      expect(row.sickDays).toBe(7);
      for (const m of row.months) {
        const j = (await monthly(m.year, m.month)).get(pB.employeeId);
        expect(m.sickDays).toBe(j!.sickDays);
      }
    });

    it("the fixture's confirmed § 9 credit inside September counts in its own month only", async () => {
      const p = await period("2026-08", "2026-10");
      const row = rowOf(p, fx.people.p6.id);
      expect(row.months.map((m) => m.sickDays)).toEqual([0, 2, 0]);
    });
  });

  describe("status and population (P-08)", () => {
    it("p1's September is confirmed and counted", async () => {
      const row = rowOf(await period("2026-07", "2026-10"), fx.people.p1.id);
      const sep = row.months.find((m) => m.month === 9)!;
      expect(sep.confirmed).toBe(true);
      expect(row.confirmedMonthCount).toBe(1);
      expect(row.monthCount).toBe(4);
    });

    it("the unlabelled MONTHLY_HOURS person is unlabelled in every month with no opening and closing", async () => {
      const row = rowOf(await period("2026-07", "2026-10"), fx.people.p5.id);
      expect(row.labelled).toBe(false);
      expect(row.months.every((m) => !m.labelled && m.closingBalanceMinutes === null)).toBe(true);
      expect(row.openingBalanceMinutes).toBeNull();
      expect(row.closingBalanceMinutes).toBeNull();
    });

    it("an exited person lists no month after the exit month", async () => {
      const row = rowOf(await period("2026-07", "2026-10"), fx.people.p7.id);
      expect(row.months.map((m) => m.month)).toEqual([7, 8, 9]);
    });
  });

  describe("closing split (P-13)", () => {
    it("a closed last month is confirmed completely", async () => {
      const row = rowOf(await period("2026-07", "2026-09"), fx.people.p1.id);
      expect(row.closingBalanceMinutes).toBe(fx.closedCarryOver.p1);
      expect(row.closingConfirmedMinutes).toBe(fx.closedCarryOver.p1);
      expect(row.closingOpenMinutes).toBe(0);
      expect(row.unconfirmedMonths).toBe(0);
    });

    it.each([
      ["2026-09", "2026-10"],
      ["2026-10", "2026-10"],
    ])("an open last month right after a closed one splits exactly (%s..%s)", async (from, to) => {
      const row = rowOf(await period(from, to), fx.people.p1.id);
      expect(row.closingConfirmedMinutes).toBe(fx.closedCarryOver.p1);
      expect(row.closingOpenMinutes).toBe(row.closingBalanceMinutes! - fx.closedCarryOver.p1);
      expect(row.unconfirmedMonths).toBe(1);
    });

    it("the open chain: August right after the closed July splits, September after the open August does not", async () => {
      const august = rowOf(await period("2026-08", "2026-08"), pX.employeeId);
      expect(august.closingConfirmedMinutes).toBe(julyCarryOver);
      expect(august.closingOpenMinutes).toBe(august.closingBalanceMinutes! - julyCarryOver);
      expect(august.unconfirmedMonths).toBe(1);

      for (const [from, to] of [
        ["2026-08", "2026-09"],
        ["2026-09", "2026-09"],
        ["2026-08", "2026-10"],
      ]) {
        const row = rowOf(await period(from, to), pX.employeeId);
        expect(row.closingConfirmedMinutes, `${from}..${to}`).toBeNull();
        expect(row.closingOpenMinutes, `${from}..${to}`).toBeNull();
        expect(row.unconfirmedMonths, `${from}..${to}`).toBeNull();
      }
    });

    it("a person who never had a closed month carries no split", async () => {
      const row = rowOf(await period("2026-09", "2026-10"), fx.people.p3.id);
      expect(row.closingConfirmedMinutes).toBeNull();
      expect(row.unconfirmedMonths).toBeNull();
    });
  });

  describe("two unclosed months (P-02, Issue #681)", () => {
    it("the period closing equals the Monatsexport Gesamtsaldo of its last month", async () => {
      const row = rowOf(await period("2026-08", "2026-09"), pX.employeeId);
      const exported = (await exportRows(9)).find((e) => e.employeeNumber === pX.employeeNumber);
      expect(exported).toBeDefined();
      expect(row.closingBalanceMinutes).toBe(exported!.closingBalanceMinutes);
      expect(row.closingBalanceMinutes).not.toBeNull();
    });

    it("the closing of a period ending in the running month equals the live saldo", async () => {
      const row = rowOf(await period("2026-08", "2026-10"), pX.employeeId);
      const res = await get(`/api/v1/overtime/${pX.employeeId}`);
      expect(res.statusCode, res.body).toBe(200);
      const live = JSON.parse(res.body) as { balanceHours: number };
      // Measured (recorded in the plan SUMMARY): closing minutes, live hours, difference.
      if (PRINT) {
        process.stdout.write(
          `OPEN_CHAIN closing=${row.closingBalanceMinutes} live=${live.balanceHours}h\n`,
        );
      }
      expect(hours(row.closingBalanceMinutes!)).toBe(live.balanceHours);
    });
  });
});

/*
 * Mutation proofs (each on a copy of composition/reports-period.ts, restored byte-identical; both
 * period test files were run, every mutation turned at least one case red):
 *   M1  `computeEmployeeSummary` called with the PERIOD's first and last day instead of the month's
 *       -> red: the /monthly parity, the single-month sums and the boundary-request case (month
 *       entries no longer 4 and 3). The sick-day total of a row is invariant under the § 9 shift by
 *       construction (sickLeaveDayCounts moves days between the attest buckets only), so it is the
 *       clipping per month, not the shift, that this case pins.
 *   M2  the row's Soll summed for every row, not only covered ones -> red: the saldo gate case.
 *   M3  the closing saldo of the FIRST listed month instead of the last -> red: six cases (row sums,
 *       closing split, Monatsexport parity of the open chain, live saldo).
 *   S1  the closed-last-month branch of the closing split disabled -> red: "a closed last month is
 *       confirmed completely".
 *   S2  the predecessor must be closed - check removed -> red: the open chain and the never-closed
 *       person.
 */
