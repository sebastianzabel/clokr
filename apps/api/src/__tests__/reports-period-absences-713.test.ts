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
  soleAuditRow,
} from "./setup";
import { createPopulationPerson } from "./population-fixtures-613";
import { leaveTypeFields } from "../contexts/absence/leave-type";
import { SYSTEM_ROLE_IDS } from "../contexts/platform";
import { PERIOD_ABSENCES_CSV_HEADER } from "../composition/period-csv";
import {
  seedMonthlyExportFixture,
  FAKE_NOW,
  type MonthlyExportFixture,
} from "./monthly-export-fixture-617";

const byText = (a: string, b: string): number => a.localeCompare(b);
const round2 = (n: number): number => Math.round(n * 100) / 100;
/** Independent of the production formatter: a day figure with a decimal comma. */
const deDays = (n: number): string => String(round2(n)).replace(".", ",");

/** Splits a CSV (without BOM) into records of cells; handles RFC 4180 quoting. */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') inQuotes = false;
      else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ";") {
      record.push(cell);
      cell = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      record.push(cell);
      records.push(record);
      record = [];
      cell = "";
      i++;
    } else cell += ch;
  }
  if (cell !== "" || record.length > 0) {
    record.push(cell);
    records.push(record);
  }
  return records;
}

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
  employeeNumber: string;
  sickDays: number;
  absence: Record<Code, number>;
  months: Array<Record<string, unknown>>;
};
type AbsenceLine = { code: Code; unit: string; personCount: number; totalDays: number };
type Period = {
  from: string;
  to: string;
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

    // One period read plus one /reports/monthly read per month: under the coverage run in CI this
    // exceeded vitest's default 10 s hook timeout (testTimeout is 30 s, hookTimeout is not set).
    beforeAll(async () => {
      unfiltered = await period(QUERY);
      for (const m of MONTHS) monthly.set(m, await monthlyRows(m));
    }, 60_000);

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
   * D-11, T-713-10..13: `GET /reports/period/csv?table=absences` - the same assembly as the JSON, a
   * file of its own with one audit row (`PERIOD_ABSENCES_CSV`) written before the bytes.
   */
  describe("the absences CSV (D-11)", { timeout: 120_000 }, () => {
    const CSV_QUERY = "from=2026-08&to=2026-10";
    const csvUrl = (qs: string) => `/api/v1/reports/period/csv?${qs}`;
    const adminGet = (url: string) => get(url, reissueTokenNow(app, fx.adminToken));
    const auditWhere = (type: string) => ({
      action: "EXPORT" as const,
      entity: "Report",
      userId: fx.adminUserId,
      newValue: { path: ["type"], equals: type },
    });
    const count = (type: string) => app.prisma.auditLog.count({ where: auditWhere(type) });
    const bodyOf = (res: { rawPayload: Buffer }) => res.rawPayload.subarray(3).toString("utf8");

    it("answers the file with BOM, content type, filename and the pinned header", async () => {
      const res = await adminGet(csvUrl(`${CSV_QUERY}&table=absences`));
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
      expect(res.headers["content-disposition"]).toBe(
        'attachment; filename="Abwesenheiten-je-Person_2026-08_2026-10.csv"',
      );
      expect([...res.rawPayload.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const text = bodyOf(res);
      expect(text.endsWith("\r\n")).toBe(true);
      const [header] = parseCsv(text);
      expect(header.join(";")).toBe(PERIOD_ABSENCES_CSV_HEADER);
      expect(header).toEqual([
        "Personalnummer",
        "Name",
        "Krank (Kalendertage)",
        "Kinderkrank (Kalendertage)",
        "Urlaub (Arbeitstage)",
        "Überstundenausgleich (Arbeitstage)",
        "Sonderurlaub (Arbeitstage)",
        "Berufsschule (Tage)",
        "Bildungsurlaub (Arbeitstage)",
        "Unbezahlt (Arbeitstage)",
        "Mutterschutz (Arbeitstage)",
        "Elternzeit (Arbeitstage)",
      ]);
      // Evidence for the SUMMARY: the first three lines of the file.
      console.info(`CSV first lines: ${JSON.stringify(text.split("\r\n").slice(0, 3))}`);
    });

    it("has one line per JSON row in the JSON order, each day cell the row's figure", async () => {
      const json = await period(CSV_QUERY);
      const res = await adminGet(csvUrl(`${CSV_QUERY}&table=absences`));
      const [, ...data] = parseCsv(bodyOf(res)).filter((r) => r.length > 1);
      expect(json.rows.length).toBeGreaterThanOrEqual(Object.keys(fx.people).length);
      expect(data.map((r) => r[0])).toEqual(json.rows.map((r) => r.employeeNumber));
      json.rows.forEach((row, i) => {
        expect(data[i]).toHaveLength(12);
        CODES.forEach((code, k) => {
          expect(data[i][2 + k], `${row.employeeNumber} ${code}`).toBe(deDays(row.absence[code]));
        });
      });
      // Evidence for the SUMMARY: p3 carries SICK, SICK_CHILD and the requested kinds.
      const p3Line = data.find((r) => r[0] === rowOf(json, fx.people.p3.id).employeeNumber);
      console.info(`CSV p3 line: ${JSON.stringify(p3Line)}`);
      // Not vacuous: a non-zero figure and a zero figure both occur.
      const flat = data.flatMap((r) => r.slice(2));
      expect(flat.some((c) => c !== "0")).toBe(true);
      expect(flat.some((c) => c === "0")).toBe(true);
    });

    it("writes exactly one audit row with its own type, period, salon and person count", async () => {
      // A period of its own: no other case of this file downloads it, so the row is unambiguous.
      const AUDIT_QUERY = "from=2026-06&to=2026-09";
      const json = await period(AUDIT_QUERY);
      const before = await count("PERIOD_ABSENCES_CSV");
      const timesBefore = await count("PERIOD_CSV");
      const res = await adminGet(csvUrl(`${AUDIT_QUERY}&table=absences`));
      expect(res.statusCode).toBe(200);
      expect(await count("PERIOD_ABSENCES_CSV")).toBe(before + 1);
      expect(await count("PERIOD_CSV")).toBe(timesBefore);
      const row = await soleAuditRow(app.prisma, {
        where: {
          ...auditWhere("PERIOD_ABSENCES_CSV"),
          AND: [{ newValue: { path: ["from"], equals: "2026-06" } }],
        },
      });
      expect(row.newValue).toEqual({
        type: "PERIOD_ABSENCES_CSV",
        from: "2026-06",
        to: "2026-09",
        salonId: null,
        personCount: json.rows.length,
      });
      console.info(`AUDIT newValue: ${JSON.stringify(row.newValue)}`);
    });

    it("under a salon filter lists the filtered JSON rows and audits the salon id", async () => {
      const qs = `from=2026-07&to=2026-10&salonId=${fx.salonId}`;
      const json = await period(qs);
      const res = await adminGet(csvUrl(`${qs}&table=absences`));
      expect(res.statusCode, res.body).toBe(200);
      const [, ...data] = parseCsv(bodyOf(res)).filter((r) => r.length > 1);
      expect(json.rows.length).toBeGreaterThan(0);
      expect(data.map((r) => r[0])).toEqual(json.rows.map((r) => r.employeeNumber));
      json.rows.forEach((row, i) => {
        CODES.forEach((code, k) => expect(data[i][2 + k]).toBe(deDays(row.absence[code])));
      });
      const audit = await soleAuditRow(app.prisma, {
        where: {
          ...auditWhere("PERIOD_ABSENCES_CSV"),
          AND: [{ newValue: { path: ["from"], equals: "2026-07" } }],
        },
      });
      expect(audit.newValue).toEqual({
        type: "PERIOD_ABSENCES_CSV",
        from: "2026-07",
        to: "2026-10",
        salonId: fx.salonId,
        personCount: json.rows.length,
      });
    });

    it("leaves today's file untouched: no table and table=times are byte-identical and audit PERIOD_CSV", async () => {
      const before = await count("PERIOD_ABSENCES_CSV");
      const timesBefore = await count("PERIOD_CSV");
      const plain = await adminGet(csvUrl(CSV_QUERY));
      const times = await adminGet(csvUrl(`${CSV_QUERY}&table=times`));
      expect(plain.statusCode).toBe(200);
      expect(times.statusCode).toBe(200);
      expect(Buffer.compare(plain.rawPayload, times.rawPayload)).toBe(0);
      expect(plain.headers["content-disposition"]).toBe(
        'attachment; filename="Zeiten-und-Konten_2026-08_2026-10.csv"',
      );
      expect(parseCsv(bodyOf(plain))[0][2]).toBe("Soll (h)");
      expect(await count("PERIOD_CSV")).toBe(timesBefore + 2);
      expect(await count("PERIOD_ABSENCES_CSV")).toBe(before);
    });

    it("refuses an unknown table, a future range and an unknown salon without an audit row", async () => {
      const before = await count("PERIOD_ABSENCES_CSV");
      const timesBefore = await count("PERIOD_CSV");
      const badTable = await adminGet(csvUrl(`${CSV_QUERY}&table=foo`));
      expect(badTable.statusCode, badTable.body).toBe(400);
      const future = await adminGet(csvUrl("from=2026-11&to=2026-12&table=absences"));
      expect(future.statusCode, future.body).toBe(400);
      const unknownSalon = await adminGet(
        csvUrl(`${CSV_QUERY}&table=absences&salonId=${randomUUID()}`),
      );
      expect(unknownSalon.statusCode).toBe(404);
      // The one 404 body of the salon filter: the same as the times file answers for an unknown salon.
      const timesUnknown = await adminGet(csvUrl(`${CSV_QUERY}&salonId=${randomUUID()}`));
      expect(timesUnknown.statusCode).toBe(404);
      expect(unknownSalon.body).toBe(timesUnknown.body);
      expect(await count("PERIOD_ABSENCES_CSV")).toBe(before);
      expect(await count("PERIOD_CSV")).toBe(timesBefore);
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
    }, 60_000);

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

    it("the absences CSV lists RA only, and the id of a person homed in B gives the file of an unknown id", async () => {
      const csvAs = (qs: string) =>
        getAs(`/api/v1/reports/period/csv?${REACH_QUERY}&table=absences${qs}`, managerToken);
      const list = await csvAs("");
      expect(list.statusCode, list.body).toBe(200);
      const records = parseCsv(list.rawPayload.subarray(3).toString("utf8")).filter(
        (r) => r.length > 1,
      );
      const jsonRows = (await periodAs(REACH_QUERY, managerToken)).rows;
      expect(jsonRows.map((r) => r.employeeId)).toEqual([person.RA]);
      expect(records.slice(1).map((r) => r[0])).toEqual(jsonRows.map((r) => r.employeeNumber));
      // Derived from the world: RA SICK 2 (07.-08.09.), SICK_CHILD 1 (09.09.).
      expect(records[1].slice(2, 4)).toEqual(["2", "1"]);

      const outside = await csvAs(`&employeeId=${person.RB}`);
      const unknown = await csvAs(`&employeeId=${randomUUID()}`);
      expect(outside.statusCode).toBe(200);
      expect(unknown.statusCode).toBe(200);
      expect(Buffer.compare(outside.rawPayload, unknown.rawPayload)).toBe(0);
      // Header only: the BOM, the header line and its CRLF.
      expect(outside.rawPayload.subarray(3).toString("utf8")).toBe(
        `${PERIOD_ABSENCES_CSV_HEADER}\r\n`,
      );
      console.info(
        `REACH csv out-of-reach vs unknown ${outside.rawPayload.length} / ${unknown.rawPayload.length} bytes`,
      );
      // Control: the admin gets RB's line for the same id.
      const control = await getAs(
        `/api/v1/reports/period/csv?${REACH_QUERY}&table=absences&employeeId=${person.RB}`,
        world.adminToken,
      );
      expect(control.statusCode).toBe(200);
      expect(
        parseCsv(control.rawPayload.subarray(3).toString("utf8")).filter((r) => r.length > 1),
      ).toHaveLength(2);
    });
  });
});
