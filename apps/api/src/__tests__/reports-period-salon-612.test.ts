/**
 * Issue #612 (P-06, D-612-1, T-612-07..09) — `GET /api/v1/reports/period?salonId=` follows the
 * header salon by the #542 rules: one 404 for every inadmissible salon, never wider than the
 * caller's reach, every month equal to the filtered `/reports/monthly` row, Soll and saldo
 * withheld with a reason, the vacation tables limited to the persons homed in the salon at the
 * period end (whole personal values).
 *
 * Fixture = the #542 fixture (`reports-salon-filter-542.test.ts`), `Date` faked to
 * 2026-07-15T10:00Z, period June (past) to July (running):
 *   PA homed A: closed entries in A on 1.-3.6. (3 x 8 h) and in B on 4.6. (4 h), one approved
 *               vacation day on 12.6., A entries on 14.7. and 15.7.
 *   PB homed B: B entries on 9.6. and 10.6. (8 h each), one A entry on 8.6. (4 h)
 *   PX homed B until 15.6., A from 16.6.: approved sick leave 10.-20.6. (11 days: 6 in B, 5 in A),
 *               B entries on 1.6./2.6., A entries on 22.6./23.6. (8 h each), vacation 18.-19.6.
 *   PN homed B: one B entry on 5.6.
 * Every person has a 2026 VACATION entitlement so the vacation tables have real rows.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { randomBytes, randomUUID } from "crypto";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { createPopulationPerson } from "./population-fixtures-613";
import { leaveTypeFields } from "../contexts/absence/leave-type";
import { normalizeRolePermissions, roleNameKey } from "../contexts/platform";

const PASSWORD = "test1234";
const FAKE_NOW = "2026-07-15T10:00:00.000Z";
const NOT_FOUND = '{"error":"Salon nicht gefunden"}';

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
type Row = Record<string, unknown> & {
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  workedMinutes: number;
  expectedMinutes: number | null;
  balanceMinutes: number | null;
  openingBalanceMinutes: number | null;
  closingBalanceMinutes: number | null;
  closingConfirmedMinutes: number | null;
  closingOpenMinutes: number | null;
  unconfirmedMonths: number | null;
  sickDays: number;
  sollUnavailableReason?: string;
  months: MonthEntry[];
};
type VacationRow = Record<string, unknown> & { employeeId: string; missingEntitlement: boolean };
type Period = Record<string, unknown> & {
  kpis: Record<string, number | string | boolean | null>;
  rows: Row[];
  vacation: { years: Array<{ year: number; asOf: string; rows: VacationRow[] }> };
  absences: Array<{ code: string; unit: string; personCount: number; totalDays: number }>;
};
type MonthlyRow = { employeeId: string; workedHours: number; sickDays: number } & Record<
  string,
  unknown
>;

// Recorded with the code before the salon filter existed (commit 548a5e79); see the test below.
const GOLDEN_UNFILTERED: unknown = {
  envelopeKeys: ["absences", "from", "kpis", "months", "rows", "to", "vacation"],
  kpiKeys: [
    "allMonthsConfirmed",
    "balanceMinutes",
    "closingAsOf",
    "closingBalanceMinutes",
    "closingConfirmed",
    "expectedMinutes",
    "personCount",
    "saldoPersonCount",
    "sickDays",
    "vacationApprovedDays",
    "vacationAsOf",
    "vacationEntitlementDays",
    "vacationTakenDays",
    "vacationYear",
    "workedMinutes",
  ],
  months: [
    { year: 2026, month: 6 },
    { year: 2026, month: 7 },
  ],
  rows: [
    {
      tag: "PA",
      hasRecordedTime: true,
      exitDay: null,
      workedMinutes: 2160,
      expectedMinutes: 21120,
      balanceMinutes: -18960,
      openingBalanceMinutes: -168960,
      closingBalanceMinutes: -181680,
      closingConfirmedMinutes: null,
      closingOpenMinutes: null,
      unconfirmedMonths: null,
      monthCount: 2,
      confirmedMonthCount: 0,
      labelled: true,
      sickDays: 0,
      months: [
        {
          year: 2026,
          month: 6,
          workedMinutes: 1680,
          expectedMinutes: 10080,
          balanceMinutes: -8400,
          closingBalanceMinutes: -177360,
          confirmed: false,
          labelled: true,
          sickDays: 0,
        },
        {
          year: 2026,
          month: 7,
          workedMinutes: 480,
          expectedMinutes: 11040,
          balanceMinutes: -10560,
          closingBalanceMinutes: -181680,
          confirmed: false,
          labelled: true,
          sickDays: 0,
        },
      ],
    },
    {
      tag: "PB",
      hasRecordedTime: true,
      exitDay: null,
      workedMinutes: 1200,
      expectedMinutes: 21600,
      balanceMinutes: -20400,
      openingBalanceMinutes: -168960,
      closingBalanceMinutes: -183120,
      closingConfirmedMinutes: null,
      closingOpenMinutes: null,
      unconfirmedMonths: null,
      monthCount: 2,
      confirmedMonthCount: 0,
      labelled: true,
      sickDays: 0,
      months: [
        {
          year: 2026,
          month: 6,
          workedMinutes: 1200,
          expectedMinutes: 10560,
          balanceMinutes: -9360,
          closingBalanceMinutes: -178320,
          confirmed: false,
          labelled: true,
          sickDays: 0,
        },
        {
          year: 2026,
          month: 7,
          workedMinutes: 0,
          expectedMinutes: 11040,
          balanceMinutes: -11040,
          closingBalanceMinutes: -183120,
          confirmed: false,
          labelled: true,
          sickDays: 0,
        },
      ],
    },
    {
      tag: "PN",
      hasRecordedTime: true,
      exitDay: null,
      workedMinutes: 480,
      expectedMinutes: 21600,
      balanceMinutes: -21120,
      openingBalanceMinutes: -168960,
      closingBalanceMinutes: -183840,
      closingConfirmedMinutes: null,
      closingOpenMinutes: null,
      unconfirmedMonths: null,
      monthCount: 2,
      confirmedMonthCount: 0,
      labelled: true,
      sickDays: 0,
      months: [
        {
          year: 2026,
          month: 6,
          workedMinutes: 480,
          expectedMinutes: 10560,
          balanceMinutes: -10080,
          closingBalanceMinutes: -179040,
          confirmed: false,
          labelled: true,
          sickDays: 0,
        },
        {
          year: 2026,
          month: 7,
          workedMinutes: 0,
          expectedMinutes: 11040,
          balanceMinutes: -11040,
          closingBalanceMinutes: -183840,
          confirmed: false,
          labelled: true,
          sickDays: 0,
        },
      ],
    },
    {
      tag: "PX",
      hasRecordedTime: true,
      exitDay: null,
      workedMinutes: 1920,
      expectedMinutes: 17760,
      balanceMinutes: -15840,
      openingBalanceMinutes: -168960,
      closingBalanceMinutes: -178560,
      closingConfirmedMinutes: null,
      closingOpenMinutes: null,
      unconfirmedMonths: null,
      monthCount: 2,
      confirmedMonthCount: 0,
      labelled: true,
      sickDays: 11,
      months: [
        {
          year: 2026,
          month: 6,
          workedMinutes: 1920,
          expectedMinutes: 6720,
          balanceMinutes: -4800,
          closingBalanceMinutes: -173760,
          confirmed: false,
          labelled: true,
          sickDays: 11,
        },
        {
          year: 2026,
          month: 7,
          workedMinutes: 0,
          expectedMinutes: 11040,
          balanceMinutes: -11040,
          closingBalanceMinutes: -178560,
          confirmed: false,
          labelled: true,
          sickDays: 0,
        },
      ],
    },
  ],
  vacation: [
    {
      tag: "PA",
      year: 2026,
      entitlementDays: 30,
      carriedOverDays: 0,
      carriedOverEffectiveDays: 0,
      carriedOverExpiredDays: 0,
      exitReductionDays: 0,
      availableDays: 30,
      takenDays: 1,
      approvedUpcomingDays: 0,
      pendingDays: 0,
      remainingDays: 29,
      atRiskDays: 0,
      carryOverDeadline: null,
      lastWarningSentAt: null,
      missingEntitlement: false,
      entitlementWarning: null,
    },
    {
      tag: "PB",
      year: 2026,
      entitlementDays: 30,
      carriedOverDays: 0,
      carriedOverEffectiveDays: 0,
      carriedOverExpiredDays: 0,
      exitReductionDays: 0,
      availableDays: 30,
      takenDays: 0,
      approvedUpcomingDays: 0,
      pendingDays: 0,
      remainingDays: 30,
      atRiskDays: 0,
      carryOverDeadline: null,
      lastWarningSentAt: null,
      missingEntitlement: false,
      entitlementWarning: null,
    },
    {
      tag: "PN",
      year: 2026,
      entitlementDays: 30,
      carriedOverDays: 0,
      carriedOverEffectiveDays: 0,
      carriedOverExpiredDays: 0,
      exitReductionDays: 0,
      availableDays: 30,
      takenDays: 0,
      approvedUpcomingDays: 0,
      pendingDays: 0,
      remainingDays: 30,
      atRiskDays: 0,
      carryOverDeadline: null,
      lastWarningSentAt: null,
      missingEntitlement: false,
      entitlementWarning: null,
    },
    {
      tag: "PX",
      year: 2026,
      entitlementDays: 30,
      carriedOverDays: 0,
      carriedOverEffectiveDays: 0,
      carriedOverExpiredDays: 0,
      exitReductionDays: 0,
      availableDays: 30,
      takenDays: 2,
      approvedUpcomingDays: 0,
      pendingDays: 0,
      remainingDays: 28,
      atRiskDays: 0,
      carryOverDeadline: null,
      lastWarningSentAt: null,
      missingEntitlement: false,
      entitlementWarning: null,
    },
  ],
  absences: [
    { code: "VACATION", unit: "WORKDAYS", personCount: 2, totalDays: 3 },
    { code: "SICK", unit: "CALENDAR_DAYS", personCount: 1, totalDays: 11 },
  ],
};

const round2 = (n: number): number => Math.round(n * 100) / 100;
const byText = (a: string, b: string): number => a.localeCompare(b);

describe("Issue #612 — the period report follows the chosen salon (#542 rules)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let foreign: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: string;
  let salonB: string;
  let inactiveSalon: string;
  const ids = {} as Record<"PA" | "PB" | "PX" | "PN", string>;
  let scopedToken: string;

  function entry(employeeId: string, salonId: string, date: string, start: string, end: string) {
    return app.prisma.timeEntry.create({
      data: {
        employeeId,
        salonId,
        date: new Date(`${date}T00:00:00Z`),
        startTime: new Date(`${date}T${start}:00Z`),
        endTime: new Date(`${date}T${end}:00Z`),
        breakMinutes: 0,
        type: "WORK",
        source: "MANUAL",
      },
    });
  }
  function get(url: string, token = data.adminToken) {
    return app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  }
  async function period(query: string, token = data.adminToken): Promise<Period> {
    const res = await get(`/api/v1/reports/period?${query}`, token);
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as Period;
  }
  async function monthly(
    year: number,
    month: number,
    salonId: string,
    token = data.adminToken,
  ): Promise<MonthlyRow[]> {
    const res = await get(
      `/api/v1/reports/monthly?year=${year}&month=${month}&salonId=${salonId}`,
      token,
    );
    expect(res.statusCode, res.body).toBe(200);
    return (JSON.parse(res.body) as { rows: MonthlyRow[] }).rows;
  }
  const rowIds = (r: Period): string[] => r.rows.map((x) => x.employeeId).sort(byText);
  const rowOf = (r: Period, id: string): Row => {
    const row = r.rows.find((x) => x.employeeId === id);
    if (!row) throw new Error(`row ${id} missing`);
    return row;
  };
  const vacationRows = (r: Period): VacationRow[] =>
    r.vacation.years.find((y) => y.year === 2026)?.rows ?? [];

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(FAKE_NOW));
    app = await getTestApp();
    data = await seedTestData(app, "rps612");
    foreign = await seedTestData(app, "rps612f");
    salonA = data.salonId;
    salonB = (await createTestSalon(app.prisma, data.tenant.id, { name: "Period612 Filter B" })).id;
    inactiveSalon = (
      await createTestSalon(app.prisma, data.tenant.id, {
        name: "Period612 Filter off",
        isActive: false,
      })
    ).id;

    const hire = new Date("2025-01-01T00:00:00Z");
    const mk = async (tag: "PA" | "PB" | "PX" | "PN", salonId: string) => {
      const p = await createPopulationPerson(app, {
        tenantId: data.tenant.id,
        salonId,
        tag,
        hireDate: hire,
      });
      ids[tag] = p.employeeId;
      await app.prisma.leaveEntitlement.create({
        data: {
          employeeId: p.employeeId,
          leaveTypeId: data.vacationType.id,
          year: 2026,
          totalDays: 30,
          usedDays: 0,
        },
      });
    };
    await mk("PA", salonA);
    await mk("PB", salonB);
    await mk("PX", salonB);
    await mk("PN", salonB);

    await app.prisma.employeeSalonAssignment.updateMany({
      where: { employeeId: ids.PX, kind: "HOME" },
      data: { validUntil: new Date("2026-06-15T00:00:00Z") },
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId: ids.PX,
        salonId: salonA,
        kind: "HOME",
        validFrom: new Date("2026-06-16T00:00:00Z"),
        validUntil: null,
        weekdays: [],
      },
    });

    for (const d of ["2026-06-01", "2026-06-02", "2026-06-03"]) {
      await entry(ids.PA, salonA, d, "08:00", "16:00");
    }
    await entry(ids.PA, salonB, "2026-06-04", "08:00", "12:00");
    await entry(ids.PB, salonA, "2026-06-08", "08:00", "12:00");
    await entry(ids.PB, salonB, "2026-06-09", "08:00", "16:00");
    await entry(ids.PB, salonB, "2026-06-10", "08:00", "16:00");
    await entry(ids.PX, salonB, "2026-06-01", "08:00", "16:00");
    await entry(ids.PX, salonB, "2026-06-02", "08:00", "16:00");
    await entry(ids.PX, salonA, "2026-06-22", "08:00", "16:00");
    await entry(ids.PX, salonA, "2026-06-23", "08:00", "16:00");
    await entry(ids.PN, salonB, "2026-06-05", "08:00", "16:00");
    await entry(ids.PA, salonA, "2026-07-14", "08:00", "16:00");
    await entry(ids.PA, salonA, "2026-07-15", "08:00", "16:00");

    const sick = await app.prisma.leaveType.create({
      data: { tenantId: data.tenant.id, ...leaveTypeFields("SICK"), color: "#EF4444" },
    });
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: ids.PX,
        leaveTypeId: sick.id,
        startDate: new Date("2026-06-10T00:00:00Z"),
        endDate: new Date("2026-06-20T00:00:00Z"),
        days: 7,
        status: "APPROVED",
        attestPresent: false,
      },
    });
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: ids.PX,
        leaveTypeId: data.vacationType.id,
        startDate: new Date("2026-06-18T00:00:00Z"),
        endDate: new Date("2026-06-19T00:00:00Z"),
        days: 2,
        status: "APPROVED",
      },
    });
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: ids.PA,
        leaveTypeId: data.vacationType.id,
        startDate: new Date("2026-06-12T00:00:00Z"),
        endDate: new Date("2026-06-12T00:00:00Z"),
        days: 1,
        status: "APPROVED",
      },
    });

    // A caller scoped to salon A (report:read only), an employee of its own without a Stammsalon.
    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    const suffix = `scoped-${randomBytes(3).toString("hex")}`;
    const user = await app.prisma.user.create({
      data: {
        email: `rps612-${suffix}@example.invalid`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `RPS${suffix}`.toUpperCase().slice(0, 20),
        firstName: "Fixture",
        lastName: "PeriodSalon612",
        hireDate: new Date("2024-01-01"),
      },
    });
    const name = `Period612 salon ${suffix}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId: data.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions(["report:read:ZUGEWIESEN"]),
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        accessRoleId: role.id,
        scopeType: "SALONS",
        salonIds: [salonA],
        employeeIds: [],
      },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: user.email, password: PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);
    scopedToken = (JSON.parse(login.body) as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: data.tenant.id } });
      await app.prisma.accessRole.deleteMany({ where: { tenantId: data.tenant.id } });
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, foreign.tenant.id);
    } catch (err) {
      console.error("reports-period-salon-612 cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("under a filter", () => {
    it("lists the persons of salon A with the months they belong to", async () => {
      const r = await period(`from=2026-06&to=2026-07&salonId=${salonA}`);
      expect(rowIds(r)).toEqual([ids.PA, ids.PB, ids.PX].sort(byText));
      expect(rowOf(r, ids.PA).months.map((m) => m.month)).toEqual([6, 7]);
      expect(rowOf(r, ids.PX).months.map((m) => m.month)).toEqual([6, 7]);
      // PB recorded time in A only in June and is homed in B: no July month.
      expect(rowOf(r, ids.PB).months.map((m) => m.month)).toEqual([6]);
    });

    it("every month equals the row of the filtered GET /reports/monthly (Ist hours, sick days)", async () => {
      const r = await period(`from=2026-06&to=2026-07&salonId=${salonA}`);
      let compared = 0;
      for (const [month, hours] of [
        [6, await monthly(2026, 6, salonA)],
        [7, await monthly(2026, 7, salonA)],
      ] as const) {
        for (const m of hours) {
          const row = r.rows.find((x) => x.employeeId === m.employeeId);
          const entryOfMonth = row?.months.find((x) => x.month === month);
          expect(entryOfMonth, `${m.employeeId} ${month}`).toBeDefined();
          expect(round2(entryOfMonth!.workedMinutes / 60), `Ist ${m.employeeId} ${month}`).toBe(
            m.workedHours,
          );
          expect(entryOfMonth!.sickDays, `sick ${m.employeeId} ${month}`).toBe(m.sickDays);
          compared += 1;
        }
      }
      expect(compared).toBeGreaterThanOrEqual(5);
      // The fixture's concrete figures: 24 h, 4 h (PB), 16 h (PX) in June; 8 h (PA) through yesterday in July.
      expect(rowOf(r, ids.PA).months[0].workedMinutes).toBe(24 * 60);
      expect(rowOf(r, ids.PB).months[0].workedMinutes).toBe(4 * 60);
      expect(rowOf(r, ids.PX).months[0].workedMinutes).toBe(16 * 60);
      expect(rowOf(r, ids.PA).months[1].workedMinutes).toBe(8 * 60);
      expect(rowOf(r, ids.PX).months[0].sickDays).toBe(5);
    });

    it("withholds Soll and saldo with the reason and adds exactly the four envelope keys", async () => {
      const filtered = await period(`from=2026-06&to=2026-07&salonId=${salonA}`);
      const plain = await period(`from=2026-06&to=2026-07`);
      for (const row of filtered.rows) {
        expect(row.expectedMinutes).toBeNull();
        expect(row.balanceMinutes).toBeNull();
        expect(row.openingBalanceMinutes).toBeNull();
        expect(row.closingBalanceMinutes).toBeNull();
        expect(row.closingConfirmedMinutes).toBeNull();
        expect(row.closingOpenMinutes).toBeNull();
        expect(row.unconfirmedMonths).toBeNull();
        expect(row.sollUnavailableReason).toBe("SALON_FILTER");
        for (const m of row.months) {
          expect(m.expectedMinutes).toBeNull();
          expect(m.balanceMinutes).toBeNull();
          expect(m.closingBalanceMinutes).toBeNull();
        }
      }
      expect(filtered.salonId).toBe(salonA);
      expect(filtered.workedBasis).toBe("SALON_ENTRIES");
      expect(filtered.sollUnavailableReason).toBe("SALON_FILTER");
      expect(filtered.leaveDaysUnavailableReason).toBe("SALON_FILTER");
      const added = Object.keys(filtered).filter((k) => !(k in plain));
      expect(added.sort(byText)).toEqual(
        ["leaveDaysUnavailableReason", "salonId", "sollUnavailableReason", "workedBasis"].sort(
          byText,
        ),
      );
      for (const k of ["salonId", "workedBasis", "leaveDaysUnavailableReason"]) {
        expect(k in plain, `${k} absent without a filter`).toBe(false);
      }
    });

    it("keeps only the sick row in the absence statistics and nulls the saldo KPIs", async () => {
      const filtered = await period(`from=2026-06&to=2026-07&salonId=${salonA}`);
      const plain = await period(`from=2026-06&to=2026-07`);
      expect(filtered.absences.map((a) => a.code)).toEqual(["SICK"]);
      // PX counts 5 sick days in A (Stammsalon per day), 11 without a filter.
      expect(filtered.absences[0].totalDays).toBe(5);
      expect(plain.absences.map((a) => a.code)).toEqual(["VACATION", "SICK"]);
      expect(filtered.kpis.expectedMinutes).toBeNull();
      expect(filtered.kpis.balanceMinutes).toBeNull();
      expect(filtered.kpis.closingBalanceMinutes).toBeNull();
      expect(filtered.kpis.saldoPersonCount).toBe(0);
      expect(filtered.kpis.personCount).toBe(3);
    });

    it("lists as vacation rows the persons homed in the salon at the period end, with whole personal values", async () => {
      const filtered = await period(`from=2026-06&to=2026-07&salonId=${salonA}`);
      const plain = await period(`from=2026-06&to=2026-07`);
      const mine = vacationRows(filtered).filter((x) => !x.missingEntitlement);
      // PA (A) and PX (A since 16.6.); PB, PN (B) and the seed employee (no Stammsalon) are out.
      expect(mine.map((x) => x.employeeId).sort(byText)).toEqual([ids.PA, ids.PX].sort(byText));
      expect(vacationRows(filtered).filter((x) => x.missingEntitlement)).toEqual([]);
      const plainById = new Map(vacationRows(plain).map((x) => [x.employeeId, x]));
      for (const row of mine) expect(row).toEqual(plainById.get(row.employeeId));
      // Not vacuous: the unfiltered table holds more persons than the filtered one.
      expect(vacationRows(plain).length).toBeGreaterThan(mine.length);
      const pa = mine.find((x) => x.employeeId === ids.PA)!;
      expect(pa.takenDays).toBe(1);
      expect(filtered.kpis.vacationTakenDays).toBe(
        round2(mine.reduce((s, x) => s + Number(x.takenDays ?? 0), 0)),
      );
      expect(filtered.kpis.vacationEntitlementDays).toBe(60);
    });
  });

  describe("one 404", () => {
    it("is the same body for a foreign, unknown and inactive salon and for a salon outside the reach, equal to /reports/monthly", async () => {
      const cases: Array<{ label: string; salonId: string; token: string }> = [
        { label: "foreign tenant", salonId: foreign.salonId as string, token: data.adminToken },
        { label: "unknown", salonId: randomUUID(), token: data.adminToken },
        { label: "inactive", salonId: inactiveSalon, token: data.adminToken },
        { label: "outside the reach", salonId: salonB, token: scopedToken },
      ];
      const bodies: string[] = [];
      for (const c of cases) {
        const res = await get(
          `/api/v1/reports/period?from=2026-06&to=2026-07&salonId=${c.salonId}`,
          c.token,
        );
        expect(res.statusCode, c.label).toBe(404);
        const monthlyRes = await get(
          `/api/v1/reports/monthly?year=2026&month=6&salonId=${c.salonId}`,
          c.token,
        );
        expect(monthlyRes.statusCode, c.label).toBe(404);
        expect(res.body, `${c.label} equals /monthly`).toBe(monthlyRes.body);
        bodies.push(res.body);
      }
      expect(new Set(bodies).size).toBe(1);
      expect(bodies[0]).toBe(NOT_FOUND);
      console.info(`[612-02] 404 body: ${bodies[0]} (${Buffer.byteLength(bodies[0])} bytes) x4`);
    });

    it("answers 400 for a malformed salon id", async () => {
      const res = await get(`/api/v1/reports/period?from=2026-06&to=2026-07&salonId=not-a-uuid`);
      expect(res.statusCode, res.body).toBe(400);
    });
  });

  describe("never wider", () => {
    it("a SALONS[A] caller's filtered rows are a subset of its unfiltered rows", async () => {
      const plain = await period(`from=2026-06&to=2026-07`, scopedToken);
      const filtered = await period(`from=2026-06&to=2026-07&salonId=${salonA}`, scopedToken);
      expect(rowIds(plain)).toEqual([ids.PA, ids.PX].sort(byText));
      expect(rowIds(filtered)).toEqual([ids.PA, ids.PX].sort(byText));
      for (const id of rowIds(filtered)) expect(rowIds(plain)).toContain(id);
      // PB: homed in B with an entry in A - reachable through neither the scope nor the filter.
      expect(rowIds(filtered)).not.toContain(ids.PB);
      const vacation = vacationRows(filtered).map((x) => x.employeeId);
      for (const id of vacation) expect([ids.PA, ids.PX]).toContain(id);
    });
  });

  describe("without a filter", () => {
    // The unfiltered answer of the fixture persons, recorded with the code BEFORE the salon filter
    // existed (commit 548a5e79, the end of task 1) and normalised: ids, numbers and names are
    // replaced by the fixture tags. Printed by CLOKR_PRINT_PERIOD_GOLDEN=1 against that commit.
    const tagOf = () =>
      new Map<string, string>([
        [ids.PA, "PA"],
        [ids.PB, "PB"],
        [ids.PX, "PX"],
        [ids.PN, "PN"],
      ]);
    function goldenOf(r: Period): unknown {
      const tags = tagOf();
      const strip = <T extends Record<string, unknown>>(o: T) => {
        const copy: Record<string, unknown> = { ...o };
        for (const k of ["employeeId", "employeeNumber", "employeeName", "entitlementId"]) {
          delete copy[k];
        }
        return copy;
      };
      return {
        envelopeKeys: Object.keys(r).sort(byText),
        kpiKeys: Object.keys(r.kpis).sort(byText),
        months: r.months,
        rows: r.rows
          .filter((x) => tags.has(x.employeeId))
          .map((x) => ({ tag: tags.get(x.employeeId), ...strip(x) })),
        vacation: vacationRows(r)
          .filter((x) => tags.has(x.employeeId))
          .map((x) => ({ tag: tags.get(x.employeeId), ...strip(x) })),
        absences: r.absences,
      };
    }

    it("is deep-equal to the answer recorded before the salon filter existed", async () => {
      const r = await period(`from=2026-06&to=2026-07`);
      const actual = goldenOf(r);
      if (process.env.CLOKR_PRINT_PERIOD_GOLDEN === "1") {
        console.info(`GOLDEN_BEGIN${JSON.stringify(actual)}GOLDEN_END`);
      }
      expect(actual).toEqual(GOLDEN_UNFILTERED);
    });

    it("carries none of the additive keys and keeps Soll and saldo", async () => {
      const r = await period(`from=2026-06&to=2026-07`);
      for (const k of [
        "salonId",
        "workedBasis",
        "sollUnavailableReason",
        "leaveDaysUnavailableReason",
      ]) {
        expect(k in r, k).toBe(false);
      }
      expect(typeof rowOf(r, ids.PA).expectedMinutes).toBe("number");
      expect(rowOf(r, ids.PX).sickDays).toBe(11);
      expect(rowIds(r)).toEqual(expect.arrayContaining([ids.PA, ids.PB, ids.PX, ids.PN]));
    });
  });
});
