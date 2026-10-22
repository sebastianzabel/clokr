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
import { getTestApp, closeTestApp, cleanupTestData, reissueTokenNow } from "./setup";
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
});
