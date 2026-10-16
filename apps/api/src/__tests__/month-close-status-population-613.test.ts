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

  async function getJson<T>(url: string) {
    return withClock(d.adminToken, async (t) => {
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
});
