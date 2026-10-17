/**
 * Issue #613 (Phase 613, plan 03) — the Monatsabschluss status and the year status list the
 * month's population (`reportPopulationWhere`), mark persons with an exit date, and compute
 * missing days only inside the employment window the close writer uses.
 *
 * Tenant time zone Europe/Berlin, clock faked to 2026-11-18T10:00:00Z (only `Date`). Persons:
 *   E1  exit 2026-09-30T00:00:00Z (the shape PATCH /employees writes)
 *   D   login deactivated, no exit date (the Elternzeit case)
 *   A   anonymised sentinel, no exit date
 *   H   hired 2026-10-01T00:00:00Z
 *   X   exempt from time tracking, no exit date
 * No person names, no real e-mails (synthetic fixture).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, reissueTokenNow } from "./setup";
import { createPopulationPerson, type PopulationPerson } from "./population-fixtures-613";
import { isEmployedInPeriod } from "../contexts/platform";
import { monthRangeUtc } from "../contexts/working-time-account";

const FAKE_NOW = new Date("2026-11-18T10:00:00Z");
const TZ = "Europe/Berlin";

interface StatusRow {
  employeeId: string;
  status: "ready" | "missing" | "closed";
  exitDate?: string | null;
  missingDates?: string[];
  missingDateCount?: number;
}

interface YearMonth {
  month: number;
  status: string;
  closedCount: number;
  totalCount: number;
  missing?: Array<{ employeeNumber: string; missingDates: string[]; missingDateCount: number }>;
}

describe("Issue #613 — Monatsabschluss status population", () => {
  let app: FastifyInstance;
  let d: Awaited<ReturnType<typeof seedTestData>>;
  let p: Record<"E1" | "D" | "A" | "H" | "X", PopulationPerson>;

  async function withClock<T>(token: string, fn: (token: string) => Promise<T>): Promise<T> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FAKE_NOW);
    try {
      return await fn(reissueTokenNow(app, token));
    } finally {
      vi.useRealTimers();
    }
  }

  async function getJson<T>(url: string, token = d.adminToken) {
    return withClock(token, async (t) => {
      const res = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${t}` },
      });
      return { status: res.statusCode, body: JSON.parse(res.body) as T };
    });
  }

  async function statusRows(year: number, month: number): Promise<StatusRow[]> {
    const res = await getJson<{ employees: StatusRow[] }>(
      `/api/v1/overtime/close-month/status?year=${year}&month=${month}`,
    );
    expect(res.status).toBe(200);
    return res.body.employees;
  }

  async function yearMonths(year: number): Promise<YearMonth[]> {
    const res = await getJson<{ months: YearMonth[] }>(
      `/api/v1/overtime/close-month/year-status?year=${year}`,
    );
    expect(res.status).toBe(200);
    return res.body.months;
  }

  beforeAll(async () => {
    app = await getTestApp();
    d = await seedTestData(app, "ms613");
    const base = { tenantId: d.tenant.id, salonId: d.salonId };
    const hire = new Date("2025-01-01T00:00:00.000Z");
    p = {
      E1: await createPopulationPerson(app, {
        ...base,
        tag: "e1",
        hireDate: hire,
        exitDate: new Date("2026-09-30T00:00:00.000Z"),
      }),
      D: await createPopulationPerson(app, {
        ...base,
        tag: "d",
        hireDate: hire,
        loginActive: false,
      }),
      A: await createPopulationPerson(app, { ...base, tag: "a", hireDate: hire, anonymized: true }),
      H: await createPopulationPerson(app, {
        ...base,
        tag: "h",
        hireDate: new Date("2026-10-01T00:00:00.000Z"),
      }),
      X: await createPopulationPerson(app, { ...base, tag: "x", hireDate: hire }),
    };
    await app.prisma.employee.update({
      where: { id: p.X.employeeId },
      data: { isTimeTrackingExempt: true },
    });
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, d.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("population", () => {
    it("September lists E1 (with exitDate) and D (exitDate null), and neither A, H nor X", async () => {
      const rows = await statusRows(2026, 9);
      const ids = rows.map((r) => r.employeeId);
      expect(ids).toEqual(expect.arrayContaining([p.E1.employeeId, p.D.employeeId]));
      for (const absent of [p.A, p.H, p.X]) expect(ids).not.toContain(absent.employeeId);
      expect(rows.find((r) => r.employeeId === p.E1.employeeId)?.exitDate).toBe("2026-09-30");
      expect(rows.find((r) => r.employeeId === p.D.employeeId)?.exitDate).toBeNull();
    });

    it("October lists D and H, and none of E1, A, X", async () => {
      const ids = (await statusRows(2026, 10)).map((r) => r.employeeId);
      expect(ids).toEqual(expect.arrayContaining([p.D.employeeId, p.H.employeeId]));
      for (const absent of [p.E1, p.A, p.X]) expect(ids).not.toContain(absent.employeeId);
    });

    it("the year status counts a person only in the months of their employment", async () => {
      const months = await yearMonths(2026);
      const sep = months.find((m) => m.month === 9)!;
      const oct = months.find((m) => m.month === 10)!;
      const people = await app.prisma.employee.findMany({
        where: { tenantId: d.tenant.id, isTimeTrackingExempt: false },
        select: { hireDate: true, exitDate: true, firstName: true },
      });
      const sepRange = monthRangeUtc(2026, 9, TZ);
      const octRange = monthRangeUtc(2026, 10, TZ);
      const live = people.filter((e) => e.firstName !== "Gelöscht");
      const inSep = live.filter((e) => isEmployedInPeriod(e, sepRange.start, sepRange.end));
      const inOct = live.filter((e) => isEmployedInPeriod(e, octRange.start, octRange.end));
      const leavers = inSep.filter((e) => !inOct.includes(e)).length;
      const joiners = inOct.filter((e) => !inSep.includes(e)).length;
      expect(leavers).toBeGreaterThanOrEqual(1);
      expect(joiners).toBeGreaterThanOrEqual(1);
      expect(sep.totalCount).toBe(inSep.length);
      expect(oct.totalCount).toBe(inOct.length);
      expect(sep.totalCount - oct.totalCount).toBe(leavers - joiners);
    });

    it("a closed September snapshot makes E1's September row closed", async () => {
      const range = monthRangeUtc(2026, 9, TZ);
      await app.prisma.saldoSnapshot.create({
        data: {
          employeeId: p.E1.employeeId,
          periodType: "MONTHLY",
          periodStart: range.start,
          periodEnd: range.end,
          workedMinutes: 0,
          expectedMinutes: 0,
          balanceMinutes: 0,
          carryOver: 0,
          closedAt: new Date(),
          closedBy: null,
        },
      });
      const row = (await statusRows(2026, 9)).find((r) => r.employeeId === p.E1.employeeId);
      expect(row?.status).toBe("closed");
    });
  });
  describe("employment window parity", () => {
    let pd: Awaited<ReturnType<typeof seedTestData>>;
    let w: Record<"M" | "M2" | "N" | "N2", PopulationPerson>;

    /** Mon–Fri days of an inclusive range of `YYYY-MM-DD` strings. */
    function workdays(fromStr: string, toStr: string): string[] {
      const out: string[] = [];
      const cur = new Date(fromStr + "T00:00:00Z");
      const end = new Date(toStr + "T00:00:00Z");
      while (cur <= end) {
        const dow = cur.getUTCDay();
        if (dow >= 1 && dow <= 5) out.push(cur.toISOString().slice(0, 10));
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
      return out;
    }

    /** The `gapDates` of the close writer for a person without `confirmGaps` (409). */
    async function writerGapDates(employeeId: string): Promise<string[]> {
      return withClock(pd.adminToken, async (t) => {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/overtime/close-month",
          headers: { authorization: `Bearer ${t}` },
          payload: { employeeId, year: 2026, month: 9 },
        });
        expect(res.statusCode, res.body).toBe(409);
        return (JSON.parse(res.body) as { gapDates: string[] }).gapDates;
      });
    }

    async function statusMissing(employeeId: string): Promise<string[]> {
      const res = await getJson<{ employees: StatusRow[] }>(
        "/api/v1/overtime/close-month/status?year=2026&month=9",
        pd.adminToken,
      );
      expect(res.status).toBe(200);
      const row = res.body.employees.find((r) => r.employeeId === employeeId);
      expect(row?.status).toBe("missing");
      return row?.missingDates ?? [];
    }

    beforeAll(async () => {
      pd = await seedTestData(app, "pw613");
      // Only the fixture persons form this tenant's population: the seeded accounts stay able to
      // sign in but are exempt, so no earlier month is open for them in the year status.
      await app.prisma.employee.updateMany({
        where: { tenantId: pd.tenant.id },
        data: { isTimeTrackingExempt: true },
      });
      const base = { tenantId: pd.tenant.id, salonId: pd.salonId };
      const hire = new Date("2025-01-01T00:00:00.000Z");
      w = {
        M: await createPopulationPerson(app, {
          ...base,
          tag: "m",
          hireDate: hire,
          exitDate: new Date("2026-09-15T00:00:00.000Z"),
        }),
        M2: await createPopulationPerson(app, {
          ...base,
          tag: "m2",
          hireDate: hire,
          exitDate: new Date("2026-09-14T22:00:00.000Z"),
        }),
        N: await createPopulationPerson(app, {
          ...base,
          tag: "n",
          hireDate: new Date("2026-09-14T22:00:00.000Z"),
        }),
        N2: await createPopulationPerson(app, {
          ...base,
          tag: "n2",
          hireDate: new Date("2026-09-15T00:00:00.000Z"),
        }),
      };
      // The writer closes month by month: January to August 2026 are closed for the two persons
      // employed before the year, so the writer reaches the September gap check.
      for (const person of [w.M, w.M2]) {
        for (let m = 1; m <= 8; m++) {
          const range = monthRangeUtc(2026, m, TZ);
          await app.prisma.saldoSnapshot.create({
            data: {
              employeeId: person.employeeId,
              periodType: "MONTHLY",
              periodStart: range.start,
              periodEnd: range.end,
              workedMinutes: 0,
              expectedMinutes: 0,
              balanceMinutes: 0,
              carryOver: 0,
              closedAt: new Date(),
              closedBy: null,
            },
          });
        }
      }
    }, 120_000);

    afterAll(async () => {
      try {
        await cleanupTestData(app, pd.tenant.id);
      } catch (err) {
        console.error("Test cleanup failed:", err);
      }
    });

    it("M (exit 15.09. as stored by PATCH): status gaps end on the exit day and equal the writer's", async () => {
      const expected = workdays("2026-09-01", "2026-09-15");
      const status = await statusMissing(w.M.employeeId);
      expect([...status].sort()).toEqual(expected);
      expect([...(await writerGapDates(w.M.employeeId))].sort()).toEqual(expected);
    });

    it("M2 (exit as tenant-local midnight): same set as M and as the writer", async () => {
      const expected = workdays("2026-09-01", "2026-09-15");
      expect([...(await statusMissing(w.M2.employeeId))].sort()).toEqual(expected);
      expect([...(await writerGapDates(w.M2.employeeId))].sort()).toEqual(expected);
    });

    it("N (hired as tenant-local midnight of 15.09.): first missing day 2026-09-15, equal to the writer's", async () => {
      const expected = workdays("2026-09-15", "2026-09-30");
      const status = [...(await statusMissing(w.N.employeeId))].sort();
      expect(status[0]).toBe("2026-09-15");
      expect(status).toEqual(expected);
      expect([...(await writerGapDates(w.N.employeeId))].sort()).toEqual(expected);
    });

    it("N2 (hired 2026-09-15T00:00Z): same set as N and as the writer", async () => {
      const expected = workdays("2026-09-15", "2026-09-30");
      expect([...(await statusMissing(w.N2.employeeId))].sort()).toEqual(expected);
      expect([...(await writerGapDates(w.N2.employeeId))].sort()).toEqual(expected);
    });

    it("the year status September counts the same missing days per person", async () => {
      const res = await getJson<{ months: YearMonth[] }>(
        "/api/v1/overtime/close-month/year-status?year=2026",
        pd.adminToken,
      );
      expect(res.status).toBe(200);
      const sep = res.body.months.find((m) => m.month === 9)!;
      expect(sep.status).toBe("open");
      const sizeOf = (person: PopulationPerson) =>
        sep.missing?.find((x) => x.employeeNumber === person.employeeNumber)?.missingDateCount;
      const early = workdays("2026-09-01", "2026-09-15").length;
      const late = workdays("2026-09-15", "2026-09-30").length;
      expect(sizeOf(w.M)).toBe(early);
      expect(sizeOf(w.M2)).toBe(early);
      expect(sizeOf(w.N)).toBe(late);
      expect(sizeOf(w.N2)).toBe(late);
    });
  });
});
