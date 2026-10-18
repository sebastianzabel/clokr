/**
 * Issue #688 — the period report reads closed months from their stored snapshots in ONE query.
 *
 * `computeMonthReportFiguresForMany` (Arbeitszeitkonto) answers many (person, month) pairs; every
 * pair must equal what `computeMonthReportFigures` answers for it, closed months are taken from the
 * stored row verbatim (never recomputed, never written), and only open months walk the kernel.
 *
 * Fixture (`Date` faked to 2026-10-15, October = the running month), one person per schedule shape:
 *   - FIX     FIXED_SCHEDULE, closed Oct 2025..Sep 2026 (converted convention); August also has a
 *             legacy UTC-naive duplicate and July a superseded row with other figures; May is closed
 *             ONLY in the legacy convention.
 *   - MH      MONTHLY_HOURS 80 h, closed Oct 2025..Sep 2026.
 *   - TRACK   MONTHLY_HOURS without hours (track-only), snapshots exist but the rows are unlabelled.
 *   - SHIFT   SHIFT_BASED, closed Oct 2025..Jun 2026, July..October open with shifts and entries.
 *   - SWITCH  FIXED until May 2026, track-only MONTHLY_HOURS from June: closed every month.
 *   - EXEMPT  time-tracking exempt with snapshots: unlabelled.
 *   - OPEN    FIXED, never closed.
 * The stored figures are deliberately arbitrary (no recomputation could produce them), so a value
 * equal to the stored one proves it was read.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { createPopulationPerson } from "./population-fixtures-613";
import { legacySaldoSnapshotPeriodBounds, saldoSnapshotPeriodBounds } from "./test-dates";
import {
  computeMonthReportFigures,
  computeMonthReportFiguresForMany,
  monthReportFiguresKey,
  type MonthReportFiguresRequest,
} from "../contexts/working-time-account";

const FAKE_NOW = "2026-10-15T10:00:00.000Z";
const HIRE = new Date("2025-01-01T00:00:00Z");

type YM = { year: number; month: number };
function monthsFrom(from: YM, count: number): YM[] {
  const out: YM[] = [];
  let { year, month } = from;
  for (let i = 0; i < count; i++) {
    out.push({ year, month });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}
// October 2025 (the month before the 12-month period) .. October 2026 (running).
const ALL_MONTHS = monthsFrom({ year: 2025, month: 10 }, 13);
const ym = (m: YM) => `${m.year}-${String(m.month).padStart(2, "0")}`;

type Period = {
  rows: Array<{
    employeeId: string;
    openingBalanceMinutes: number | null;
    closingBalanceMinutes: number | null;
    months: Array<{
      year: number;
      month: number;
      workedMinutes: number;
      expectedMinutes: number | null;
      balanceMinutes: number | null;
      closingBalanceMinutes: number | null;
      confirmed: boolean;
      labelled: boolean;
    }>;
  }>;
};

describe("Issue #688 — closed months of a period are read in one query, never recomputed", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  const ids: Record<"FIX" | "MH" | "TRACK" | "SHIFT" | "SWITCH" | "EXEMPT" | "OPEN", string> = {
    FIX: "",
    MH: "",
    TRACK: "",
    SHIFT: "",
    SWITCH: "",
    EXEMPT: "",
    OPEN: "",
  };
  // employeeId::YYYY-MM -> the stored figures the reader must return verbatim.
  const stored = new Map<string, { worked: number; expected: number; carry: number }>();

  async function snapshot(
    employeeId: string,
    m: YM,
    figures: { worked: number; expected: number; carry: number },
    opts: { legacy?: boolean; superseded?: boolean; record?: boolean } = {},
  ) {
    const bounds = opts.legacy
      ? legacySaldoSnapshotPeriodBounds(m.year, m.month)
      : saldoSnapshotPeriodBounds(new Date(Date.UTC(m.year, m.month - 1, 1)));
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId,
        periodType: "MONTHLY",
        periodStart: bounds.start,
        periodEnd: bounds.end,
        workedMinutes: figures.worked,
        expectedMinutes: figures.expected,
        balanceMinutes: figures.worked - figures.expected,
        carryOver: figures.carry,
        closedAt: new Date(),
        closedBy: data.adminUser.id,
        superseded: opts.superseded ?? false,
        ...(opts.superseded ? { supersededReason: "test #688" } : {}),
      },
    });
    if (opts.record !== false) stored.set(`${employeeId}::${ym(m)}`, figures);
  }

  async function closeMonths(employeeId: string, months: YM[], seed: number) {
    let carry = seed * 7;
    for (const [i, m] of months.entries()) {
      const worked = 1000 + seed * 13 + i * 17;
      const expected = 900 + seed * 11 + i * 5;
      carry += worked - expected + 3; // +3: a stored chain no recomputation reproduces
      await snapshot(employeeId, m, { worked, expected, carry });
    }
  }

  async function entry(employeeId: string, date: string) {
    await app.prisma.timeEntry.create({
      data: {
        employeeId,
        salonId: data.salonId,
        date: new Date(`${date}T00:00:00Z`),
        startTime: new Date(`${date}T07:00:00Z`),
        endTime: new Date(`${date}T15:00:00Z`),
        breakMinutes: 30,
        type: "WORK",
        source: "MANUAL",
      },
    });
  }

  async function periodReport(from: string, to: string): Promise<Period> {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/period?from=${from}&to=${to}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as Period;
  }

  const allRequests = (): MonthReportFiguresRequest[] =>
    Object.values(ids).flatMap((employeeId) => ALL_MONTHS.map((m) => ({ employeeId, ...m })));

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(FAKE_NOW));
    app = await getTestApp();
    data = await seedTestData(app, "bulk688");
    for (const tag of Object.keys(ids) as Array<keyof typeof ids>) {
      const p = await createPopulationPerson(app, {
        tenantId: data.tenant.id,
        salonId: data.salonId,
        tag: `B688${tag}`,
        hireDate: HIRE,
      });
      ids[tag] = p.employeeId;
    }
    await app.prisma.workSchedule.updateMany({
      where: { employeeId: { in: [ids.FIX, ids.OPEN, ids.SWITCH, ids.EXEMPT] } },
      data: { type: "FIXED_SCHEDULE", workDays: [1, 2, 3, 4, 5] },
    });
    await app.prisma.workSchedule.updateMany({
      where: { employeeId: ids.MH },
      data: { type: "MONTHLY_HOURS", monthlyHours: 80, workDays: [1, 2, 3, 4, 5] },
    });
    await app.prisma.workSchedule.updateMany({
      where: { employeeId: ids.TRACK },
      data: { type: "MONTHLY_HOURS", monthlyHours: null, workDays: [1, 2, 3, 4, 5] },
    });
    await app.prisma.workSchedule.updateMany({
      where: { employeeId: ids.SHIFT },
      data: {
        type: "SHIFT_BASED",
        contractWorkDaysPerWeek: 5,
        usualWorkDays: [1, 2, 3, 4, 5],
        workDays: [1, 2, 3, 4, 5],
      },
    });
    // SWITCH: a contract change to track-only MONTHLY_HOURS from 1 June 2026.
    await app.prisma.workSchedule.create({
      data: {
        employeeId: ids.SWITCH,
        type: "MONTHLY_HOURS",
        monthlyHours: null,
        weeklyHours: 0,
        mondayHours: 0,
        tuesdayHours: 0,
        wednesdayHours: 0,
        thursdayHours: 0,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4, 5],
        validFrom: saldoSnapshotPeriodBounds(new Date("2026-06-01T00:00:00Z")).start,
      },
    });
    await app.prisma.employee.update({
      where: { id: ids.EXEMPT },
      data: { isTimeTrackingExempt: true },
    });

    const closedToSep = ALL_MONTHS.slice(0, 12); // Oct 2025 .. Sep 2026
    // FIX: converted rows except May (legacy only); August with a legacy duplicate that must lose.
    await closeMonths(
      ids.FIX,
      closedToSep.filter((m) => !(m.year === 2026 && m.month === 5)),
      1,
    );
    await snapshot(
      ids.FIX,
      { year: 2026, month: 5 },
      { worked: 4321, expected: 1234, carry: 777 },
      {
        legacy: true,
      },
    );
    await snapshot(
      ids.FIX,
      { year: 2026, month: 8 },
      { worked: 1, expected: 2, carry: 3 },
      { legacy: true, record: false },
    );
    await snapshot(
      ids.FIX,
      { year: 2026, month: 7 },
      { worked: 9, expected: 8, carry: 7 },
      { superseded: true, record: false },
    );
    await closeMonths(ids.MH, closedToSep, 2);
    await closeMonths(ids.TRACK, closedToSep, 3);
    await closeMonths(ids.SHIFT, ALL_MONTHS.slice(0, 9), 4); // Oct 2025 .. Jun 2026
    await closeMonths(ids.SWITCH, closedToSep, 5);
    await closeMonths(ids.EXEMPT, closedToSep, 6);

    for (const id of Object.values(ids)) {
      for (const d of ["2026-07-06", "2026-08-03", "2026-09-07", "2026-10-05", "2026-10-12"]) {
        await entry(id, d);
      }
    }
    for (const d of ["2026-07-06", "2026-08-03", "2026-09-07", "2026-10-05", "2026-10-12"]) {
      await app.prisma.shift.create({
        data: {
          employeeId: ids.SHIFT,
          salonId: data.salonId,
          date: new Date(`${d}T00:00:00Z`),
          startTime: "09:00",
          endTime: "17:00",
        },
      });
    }
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("reports-period-bulk-read-688 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("answers every (person, month) pair exactly like computeMonthReportFigures", async () => {
    const requests = allRequests();
    const many = await computeMonthReportFiguresForMany(app, data.tenant.id, requests);
    expect(many.size).toBe(requests.length);
    let snapshotBasis = 0;
    for (const r of requests) {
      const single = await computeMonthReportFigures(app, r.employeeId, r.year, r.month);
      const bulk = many.get(monthReportFiguresKey(r.employeeId, r.year, r.month));
      expect(bulk, `${r.employeeId} ${r.year}-${r.month}`).toEqual(single);
      if (single.basis === "snapshot") snapshotBasis++;
    }
    // FIX 12 + MH 12 + SHIFT 9 + SWITCH Oct..May 8 = 41 stored months; TRACK, EXEMPT and SWITCH
    // from June are unlabelled although rows exist.
    expect(snapshotBasis).toBe(41);
  });

  it("returns the stored row verbatim for every labelled closed month (both conventions, first row wins)", async () => {
    const many = await computeMonthReportFiguresForMany(app, data.tenant.id, allRequests());
    let checked = 0;
    for (const [key, s] of stored) {
      const [employeeId, month] = key.split("::");
      const f = many.get(
        monthReportFiguresKey(employeeId, Number(month.slice(0, 4)), Number(month.slice(5))),
      )!;
      if (!f.labelled) {
        expect([ids.TRACK, ids.EXEMPT, ids.SWITCH]).toContain(employeeId);
        expect(f.confirmed).toBe(false);
        expect(f.closingBalanceMinutes).toBeNull();
        continue;
      }
      expect(f).toEqual({
        workedMinutes: s.worked,
        expectedMinutes: s.expected,
        balanceMinutes: s.worked - s.expected,
        balanceAdjustmentMinutes: 0,
        closingBalanceMinutes: s.carry,
        confirmed: true,
        labelled: true,
        basis: "snapshot",
      });
      checked++;
    }
    expect(checked).toBe(41);
    // The legacy-only May of FIX is read as closed with its stored figures.
    expect(many.get(monthReportFiguresKey(ids.FIX, 2026, 5))?.closingBalanceMinutes).toBe(777);
  });

  it("reads all closed months in ONE snapshot query and walks no kernel for them", async () => {
    const closedPairs: MonthReportFiguresRequest[] = [ids.FIX, ids.MH].flatMap((employeeId) =>
      ALL_MONTHS.slice(0, 12).map((m) => ({ employeeId, ...m })),
    );
    const findMany = vi.spyOn(app.prisma.saldoSnapshot, "findMany");
    const findFirst = vi.spyOn(app.prisma.saldoSnapshot, "findFirst");
    try {
      const many = await computeMonthReportFiguresForMany(app, data.tenant.id, closedPairs);
      expect([...many.values()].every((f) => f.basis === "snapshot")).toBe(true);
      expect(findMany).toHaveBeenCalledTimes(1);
      expect(findFirst).not.toHaveBeenCalled();
    } finally {
      findMany.mockRestore();
      findFirst.mockRestore();
    }
  });

  it("the period report shows the stored figures and the stored opening carry-over", async () => {
    const report = await periodReport("2025-11", "2026-10");
    for (const id of [ids.FIX, ids.MH, ids.SHIFT]) {
      const row = report.rows.find((r) => r.employeeId === id)!;
      expect(row.months).toHaveLength(12);
      expect(row.openingBalanceMinutes).toBe(stored.get(`${id}::2025-10`)!.carry);
      for (const m of row.months) {
        const s = stored.get(`${id}::${ym(m)}`);
        if (!s) {
          expect(m.confirmed).toBe(false);
          continue;
        }
        expect(m).toMatchObject({
          workedMinutes: s.worked,
          expectedMinutes: s.expected,
          balanceMinutes: s.worked - s.expected,
          closingBalanceMinutes: s.carry,
          confirmed: true,
          labelled: true,
        });
      }
    }
    const track = report.rows.find((r) => r.employeeId === ids.TRACK)!;
    expect(track.months.every((m) => !m.labelled && !m.confirmed)).toBe(true);
    expect(track.openingBalanceMinutes).toBeNull();
  });

  it("changes no SaldoSnapshot or OvertimeAccount row and writes no account audit (full-row comparison)", async () => {
    const personIds = Object.values(ids);
    const state = async () => ({
      snapshots: await app.prisma.saldoSnapshot.findMany({
        where: { employeeId: { in: personIds } },
        orderBy: [{ id: "asc" }],
      }),
      accounts: await app.prisma.overtimeAccount.findMany({
        where: { employeeId: { in: personIds } },
        orderBy: [{ id: "asc" }],
      }),
    });
    const before = await state();
    expect(before.snapshots.length).toBeGreaterThan(60);
    const auditBefore = await app.prisma.auditLog.count({
      where: { entity: { in: ["SaldoSnapshot", "OvertimeAccount"] } },
    });

    await periodReport("2025-11", "2026-10");
    await periodReport("2026-06", "2026-10");
    const csv = await app.inject({
      method: "GET",
      url: "/api/v1/reports/period/csv?from=2025-11&to=2026-10",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(csv.statusCode, csv.body).toBe(200);

    expect(await state()).toEqual(before);
    expect(
      await app.prisma.auditLog.count({
        where: { entity: { in: ["SaldoSnapshot", "OvertimeAccount"] } },
      }),
    ).toBe(auditBefore);
  });
});
