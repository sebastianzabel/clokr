/**
 * Issue #612 (D-612-2, P-01..P-04, P-08, P-09) — `GET /api/v1/reports/period?from=&to=`.
 *
 * The period report sums what the working-time account already answers per month. This file pins
 * the tracer: the per-month series equals `computeMonthReportFigures`, the row and the KPIs are
 * sums of those months, the opening saldo is the previous month's Gesamtsaldo, Soll and saldo
 * follow `overtime:read`, the range limits answer 400, and a scoped reader sees only the persons
 * of his reach. Sums against /reports/monthly and the Monatsexport live in
 * reports-period-sums-612.test.ts.
 *
 * Fixture (tenant Europe/Berlin, `Date` faked to 2026-10-15T10:00Z so October is the running
 * month): salon A is the seeded salon, B a second one.
 *   P1 homed A: closed WORK entries in August, September and October 2026, August closed by a
 *      stored snapshot (converted period convention)
 *   P2 homed A: entries only (no snapshot)
 *   P3 homed B: entries in September (outside a salon-A manager's reach)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { createPopulationPerson } from "./population-fixtures-613";
import { saldoSnapshotPeriodBounds } from "./test-dates";
import { computeMonthReportFigures } from "../contexts/working-time-account";
import { normalizeRolePermissions, roleNameKey, SYSTEM_ROLE_IDS } from "../contexts/platform";

const PASSWORD = "test1234";
const FAKE_NOW = "2026-10-15T10:00:00.000Z";

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
  employeeName: string;
  employeeNumber: string;
  workedMinutes: number;
  expectedMinutes: number | null;
  balanceMinutes: number | null;
  openingBalanceMinutes: number | null;
  closingBalanceMinutes: number | null;
  monthCount: number;
  confirmedMonthCount: number;
  labelled: boolean;
  sickDays: number;
  sollUnavailableReason?: string;
  months: MonthEntry[];
};
type Kpis = {
  personCount: number;
  saldoPersonCount: number;
  workedMinutes: number;
  expectedMinutes: number | null;
  balanceMinutes: number | null;
  closingBalanceMinutes: number | null;
  closingAsOf: string;
  closingConfirmed: boolean;
  allMonthsConfirmed: boolean;
  sickDays: number;
};
type Period = {
  from: string;
  to: string;
  months: Array<{ year: number; month: number }>;
  kpis: Kpis;
  rows: Row[];
};

describe("Issue #612 — GET /reports/period", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let foreign: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: string;
  let salonB: string;
  const ids = {} as Record<"P1" | "P2" | "P3", string>;
  let managerToken: string;
  let noOvertimeToken: string;
  let noReportToken: string;

  function entry(employeeId: string, salonId: string, date: string) {
    return app.prisma.timeEntry.create({
      data: {
        employeeId,
        salonId,
        date: new Date(`${date}T00:00:00Z`),
        startTime: new Date(`${date}T08:00:00Z`),
        endTime: new Date(`${date}T16:00:00Z`),
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

  const rowOf = (r: Period, id: string): Row => {
    const row = r.rows.find((x) => x.employeeId === id);
    if (!row) throw new Error(`row ${id} missing`);
    return row;
  };

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(FAKE_NOW));
    app = await getTestApp();
    data = await seedTestData(app, "rp612");
    foreign = await seedTestData(app, "rp612f");
    salonA = data.salonId;
    salonB = (await createTestSalon(app.prisma, data.tenant.id, { name: "Period612 B" })).id;

    const hire = new Date("2025-01-01T00:00:00Z");
    const mk = async (tag: "P1" | "P2" | "P3", salonId: string) => {
      const p = await createPopulationPerson(app, {
        tenantId: data.tenant.id,
        salonId,
        tag,
        hireDate: hire,
      });
      ids[tag] = p.employeeId;
    };
    await mk("P1", salonA);
    await mk("P2", salonA);
    await mk("P3", salonB);

    for (const d of ["2026-08-03", "2026-08-04", "2026-08-05"]) await entry(ids.P1, salonA, d);
    for (const d of ["2026-09-01", "2026-09-02"]) await entry(ids.P1, salonA, d);
    for (const d of ["2026-10-01", "2026-10-02", "2026-10-05"]) await entry(ids.P1, salonA, d);
    for (const d of ["2026-08-10", "2026-09-07", "2026-10-06", "2026-10-07"]) {
      await entry(ids.P2, salonA, d);
    }
    for (const d of ["2026-09-08", "2026-09-09"]) await entry(ids.P3, salonB, d);

    const bounds = saldoSnapshotPeriodBounds(new Date("2026-08-01T00:00:00Z"));
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: ids.P1,
        periodType: "MONTHLY",
        periodStart: bounds.start,
        periodEnd: bounds.end,
        workedMinutes: 1440,
        expectedMinutes: 10080,
        balanceMinutes: -8640,
        carryOver: -8000,
        closedAt: new Date(),
        closedBy: data.adminUser.id,
      },
    });

    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    const caller = async (
      tag: string,
      assignment:
        | { accessRoleId: string; scopeType: "TENANT" | "SALONS"; salonIds?: string[] }
        | { permissions: string[]; scopeType: "TENANT" },
    ): Promise<string> => {
      const suffix = `${tag}-${randomBytes(3).toString("hex")}`;
      const user = await app.prisma.user.create({
        data: {
          email: `rp612-${suffix}@example.invalid`,
          passwordHash,
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      await app.prisma.employee.create({
        data: {
          tenantId: data.tenant.id,
          userId: user.id,
          employeeNumber: `RP${suffix}`.toUpperCase().slice(0, 20),
          firstName: "Fixture",
          lastName: "ReportsPeriod612",
          hireDate: new Date("2024-01-01"),
        },
      });
      let accessRoleId: string;
      if ("accessRoleId" in assignment) {
        accessRoleId = assignment.accessRoleId;
      } else {
        const name = `Period612 ${suffix}`;
        const role = await app.prisma.accessRole.create({
          data: {
            tenantId: data.tenant.id,
            name,
            nameKey: roleNameKey(name),
            permissions: normalizeRolePermissions(assignment.permissions),
          },
        });
        accessRoleId = role.id;
      }
      await app.prisma.roleAssignment.create({
        data: {
          tenantId: data.tenant.id,
          userId: user.id,
          accessRoleId,
          scopeType: assignment.scopeType,
          salonIds: "salonIds" in assignment ? (assignment.salonIds ?? []) : [],
          employeeIds: [],
        },
      });
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: user.email, password: PASSWORD },
      });
      expect(login.statusCode, login.body).toBe(200);
      return (JSON.parse(login.body) as { accessToken: string }).accessToken;
    };
    managerToken = await caller("mgr", {
      accessRoleId: SYSTEM_ROLE_IDS.MANAGER,
      scopeType: "SALONS",
      salonIds: [salonA],
    });
    noOvertimeToken = await caller("noot", {
      permissions: ["report:read:ZUGEWIESEN"],
      scopeType: "TENANT",
    });
    noReportToken = await caller("norep", {
      permissions: ["overtime:read:ZUGEWIESEN"],
      scopeType: "TENANT",
    });
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, foreign.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("tracer", () => {
    it("lists the months of the period per person, each equal to the account's month answer", async () => {
      const r = await period("from=2026-08&to=2026-10");
      expect(r.from).toBe("2026-08");
      expect(r.to).toBe("2026-10");
      expect(r.months).toEqual([
        { year: 2026, month: 8 },
        { year: 2026, month: 9 },
        { year: 2026, month: 10 },
      ]);
      for (const id of [ids.P1, ids.P2]) {
        const row = rowOf(r, id);
        expect(row.months.map((m) => m.month)).toEqual([8, 9, 10]);
        for (const m of row.months) {
          const f = await computeMonthReportFigures(app, id, m.year, m.month);
          expect(m.workedMinutes, `${id} ${m.month} worked`).toBe(f.workedMinutes);
          expect(m.expectedMinutes, `${id} ${m.month} expected`).toBe(f.expectedMinutes);
          expect(m.balanceMinutes, `${id} ${m.month} balance`).toBe(f.balanceMinutes);
          expect(m.closingBalanceMinutes, `${id} ${m.month} closing`).toBe(f.closingBalanceMinutes);
          expect(m.confirmed, `${id} ${m.month} confirmed`).toBe(f.confirmed);
          expect(m.labelled, `${id} ${m.month} labelled`).toBe(f.labelled);
        }
      }
    });

    it("takes a closed month from the stored snapshot and counts confirmed months", async () => {
      const r = await period("from=2026-08&to=2026-10");
      const row = rowOf(r, ids.P1);
      const august = row.months[0];
      expect(august.confirmed).toBe(true);
      expect(august.workedMinutes).toBe(1440);
      expect(august.expectedMinutes).toBe(10080);
      expect(august.balanceMinutes).toBe(-8640);
      expect(august.closingBalanceMinutes).toBe(-8000);
      expect(row.monthCount).toBe(3);
      expect(row.confirmedMonthCount).toBe(1);
      expect(rowOf(r, ids.P2).confirmedMonthCount).toBe(0);
    });

    it("sums the months into the row and reads opening and closing saldo from the account", async () => {
      const r = await period("from=2026-08&to=2026-10");
      for (const id of [ids.P1, ids.P2]) {
        const row = rowOf(r, id);
        const sum = (pick: (m: MonthEntry) => number | null) =>
          row.months.reduce((s, m) => s + (pick(m) ?? 0), 0);
        expect(row.workedMinutes).toBe(sum((m) => m.workedMinutes));
        expect(row.expectedMinutes).toBe(sum((m) => m.expectedMinutes));
        expect(row.balanceMinutes).toBe(sum((m) => m.balanceMinutes));
        expect(row.sickDays).toBe(0);
        const july = await computeMonthReportFigures(app, id, 2026, 7);
        expect(row.openingBalanceMinutes).toBe(july.closingBalanceMinutes);
        const october = await computeMonthReportFigures(app, id, 2026, 10);
        expect(row.closingBalanceMinutes).toBe(october.closingBalanceMinutes);
        expect(row.labelled).toBe(true);
        expect(row.sollUnavailableReason).toBeUndefined();
      }
    });

    it("the KPIs are the sums over the rows", async () => {
      const r = await period("from=2026-08&to=2026-10");
      const k = r.kpis;
      expect(k.personCount).toBe(r.rows.length);
      expect(k.saldoPersonCount).toBe(r.rows.length);
      expect(k.workedMinutes).toBe(r.rows.reduce((s, x) => s + x.workedMinutes, 0));
      expect(k.expectedMinutes).toBe(r.rows.reduce((s, x) => s + (x.expectedMinutes ?? 0), 0));
      expect(k.balanceMinutes).toBe(r.rows.reduce((s, x) => s + (x.balanceMinutes ?? 0), 0));
      expect(k.closingBalanceMinutes).toBe(
        r.rows.reduce((s, x) => s + (x.closingBalanceMinutes ?? 0), 0),
      );
      expect(k.sickDays).toBe(0);
      // The running October is an open month: the value runs through tenant-local yesterday.
      expect(k.closingAsOf).toBe("2026-10-14");
      expect(k.closingConfirmed).toBe(false);
      expect(k.allMonthsConfirmed).toBe(false);
    });

    it("a past period ends its closing figure on the last day of its last month", async () => {
      const r = await period("from=2026-08&to=2026-08");
      expect(r.kpis.closingAsOf).toBe("2026-08-31");
      expect(rowOf(r, ids.P1).closingBalanceMinutes).toBe(-8000);
      expect(rowOf(r, ids.P1).openingBalanceMinutes).toBe(
        (await computeMonthReportFigures(app, ids.P1, 2026, 7)).closingBalanceMinutes,
      );
    });
  });

  describe("limits (P-09)", () => {
    it.each([
      ["13 months", "from=2025-10&to=2026-10"],
      ["to before from", "from=2026-10&to=2026-08"],
      ["to after the current month", "from=2026-10&to=2026-11"],
      ["malformed month", "from=2026-8&to=2026-10"],
      ["month 13", "from=2026-01&to=2026-13"],
      ["missing to", "from=2026-08"],
    ])("answers 400 with a German text for %s", async (_label, query) => {
      const res = await get(`/api/v1/reports/period?${query}`);
      expect(res.statusCode, res.body).toBe(400);
      const body = JSON.parse(res.body) as { error: string };
      expect(typeof body.error).toBe("string");
      expect(body.error.length).toBeGreaterThan(0);
    });

    it("names the reason of the three range rules in German", async () => {
      const texts = [];
      for (const q of [
        "from=2025-10&to=2026-10",
        "from=2026-10&to=2026-08",
        "from=2026-10&to=2026-11",
      ]) {
        const res = await get(`/api/v1/reports/period?${q}`);
        texts.push((JSON.parse(res.body) as { error: string }).error);
      }
      expect(texts).toEqual([
        "Höchstens 12 Monate auf einmal.",
        "„Bis“ liegt vor „Von“.",
        "Der Zeitraum darf nicht in der Zukunft liegen.",
      ]);
    });

    it("accepts exactly twelve months", async () => {
      const r = await period("from=2025-11&to=2026-10");
      expect(r.months).toHaveLength(12);
    });

    it("a malformed employeeId answers 400", async () => {
      const res = await get("/api/v1/reports/period?from=2026-08&to=2026-08&employeeId=nope");
      expect(res.statusCode).toBe(400);
    });
  });

  describe("scope", () => {
    it("a salon manager sees only persons of his reach", async () => {
      const r = await period("from=2026-08&to=2026-10", managerToken);
      const listed = new Set(r.rows.map((x) => x.employeeId));
      expect(listed.has(ids.P1)).toBe(true);
      expect(listed.has(ids.P2)).toBe(true);
      expect(listed.has(ids.P3)).toBe(false);
    });

    it("an employeeId outside the reach answers an empty list, not an error", async () => {
      const r = await period(`from=2026-08&to=2026-10&employeeId=${ids.P3}`, managerToken);
      expect(r.rows).toEqual([]);
      expect(r.kpis.personCount).toBe(0);
    });

    it("an employeeId narrows the whole-tenant list to that person", async () => {
      const r = await period(`from=2026-08&to=2026-10&employeeId=${ids.P3}`);
      expect(r.rows.map((x) => x.employeeId)).toEqual([ids.P3]);
    });

    it("a caller without report:read gets 403", async () => {
      const res = await get("/api/v1/reports/period?from=2026-08&to=2026-10", noReportToken);
      expect(res.statusCode).toBe(403);
    });
  });

  describe("saldo gate (P-04)", () => {
    it("withholds Soll and saldo without overtime:read and keeps Ist", async () => {
      const r = await period("from=2026-08&to=2026-10", noOvertimeToken);
      expect(r.rows.length).toBeGreaterThan(0);
      for (const row of r.rows) {
        expect(row.sollUnavailableReason).toBe("NO_PERMISSION");
        expect(row.expectedMinutes).toBeNull();
        expect(row.balanceMinutes).toBeNull();
        expect(row.openingBalanceMinutes).toBeNull();
        expect(row.closingBalanceMinutes).toBeNull();
        for (const m of row.months) {
          expect(m.expectedMinutes).toBeNull();
          expect(m.balanceMinutes).toBeNull();
          expect(m.closingBalanceMinutes).toBeNull();
        }
      }
      const p1 = rowOf(r, ids.P1);
      const full = rowOf(await period("from=2026-08&to=2026-10"), ids.P1);
      expect(p1.workedMinutes).toBe(full.workedMinutes);
      expect(r.kpis.expectedMinutes).toBeNull();
      expect(r.kpis.balanceMinutes).toBeNull();
      expect(r.kpis.closingBalanceMinutes).toBeNull();
      expect(r.kpis.saldoPersonCount).toBe(0);
      expect(r.kpis.workedMinutes).toBe(r.rows.reduce((s, x) => s + x.workedMinutes, 0));
    });
  });
});
