/**
 * Issue #612 (P-06, D-612-1, T-612-07..09), rule paragraph replaced by Issue #714 (owner decision
 * 19.10.2026) — `GET /api/v1/reports/period?salonId=`: one 404 for every inadmissible salon (#542
 * rules), never wider than the caller's reach, and, since #714, ONE circle under a filter: the
 * persons whose Stammsalon is the salon at the period Stichtag (the exit day for an exit inside the
 * period, else the period's last day), each with the WHOLE figures of the unfiltered answer (Soll,
 * Ist, saldo, status, sick days, every absence kind). Nothing is split by salon; the vacation tables
 * list exactly the persons that have a row.
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
  salonWorkedMinutes?: number;
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
  salonWorkedMinutes?: number;
  months: MonthEntry[];
};
type Helper = {
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  salonWorkedMinutes: number;
};
type VacationRow = Record<string, unknown> & { employeeId: string; missingEntitlement: boolean };
type Period = Record<string, unknown> & {
  kpis: Record<string, number | string | boolean | null>;
  rows: Row[];
  helpers?: Helper[];
  withoutHomeSalonCount?: number;
  helpersReach?: string;
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
// Issue #714 (plan 02): a filtered row adds ONLY the salon viewpoint `salonWorkedMinutes` (row and
// months) to the whole person; stripped here, every other value must equal the unfiltered row.
const withoutSalonMinutes = (row: Row): Row => {
  const copy = { ...row, months: row.months.map((m) => ({ ...m })) };
  delete copy.salonWorkedMinutes;
  for (const m of copy.months) delete m.salonWorkedMinutes;
  return copy;
};
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
    it("lists the persons homed in salon A at the period end with the months they belong to", async () => {
      const r = await period(`from=2026-06&to=2026-07&salonId=${salonA}`);
      // PA (A) and PX (A since 16.6.); PB is homed in B and is no row any more (owner decision #714).
      expect(rowIds(r)).toEqual([ids.PA, ids.PX].sort(byText));
      expect(rowOf(r, ids.PA).months.map((m) => m.month)).toEqual([6, 7]);
      expect(rowOf(r, ids.PX).months.map((m) => m.month)).toEqual([6, 7]);
    });

    // Old rule (#612): every month equalled the row of the filtered GET /reports/monthly (Ist = the
    // salon's entries). Owner decision #714: a filtered row is the whole person. The salon-Ist parity
    // with the filtered /reports/monthly returns in 714-02 as "Im Salon gearbeitet equals the Ist of
    // the filtered /reports/monthly"; it is not dropped.
    it("every filtered row equals the unfiltered row of the same person (whole personal values)", async () => {
      const filtered = await period(`from=2026-06&to=2026-07&salonId=${salonA}`);
      const plain = await period(`from=2026-06&to=2026-07`);
      expect(filtered.rows.length).toBe(2);
      for (const row of filtered.rows) {
        // owner decision #714: the whole person, plus the separate salon viewpoint (plan 02).
        expect(withoutSalonMinutes(row)).toEqual(rowOf(plain, row.employeeId));
        expect(row.sollUnavailableReason).toBeUndefined();
      }
      // The fixture's concrete whole figures: PX counts all 11 sick days (not 5 of one salon).
      expect(rowOf(filtered, ids.PX).sickDays).toBe(11);
      expect(typeof rowOf(filtered, ids.PA).expectedMinutes).toBe("number");
      expect(typeof rowOf(filtered, ids.PA).closingBalanceMinutes).toBe("number");
      // PA: 24 h + 4 h in June (both salons, whole person), 8 h through yesterday in July.
      expect(rowOf(filtered, ids.PA).months[0].workedMinutes).toBe(28 * 60);
      expect(rowOf(filtered, ids.PA).months[1].workedMinutes).toBe(8 * 60);
    });

    it("shows Soll and saldo of the Stammsalon persons and adds exactly the salon-view keys", async () => {
      const filtered = await period(`from=2026-06&to=2026-07&salonId=${salonA}`);
      const plain = await period(`from=2026-06&to=2026-07`);
      for (const row of filtered.rows) {
        expect(typeof row.expectedMinutes).toBe("number");
        expect(typeof row.balanceMinutes).toBe("number");
        expect(typeof row.closingBalanceMinutes).toBe("number");
        expect("sollUnavailableReason" in row).toBe(false);
        for (const m of row.months) {
          expect(typeof m.expectedMinutes).toBe("number");
          expect(typeof m.balanceMinutes).toBe("number");
          expect(typeof m.closingBalanceMinutes).toBe("number");
        }
      }
      expect(filtered.salonId).toBe(salonA);
      expect(filtered.personBasis).toBe("HOME_SALON_AT_PERIOD_END");
      for (const k of ["workedBasis", "sollUnavailableReason", "leaveDaysUnavailableReason"]) {
        expect(k in filtered, `${k} gone under a filter`).toBe(false);
      }
      const added = Object.keys(filtered).filter((k) => !(k in plain));
      // owner decision #714 (plan 02): the salon viewpoint adds helpers and the reach kind.
      expect(added.sort(byText)).toEqual(
        ["helpers", "helpersReach", "personBasis", "salonId", "withoutHomeSalonCount"].sort(byText),
      );
      for (const k of [
        "salonId",
        "personBasis",
        "helpers",
        "helpersReach",
        "withoutHomeSalonCount",
      ]) {
        expect(k in plain, `${k} absent without a filter`).toBe(false);
      }
    });

    // The property of the old #612 case "every month equals the row of the filtered /reports/monthly",
    // kept for the one figure that is still a salon figure: Ist in the salon (owner decision #714).
    it("Im Salon gearbeitet equals the Ist of the filtered /reports/monthly for every person-month", async () => {
      const filtered = await period(`from=2026-06&to=2026-07&salonId=${salonA}`);
      const m6 = await monthly(2026, 6, salonA);
      const m7 = await monthly(2026, 7, salonA);
      const monthlyBy = (rows: MonthlyRow[], id: string): MonthlyRow | undefined =>
        rows.find((r) => r.employeeId === id);
      const compared: string[] = [];
      for (const row of filtered.rows) {
        expect(typeof row.salonWorkedMinutes).toBe("number");
        let monthSum = 0;
        for (const month of row.months) {
          const mRow = monthlyBy(month.month === 6 ? m6 : m7, row.employeeId);
          expect(mRow, `monthly row ${row.employeeId} ${month.month}`).toBeDefined();
          expect(
            round2((month.salonWorkedMinutes ?? NaN) / 60),
            `person-month ${month.month}`,
          ).toBe(mRow!.workedHours);
          compared.push(`${month.month}:${month.salonWorkedMinutes}/${mRow!.workedHours}`);
          monthSum += month.salonWorkedMinutes ?? 0;
        }
        expect(row.salonWorkedMinutes).toBe(monthSum);
      }
      // PA June 1440, July 480; PX June 960, July 0 (A entries 22./23.6.).
      expect(rowOf(filtered, ids.PA).months.map((m) => m.salonWorkedMinutes)).toEqual([1440, 480]);
      expect(rowOf(filtered, ids.PX).months.map((m) => m.salonWorkedMinutes)).toEqual([960, 0]);
      // PB is homed in B with a 4 h entry in A: a helper, never a row.
      expect(filtered.helpers).toEqual([
        {
          employeeId: ids.PB,
          employeeName: expect.any(String),
          employeeNumber: expect.any(String),
          salonWorkedMinutes: 240,
        },
      ]);
      const helperMonthly = [...m6, ...m7]
        .filter((r) => r.employeeId === ids.PB)
        .reduce((s, r) => s + r.workedHours * 60, 0);
      expect(filtered.helpers![0].salonWorkedMinutes).toBe(helperMonthly);
      expect(filtered.kpis.salonWorkedMinutes).toBe(3120);
      console.info(`[714-02] salon A person-months (period / monthly h): ${compared.join(" ")}`);
    });

    it("a helper object has exactly the four identity-and-minutes keys and the caller's reach kind is named", async () => {
      const filtered = await period(`from=2026-06&to=2026-07&salonId=${salonA}`);
      expect(filtered.helpers!.length).toBeGreaterThan(0);
      for (const h of filtered.helpers!) {
        expect(Object.keys(h).sort(byText)).toEqual(
          ["employeeId", "employeeName", "employeeNumber", "salonWorkedMinutes"].sort(byText),
        );
      }
      expect(filtered.helpersReach).toBe("WHOLE_TENANT");
      const scoped = await period(`from=2026-06&to=2026-07&salonId=${salonA}`, scopedToken);
      const scopedPlain = await period(`from=2026-06&to=2026-07`, scopedToken);
      expect(scoped.helpersReach).toBe("SCOPED");
      // Never wider: every helper of a scoped caller lies inside its unfiltered rows.
      for (const h of scoped.helpers!) expect(rowIds(scopedPlain)).toContain(h.employeeId);
      expect(scoped.helpers!.map((h) => h.employeeId)).not.toContain(ids.PB);
      // The KPI is Σ rows + Σ helpers in both answers.
      for (const a of [filtered, scoped]) {
        const sum =
          a.rows.reduce((s, r) => s + (r.salonWorkedMinutes ?? 0), 0) +
          a.helpers!.reduce((s, h) => s + h.salonWorkedMinutes, 0);
        expect(a.kpis.salonWorkedMinutes).toBe(sum);
      }
    });

    it("counts the persons without a Stammsalon at the period end and does not leak the number to a scoped caller", async () => {
      const plain = await period(`from=2026-06&to=2026-07`);
      const salonPersons = Object.values(ids);
      // Measured: the unfiltered rows that are not one of the four fixture persons (the seed's two
      // employees and the scoped caller's own employee), each without any HOME assignment.
      const others = rowIds(plain).filter((id) => !salonPersons.includes(id));
      const homeRows = await app.prisma.employeeSalonAssignment.count({
        where: { employeeId: { in: others }, kind: "HOME" },
      });
      expect(homeRows).toBe(0);
      expect(others.length).toBe(3);
      for (const salonId of [salonA, salonB]) {
        const filtered = await period(`from=2026-06&to=2026-07&salonId=${salonId}`);
        expect(filtered.withoutHomeSalonCount, `admin under ${salonId}`).toBe(others.length);
      }
      // A SALONS[A] caller's population is its reach: the tenant's no-Stammsalon persons are not in it.
      const scoped = await period(`from=2026-06&to=2026-07&salonId=${salonA}`, scopedToken);
      expect(scoped.withoutHomeSalonCount).toBe(0);
    });

    it("counts every absence kind of the Stammsalon persons and sums their saldo in the KPIs", async () => {
      const filtered = await period(`from=2026-06&to=2026-07&salonId=${salonA}`);
      const plain = await period(`from=2026-06&to=2026-07`);
      // Measured, never copied from a run: the unfiltered answers of exactly the two Stammsalon persons.
      const own = [
        await period(`from=2026-06&to=2026-07&employeeId=${ids.PA}`),
        await period(`from=2026-06&to=2026-07&employeeId=${ids.PX}`),
      ];
      const expectedAbsences = new Map<string, { personCount: number; totalDays: number }>();
      for (const answer of own) {
        for (const a of answer.absences) {
          const sum = expectedAbsences.get(a.code) ?? { personCount: 0, totalDays: 0 };
          sum.personCount += a.personCount;
          sum.totalDays = round2(sum.totalDays + a.totalDays);
          expectedAbsences.set(a.code, sum);
        }
      }
      expect(expectedAbsences.has("VACATION")).toBe(true);
      expect(expectedAbsences.has("SICK")).toBe(true);
      expect(filtered.absences.map((a) => a.code)).toEqual(plain.absences.map((a) => a.code));
      for (const a of filtered.absences) {
        expect(a.personCount, `personCount ${a.code}`).toBe(
          expectedAbsences.get(a.code)?.personCount,
        );
        expect(a.totalDays, `totalDays ${a.code}`).toBe(expectedAbsences.get(a.code)?.totalDays);
      }
      // PX counts 11 sick days whole, not 5 of one salon.
      expect(filtered.absences.find((a) => a.code === "SICK")?.totalDays).toBe(11);

      const two = [rowOf(plain, ids.PA), rowOf(plain, ids.PX)];
      const sumOf = (pick: (r: Row) => number | null): number =>
        two.reduce((s, r) => s + (pick(r) ?? 0), 0);
      expect(filtered.kpis.expectedMinutes).toBe(sumOf((r) => r.expectedMinutes));
      expect(filtered.kpis.balanceMinutes).toBe(sumOf((r) => r.balanceMinutes));
      expect(filtered.kpis.closingBalanceMinutes).toBe(sumOf((r) => r.closingBalanceMinutes));
      expect(filtered.kpis.saldoPersonCount).toBe(2);
      expect(filtered.kpis.personCount).toBe(2);
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
        "personBasis",
        "helpers",
        "helpersReach",
        "withoutHomeSalonCount",
        "workedBasis",
        "sollUnavailableReason",
        "leaveDaysUnavailableReason",
      ]) {
        expect(k in r, k).toBe(false);
      }
      expect(typeof rowOf(r, ids.PA).expectedMinutes).toBe("number");
      expect(rowOf(r, ids.PX).sickDays).toBe(11);
      // The salon viewpoint exists only under a filter: no row, month or KPI carries it.
      expect("salonWorkedMinutes" in r.kpis).toBe(false);
      for (const row of r.rows) {
        expect("salonWorkedMinutes" in row, "row").toBe(false);
        for (const m of row.months) expect("salonWorkedMinutes" in m, "month").toBe(false);
      }
      expect(rowIds(r)).toEqual(expect.arrayContaining([ids.PA, ids.PB, ids.PX, ids.PN]));
    });
  });
});
