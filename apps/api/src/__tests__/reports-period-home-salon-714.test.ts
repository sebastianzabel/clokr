/**
 * Issue #714 (D-01, D-02, D-10, D-12; AC-714-2, AC-714-3, AC-714-5) — under a salon filter
 * `GET /api/v1/reports/period` lists ONE circle: the persons whose Stammsalon is the salon at their
 * period Stichtag (the exit day for an exit inside the period, else the period's last day), each with
 * the whole figures of the unfiltered answer. This file proves it over HTTP on a world built for it.
 *
 * World (`Date` faked to 2026-03-16T10:00Z, tenant Europe/Berlin; February 2026 has 20 weekdays and
 * no statutory holiday; salons Sued = the seed's salon, Nord, West active, Alt inactive):
 *
 *   tag | Stammsalon                              | hire / exit        | what is recorded
 *   ----+-----------------------------------------+--------------------+---------------------------------
 *   SP  | Sued (the Springer)                     | hire 2026-02-01    | 8 h x 10 days in Sued (2.-6., 9.-13.2.),
 *       |                                         |                    | 8 h x 10 days in Nord (16.-20., 23.-27.2.)
 *   NS  | Nord                                    |                    | 2 Nord days in January, 2 in February
 *   WS  | West                                    |                    | West days, approved SICK 16.-17.2.
 *   MV  | Nord until 10.2., Sued from 11.2.       |                    | Nord days before, Sued days after
 *   OH  | no HOME row                             |                    | Nord days
 *   LV  | West until 20.1. (HOME validUntil)      | exit 2026-01-20    | West days in January
 *   IN  | Alt (inactive)                          | exit 2026-01-15    | Alt day in January
 *   EJ  | West (HOME left open)                   | exit 2026-01-10    | West day in January
 *   the seed's own employees (no HOME row, asserted)
 *
 * Parity is a property of a WHOLE-TENANT caller (P-714-09): a scoped caller's per-month reach (the
 * month Stichtag) and the circle (the period Stichtag) can differ for a mid-period mover; that is
 * stated, not hidden, and is not what this file measures.
 *
 * Mutation proofs (cp backup/restore, each run of this file alone; recorded in the plan SUMMARY):
 *   M1 `periodReachDay` always answers the period's last day            -> the LV case
 *   M2 the figure slots pushed only without a filter (the old guard)     -> whole-person and parity cases
 *   M3 `employees` = the whole population under a filter (no ∩)          -> disjointness / one-circle cases
 *   M4 vacation `onlyEmployeeIds` = the home set instead of the row ids  -> the EJ vacation case
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { createPopulationPerson } from "./population-fixtures-613";
import { leaveTypeFields } from "../contexts/absence/leave-type";
import { listSalons } from "../contexts/platform";
import { computeMonthReportFigures } from "../contexts/working-time-account";
import { salonPersonsAtStichtag } from "../composition/reports";

const FAKE_NOW = "2026-03-16T10:00:00.000Z";
const NOT_FOUND = '{"error":"Salon nicht gefunden"}';

type MonthEntry = { year: number; month: number } & Record<string, unknown>;
type Row = Record<string, unknown> & {
  employeeId: string;
  workedMinutes: number;
  expectedMinutes: number | null;
  balanceMinutes: number | null;
  closingBalanceMinutes: number | null;
  sickDays: number;
  sollUnavailableReason?: string;
  months: MonthEntry[];
};
type Helper = {
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  salonWorkedMinutes: number;
};
type VacationRow = Record<string, unknown> & {
  employeeId: string;
  missingEntitlement: boolean;
  takenDays: number | null;
  entitlementDays: number | null;
};
type Period = Record<string, unknown> & {
  kpis: Record<string, number | string | boolean | null>;
  rows: Row[];
  helpers?: Helper[];
  vacation: { years: Array<{ year: number; asOf: string; rows: VacationRow[] }> };
  absences: Array<{ code: string; unit: string; personCount: number; totalDays: number }>;
};

const TAGS = ["SP", "NS", "WS", "MV", "OH", "LV", "IN", "EJ"] as const;
type Tag = (typeof TAGS)[number];

const round2 = (n: number): number => Math.round(n * 100) / 100;
// Plan 714-02: a filtered row adds only the separate salon viewpoint `salonWorkedMinutes` (row and
// months) to the whole person; everything else must equal the unfiltered row.
const whole = (row: Row): Row => {
  const copy = { ...row, months: row.months.map((m) => ({ ...m })) } as Row & {
    salonWorkedMinutes?: number;
  };
  delete copy.salonWorkedMinutes;
  for (const m of copy.months) delete m.salonWorkedMinutes;
  return copy;
};
const byText = (a: string, b: string): number => a.localeCompare(b);
const sorted = (xs: Iterable<string>): string[] => [...xs].sort(byText);

describe("Issue #714 — the salon views of the period report add up to all salons", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let foreign: Awaited<ReturnType<typeof seedTestData>>;
  let sued: string;
  let nord: string;
  let west: string;
  let alt: string;
  let tenantId: string;
  const ids = {} as Record<Tag, string>;
  let activeSalonIds: string[] = [];

  function entry(
    employeeId: string,
    salonId: string,
    date: string,
    start = "08:00",
    end = "16:00",
  ) {
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
  const days = (from: string, to: string): string[] => {
    const out: string[] = [];
    for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`);) {
      out.push(d.toISOString().slice(0, 10));
      d = new Date(d.getTime() + 86_400_000);
    }
    return out;
  };
  const weekdays = (from: string, to: string): string[] =>
    days(from, to).filter((d) => {
      const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
      return dow !== 0 && dow !== 6;
    });

  async function get(url: string) {
    return app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
  }
  async function period(query: string): Promise<Period> {
    const res = await get(`/api/v1/reports/period?${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as Period;
  }
  const rowIds = (r: Period): string[] => sorted(r.rows.map((x) => x.employeeId));
  const rowOf = (r: Period, id: string): Row => {
    const row = r.rows.find((x) => x.employeeId === id);
    if (!row) throw new Error(`row ${id} missing`);
    return row;
  };
  const vacationRows = (r: Period): VacationRow[] =>
    r.vacation.years.find((y) => y.year === 2026)?.rows ?? [];
  const tagOf = (id: string): string => TAGS.find((t) => ids[t] === id) ?? id.slice(0, 8);

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(FAKE_NOW));
    app = await getTestApp();
    data = await seedTestData(app, "rph714");
    foreign = await seedTestData(app, "rph714f");
    tenantId = data.tenant.id;
    sued = data.salonId;
    nord = (await createTestSalon(app.prisma, tenantId, { name: "Home714 Nord" })).id;
    west = (await createTestSalon(app.prisma, tenantId, { name: "Home714 West" })).id;
    alt = (await createTestSalon(app.prisma, tenantId, { name: "Home714 Alt", isActive: false }))
      .id;
    activeSalonIds = (await listSalons(app.prisma, tenantId, { includeInactive: false })).map(
      (s) => s.id,
    );

    const old = new Date("2025-06-01T00:00:00Z");
    const mk = async (
      tag: Tag,
      salonId: string,
      opts: { hireDate?: Date; exitDate?: Date } = {},
    ) => {
      const p = await createPopulationPerson(app, {
        tenantId,
        salonId,
        tag,
        hireDate: opts.hireDate ?? old,
        exitDate: opts.exitDate ?? null,
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
    await mk("SP", sued, { hireDate: new Date("2026-02-01T00:00:00Z") });
    await mk("NS", nord);
    await mk("WS", west);
    await mk("MV", nord);
    await mk("OH", nord);
    await mk("LV", west, { exitDate: new Date("2026-01-20T12:00:00Z") });
    await mk("IN", alt, { exitDate: new Date("2026-01-15T12:00:00Z") });
    await mk("EJ", west, { exitDate: new Date("2026-01-10T12:00:00Z") });

    // MV moves Nord -> Sued on 11.2.; LV's Stammsalon ends on the exit day; OH never had one.
    await app.prisma.employeeSalonAssignment.updateMany({
      where: { employeeId: ids.MV, kind: "HOME" },
      data: { validUntil: new Date("2026-02-10T00:00:00Z") },
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId,
        employeeId: ids.MV,
        salonId: sued,
        kind: "HOME",
        validFrom: new Date("2026-02-11T00:00:00Z"),
        validUntil: null,
        weekdays: [],
      },
    });
    await app.prisma.employeeSalonAssignment.updateMany({
      where: { employeeId: ids.LV, kind: "HOME" },
      data: { validUntil: new Date("2026-01-20T00:00:00Z") },
    });
    await app.prisma.employeeSalonAssignment.deleteMany({ where: { employeeId: ids.OH } });

    // The Springer: 80 h in Sued and 80 h in Nord = the 160 h Soll of February.
    for (const d of weekdays("2026-02-02", "2026-02-13")) await entry(ids.SP, sued, d);
    for (const d of weekdays("2026-02-16", "2026-02-27")) await entry(ids.SP, nord, d);

    for (const d of ["2026-01-05", "2026-01-06", "2026-02-03", "2026-02-04"]) {
      await entry(ids.NS, nord, d);
    }
    for (const d of ["2026-01-12", "2026-01-13", "2026-02-10"]) await entry(ids.WS, west, d);
    for (const d of ["2026-02-02", "2026-02-03"]) await entry(ids.MV, nord, d);
    for (const d of ["2026-02-12", "2026-02-13"]) await entry(ids.MV, sued, d);
    for (const d of ["2026-01-07", "2026-02-05"]) await entry(ids.OH, nord, d);
    for (const d of ["2026-01-05", "2026-01-06"]) await entry(ids.LV, west, d);
    await entry(ids.IN, alt, "2026-01-05");
    await entry(ids.EJ, west, "2026-01-05");

    const sick = await app.prisma.leaveType.create({
      data: { tenantId, ...leaveTypeFields("SICK"), color: "#EF4444" },
    });
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: ids.WS,
        leaveTypeId: sick.id,
        startDate: new Date("2026-02-16T00:00:00Z"),
        endDate: new Date("2026-02-17T00:00:00Z"),
        days: 2,
        status: "APPROVED",
        attestPresent: false,
      },
    });
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, tenantId);
      await cleanupTestData(app, foreign.tenant.id);
    } catch (err) {
      console.error("reports-period-home-salon-714 cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("the world", () => {
    it("is not vacuous: three active salons, the inactive one is not listed, the seed employees have no Stammsalon", async () => {
      expect(sorted(activeSalonIds)).toEqual(sorted([sued, nord, west]));
      expect(activeSalonIds).not.toContain(alt);
      const seedIds = [data.adminEmployee.id, data.employee.id];
      const homeRows = await app.prisma.employeeSalonAssignment.count({
        where: { employeeId: { in: seedIds }, kind: "HOME" },
      });
      expect(homeRows).toBe(0);
      const ohHome = await app.prisma.employeeSalonAssignment.count({
        where: { employeeId: ids.OH },
      });
      expect(ohHome).toBe(0);
    });
  });

  describe("Σ over every salon + the persons without a Stammsalon = all salons (AC-714-2, D-12)", () => {
    const PERIOD = "from=2026-01&to=2026-02";

    it("the filtered rows are pairwise disjoint and, with the no-Stammsalon rows, are exactly the unfiltered rows", async () => {
      const plain = await period(PERIOD);
      const noHome = new Set([ids.OH, ids.IN, data.adminEmployee.id, data.employee.id]);
      const seen = new Map<string, string>();
      for (const salonId of activeSalonIds) {
        const filtered = await period(`${PERIOD}&salonId=${salonId}`);
        expect(filtered.rows.length, `rows of ${salonId}`).toBeGreaterThan(0);
        for (const row of filtered.rows) {
          expect(seen.has(row.employeeId), `${tagOf(row.employeeId)} in two salons`).toBe(false);
          expect(noHome.has(row.employeeId), `${tagOf(row.employeeId)} has no Stammsalon`).toBe(
            false,
          );
          seen.set(row.employeeId, salonId);
        }
      }
      expect(sorted([...seen.keys(), ...noHome])).toEqual(rowIds(plain));
      // The world's expectation by tag: who is homed where at the period Stichtag.
      expect(seen.get(ids.SP)).toBe(sued);
      expect(seen.get(ids.MV)).toBe(sued);
      expect(seen.get(ids.NS)).toBe(nord);
      expect(seen.get(ids.WS)).toBe(west);
      expect(seen.get(ids.LV)).toBe(west);
      expect(seen.get(ids.EJ)).toBe(west);
    });

    it("every KPI of the salons plus the no-Stammsalon rows equals the unfiltered KPI", async () => {
      const plain = await period(PERIOD);
      const noHomeIds = [ids.OH, ids.IN, data.adminEmployee.id, data.employee.id];
      const noHomeRows = noHomeIds.map((id) => rowOf(plain, id));
      const filtered = await Promise.all(
        activeSalonIds.map((salonId) => period(`${PERIOD}&salonId=${salonId}`)),
      );
      const keys = [
        "workedMinutes",
        "expectedMinutes",
        "balanceMinutes",
        "closingBalanceMinutes",
        "sickDays",
        "personCount",
        "saldoPersonCount",
      ] as const;
      const table: string[] = [];
      for (const key of keys) {
        const salonSum = filtered.reduce((s, f) => s + Number(f.kpis[key] ?? 0), 0);
        const noHomeSum = noHomeRows.reduce((s, r) => {
          if (key === "personCount") return s + 1;
          if (key === "saldoPersonCount")
            return s + (r.sollUnavailableReason === undefined ? 1 : 0);
          return s + Number(r[key] ?? 0);
        }, 0);
        expect(plain.kpis[key], `${key} is a number`).not.toBeNull();
        expect(round2(salonSum + noHomeSum), key).toBe(round2(Number(plain.kpis[key])));
        table.push(
          `${key}: salons ${filtered.map((f) => f.kpis[key]).join(" + ")} + no-home ${round2(noHomeSum)} = ${plain.kpis[key]}`,
        );
      }
      console.info(`[714-01] parity (minutes, days, persons)\n  ${table.join("\n  ")}`);
    });

    it("every filtered row is the whole person: deep-equal to the unfiltered row of the same person", async () => {
      const plain = await period(PERIOD);
      let compared = 0;
      for (const salonId of activeSalonIds) {
        const filtered = await period(`${PERIOD}&salonId=${salonId}`);
        for (const row of filtered.rows) {
          expect(whole(row), tagOf(row.employeeId)).toEqual(rowOf(plain, row.employeeId));
          expect(row.sollUnavailableReason).toBeUndefined();
          compared += 1;
        }
      }
      expect(compared).toBe(6);
    });
  });

  describe("no Scheinminus for the Springer (AC-714-5)", () => {
    const FEB = "from=2026-02&to=2026-02";

    it("shows 160 h Ist against 160 h Soll and a saldo of 0 in the Stammsalon, as the account states it", async () => {
      const r = await period(`${FEB}&salonId=${sued}`);
      const sp = rowOf(r, ids.SP);
      const account = await computeMonthReportFigures(app, ids.SP, 2026, 2);
      console.info(
        `[714-01] Springer in Sued: Ist ${sp.workedMinutes} Soll ${sp.expectedMinutes} saldo ${sp.balanceMinutes} closing ${sp.closingBalanceMinutes}; account Ist ${account.workedMinutes} Soll ${account.expectedMinutes} saldo ${account.balanceMinutes} closing ${account.closingBalanceMinutes}`,
      );
      expect(sp.workedMinutes).toBe(account.workedMinutes);
      expect(sp.expectedMinutes).toBe(account.expectedMinutes);
      expect(sp.balanceMinutes).toBe(account.balanceMinutes);
      expect(sp.closingBalanceMinutes).toBe(account.closingBalanceMinutes);
      expect(sp.workedMinutes).toBe(9600);
      expect(sp.expectedMinutes).toBe(9600);
      expect(sp.balanceMinutes).toBe(0);
      expect(sp.closingBalanceMinutes).toBe(0);
    });

    // Old rule (714-01): "nothing of the Nord answer names the Springer". Owner decision #714 (D-06,
    // D-07, plan 02): the 80 h the Springer worked in Nord ARE shown in Nord - as hours of a helper
    // and nothing else. The Scheinminus guard stays: no row, no Soll, no saldo of the Springer there.
    it("is no row in Nord and West; in Nord the Springer is only a helper with the hours worked there", async () => {
      const nordAnswer = await period(`${FEB}&salonId=${nord}`);
      const westAnswer = await period(`${FEB}&salonId=${west}`);
      for (const r of [nordAnswer, westAnswer]) {
        expect(rowIds(r)).not.toContain(ids.SP);
        expect(r.rows.length).toBeGreaterThan(0);
      }
      const helper = (nordAnswer.helpers as Helper[]).find((h) => h.employeeId === ids.SP);
      expect(helper).toBeDefined();
      expect(helper!.salonWorkedMinutes).toBe(4800);
      expect(Object.keys(helper!).sort(byText)).toEqual(
        ["employeeId", "employeeName", "employeeNumber", "salonWorkedMinutes"].sort(byText),
      );
      // The Springer's Soll, saldo and closing never show up in the Nord answer (no Scheinminus):
      // the only place the id occurs is the helper object.
      const withoutHelpers = { ...nordAnswer, helpers: [] };
      expect(JSON.stringify(withoutHelpers)).not.toContain(ids.SP);
      // West has no hour of the Springer at all.
      expect(JSON.stringify(westAnswer)).not.toContain(ids.SP);
    });

    it("shows the Springer's Sued hours as the row's salon viewpoint next to the whole 9600 minutes", async () => {
      const r = await period(`${FEB}&salonId=${sued}`);
      const sp = rowOf(r, ids.SP);
      expect(sp.salonWorkedMinutes).toBe(4800);
      expect(sp.workedMinutes).toBe(9600);
    });
  });

  describe("Im Salon gearbeitet (AC-714-4, D-06, D-07)", () => {
    const PERIOD = "from=2026-01&to=2026-02";

    it("Σ over the active salons of the KPI is every hour recorded in an active salon, Springer and Aushilfen included", async () => {
      const answers = await Promise.all(
        activeSalonIds.map((salonId) => period(`${PERIOD}&salonId=${salonId}`)),
      );
      // Measured from the rows the world created: closed WORK entries of the fixture persons in the
      // active salons through yesterday (the inactive Alt salon and every other tenant are out).
      const fixtureIds = Object.values(ids);
      const entries = await app.prisma.timeEntry.findMany({
        where: {
          employeeId: { in: fixtureIds },
          salonId: { in: activeSalonIds },
          deletedAt: null,
          type: "WORK",
          endTime: { not: null },
          date: { lte: new Date("2026-03-15T00:00:00Z") },
        },
      });
      const expected = entries.reduce(
        (sum, t) => sum + (t.endTime!.getTime() - t.startTime.getTime()) / 60_000,
        0,
      );
      expect(entries.length).toBeGreaterThan(0);
      const perSalon = answers.map((a) => a.kpis.salonWorkedMinutes);
      expect(perSalon.reduce((s: number, x) => s + Number(x), 0)).toBe(expected);
      // Every KPI = Σ its rows + Σ its helpers.
      for (const a of answers) {
        const sum =
          a.rows.reduce((s, r) => s + Number(r.salonWorkedMinutes ?? 0), 0) +
          (a.helpers ?? []).reduce((s, h) => s + h.salonWorkedMinutes, 0);
        expect(a.kpis.salonWorkedMinutes).toBe(sum);
      }
      console.info(
        `[714-02] salon hours per salon (Sued, Nord, West): ${perSalon.join(" + ")} = ${expected}`,
      );
    });

    it("lists the Springer in Nord with 4800 minutes, MV and OH with their Nord hours, and nobody of the circle", async () => {
      const feb = await period(`from=2026-02&to=2026-02&salonId=${nord}`);
      const helpers = feb.helpers as Helper[];
      const minutesOf = (id: string): number | undefined =>
        helpers.find((h) => h.employeeId === id)?.salonWorkedMinutes;
      expect(minutesOf(ids.SP)).toBe(4800);
      expect(minutesOf(ids.MV)).toBe(2 * 480); // Nord days 2./3.2. before the move to Sued
      expect(minutesOf(ids.OH)).toBe(480); // 5.2. in Nord; no Stammsalon at all
      // MV is a Sued row (whole) and a Nord helper; NS is Nord's own row, never its own helper.
      expect(rowIds(feb)).not.toContain(ids.MV);
      expect(rowIds(feb)).toContain(ids.NS);
      expect(helpers.map((h) => h.employeeId)).not.toContain(ids.NS);
      const sued2 = await period(`from=2026-02&to=2026-02&salonId=${sued}`);
      expect(rowIds(sued2)).toContain(ids.MV);
      // Order: last name, first name, id.
      const names = helpers.map((h) => h.employeeName);
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "de")));
    });
  });

  describe("one circle per answer (AC-714-3)", () => {
    const PERIODS = ["from=2026-01&to=2026-02", "from=2026-02&to=2026-02"];

    it("every KPI and the vacation table of a filtered answer refer to the persons of its rows", async () => {
      let answers = 0;
      for (const query of PERIODS) {
        for (const salonId of activeSalonIds) {
          const r = await period(`${query}&salonId=${salonId}`);
          const label = `${query} ${salonId === sued ? "Sued" : salonId === nord ? "Nord" : "West"}`;
          const sum = (pick: (x: Row) => number | null): number =>
            r.rows.reduce((s, x) => s + (pick(x) ?? 0), 0);
          const covered = r.rows.filter((x) => x.sollUnavailableReason === undefined);
          expect(r.kpis.personCount, `${label} personCount`).toBe(r.rows.length);
          expect(r.kpis.saldoPersonCount, `${label} saldoPersonCount`).toBe(covered.length);
          expect(r.kpis.workedMinutes, `${label} Ist`).toBe(sum((x) => x.workedMinutes));
          expect(r.kpis.expectedMinutes, `${label} Soll`).toBe(sum((x) => x.expectedMinutes));
          expect(r.kpis.balanceMinutes, `${label} saldo`).toBe(sum((x) => x.balanceMinutes));
          expect(r.kpis.closingBalanceMinutes, `${label} closing`).toBe(
            sum((x) => x.closingBalanceMinutes),
          );
          expect(r.kpis.sickDays, `${label} sickDays`).toBe(round2(sum((x) => x.sickDays)));
          const sick = r.absences.find((a) => a.code === "SICK");
          expect(sick?.totalDays ?? 0, `${label} SICK total`).toBe(round2(sum((x) => x.sickDays)));

          const table = vacationRows(r);
          expect(sorted(table.map((x) => x.employeeId)), `${label} vacation ids`).toEqual(
            rowIds(r),
          );
          const taken = round2(
            table.reduce((s, x) => s + (x.missingEntitlement ? 0 : (x.takenDays ?? 0)), 0),
          );
          const entitlement = round2(
            table.reduce((s, x) => s + (x.missingEntitlement ? 0 : (x.entitlementDays ?? 0)), 0),
          );
          expect(r.kpis.vacationTakenDays, `${label} taken`).toBe(taken);
          expect(r.kpis.vacationEntitlementDays, `${label} entitlement`).toBe(entitlement);
          answers += 1;
        }
      }
      expect(answers).toBe(PERIODS.length * activeSalonIds.length);
    });
  });

  describe("the period Stichtag", () => {
    it("lists a leaver whose exit lies inside the period in the salon of the exit day (LV: West)", async () => {
      const r = await period(`from=2026-01&to=2026-02&salonId=${west}`);
      expect(rowIds(r)).toContain(ids.LV);
      expect(rowOf(r, ids.LV).months.map((m) => m.month)).toEqual([1]);
    });

    it("does not list a person who left before the period (EJ), neither as a row nor in the vacation table, although the unfiltered table does", async () => {
      const filtered = await period(`from=2026-02&to=2026-02&salonId=${west}`);
      const plain = await period(`from=2026-02&to=2026-02`);
      expect(rowIds(filtered)).not.toContain(ids.EJ);
      expect(vacationRows(filtered).map((x) => x.employeeId)).not.toContain(ids.EJ);
      // Not vacuous: the unfiltered 2026 table does list EJ (an entitlement, employed in 2026).
      expect(vacationRows(plain).map((x) => x.employeeId)).toContain(ids.EJ);
      expect(rowIds(filtered)).toContain(ids.WS);
    });

    it("lists a mover (MV, Nord until 10.2., Sued from 11.2.) whole in the salon of the Stichtag only", async () => {
      const q = "from=2026-02&to=2026-02";
      const plain = await period(q);
      const inSued = await period(`${q}&salonId=${sued}`);
      const inNord = await period(`${q}&salonId=${nord}`);
      expect(rowIds(inSued)).toContain(ids.MV);
      expect(rowIds(inNord)).not.toContain(ids.MV);
      expect(whole(rowOf(inSued, ids.MV))).toEqual(rowOf(plain, ids.MV));
      // Whole values: the two Nord days before the move are in the row, not left in Nord.
      expect(rowOf(inSued, ids.MV).workedMinutes).toBe(4 * 480);
    });

    it.each([1, 2])(
      "decides month %i exactly like the Monatsexport rule (salonPersonsAtStichtag), within the month population",
      async (month) => {
        const q = `from=2026-0${month}&to=2026-0${month}`;
        const population = new Set(rowIds(await period(q)));
        const filtered = await period(`${q}&salonId=${west}`);
        const stichtag = await salonPersonsAtStichtag(app, tenantId, west, 2026, month);
        expect(rowIds(filtered)).toEqual(sorted(stichtag.filter((id) => population.has(id))));
        expect(filtered.rows.length).toBeGreaterThan(0);
      },
    );
  });

  describe("employeeId together with salonId (D-10)", () => {
    it("answers 200 with no row for a person outside the circle", async () => {
      const r = await period(`from=2026-01&to=2026-02&salonId=${sued}&employeeId=${ids.NS}`);
      expect(r.rows).toEqual([]);
      expect(r.kpis.personCount).toBe(0);
    });

    it("answers exactly the person's row for a person inside the circle", async () => {
      const q = "from=2026-02&to=2026-02";
      const alone = await period(`${q}&employeeId=${ids.SP}`);
      const filtered = await period(`${q}&salonId=${sued}&employeeId=${ids.SP}`);
      expect(filtered.rows.map(whole)).toEqual([rowOf(alone, ids.SP)]);
    });

    it("keeps the one 404 for a foreign or unknown salon, with any employeeId", async () => {
      for (const salonId of [foreign.salonId as string, "00000000-0000-4000-8000-0000000000aa"]) {
        const res = await get(
          `/api/v1/reports/period?from=2026-02&to=2026-02&salonId=${salonId}&employeeId=${ids.SP}`,
        );
        expect(res.statusCode).toBe(404);
        expect(res.body).toBe(NOT_FOUND);
      }
    });
  });
});
