/**
 * Issue #713 (D-04, D-05, D-08, D-09; P-713-01, P-713-05) — the per-person absence counts of
 * `GET /api/v1/reports/period`: `rows[].absence` (ten numbers keyed by leave-type code) and
 * „Abwesenheiten nach Art“ (`absences[]`) as the sum of those rows.
 *
 * Expected values are measured from `GET /reports/monthly` or the stored rows, or derived from the
 * fixture's own dates in a comment — never a literal copied from a run.
 *
 * World (the #617 nine-person fixture as its own tenant, `Date` faked to 2026-10-15T10:00Z, period
 * August to October 2026, every person homed in the fixture salon):
 *   p3  VACATION 07.-08.09., SICK 15.-16.09. (2 calendar days), SICK_CHILD 17.09. (1), OVERTIME_COMP,
 *       SPECIAL, EDUCATION and UNPAID one workday each
 *   p5  MATERNITY 07.-08.09., PARENTAL 09.09.
 *   p6  VACATION 21.-25.09., SICK 23.-24.09. (2 calendar days, a confirmed § 9 credit inside)
 *   p8  Azubi with one Berufsschule `Absence` on 09.09.
 *   p9  a soft-deleted SICK request (counts nothing)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { randomBytes, randomUUID } from "crypto";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
  reissueTokenNow,
} from "./setup";
import { createPopulationPerson } from "./population-fixtures-613";
import { leaveTypeFields } from "../contexts/absence/leave-type";
import { SYSTEM_ROLE_IDS } from "../contexts/platform";
import {
  seedMonthlyExportFixture,
  FAKE_NOW,
  type MonthlyExportFixture,
} from "./monthly-export-fixture-617";

const byText = (a: string, b: string): number => a.localeCompare(b);
const round2 = (n: number): number => Math.round(n * 100) / 100;

const CODES = [
  "SICK",
  "SICK_CHILD",
  "VACATION",
  "OVERTIME_COMP",
  "SPECIAL",
  "VOCATIONAL_SCHOOL",
  "EDUCATION",
  "UNPAID",
  "MATERNITY",
  "PARENTAL",
] as const;
type Code = (typeof CODES)[number];
// The seven LeaveRequest kinds in Arbeitstage and the /reports/monthly field each one is summed from.
const KIND_FIELDS = {
  VACATION: "vacationDays",
  OVERTIME_COMP: "overtimeCompDays",
  SPECIAL: "specialLeaveDays",
  EDUCATION: "educationDays",
  UNPAID: "unpaidDays",
  MATERNITY: "maternityDays",
  PARENTAL: "parentalDays",
} as const;
type KindCode = keyof typeof KIND_FIELDS;
const KIND_CODES = Object.keys(KIND_FIELDS) as KindCode[];
// The nine codes of „Abwesenheiten nach Art“ (no Berufsschule line, D-05).
const LINE_CODES: readonly Code[] = [...KIND_CODES, "SICK", "SICK_CHILD"];

type MonthlyRow = { employeeId: string; sickDays: number } & Record<
  (typeof KIND_FIELDS)[KindCode],
  number
>;
type PeriodRow = {
  employeeId: string;
  sickDays: number;
  absence: Record<Code, number>;
  months: Array<Record<string, unknown>>;
};
type AbsenceLine = { code: Code; unit: string; personCount: number; totalDays: number };
type Period = {
  kpis: { sickDays: number };
  rows: PeriodRow[];
  absences: AbsenceLine[];
};

describe("Issue #713 — the per-person absence counts of the period report", () => {
  let app: FastifyInstance;
  let fx: MonthlyExportFixture;
  const MONTHS = [8, 9, 10];
  const QUERY = "from=2026-08&to=2026-10";

  function get(url: string, token: string) {
    return app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  }
  async function period(query: string): Promise<Period> {
    const res = await get(`/api/v1/reports/period?${query}`, reissueTokenNow(app, fx.adminToken));
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as Period;
  }
  async function monthlyRows(month: number): Promise<MonthlyRow[]> {
    const res = await get(
      `/api/v1/reports/monthly?year=2026&month=${month}`,
      reissueTokenNow(app, fx.adminToken),
    );
    expect(res.statusCode, res.body).toBe(200);
    return (JSON.parse(res.body) as { rows: MonthlyRow[] }).rows;
  }
  const rowOf = (r: Period, id: string): PeriodRow => {
    const row = r.rows.find((x) => x.employeeId === id);
    if (!row) throw new Error(`row ${id} missing`);
    return row;
  };
  const sumRows = (r: Period, code: Code): number =>
    round2(r.rows.reduce((s, x) => s + x.absence[code], 0));

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FAKE_NOW);
    app = await getTestApp();
    fx = await seedMonthlyExportFixture(app, "rpa713");
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, fx.tenantId);
    } catch (err) {
      console.error("reports-period-absences-713 cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("per person, against /reports/monthly and the stored rows", () => {
    let unfiltered: Period;
    const monthly = new Map<number, MonthlyRow[]>();

    beforeAll(async () => {
      unfiltered = await period(QUERY);
      for (const m of MONTHS) monthly.set(m, await monthlyRows(m));
    });

    it("every row has exactly the ten codes as numbers, and no month entry has an absence key", () => {
      expect(unfiltered.rows.length).toBeGreaterThanOrEqual(Object.keys(fx.people).length);
      for (const row of unfiltered.rows) {
        expect(Object.keys(row.absence).sort(byText), row.employeeId).toEqual(
          [...CODES].sort(byText),
        );
        for (const code of CODES) {
          expect(typeof row.absence[code], `${row.employeeId} ${code}`).toBe("number");
          expect(row.absence[code], `${row.employeeId} ${code}`).toBeGreaterThanOrEqual(0);
        }
        expect(row.months.length).toBeGreaterThan(0);
        for (const month of row.months) expect(month, row.employeeId).not.toHaveProperty("absence");
      }
    });

    it("each of the seven kinds equals the sum over the months of the person's /reports/monthly row", () => {
      let compared = 0;
      for (const row of unfiltered.rows) {
        for (const code of KIND_CODES) {
          let total = 0;
          for (const m of MONTHS) {
            const monthlyRow = monthly.get(m)!.find((x) => x.employeeId === row.employeeId);
            total += monthlyRow ? monthlyRow[KIND_FIELDS[code]] : 0;
          }
          expect(row.absence[code], `${row.employeeId} ${code}`).toBe(round2(total));
          compared += 1;
        }
      }
      expect(compared).toBe(unfiltered.rows.length * KIND_CODES.length);
    });

    it("SICK + SICK_CHILD is the old sick figure per row, and the monthly sum of sickDays", () => {
      for (const row of unfiltered.rows) {
        let monthlySick = 0;
        for (const m of MONTHS) {
          monthlySick +=
            monthly.get(m)!.find((x) => x.employeeId === row.employeeId)?.sickDays ?? 0;
        }
        expect(round2(row.absence.SICK + row.absence.SICK_CHILD), row.employeeId).toBe(
          row.sickDays,
        );
        expect(row.sickDays, row.employeeId).toBe(round2(monthlySick));
      }
      // Derived from the fixture's dates: p3 SICK 15.-16.09. = 2 calendar days and SICK_CHILD 17.09.
      // = 1; p6 SICK 23.-24.09. = 2 (the § 9 credit moves days between attest buckets, not the
      // total); p9's only sick request is soft-deleted and counts nothing.
      const { p3, p6, p9 } = fx.people;
      expect(rowOf(unfiltered, p3.id).absence.SICK).toBe(2);
      expect(rowOf(unfiltered, p3.id).absence.SICK_CHILD).toBe(1);
      expect(rowOf(unfiltered, p6.id).absence.SICK).toBe(2);
      expect(rowOf(unfiltered, p6.id).absence.SICK_CHILD).toBe(0);
      expect(rowOf(unfiltered, p9.id).absence.SICK).toBe(0);
      expect(rowOf(unfiltered, p9.id).absence.SICK_CHILD).toBe(0);
    });

    it("VOCATIONAL_SCHOOL equals the person's stored Berufsschule rows inside the period", async () => {
      const stored = await app.prisma.absence.findMany({
        where: {
          type: "VOCATIONAL_SCHOOL",
          deletedAt: null,
          startDate: {
            gte: new Date("2026-08-01T00:00:00Z"),
            lte: new Date("2026-10-31T00:00:00Z"),
          },
          employee: { tenantId: fx.tenantId },
        },
        select: { employeeId: true },
      });
      const perPerson = new Map<string, number>();
      for (const a of stored) perPerson.set(a.employeeId, (perPerson.get(a.employeeId) ?? 0) + 1);
      for (const row of unfiltered.rows) {
        expect(row.absence.VOCATIONAL_SCHOOL, row.employeeId).toBe(
          perPerson.get(row.employeeId) ?? 0,
        );
      }
      // Derived from the fixture: p8 has exactly one Berufsschule row (09.09.), nobody else has one.
      expect(perPerson.get(fx.people.p8.id)).toBe(1);
      expect(rowOf(unfiltered, fx.people.p8.id).absence.VOCATIONAL_SCHOOL).toBe(1);
      expect(sumRows(unfiltered, "VOCATIONAL_SCHOOL")).toBe(1);
    });

    it("is not vacuous: every one of the ten codes has a positive sum over the rows", () => {
      for (const code of CODES) {
        expect(sumRows(unfiltered, code), code).toBeGreaterThan(0);
      }
    });
  });

  describe("the sums: rows, „nach Art“ and the KPI", () => {
    async function expectSumsHold(r: Period, label: string): Promise<void> {
      // Printed once per answer: Σ rows / „nach Art“ totalDays / personCount per code (the evidence).
      console.info(
        `SUMS ${label}: ` +
          CODES.map((code) => {
            const line = r.absences.find((a) => a.code === code);
            return `${code} Σ${sumRows(r, code)} line ${line ? `${line.totalDays}/${line.personCount}` : "-"}`;
          }).join("; "),
      );
      for (const code of LINE_CODES) {
        const total = sumRows(r, code);
        const line = r.absences.find((a) => a.code === code);
        const persons = r.rows.filter((x) => x.absence[code] > 0).length;
        if (total > 0) {
          expect(line, `${label} ${code} line`).toBeDefined();
          expect(line!.totalDays, `${label} ${code} totalDays`).toBe(total);
          expect(line!.personCount, `${label} ${code} personCount`).toBe(persons);
          expect(line!.unit, `${label} ${code} unit`).toBe(
            code === "SICK" || code === "SICK_CHILD" ? "CALENDAR_DAYS" : "WORKDAYS",
          );
        } else {
          expect(line, `${label} ${code} has no days and no line`).toBeUndefined();
        }
      }
      expect(
        r.absences.some((a) => a.code === "VOCATIONAL_SCHOOL"),
        `${label} no Berufsschule line`,
      ).toBe(false);
      expect(r.absences.length, `${label} lines`).toBe(
        LINE_CODES.filter((code) => sumRows(r, code) > 0).length,
      );
      const sick = r.absences.find((a) => a.code === "SICK")?.totalDays ?? 0;
      const child = r.absences.find((a) => a.code === "SICK_CHILD")?.totalDays ?? 0;
      expect(r.kpis.sickDays, `${label} KPI`).toBe(
        round2(r.rows.reduce((s, x) => s + x.absence.SICK + x.absence.SICK_CHILD, 0)),
      );
      expect(r.kpis.sickDays, `${label} KPI = both lines`).toBe(round2(sick + child));
    }

    it("unfiltered: Σ rows = the „nach Art“ line, personCount = rows with a value, Σ sick = the KPI", async () => {
      const r = await period(QUERY);
      await expectSumsHold(r, "unfiltered");
      // Not vacuous: all nine lines exist for this fixture.
      expect(r.absences.length).toBe(LINE_CODES.length);
    });

    it("filtered by the fixture salon: the same invariants and every row equals the unfiltered person", async () => {
      const all = await period(QUERY);
      const filtered = await period(`${QUERY}&salonId=${fx.salonId}`);
      await expectSumsHold(filtered, "filtered");
      expect(filtered.rows.length).toBeGreaterThan(0);
      for (const row of filtered.rows) {
        // One computation, no salon branch (D-08): the person's counts are the whole-person counts.
        expect(row.absence, row.employeeId).toEqual(rowOf(all, row.employeeId).absence);
        expect(row.sickDays, row.employeeId).toBe(rowOf(all, row.employeeId).sickDays);
      }
      // Not vacuous: the persons that carry the absences are in the filtered answer.
      for (const person of [fx.people.p3, fx.people.p5, fx.people.p6, fx.people.p8]) {
        expect(filtered.rows.map((x) => x.employeeId)).toContain(person.id);
      }
      for (const code of CODES)
        expect(sumRows(filtered, code), `filtered ${code}`).toBeGreaterThan(0);
    });

    it("an employeeId query answers that one row with its counts and the matching KPI", async () => {
      const r = await period(`${QUERY}&employeeId=${fx.people.p3.id}`);
      expect(r.rows.map((x) => x.employeeId)).toEqual([fx.people.p3.id]);
      expect(r.rows[0].absence.SICK_CHILD).toBe(1);
      expect(r.kpis.sickDays).toBe(3);
    });
  });

  /*
   * AC-713-4 (D-06, P-713-07): no new gate - the absence counts are served to exactly the rows
   * report:read already lists. World (own tenant): RA homed in salon A, RB homed in salon B, each
   * with an APPROVED SICK request of two calendar days (07.-08.09.2026) and an APPROVED SICK_CHILD
   * request of one day (09.09.2026); a MANAGER scoped to salon A.
   */
  describe("the reach: a salon-scoped manager sees the counts of its persons only", () => {
    const REACH_QUERY = "from=2026-08&to=2026-09";
    let world: Awaited<ReturnType<typeof seedTestData>>;
    let managerToken: string;
    const person = {} as Record<"RA" | "RB", string>;

    function getAs(url: string, token: string) {
      return app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
    }
    async function periodAs(query: string, token: string): Promise<Period> {
      const res = await getAs(`/api/v1/reports/period?${query}`, token);
      expect(res.statusCode, res.body).toBe(200);
      return JSON.parse(res.body) as Period;
    }

    beforeAll(async () => {
      world = await seedTestData(app, "rpa713r");
      const salonA = world.salonId;
      const salonB = (await createTestSalon(app.prisma, world.tenant.id, { name: "Absence713 B" }))
        .id;
      const sick = await app.prisma.leaveType.create({
        data: { tenantId: world.tenant.id, ...leaveTypeFields("SICK"), color: "#EF4444" },
      });
      const child = await app.prisma.leaveType.create({
        data: { tenantId: world.tenant.id, ...leaveTypeFields("SICK_CHILD"), color: "#F97316" },
      });
      const hire = new Date("2025-01-01T00:00:00Z");
      const mk = async (tag: "RA" | "RB", salonId: string) => {
        const p = await createPopulationPerson(app, {
          tenantId: world.tenant.id,
          salonId,
          tag,
          hireDate: hire,
        });
        person[tag] = p.employeeId;
        await app.prisma.leaveRequest.create({
          data: {
            employeeId: p.employeeId,
            leaveTypeId: sick.id,
            startDate: new Date("2026-09-07T00:00:00Z"),
            endDate: new Date("2026-09-08T00:00:00Z"),
            days: 2,
            status: "APPROVED",
            attestPresent: false,
          },
        });
        await app.prisma.leaveRequest.create({
          data: {
            employeeId: p.employeeId,
            leaveTypeId: child.id,
            startDate: new Date("2026-09-09T00:00:00Z"),
            endDate: new Date("2026-09-09T00:00:00Z"),
            days: 1,
            status: "APPROVED",
            attestPresent: false,
          },
        });
      };
      await mk("RA", salonA);
      await mk("RB", salonB);

      // The manager: a user + employee of its own without a Stammsalon, the MANAGER system role scoped to A.
      const password = "test1234";
      const suffix = `mgr-${randomBytes(3).toString("hex")}`;
      const user = await app.prisma.user.create({
        data: {
          email: `rpa713-${suffix}@example.invalid`,
          passwordHash: await bcrypt.hash(password, 4),
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      await app.prisma.employee.create({
        data: {
          tenantId: world.tenant.id,
          userId: user.id,
          employeeNumber: `RPA${suffix}`.toUpperCase().slice(0, 20),
          firstName: "Fixture",
          lastName: "Absence713",
          hireDate: new Date("2024-01-01"),
        },
      });
      await app.prisma.roleAssignment.create({
        data: {
          tenantId: world.tenant.id,
          userId: user.id,
          accessRoleId: SYSTEM_ROLE_IDS.MANAGER,
          scopeType: "SALONS",
          salonIds: [salonA],
          employeeIds: [],
        },
      });
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: user.email, password },
      });
      expect(login.statusCode, login.body).toBe(200);
      managerToken = (JSON.parse(login.body) as { accessToken: string }).accessToken;
    });

    afterAll(async () => {
      try {
        await app.prisma.roleAssignment.deleteMany({ where: { tenantId: world.tenant.id } });
        await app.prisma.accessRole.deleteMany({ where: { tenantId: world.tenant.id } });
        await cleanupTestData(app, world.tenant.id);
      } catch (err) {
        console.error("reports-period-absences-713 reach cleanup failed:", err);
      }
    });

    it("lists exactly RA with its SICK and SICK_CHILD, and the KPI and lines are RA's figures only", async () => {
      const r = await periodAs(REACH_QUERY, managerToken);
      expect(r.rows.map((x) => x.employeeId)).toEqual([person.RA]);
      // Derived from the world: 07.-08.09. = 2 calendar days own illness, 09.09. = 1 child day.
      expect(r.rows[0].absence.SICK).toBe(2);
      expect(r.rows[0].absence.SICK_CHILD).toBe(1);
      expect(r.kpis.sickDays).toBe(3);
      expect(r.absences.find((a) => a.code === "SICK")).toMatchObject({
        totalDays: 2,
        personCount: 1,
      });
      expect(r.absences.find((a) => a.code === "SICK_CHILD")).toMatchObject({
        totalDays: 1,
        personCount: 1,
      });
    });

    it("answers the id of a person homed in B byte-identically to an unknown id", async () => {
      const outside = await getAs(
        `/api/v1/reports/period?${REACH_QUERY}&employeeId=${person.RB}`,
        managerToken,
      );
      const unknown = await getAs(
        `/api/v1/reports/period?${REACH_QUERY}&employeeId=${randomUUID()}`,
        managerToken,
      );
      expect(outside.statusCode).toBe(200);
      expect(unknown.statusCode).toBe(200);
      expect(outside.body).toBe(unknown.body);
      expect(Buffer.byteLength(outside.body)).toBe(Buffer.byteLength(unknown.body));
      const body = JSON.parse(outside.body) as Period & { kpis: { personCount: number } };
      expect(body.rows).toEqual([]);
      expect(body.kpis.personCount).toBe(0);
      console.info(
        `REACH manager rows ${JSON.stringify(
          (await periodAs(REACH_QUERY, managerToken)).rows.map((x) => x.employeeId === person.RA),
        )}; out-of-reach vs unknown body ${Buffer.byteLength(outside.body)} / ${Buffer.byteLength(unknown.body)} bytes, equal ${outside.body === unknown.body}`,
      );
    });

    it("is not vacuous: the admin gets RB's row with its child sickness", async () => {
      const r = await periodAs(`${REACH_QUERY}&employeeId=${person.RB}`, world.adminToken);
      expect(r.rows.map((x) => x.employeeId)).toEqual([person.RB]);
      expect(r.rows[0].absence.SICK_CHILD).toBe(1);
      expect(r.rows[0].absence.SICK).toBe(2);
      // The admin sees both persons; the manager sees one of them (the reach narrows, never widens).
      const both = await periodAs(REACH_QUERY, world.adminToken);
      const ids = both.rows.map((x) => x.employeeId);
      expect(ids).toContain(person.RA);
      expect(ids).toContain(person.RB);
    });
  });
});
