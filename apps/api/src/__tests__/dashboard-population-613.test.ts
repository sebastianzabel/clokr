/**
 * Issue #613 (Phase 613, plan 05), AC-613-1 / AC-613-2, D-613-1 / P-02 - the dashboard's Stichtag
 * views read the period population (`reportPopulationWhere`) with the day, week or month as the
 * period: today's attendance, the team trend (the same population as `GET /reports/monthly` per
 * month), the overtime trend and the team week.
 *
 * Tenant time zone Europe/Berlin; every describe fakes only `Date` at a mid-day UTC instant and
 * re-signs the token for it. Persons are built with `createPopulationPerson` (synthetic data, no
 * names). A is the DSGVO sentinel; its login is switched ON again in each describe so the proof
 * rests on the sentinel, never on the login state.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, reissueTokenNow } from "./setup";
import { createPopulationPerson, type PopulationPerson } from "./population-fixtures-613";

const HIRE = new Date("2025-01-01T00:00:00.000Z");
const day = (d: string) => new Date(`${d}T00:00:00.000Z`);

describe("Issue #613 - dashboard Stichtag views read the period population", () => {
  let app: FastifyInstance;

  async function withClock<T>(
    now: string,
    token: string,
    fn: (token: string) => Promise<T>,
  ): Promise<T> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now));
    try {
      return await fn(reissueTokenNow(app, token));
    } finally {
      vi.useRealTimers();
    }
  }

  async function getJson<T>(now: string, token: string, url: string): Promise<T> {
    return withClock(now, token, async (t) => {
      const res = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${t}` },
      });
      expect(res.statusCode, res.body).toBe(200);
      return JSON.parse(res.body) as T;
    });
  }

  async function entry(
    salonId: string,
    employeeId: string,
    date: string,
    start: string,
    end: string,
  ): Promise<void> {
    await app.prisma.timeEntry.create({
      data: {
        employeeId,
        salonId,
        date: day(date),
        startTime: new Date(`${date}T${start}:00Z`),
        endTime: new Date(`${date}T${end}:00Z`),
        breakMinutes: 0,
        type: "WORK",
        source: "MANUAL",
      },
    });
  }

  /** An anonymised person whose login is (inconsistently) ON: only the sentinel can exclude it. */
  async function anonymisedWithLogin(
    tenantId: string,
    salonId: string,
    tag: string,
    exitDate?: Date,
  ): Promise<PopulationPerson> {
    const person = await createPopulationPerson(app, {
      tenantId,
      salonId,
      tag,
      hireDate: HIRE,
      anonymized: true,
      exitDate,
    });
    await app.prisma.user.update({ where: { id: person.userId }, data: { isActive: true } });
    return person;
  }

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe("attendance today", () => {
    let d: Awaited<ReturnType<typeof seedTestData>>;
    let p: Record<"E0" | "F" | "D" | "E" | "H" | "A", PopulationPerson>;
    const NOW = "2026-09-16T10:00:00Z"; // Wed 16.09., 12:00 Berlin

    beforeAll(async () => {
      d = await seedTestData(app, "pa613");
      const base = { tenantId: d.tenant.id, salonId: d.salonId, hireDate: HIRE };
      p = {
        E0: await createPopulationPerson(app, {
          ...base,
          tag: "e0",
          exitDate: day("2026-09-16"),
        }),
        F: await createPopulationPerson(app, { ...base, tag: "f", exitDate: day("2026-12-31") }),
        D: await createPopulationPerson(app, { ...base, tag: "d", loginActive: false }),
        E: await createPopulationPerson(app, { ...base, tag: "e", exitDate: day("2026-09-15") }),
        H: await createPopulationPerson(app, {
          ...base,
          tag: "h",
          hireDate: day("2026-09-17"),
        }),
        A: await anonymisedWithLogin(d.tenant.id, d.salonId, "a"),
      };
    }, 120_000);

    afterAll(async () => {
      try {
        await cleanupTestData(app, d.tenant.id);
      } catch (err) {
        console.error("Test cleanup failed:", err);
      }
    });

    it("lists the persons employed today: exit today or later (also a notice exit), a deactivated login; not a leaver of yesterday, a hire of tomorrow, an anonymised person", async () => {
      const body = await getJson<{ employees: Array<{ id: string }> }>(
        NOW,
        d.adminToken,
        "/api/v1/dashboard/today-attendance",
      );
      const ids = new Set(body.employees.map((e) => e.id));
      expect(ids.has(p.E0.employeeId)).toBe(true);
      expect(ids.has(p.F.employeeId)).toBe(true);
      expect(ids.has(p.D.employeeId)).toBe(true);
      expect(ids.has(p.E.employeeId)).toBe(false);
      expect(ids.has(p.H.employeeId)).toBe(false);
      expect(ids.has(p.A.employeeId)).toBe(false);
    });
  });

  describe("team trend and overtime trend", () => {
    let d: Awaited<ReturnType<typeof seedTestData>>;
    let p: Record<"L" | "E" | "D" | "A", PopulationPerson>;
    const NOW = "2026-10-14T10:00:00Z"; // Wed 14.10.

    type TrendMonth = { month: string; workedMinutes: number };
    type MonthlyRow = { workedHours: number };

    async function monthlyWorked(month: number): Promise<number> {
      const body = await getJson<{ rows: MonthlyRow[] }>(
        NOW,
        d.adminToken,
        `/api/v1/reports/monthly?year=2026&month=${month}`,
      );
      return Math.round(body.rows.reduce((sum, r) => sum + r.workedHours * 60, 0));
    }

    beforeAll(async () => {
      d = await seedTestData(app, "pt613");
      const base = { tenantId: d.tenant.id, salonId: d.salonId, hireDate: HIRE };
      p = {
        L: await createPopulationPerson(app, { ...base, tag: "l", exitDate: day("2026-08-31") }),
        E: await createPopulationPerson(app, { ...base, tag: "e" }),
        D: await createPopulationPerson(app, { ...base, tag: "d", loginActive: false }),
        A: await anonymisedWithLogin(d.tenant.id, d.salonId, "a"),
      };
      // Worked minutes are multiples of 3 so the report's rounded hours convert back exactly.
      await entry(d.salonId, p.L.employeeId, "2026-08-10", "08:00", "16:00"); // 480
      await entry(d.salonId, p.E.employeeId, "2026-08-11", "08:00", "12:00"); // 240
      await entry(d.salonId, p.D.employeeId, "2026-08-12", "08:00", "11:00"); // 180
      await entry(d.salonId, p.E.employeeId, "2026-09-02", "08:00", "12:00"); // 240
      await entry(d.salonId, p.A.employeeId, "2026-09-02", "08:00", "12:00"); // 240, never counted
      await entry(d.salonId, p.A.employeeId, "2026-08-13", "08:00", "12:00"); // 240, never counted
      // Closed August snapshots (legacy convention): the overtime trend sums their carry-over, and a
      // closed month's worked figure comes from the snapshot, so it matches the entries above.
      for (const [person, carry, worked] of [
        [p.L, 120, 480],
        [p.E, 60, 240],
        [p.D, 30, 180],
        [p.A, 600, 240],
      ] as const) {
        await app.prisma.saldoSnapshot.create({
          data: {
            employeeId: person.employeeId,
            periodType: "MONTHLY",
            periodStart: day("2026-08-01"),
            periodEnd: day("2026-08-31"),
            workedMinutes: worked,
            expectedMinutes: 0,
            balanceMinutes: carry,
            carryOver: carry,
            closedAt: new Date("2026-09-02T06:00:00Z"),
            superseded: false,
          },
        });
      }
    }, 120_000);

    afterAll(async () => {
      try {
        await cleanupTestData(app, d.tenant.id);
      } catch (err) {
        console.error("Test cleanup failed:", err);
      }
    });

    it("the team trend counts the leaver in August and not in September, and equals /reports/monthly per month", async () => {
      const body = await getJson<{ months: TrendMonth[] }>(
        NOW,
        d.adminToken,
        "/api/v1/dashboard/team-trend?months=3",
      );
      const byMonth = new Map(body.months.map((m) => [m.month, m.workedMinutes]));
      // August: L 480 + E 240 + D 180 (deactivated login still employed); A never.
      expect(byMonth.get("2026-08")).toBe(900);
      // September: only E - L left on 31.08., A is anonymised.
      expect(byMonth.get("2026-09")).toBe(240);
      expect(byMonth.get("2026-08")).toBe(await monthlyWorked(8));
      expect(byMonth.get("2026-09")).toBe(await monthlyWorked(9));
    });

    it("the overtime trend aggregates the snapshots of the window's population, never an anonymised person's", async () => {
      const body = await getJson<{
        snapshots: Array<{ month: string; teamCarryOverMinutes: number }>;
      }>(NOW, d.adminToken, "/api/v1/dashboard/overtime-trend");
      const august = body.snapshots.find((s) => s.month === "2026-08-01");
      // L 120 + E 60 + D 30 (a deactivated login still belongs to the team); A (600) never.
      expect(august?.teamCarryOverMinutes).toBe(210);
    });
  });
});
