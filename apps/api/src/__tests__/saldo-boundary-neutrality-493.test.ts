/**
 * Phase 493 (Issue #493) R5/D-04 — boundary-neutrality pins for the saldo and the Monatsabschluss.
 *
 * Written and GREEN on the unfixed tree at branch base 7c6018e9, BEFORE any read-side bound of
 * this phase changes. Every literal below is either hand-derived (marked "hand") or was captured
 * from that untouched tree (marked "captured"). This file is the integration half of the R5/R6
 * proof: the later 493 plans change only read-side bounds of display/export outputs, and this file
 * proves that none of those edits moves a saldo, a live balance or a stored closed-month snapshot.
 *
 * THIS FILE MUST NEVER BE EDITED TO MAKE A TEST PASS. A red cell after a later 493 plan is a
 * saldo regression, not a stale value. There is deliberately no snapshot mechanism — every pinned
 * value is an explicit literal. It pins ONLY saldo/close figures (month-saldo, tracked report
 * Soll/Ist/Überstunden, live balance, SaldoSnapshot rows); it never pins the display/export
 * values that Issue #493 corrects (day counts, entry lists, DATEV lines).
 *
 * Fixture — tenant timezone Europe/Berlin (CEST = UTC+2 in September/October, CET = UTC+1 in
 * November..February), NIEDERSACHSEN. Two employees hired 2025-09-01:
 *   F  FIXED_SCHEDULE Mo-Fr 8h (weeklyHours 40)
 *   M  MONTHLY_HOURS, monthlyHours 40 (tracked — owed monthly Soll)
 * Rows sitting exactly on month boundaries (all times UTC):
 *   2025-09-30 19:44-20:42  = Tue 21:44-22:42 Berlin, the LAST day of September (58 min);
 *                             startTime 2025-09-30T19:44:00Z, endTime 2025-09-30T20:42:00Z
 *   2025-10-01 06:00-08:00  = the FIRST day of October (120 min)
 *   2026-01-31 19:00-20:00  = Saturday, last day of January (F only)
 *   2026-02-01 09:00-10:00  = Sunday, first day of February (F only)
 *   F sick leave 2025-10-29..2025-10-31 (ends on October's last day; 31.10. is a NI holiday)
 *   M sick leave 2026-01-28..2026-01-31 (ends on January's last day)
 * The saldo path buckets entries by tenant-local day (`dateStrInTz`), so the 30.09. entry belongs
 * to September only — that is the reference behaviour the date-bound fixes must never disturb.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, reissueTokenNow } from "./setup";
import { leaveTypeFields } from "../contexts/absence/leave-type";

type Emp = "F" | "M";
type Ym = "2025-09" | "2025-10" | "2025-11" | "2026-01" | "2026-02";

const MONTHS: Array<{ ym: Ym; year: number; month: number }> = [
  { ym: "2025-09", year: 2025, month: 9 },
  { ym: "2025-10", year: 2025, month: 10 },
  { ym: "2025-11", year: 2025, month: 11 },
  { ym: "2026-01", year: 2026, month: 1 },
  { ym: "2026-02", year: 2026, month: 2 },
];

interface SaldoPin {
  workedMinutes: number;
  expectedMinutes: number;
  balanceMinutes: number;
  closed: boolean;
  workedDays: number;
  monthSollMinutes?: number;
  fullMonth: { workedMinutes: number; expectedMinutes: number; balanceMinutes: number };
  dayCount: number;
  firstDayCumulative: number;
  lastDayCumulative: number;
}

// Open-month saldo (GET /overtime/month-saldo/:id) at branch base 7c6018e9.
// "hand": F 2025-09 worked 538 (480 + 58), F 2025-10 worked 600 (120 + 480),
//         M 2025-09 worked 58, M 2025-10 worked 120. Everything else "captured".
const SALDO: Record<Emp, Record<Ym, SaldoPin>> = {
  F: {
    "2025-09": {
      workedMinutes: 538, // hand
      expectedMinutes: 10560,
      balanceMinutes: -10022,
      closed: false,
      workedDays: 2,
      fullMonth: { workedMinutes: 538, expectedMinutes: 10560, balanceMinutes: -10022 },
      dayCount: 30,
      firstDayCumulative: -480,
      lastDayCumulative: -10022,
    },
    "2025-10": {
      workedMinutes: 600, // hand
      expectedMinutes: 9120,
      balanceMinutes: -8520,
      closed: false,
      workedDays: 2,
      fullMonth: { workedMinutes: 600, expectedMinutes: 9120, balanceMinutes: -8520 },
      dayCount: 31,
      firstDayCumulative: -360,
      lastDayCumulative: -8520,
    },
    "2025-11": {
      workedMinutes: 480,
      expectedMinutes: 9600,
      balanceMinutes: -9120,
      closed: false,
      workedDays: 1,
      fullMonth: { workedMinutes: 480, expectedMinutes: 9600, balanceMinutes: -9120 },
      dayCount: 30,
      firstDayCumulative: 0,
      lastDayCumulative: -9120,
    },
    "2026-01": {
      workedMinutes: 540,
      expectedMinutes: 10080,
      balanceMinutes: -9540,
      closed: false,
      workedDays: 2,
      fullMonth: { workedMinutes: 540, expectedMinutes: 10080, balanceMinutes: -9540 },
      dayCount: 31,
      firstDayCumulative: 0,
      lastDayCumulative: -9540,
    },
    "2026-02": {
      workedMinutes: 540,
      expectedMinutes: 9600,
      balanceMinutes: -9060,
      closed: false,
      workedDays: 2,
      fullMonth: { workedMinutes: 540, expectedMinutes: 9600, balanceMinutes: -9060 },
      dayCount: 28,
      firstDayCumulative: 60,
      lastDayCumulative: -9060,
    },
  },
  M: {
    "2025-09": {
      workedMinutes: 58, // hand
      expectedMinutes: 2400,
      balanceMinutes: -2342,
      closed: false,
      workedDays: 1,
      monthSollMinutes: 2400,
      fullMonth: { workedMinutes: 58, expectedMinutes: 2400, balanceMinutes: -2342 },
      dayCount: 30,
      firstDayCumulative: -109,
      lastDayCumulative: -2342,
    },
    "2025-10": {
      workedMinutes: 120, // hand
      expectedMinutes: 2191,
      balanceMinutes: -2071,
      closed: false,
      workedDays: 1,
      monthSollMinutes: 2191,
      fullMonth: { workedMinutes: 120, expectedMinutes: 2191, balanceMinutes: -2071 },
      dayCount: 31,
      firstDayCumulative: 16,
      lastDayCumulative: -2071,
    },
    "2025-11": {
      workedMinutes: 240,
      expectedMinutes: 2400,
      balanceMinutes: -2160,
      closed: false,
      workedDays: 1,
      monthSollMinutes: 2400,
      fullMonth: { workedMinutes: 240, expectedMinutes: 2400, balanceMinutes: -2160 },
      dayCount: 30,
      firstDayCumulative: 0,
      lastDayCumulative: -2160,
    },
    "2026-01": {
      workedMinutes: 240,
      expectedMinutes: 1964,
      balanceMinutes: -1724,
      closed: false,
      workedDays: 1,
      monthSollMinutes: 1964,
      fullMonth: { workedMinutes: 240, expectedMinutes: 1964, balanceMinutes: -1724 },
      dayCount: 31,
      firstDayCumulative: 0,
      lastDayCumulative: -1724,
    },
    "2026-02": {
      workedMinutes: 240,
      expectedMinutes: 2400,
      balanceMinutes: -2160,
      closed: false,
      workedDays: 1,
      monthSollMinutes: 2400,
      fullMonth: { workedMinutes: 240, expectedMinutes: 2400, balanceMinutes: -2160 },
      dayCount: 28,
      firstDayCumulative: 0,
      lastDayCumulative: -2160,
    },
  },
};

interface ReportPin {
  workedHours: number;
  shouldHours: number;
  overtimeHours: number;
  balanceAdjustmentHours: number;
}

// Tracked report figures (GET /reports/monthly rows[0]) — captured at 7c6018e9. They are
// identical for the open month (fullMonth basis) and the closed month (snapshot basis); only
// `overtimeConfirmed` flips from false to true.
const REPORT: Record<Emp, Record<Ym, ReportPin>> = {
  F: {
    "2025-09": {
      workedHours: 8.97,
      shouldHours: 176,
      overtimeHours: -167.03,
      balanceAdjustmentHours: 0,
    },
    "2025-10": {
      workedHours: 10,
      shouldHours: 152,
      overtimeHours: -142,
      balanceAdjustmentHours: 0,
    },
    "2025-11": { workedHours: 8, shouldHours: 160, overtimeHours: -152, balanceAdjustmentHours: 0 },
    "2026-01": { workedHours: 9, shouldHours: 168, overtimeHours: -159, balanceAdjustmentHours: 0 },
    "2026-02": { workedHours: 9, shouldHours: 160, overtimeHours: -151, balanceAdjustmentHours: 0 },
  },
  M: {
    "2025-09": {
      workedHours: 0.97,
      shouldHours: 40,
      overtimeHours: -39.03,
      balanceAdjustmentHours: 0,
    },
    "2025-10": {
      workedHours: 2,
      shouldHours: 36.52,
      overtimeHours: -34.52,
      balanceAdjustmentHours: 0,
    },
    "2025-11": { workedHours: 4, shouldHours: 40, overtimeHours: -36, balanceAdjustmentHours: 0 },
    "2026-01": {
      workedHours: 4,
      shouldHours: 32.73,
      overtimeHours: -28.73,
      balanceAdjustmentHours: 0,
    },
    "2026-02": { workedHours: 4, shouldHours: 40, overtimeHours: -36, balanceAdjustmentHours: 0 },
  },
};

interface SnapshotPin {
  periodStart: string;
  periodEnd: string;
  workedMinutes: number;
  expectedMinutes: number;
  balanceMinutes: number;
  carryOver: number;
}

// Stored MONTHLY SaldoSnapshot rows after closing 2025-09..2025-12 and 2026-01..02 — captured at
// 7c6018e9. periodStart/periodEnd are the stored @db.Date values (the tz-instant keys truncated
// to a calendar date); that representation is NOT changed by Phase 493 (D-02).
const SNAPSHOTS: Record<Emp, SnapshotPin[]> = {
  F: [
    {
      periodStart: "2025-08-31T00:00:00.000Z",
      periodEnd: "2025-09-30T00:00:00.000Z",
      workedMinutes: 538,
      expectedMinutes: 10560,
      balanceMinutes: -10022,
      carryOver: -10022,
    },
    {
      periodStart: "2025-09-30T00:00:00.000Z",
      periodEnd: "2025-10-31T00:00:00.000Z",
      workedMinutes: 600,
      expectedMinutes: 9120,
      balanceMinutes: -8520,
      carryOver: -18542,
    },
    {
      periodStart: "2025-10-31T00:00:00.000Z",
      periodEnd: "2025-11-30T00:00:00.000Z",
      workedMinutes: 480,
      expectedMinutes: 9600,
      balanceMinutes: -9120,
      carryOver: -27662,
    },
    {
      periodStart: "2025-11-30T00:00:00.000Z",
      periodEnd: "2025-12-31T00:00:00.000Z",
      workedMinutes: 480,
      expectedMinutes: 10080,
      balanceMinutes: -9600,
      carryOver: -37262,
    },
    {
      periodStart: "2025-12-31T00:00:00.000Z",
      periodEnd: "2026-01-31T00:00:00.000Z",
      workedMinutes: 540,
      expectedMinutes: 10080,
      balanceMinutes: -9540,
      carryOver: -46802,
    },
    {
      periodStart: "2026-01-31T00:00:00.000Z",
      periodEnd: "2026-02-28T00:00:00.000Z",
      workedMinutes: 540,
      expectedMinutes: 9600,
      balanceMinutes: -9060,
      carryOver: -55862,
    },
  ],
  M: [
    {
      periodStart: "2025-08-31T00:00:00.000Z",
      periodEnd: "2025-09-30T00:00:00.000Z",
      workedMinutes: 58,
      expectedMinutes: 2400,
      balanceMinutes: -2342,
      carryOver: -2342,
    },
    {
      periodStart: "2025-09-30T00:00:00.000Z",
      periodEnd: "2025-10-31T00:00:00.000Z",
      workedMinutes: 120,
      expectedMinutes: 2191,
      balanceMinutes: -2071,
      carryOver: -4413,
    },
    {
      periodStart: "2025-10-31T00:00:00.000Z",
      periodEnd: "2025-11-30T00:00:00.000Z",
      workedMinutes: 240,
      expectedMinutes: 2400,
      balanceMinutes: -2160,
      carryOver: -6573,
    },
    {
      periodStart: "2025-11-30T00:00:00.000Z",
      periodEnd: "2025-12-31T00:00:00.000Z",
      workedMinutes: 0,
      expectedMinutes: 2191,
      balanceMinutes: -2191,
      carryOver: -8764,
    },
    {
      periodStart: "2025-12-31T00:00:00.000Z",
      periodEnd: "2026-01-31T00:00:00.000Z",
      workedMinutes: 240,
      expectedMinutes: 1964,
      balanceMinutes: -1724,
      carryOver: -10488,
    },
    {
      periodStart: "2026-01-31T00:00:00.000Z",
      periodEnd: "2026-02-28T00:00:00.000Z",
      workedMinutes: 240,
      expectedMinutes: 2400,
      balanceMinutes: -2160,
      carryOver: -12648,
    },
  ],
};

const CLOSE_MONTHS: Array<{ year: number; month: number }> = [
  { year: 2025, month: 9 },
  { year: 2025, month: 10 },
  { year: 2025, month: 11 },
  { year: 2025, month: 12 },
  { year: 2026, month: 1 },
  { year: 2026, month: 2 },
];

// GET /overtime/:id (live lifetime balance, hire date -> yesterday) at the faked clock
// 2026-03-02T10:00:00Z — captured at 7c6018e9. `balanceHours` must be IDENTICAL before and after
// closing (live == closed at the boundary); only the confirmed/open split moves.
const LIVE_CLOCK = "2026-03-02T10:00:00.000Z";
const LIVE_BALANCE_HOURS: Record<Emp, number> = { F: -931.03, M: -210.8 };
const LIVE_BEFORE: Record<
  Emp,
  { confirmedMinutes: number; openMonthMinutes: number; hasClosedMonth: boolean }
> = {
  F: { confirmedMinutes: 0, openMonthMinutes: -55862, hasClosedMonth: false },
  M: { confirmedMinutes: 0, openMonthMinutes: -12648, hasClosedMonth: false },
};
const LIVE_AFTER: Record<
  Emp,
  { confirmedMinutes: number; openMonthMinutes: number; hasClosedMonth: boolean }
> = {
  F: { confirmedMinutes: -55862, openMonthMinutes: 0, hasClosedMonth: true },
  M: { confirmedMinutes: -12648, openMonthMinutes: 0, hasClosedMonth: true },
};

describe("Phase 493 R5 — month-boundary saldo neutrality (frozen on the unfixed tree)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  const ids = { F: "", M: "" } as Record<Emp, string>;

  async function get(url: string, token: string = data.adminToken) {
    const res = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "sbn493");
    const prisma = app.prisma;

    // The fixture is only meaningful for a UTC+1/+2 tenant: a null timezone resolves to the
    // default, and the saldo path is asserted against exactly that default.
    const cfg = await prisma.tenantConfig.findUnique({ where: { tenantId: data.tenant.id } });
    expect(cfg?.timezone ?? "Europe/Berlin").toBe("Europe/Berlin");

    const passwordHash = await bcrypt.hash("test1234", 10);
    const HIRE = new Date("2025-09-01T00:00:00Z");

    async function createEmployee(label: string, schedule: Record<string, unknown>) {
      const suffix = `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const user = await prisma.user.create({
        data: {
          email: `${suffix}@test.de`,
          passwordHash,
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const employee = await prisma.employee.create({
        data: {
          tenantId: data.tenant.id,
          userId: user.id,
          employeeNumber: `N-${suffix}`,
          firstName: label,
          lastName: "Sbn493",
          hireDate: HIRE,
        },
      });
      await prisma.workSchedule.create({
        data: {
          employeeId: employee.id,
          validFrom: HIRE,
          workDays: [1, 2, 3, 4, 5],
          ...schedule,
        } as never,
      });
      await prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
      return employee.id;
    }

    ids.F = await createEmployee("fixed", {
      type: "FIXED_SCHEDULE",
      weeklyHours: 40,
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
    });
    ids.M = await createEmployee("monthly", {
      type: "MONTHLY_HOURS",
      monthlyHours: 40,
      weeklyHours: null,
      mondayHours: 0,
      tuesdayHours: 0,
      wednesdayHours: 0,
      thursdayHours: 0,
      fridayHours: 0,
      saturdayHours: 0,
      sundayHours: 0,
    });

    async function entry(
      employeeId: string,
      day: string,
      start: string,
      end: string,
      breakMinutes: number,
    ) {
      await prisma.timeEntry.create({
        data: {
          employeeId,
          date: new Date(`${day}T00:00:00Z`),
          startTime: new Date(`${day}T${start}:00Z`),
          endTime: new Date(`${day}T${end}:00Z`),
          breakMinutes,
          type: "WORK",
          source: "MANUAL",
          salonId: data.salonId,
        },
      });
    }
    await entry(ids.F, "2025-09-15", "06:00", "14:30", 30);
    await entry(ids.F, "2025-09-30", "19:44", "20:42", 0);
    await entry(ids.F, "2025-10-01", "06:00", "08:00", 0);
    await entry(ids.F, "2025-10-15", "06:00", "14:30", 30);
    await entry(ids.F, "2025-11-17", "07:00", "15:30", 30);
    await entry(ids.F, "2025-12-15", "07:00", "15:30", 30);
    await entry(ids.F, "2026-01-15", "07:00", "15:30", 30);
    await entry(ids.F, "2026-01-31", "19:00", "20:00", 0);
    await entry(ids.F, "2026-02-01", "09:00", "10:00", 0);
    await entry(ids.F, "2026-02-16", "07:00", "15:30", 30);
    await entry(ids.M, "2025-09-30", "19:44", "20:42", 0);
    await entry(ids.M, "2025-10-01", "06:00", "08:00", 0);
    await entry(ids.M, "2025-11-03", "07:00", "11:00", 0);
    await entry(ids.M, "2026-01-26", "07:00", "11:00", 0);
    await entry(ids.M, "2026-02-02", "07:00", "11:00", 0);

    const sick = await prisma.leaveType.create({
      data: { tenantId: data.tenant.id, ...leaveTypeFields("SICK"), color: "#EF4444" },
    });
    await prisma.leaveRequest.create({
      data: {
        employeeId: ids.F,
        leaveTypeId: sick.id,
        startDate: new Date("2025-10-29T00:00:00Z"),
        endDate: new Date("2025-10-31T00:00:00Z"),
        days: 3,
        status: "APPROVED",
      },
    });
    await prisma.leaveRequest.create({
      data: {
        employeeId: ids.M,
        leaveTypeId: sick.id,
        startDate: new Date("2026-01-28T00:00:00Z"),
        endDate: new Date("2026-01-31T00:00:00Z"),
        days: 4,
        status: "APPROVED",
      },
    });
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("saldo-boundary-neutrality-493 cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("open months — real clock", () => {
    for (const emp of ["F", "M"] as const) {
      describe(`employee ${emp}`, () => {
        it.each(MONTHS)("month-saldo $ym", async ({ ym, year, month }) => {
          const { status, body } = await get(
            `/api/v1/overtime/month-saldo/${ids[emp]}?year=${year}&month=${month}`,
          );
          expect(status).toBe(200);
          const expected = SALDO[emp][ym];
          expect({
            workedMinutes: body.workedMinutes,
            expectedMinutes: body.expectedMinutes,
            balanceMinutes: body.balanceMinutes,
            closed: body.closed,
            workedDays: body.workedDays,
            monthSollMinutes: body.monthSollMinutes,
            fullMonth: body.fullMonth,
            dayCount: body.days.length,
            firstDayCumulative: body.days[0].cumulativeSaldoMinutes,
            lastDayCumulative: body.days[body.days.length - 1].cumulativeSaldoMinutes,
          }).toEqual(expected);
        });

        it.each(MONTHS)("report figures $ym", async ({ ym, year, month }) => {
          const { status, body } = await get(
            `/api/v1/reports/monthly?employeeId=${ids[emp]}&year=${year}&month=${month}`,
          );
          expect(status).toBe(200);
          expect(body.rows).toHaveLength(1);
          const row = body.rows[0];
          expect({
            workedHours: row.workedHours,
            shouldHours: row.shouldHours,
            overtimeHours: row.overtimeHours,
            balanceAdjustmentHours: row.balanceAdjustmentHours,
          }).toEqual(REPORT[emp][ym]);
          expect(row.overtimeConfirmed).toBe(false);
        });
      });
    }
  });

  async function liveBalance(emp: Emp) {
    vi.useFakeTimers({ now: new Date(LIVE_CLOCK), toFake: ["Date"] });
    try {
      const token = reissueTokenNow(app, data.adminToken);
      const { status, body } = await get(`/api/v1/overtime/${ids[emp]}`, token);
      expect(status).toBe(200);
      return {
        balanceHours: body.balanceHours as number,
        confirmedMinutes: body.confirmedMinutes as number,
        openMonthMinutes: body.openMonthMinutes as number,
        hasClosedMonth: body.hasClosedMonth as boolean,
      };
    } finally {
      vi.useRealTimers();
    }
  }

  describe("live balance before closing — clock 2026-03-02T10:00:00Z", () => {
    it.each(["F", "M"] as const)("employee %s", async (emp) => {
      const live = await liveBalance(emp);
      expect(live).toEqual({ balanceHours: LIVE_BALANCE_HOURS[emp], ...LIVE_BEFORE[emp] });
    });
  });

  describe("Monatsabschluss — real clock", () => {
    for (const emp of ["F", "M"] as const) {
      describe(`employee ${emp}`, () => {
        it.each(CLOSE_MONTHS)("close $year-$month", async ({ year, month }) => {
          const res = await app.inject({
            method: "POST",
            url: "/api/v1/overtime/close-month",
            headers: { authorization: `Bearer ${data.adminToken}` },
            payload: { employeeId: ids[emp], year, month, confirmGaps: true },
          });
          expect(res.statusCode).toBe(201);
        });

        it("stored snapshot rows", async () => {
          const rows = await app.prisma.saldoSnapshot.findMany({
            where: { employeeId: ids[emp], periodType: "MONTHLY", superseded: false },
            orderBy: { periodStart: "asc" },
          });
          expect(
            rows.map((r) => ({
              periodStart: r.periodStart.toISOString(),
              periodEnd: r.periodEnd.toISOString(),
              workedMinutes: r.workedMinutes,
              expectedMinutes: r.expectedMinutes,
              balanceMinutes: r.balanceMinutes,
              carryOver: r.carryOver,
            })),
          ).toEqual(SNAPSHOTS[emp]);
        });
      });
    }
  });

  describe("after closing", () => {
    it.each(["F", "M"] as const)(
      "live balance equals the pre-close literal — employee %s",
      async (emp) => {
        const live = await liveBalance(emp);
        // live == closed at the boundary: the balance is the SAME literal as before closing.
        expect(live.balanceHours).toBe(LIVE_BALANCE_HOURS[emp]);
        expect(live).toEqual({ balanceHours: LIVE_BALANCE_HOURS[emp], ...LIVE_AFTER[emp] });
      },
    );

    for (const emp of ["F", "M"] as const) {
      describe(`closed-month report figures — employee ${emp}`, () => {
        it.each(MONTHS)("report figures $ym (snapshot basis)", async ({ ym, year, month }) => {
          const { status, body } = await get(
            `/api/v1/reports/monthly?employeeId=${ids[emp]}&year=${year}&month=${month}`,
          );
          expect(status).toBe(200);
          expect(body.rows).toHaveLength(1);
          const row = body.rows[0];
          expect({
            workedHours: row.workedHours,
            shouldHours: row.shouldHours,
            overtimeHours: row.overtimeHours,
            balanceAdjustmentHours: row.balanceAdjustmentHours,
          }).toEqual(REPORT[emp][ym]);
          expect(row.overtimeConfirmed).toBe(true);
        });
      });
    }
  });
});
