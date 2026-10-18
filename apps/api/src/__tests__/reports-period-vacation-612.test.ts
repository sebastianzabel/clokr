/**
 * Issue #612 (AC-612-3, D-612-3, D-612-5, P-05, P-06, P-07, P-12, P-21, ADD-2) — the vacation
 * tables, the Verfall facts, the vacation KPIs, the absence statistics by kind and the
 * recorded-time flag of `GET /api/v1/reports/period`.
 *
 * Every figure is an existing assembly read at a Stichtag, never a new rule: the vacation rows
 * equal `GET /reports/leave-overview` field by field, the Verfall facts equal
 * `GET /reports/carryover-at-risk`, the absence counts equal Σ over the months of
 * `GET /reports/monthly`, and `hasRecordedTime` equals the `/dashboard/overtime-overview` row.
 *
 * Fixtures: tenant T (own persons V1..V5 with explicit entitlements) for the vacation cases; the
 * #617 nine-person fixture (second tenant) for the absences, the recorded-time flag and `exitDay`.
 * `Date` is faked to 2026-10-15T10:00Z (tenant-local yesterday = 2026-10-14); the Verfall block
 * moves it to 2026-02-16T10:00Z. Both instants lie in the past of any real run.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, reissueTokenNow } from "./setup";
import { createPopulationPerson } from "./population-fixtures-613";
import {
  seedMonthlyExportFixture,
  FAKE_NOW as EXPORT_FAKE_NOW,
  type MonthlyExportFixture,
} from "./monthly-export-fixture-617";

const FAKE_NOW = "2026-10-15T10:00:00.000Z";

type VacationRow = {
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  year: number;
  entitlementId: string | null;
  entitlementDays: number | null;
  carriedOverDays: number | null;
  carriedOverEffectiveDays: number | null;
  carriedOverExpiredDays: number | null;
  exitReductionDays: number | null;
  availableDays: number | null;
  takenDays: number | null;
  approvedUpcomingDays: number | null;
  pendingDays: number | null;
  remainingDays: number | null;
  atRiskDays: number | null;
  carryOverDeadline: string | null;
  lastWarningSentAt: string | null;
  missingEntitlement: boolean;
  entitlementWarning: string | null;
};
type Absence = { code: string; unit: string; personCount: number; totalDays: number };
type PeriodRow = {
  employeeId: string;
  hasRecordedTime: boolean;
  exitDay: string | null;
  sickDays: number;
};
type Period = {
  kpis: {
    vacationYear: number;
    vacationAsOf: string;
    vacationTakenDays: number;
    vacationApprovedDays: number;
    vacationEntitlementDays: number;
    sickDays: number;
  };
  rows: PeriodRow[];
  vacation: {
    year: number;
    asOf: string;
    years: Array<{ year: number; asOf: string; rows: VacationRow[] }>;
  };
  absences: Absence[];
};
type OverviewRow = {
  employee: { id: string };
  year: number;
  totalDays: number | null;
  carriedOverDays: number | null;
  carriedOverEffectiveDays?: number | null;
  carriedOverExpiredDays?: number | null;
  exitReductionDays?: number | null;
  availableDays: number | null;
  takenDays: number | null;
  approvedUpcomingDays: number | null;
  pendingDays: number | null;
  remainingDays: number | null;
  atRiskDays?: number | null;
  missingEntitlement: boolean;
  entitlementWarning: string | null;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

describe("Issue #612 — the period report: vacation, Verfall, absences, recorded time", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let fx: MonthlyExportFixture;
  const ids = {} as Record<"V1" | "V2" | "V3" | "V4" | "V5", string>;

  function get(url: string, token: string) {
    return app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  }
  async function period(query: string, token = data.adminToken): Promise<Period> {
    const res = await get(`/api/v1/reports/period?${query}`, token);
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as Period;
  }
  async function overview(year: number, token = data.adminToken): Promise<OverviewRow[]> {
    const res = await get(`/api/v1/reports/leave-overview?year=${year}`, token);
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as OverviewRow[];
  }
  const yearRows = (r: Period, year: number): VacationRow[] =>
    r.vacation.years.find((y) => y.year === year)?.rows ?? [];

  async function leave(
    employeeId: string,
    start: string,
    end: string,
    days: number,
    status: "APPROVED" | "PENDING",
  ) {
    await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        status,
        startDate: new Date(`${start}T00:00:00Z`),
        endDate: new Date(`${end}T00:00:00Z`),
        days,
      },
    });
  }
  async function entitlement(
    employeeId: string,
    year: number,
    totalDays: number,
    extra: { carriedOverDays?: number; carryOverDeadline?: Date } = {},
  ) {
    return app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year,
        totalDays,
        usedDays: 0,
        ...extra,
      },
    });
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(FAKE_NOW));
    app = await getTestApp();
    data = await seedTestData(app, "rpv612");
    const hire = new Date("2025-01-01T00:00:00Z");
    const mk = async (tag: "V1" | "V2" | "V3" | "V4" | "V5", exitDate?: Date) => {
      const p = await createPopulationPerson(app, {
        tenantId: data.tenant.id,
        salonId: data.salonId,
        tag,
        hireDate: hire,
        ...(exitDate ? { exitDate } : {}),
      });
      ids[tag] = p.employeeId;
    };
    await mk("V1");
    await mk("V2");
    await mk("V3"); // no VACATION entitlement at all: a placeholder row
    await mk("V4", new Date("2026-09-15T00:00:00Z"));
    await mk("V5");

    // V1: two taken (March), three taken in October before the Stichtag, three upcoming, two pending.
    await entitlement(ids.V1, 2026, 30);
    await leave(ids.V1, "2026-03-02", "2026-03-03", 2, "APPROVED");
    await leave(ids.V1, "2026-10-12", "2026-10-14", 3, "APPROVED");
    await leave(ids.V1, "2026-12-14", "2026-12-16", 3, "APPROVED");
    await leave(ids.V1, "2026-11-02", "2026-11-03", 2, "PENDING");
    await entitlement(ids.V2, 2026, 28);
    await entitlement(ids.V4, 2026, 30);
    await entitlement(ids.V5, 2025, 30);
    await entitlement(ids.V5, 2026, 30);
    await leave(ids.V5, "2025-11-10", "2025-11-11", 2, "APPROVED");
    await leave(ids.V5, "2026-01-05", "2026-01-06", 2, "APPROVED");

    fx = await seedMonthlyExportFixture(app, "rpx612");
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, fx.tenantId);
    } catch (err) {
      console.error("reports-period-vacation-612 cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("current month", () => {
    it("has one vacation year at the tenant-local yesterday", async () => {
      const r = await period("from=2026-10&to=2026-10");
      expect(r.vacation.years.map((y) => ({ year: y.year, asOf: y.asOf }))).toEqual([
        { year: 2026, asOf: "2026-10-14" },
      ]);
      expect(r.vacation.year).toBe(2026);
      expect(r.vacation.asOf).toBe("2026-10-14");
    });

    it("every row equals the row of GET /reports/leave-overview, figure by figure, placeholders included", async () => {
      const r = await period("from=2026-10&to=2026-10");
      const mine = yearRows(r, 2026);
      const theirs = await overview(2026);
      const byId = new Map(theirs.map((o) => [o.employee.id, o]));
      expect(mine.length).toBe(theirs.length);
      expect(new Set(mine.map((m) => m.employeeId))).toEqual(new Set(byId.keys()));
      // Not vacuous: real rows with leave, and at least one placeholder person.
      expect(mine.filter((m) => !m.missingEntitlement).length).toBeGreaterThanOrEqual(4);
      expect(mine.filter((m) => m.missingEntitlement).length).toBeGreaterThanOrEqual(1);
      expect(mine.find((m) => m.employeeId === ids.V3)?.missingEntitlement).toBe(true);
      for (const row of mine) {
        const o = byId.get(row.employeeId)!;
        const label = `${row.employeeName} ${row.employeeNumber}`;
        expect(row.missingEntitlement, label).toBe(o.missingEntitlement);
        expect(row.entitlementWarning, label).toBe(o.entitlementWarning);
        if (row.missingEntitlement) {
          expect(row.entitlementDays, label).toBeNull();
          expect(row.entitlementId, label).toBeNull();
          continue;
        }
        expect(row.entitlementDays, label).toBe(o.totalDays);
        expect(row.carriedOverDays, label).toBe(o.carriedOverDays);
        expect(row.carriedOverEffectiveDays, label).toBe(o.carriedOverEffectiveDays);
        expect(row.carriedOverExpiredDays, label).toBe(o.carriedOverExpiredDays);
        expect(row.exitReductionDays, label).toBe(o.exitReductionDays);
        expect(row.availableDays, label).toBe(o.availableDays);
        expect(row.takenDays, label).toBe(o.takenDays);
        expect(row.approvedUpcomingDays, label).toBe(o.approvedUpcomingDays);
        expect(row.pendingDays, label).toBe(o.pendingDays);
        expect(row.remainingDays, label).toBe(o.remainingDays);
        expect(row.atRiskDays, label).toBe(o.atRiskDays);
      }
      const v1 = mine.find((m) => m.employeeId === ids.V1)!;
      expect(v1.takenDays).toBe(5);
      expect(v1.approvedUpcomingDays).toBe(3);
      expect(v1.pendingDays).toBe(2);
    });

    it("the vacation KPIs are the column sums of the period-end year's real rows", async () => {
      const r = await period("from=2026-10&to=2026-10");
      const rows = yearRows(r, 2026).filter((x) => !x.missingEntitlement);
      const sum = (pick: (x: VacationRow) => number | null) =>
        round2(rows.reduce((s, x) => s + (pick(x) ?? 0), 0));
      expect(r.kpis.vacationYear).toBe(2026);
      expect(r.kpis.vacationAsOf).toBe("2026-10-14");
      expect(r.kpis.vacationTakenDays).toBe(sum((x) => x.takenDays));
      expect(r.kpis.vacationApprovedDays).toBe(sum((x) => x.approvedUpcomingDays));
      expect(r.kpis.vacationEntitlementDays).toBe(sum((x) => x.entitlementDays));
      expect(r.kpis.vacationEntitlementDays).toBeGreaterThan(0);
      expect(r.kpis.vacationTakenDays).toBeGreaterThan(0);
    });
  });

  describe("past period", () => {
    it("reads the year at the last day of the period: October vacation is upcoming, not taken", async () => {
      const r = await period("from=2026-07&to=2026-09");
      expect(r.vacation.years.map((y) => y.asOf)).toEqual(["2026-09-30"]);
      const v1 = yearRows(r, 2026).find((x) => x.employeeId === ids.V1)!;
      expect(v1.takenDays).toBe(2);
      expect(v1.approvedUpcomingDays).toBe(6);
      expect(r.kpis.vacationAsOf).toBe("2026-09-30");
    });

    it("repeating the request gives identical vacation figures", async () => {
      const first = await period("from=2026-07&to=2026-09");
      const second = await period("from=2026-07&to=2026-09");
      expect(second.vacation).toEqual(first.vacation);
      expect(second.kpis).toMatchObject({
        vacationTakenDays: first.kpis.vacationTakenDays,
        vacationApprovedDays: first.kpis.vacationApprovedDays,
        vacationEntitlementDays: first.kpis.vacationEntitlementDays,
      });
    });
  });

  describe("two years", () => {
    it("lists one table per calendar year the period touches, the KPIs on the period-end year", async () => {
      const r = await period("from=2025-11&to=2026-02");
      expect(r.vacation.years.map((y) => ({ year: y.year, asOf: y.asOf }))).toEqual([
        { year: 2025, asOf: "2025-12-31" },
        { year: 2026, asOf: "2026-02-28" },
      ]);
      expect(r.kpis.vacationYear).toBe(2026);
      expect(r.kpis.vacationAsOf).toBe("2026-02-28");
      const v5in2025 = yearRows(r, 2025).find((x) => x.employeeId === ids.V5)!;
      expect(v5in2025.year).toBe(2025);
      expect(v5in2025.takenDays).toBe(2);
      const v5in2026 = yearRows(r, 2026).find((x) => x.employeeId === ids.V5)!;
      expect(v5in2026.takenDays).toBe(2);
      // V1 has no 2025 entitlement: a placeholder in the 2025 table, a real row in the 2026 table.
      expect(yearRows(r, 2025).find((x) => x.employeeId === ids.V1)?.missingEntitlement).toBe(true);
      expect(yearRows(r, 2026).find((x) => x.employeeId === ids.V1)?.missingEntitlement).toBe(
        false,
      );
      const real2026 = yearRows(r, 2026).filter((x) => !x.missingEntitlement);
      expect(r.kpis.vacationEntitlementDays).toBe(
        round2(real2026.reduce((s, x) => s + (x.entitlementDays ?? 0), 0)),
      );
    });
  });

  describe("Verfall", () => {
    // Own tenant and a clock inside the carry-over window: 16 February, deadline 31 March.
    const VERFALL_NOW = "2026-02-16T10:00:00.000Z";
    let vf: Awaited<ReturnType<typeof seedTestData>>;
    let vfToken: string;
    let vfPerson: string;
    let entitlementId: string;
    let warnedAt: Date;

    beforeAll(async () => {
      vi.setSystemTime(new Date(VERFALL_NOW));
      vf = await seedTestData(app, "rpf612");
      vfToken = reissueTokenNow(app, vf.adminToken);
      const p = await createPopulationPerson(app, {
        tenantId: vf.tenant.id,
        salonId: vf.salonId,
        tag: "VF",
        hireDate: new Date("2025-01-01T00:00:00Z"),
      });
      vfPerson = p.employeeId;
      const row = await app.prisma.leaveEntitlement.create({
        data: {
          employeeId: vfPerson,
          leaveTypeId: vf.vacationType.id,
          year: 2026,
          totalDays: 30,
          usedDays: 0,
          carriedOverDays: 3,
          carryOverDeadline: new Date("2026-03-31T00:00:00Z"),
        },
      });
      entitlementId = row.id;
      warnedAt = new Date("2026-02-10T09:00:00.000Z");
      await app.prisma.auditLog.create({
        data: {
          action: "CARRYOVER_WARNED",
          entity: "LeaveEntitlement",
          entityId: entitlementId,
          newValue: { carriedOverDays: 3, atRiskDays: 3 },
          createdAt: warnedAt,
        },
      });
    });

    afterAll(async () => {
      vi.setSystemTime(new Date(FAKE_NOW));
      try {
        await cleanupTestData(app, vf.tenant.id);
      } catch (err) {
        console.error("reports-period-vacation-612 Verfall cleanup failed:", err);
      }
    });

    it("carries deadline, date of the last Hinweis and entitlement id, equal to /carryover-at-risk", async () => {
      const r = await period("from=2026-02&to=2026-02", vfToken);
      const row = yearRows(r, 2026).find((x) => x.employeeId === vfPerson)!;
      expect(row.entitlementId).toBe(entitlementId);
      expect(row.atRiskDays).toBe(3);
      expect(row.carryOverDeadline).toBe("2026-03-31");
      expect(row.lastWarningSentAt).toBe(warnedAt.toISOString());

      const res = await get("/api/v1/reports/carryover-at-risk?days=365", vfToken);
      expect(res.statusCode, res.body).toBe(200);
      const atRisk = (
        JSON.parse(res.body) as {
          rows: Array<{
            entitlementId: string;
            atRiskDays: number;
            deadline: string;
            lastWarningSentAt: string | null;
          }>;
        }
      ).rows.filter((x) => x.entitlementId === entitlementId);
      expect(atRisk).toHaveLength(1);
      expect(atRisk[0].atRiskDays).toBe(row.atRiskDays);
      expect(atRisk[0].deadline.slice(0, 10)).toBe(row.carryOverDeadline);
      expect(atRisk[0].lastWarningSentAt).toBe(row.lastWarningSentAt);
    });

    it("a row without a Hinweis and without a deadline carries null for both", async () => {
      const r = await period("from=2026-02&to=2026-02", vfToken);
      const others = yearRows(r, 2026).filter(
        (x) => x.employeeId !== vfPerson && !x.missingEntitlement,
      );
      // The seed employee's entitlement has neither (non-vacuous: at least one such real row exists).
      expect(others.length).toBeGreaterThanOrEqual(1);
      for (const o of others) {
        expect(o.carryOverDeadline).toBeNull();
        expect(o.lastWarningSentAt).toBeNull();
      }
    });
  });

  describe("absences by kind (the #617 fixture, a second tenant)", () => {
    const KIND_FIELDS = {
      VACATION: "vacationDays",
      OVERTIME_COMP: "overtimeCompDays",
      SPECIAL: "specialLeaveDays",
      EDUCATION: "educationDays",
      UNPAID: "unpaidDays",
      MATERNITY: "maternityDays",
      PARENTAL: "parentalDays",
    } as const;
    type MonthlyRow = { employeeId: string; sickDays: number } & Record<
      (typeof KIND_FIELDS)[keyof typeof KIND_FIELDS],
      number
    >;

    beforeAll(() => {
      vi.setSystemTime(EXPORT_FAKE_NOW);
    });

    async function monthlyRows(year: number, month: number): Promise<MonthlyRow[]> {
      const res = await get(
        `/api/v1/reports/monthly?year=${year}&month=${month}`,
        reissueTokenNow(app, fx.adminToken),
      );
      expect(res.statusCode, res.body).toBe(200);
      return (JSON.parse(res.body) as { rows: MonthlyRow[] }).rows;
    }

    it("each kind equals the sum over the months of /reports/monthly; the sick row is in calendar days", async () => {
      const token = reissueTokenNow(app, fx.adminToken);
      const r = await period("from=2026-08&to=2026-10", token);
      const months = [8, 9, 10];
      const monthly = new Map<number, MonthlyRow[]>();
      for (const m of months) monthly.set(m, await monthlyRows(2026, m));

      const expectedCodes: string[] = [];
      for (const [code, field] of Object.entries(KIND_FIELDS)) {
        let total = 0;
        const persons = new Set<string>();
        for (const m of months) {
          for (const row of monthly.get(m)!) {
            const days = row[field as (typeof KIND_FIELDS)[keyof typeof KIND_FIELDS]];
            if (days > 0) persons.add(row.employeeId);
            total += days;
          }
        }
        const entry = r.absences.find((a) => a.code === code);
        if (total > 0) {
          expectedCodes.push(code);
          expect(entry, code).toBeDefined();
          expect(entry!.unit).toBe("WORKDAYS");
          expect(entry!.totalDays, code).toBe(round2(total));
          expect(entry!.personCount, code).toBe(persons.size);
        } else {
          expect(entry, `${code} has 0 days and is absent`).toBeUndefined();
        }
      }
      let sick = 0;
      const sickPersons = new Set<string>();
      for (const m of months) {
        for (const row of monthly.get(m)!) {
          sick += row.sickDays;
          if (row.sickDays > 0) sickPersons.add(row.employeeId);
        }
      }
      const sickEntry = r.absences.find((a) => a.code === "SICK");
      expect(sickEntry?.unit).toBe("CALENDAR_DAYS");
      expect(sickEntry?.totalDays).toBe(round2(sick));
      expect(sickEntry?.personCount).toBe(sickPersons.size);
      expect(r.kpis.sickDays).toBe(round2(sick));

      // Not vacuous: the fixture yields every kind, and no entry carries zero days.
      expect(expectedCodes.sort((a, b) => (a < b ? -1 : 1))).toEqual(
        Object.keys(KIND_FIELDS).sort((a, b) => (a < b ? -1 : 1)),
      );
      expect(sick).toBeGreaterThan(0);
      for (const a of r.absences) expect(a.totalDays).toBeGreaterThan(0);
      expect(r.absences.length).toBe(Object.keys(KIND_FIELDS).length + 1);
    });

    it("no key of the answer is a day list (calendar fields are only counts and sums)", async () => {
      const r = await period("from=2026-09&to=2026-09", reissueTokenNow(app, fx.adminToken));
      for (const a of r.absences) {
        expect(Object.keys(a).sort((x, y) => (x < y ? -1 : 1))).toEqual([
          "code",
          "personCount",
          "totalDays",
          "unit",
        ]);
      }
    });
  });

  describe("recorded time and exit day (the #617 fixture)", () => {
    beforeAll(() => {
      vi.setSystemTime(EXPORT_FAKE_NOW);
    });

    it("hasRecordedTime equals the /dashboard/overtime-overview row of the same person", async () => {
      const token = reissueTokenNow(app, fx.adminToken);
      const r = await period("from=2026-09&to=2026-10", token);
      const res = await get("/api/v1/dashboard/overtime-overview", token);
      expect(res.statusCode, res.body).toBe(200);
      const overview = (
        JSON.parse(res.body) as { employees: Array<{ id: string; hasRecordedTime: boolean }> }
      ).employees;
      const byId = new Map(overview.map((e) => [e.id, e.hasRecordedTime]));
      let compared = 0;
      for (const row of r.rows) {
        if (!byId.has(row.employeeId)) continue;
        compared += 1;
        expect(row.hasRecordedTime, row.employeeId).toBe(byId.get(row.employeeId));
      }
      expect(compared).toBeGreaterThanOrEqual(5);
      // Both values occur (the fixture's persons book time, the seeded admin and employee do not).
      expect(r.rows.some((x) => x.hasRecordedTime)).toBe(true);
      expect(r.rows.some((x) => !x.hasRecordedTime)).toBe(true);
    });

    it("exitDay is the tenant-local exit day for a person who left inside the period, else null", async () => {
      const token = reissueTokenNow(app, fx.adminToken);
      const r = await period("from=2026-09&to=2026-10", token);
      const p7 = r.rows.find((x) => x.employeeId === fx.people.p7.id)!;
      expect(p7.exitDay).toBe("2026-09-15");
      const others = r.rows.filter((x) => x.employeeId !== fx.people.p7.id);
      expect(others.length).toBeGreaterThanOrEqual(8);
      for (const o of others) expect(o.exitDay, o.employeeId).toBeNull();
      // A period that ends before the exit day does not name it.
      const early = await period("from=2026-08&to=2026-08", token);
      const p7early = early.rows.find((x) => x.employeeId === fx.people.p7.id)!;
      expect(p7early.exitDay).toBeNull();
    });
  });
});
