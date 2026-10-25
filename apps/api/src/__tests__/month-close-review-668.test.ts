/**
 * Issue #668 - review findings of PR #751, one describe per finding.
 *
 *  1. Gaps end on the exit day (cron, deferred escalation, `detectMonthGaps`).
 *  2. The status routes list exactly the cron / deferred population, so a deferred anonymised
 *     leaver can be opened and closed in the UI path.
 *  3. The year-end close expects months only through the exit month.
 *  5. A deactivated login WITHOUT an exit date is never force-closed over gap months; months
 *     without gaps close normally; the deferred state names the cause EXIT_DATE_MISSING.
 *
 * (Finding 4, the dry run, lives in scripts/__tests__/audit-613-month-close-population.test.ts.)
 * Tenant time zone Europe/Berlin; Date is faked. Synthetic fixture persons, no real data.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, reissueTokenNow } from "./setup";
import { createPopulationPerson, type PopulationPerson } from "./population-fixtures-613";
import { getDeferredMonthCloseState } from "../contexts/working-time-account/deferred-month-close";
import { detectMonthGaps } from "../contexts/working-time-account/month-gap-check";
import { periodStartWindow } from "../contexts/working-time-account/snapshot-period";
import { monthRangeUtc } from "../contexts/working-time-account/timezone";

const TZ = "Europe/Berlin";
const NOW = new Date("2026-11-18T10:00:00Z");
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

async function withClock<T>(now: Date, fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}

async function cleanup(app: FastifyInstance, tenantId: string) {
  try {
    const ids = (
      await app.prisma.employee.findMany({ where: { tenantId }, select: { id: true } })
    ).map((e) => e.id);
    await app.prisma.saldoSnapshot.deleteMany({ where: { employeeId: { in: ids } } });
    await cleanupTestData(app, tenantId);
  } catch (err) {
    console.error("668 review cleanup failed:", err);
  }
}

async function monthRow(app: FastifyInstance, employeeId: string, year: number, month: number) {
  return app.prisma.saldoSnapshot.findFirst({
    where: {
      employeeId,
      periodType: "MONTHLY",
      superseded: false,
      periodStart: periodStartWindow(monthRangeUtc(year, month, TZ).start),
    },
  });
}

describe("Issue #668 review - findings 1, 2 and 5 (cron, deferred state, status routes)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let p: Record<"L" | "D" | "E" | "Q" | "Q2" | "Q3", PopulationPerson>;

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "r668");
    // Only the fixture persons form this tenant's population.
    await app.prisma.employee.updateMany({
      where: { tenantId: seed.tenant.id },
      data: { isTimeTrackingExempt: true },
    });
    const base = { tenantId: seed.tenant.id, salonId: seed.salonId, hireDate: d("2026-09-01") };
    p = {
      // L: login off, left on Thu 10.09. -> gaps only 01.-10.09.
      L: await createPopulationPerson(app, {
        ...base,
        tag: "l",
        loginActive: false,
        exitDate: d("2026-09-10"),
      }),
      // D: anonymised AFTER leaving on 30.09. -> deferred, must be closable in the UI path.
      D: await createPopulationPerson(app, {
        ...base,
        tag: "d",
        anonymized: true,
        exitDate: d("2026-09-30"),
      }),
      // E: legacy anonymised row without an exit date -> in no population.
      E: await createPopulationPerson(app, { ...base, tag: "e", anonymized: true }),
      // Q: login off, NO exit date, gap days -> never force-closed.
      Q: await createPopulationPerson(app, { ...base, tag: "q", loginActive: false }),
      // Q2: login off, NO exit date, but no daily gap rule (MONTHLY_HOURS) -> closes normally.
      Q2: await createPopulationPerson(app, { ...base, tag: "q2", loginActive: false }),
      // Q3: ACTIVE login, no exit date, gap days -> force-closed as before.
      Q3: await createPopulationPerson(app, { ...base, tag: "q3" }),
    };
    await app.prisma.workSchedule.updateMany({
      where: { employeeId: p.Q2.employeeId },
      data: { type: "MONTHLY_HOURS", monthlyHours: 40 },
    });
    for (const person of [p.L, p.D, p.E, p.Q, p.Q2, p.Q3]) {
      await app.prisma.employee.update({
        where: { id: person.employeeId },
        data: { isTimeTrackingExempt: false },
      });
    }
  }, 180_000);

  afterAll(async () => {
    await cleanup(app, seed.tenant.id);
    await closeTestApp();
  });

  async function getJson<T>(url: string) {
    return withClock(NOW, async () => {
      const res = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${reissueTokenNow(app, seed.adminToken)}` },
      });
      return { status: res.statusCode, body: JSON.parse(res.body) as T };
    });
  }

  // ── Finding 1 ────────────────────────────────────────────────────────────────────────────
  describe("finding 1 - no gap after the exit day", () => {
    const gapInput = (exitDate: Date | null, who: PopulationPerson) => ({
      tenantId: seed.tenant.id,
      employeeId: who.employeeId,
      hireDate: d("2026-09-01"),
      exitDate,
      month: { year: 2026, month: 9 },
      tz: TZ,
    });
    async function scheduleOf(who: PopulationPerson) {
      return (await app.prisma.workSchedule.findFirst({
        where: { employeeId: who.employeeId },
      })) as unknown as Record<string, unknown>;
    }

    it("detectMonthGaps ends at the exit day (inclusive) and keeps the full month without one", async () => {
      const schedule = await scheduleOf(p.L);
      const withExit = await detectMonthGaps(app.prisma, {
        ...gapInput(d("2026-09-10"), p.L),
        schedule,
      });
      expect(withExit.gapDates).toEqual([
        "2026-09-01",
        "2026-09-02",
        "2026-09-03",
        "2026-09-04",
        "2026-09-07",
        "2026-09-08",
        "2026-09-09",
        "2026-09-10",
      ]);
      const open = await detectMonthGaps(app.prisma, { ...gapInput(null, p.L), schedule });
      expect(open.gapDates.at(-1)).toBe("2026-09-30");
    });

    it("a month entirely after the exit has no gap", async () => {
      const schedule = await scheduleOf(p.L);
      const res = await detectMonthGaps(app.prisma, {
        ...gapInput(d("2026-08-20"), p.L),
        schedule,
      });
      expect(res.gapDates).toEqual([]);
    });

    it("the deferred escalation names gap days only up to the exit day", async () => {
      const state = await getDeferredMonthCloseState(app.prisma, seed.tenant.id, {
        now: NOW,
        detailed: true,
      });
      const row = state.employees.find((e) => e.employeeId === p.L.employeeId);
      expect(row?.reason).toBe("GAPS");
      expect(row?.gapDates.at(-1)).toBe("2026-09-10");
      expect(row?.gapCount).toBe(8);
    });
  });

  // ── Finding 2 ────────────────────────────────────────────────────────────────────────────
  describe("finding 2 - the status routes list the cron / deferred population", () => {
    it("lists the anonymised leaver D for its exit month, not the legacy row E", async () => {
      const res = await getJson<{ employees: Array<{ employeeId: string; status: string }> }>(
        "/api/v1/overtime/close-month/status?year=2026&month=9",
      );
      expect(res.status).toBe(200);
      const ids = res.body.employees.map((r) => r.employeeId);
      expect(ids).toContain(p.D.employeeId);
      expect(ids).not.toContain(p.E.employeeId);
    });

    it("every person of the deferred list appears in the status of its oldest open month", async () => {
      const state = await getDeferredMonthCloseState(app.prisma, seed.tenant.id, { now: NOW });
      expect(state.employees.map((e) => e.employeeId)).toContain(p.D.employeeId);
      for (const e of state.employees) {
        const res = await getJson<{ employees: Array<{ employeeId: string }> }>(
          `/api/v1/overtime/close-month/status?year=${e.oldestOpenMonth.year}&month=${e.oldestOpenMonth.month}`,
        );
        expect(
          res.body.employees.map((r) => r.employeeId),
          e.employeeId,
        ).toContain(e.employeeId);
      }
    });

    it("the year status counts D in September (and not E)", async () => {
      const res = await getJson<{
        months: Array<{ month: number; totalCount: number }>;
      }>("/api/v1/overtime/close-month/year-status?year=2026");
      expect(res.status).toBe(200);
      // L, D, Q, Q2, Q3 are employed in September; E is in no population.
      expect(res.body.months.find((m) => m.month === 9)?.totalCount).toBe(5);
      // Only Q, Q2 and Q3 reach October (L and D left in September).
      expect(res.body.months.find((m) => m.month === 10)?.totalCount).toBe(3);
    });

    it("the deferred anonymised leaver D can be closed through the UI path", async () => {
      const closed = await withClock(NOW, () =>
        app.inject({
          method: "POST",
          url: "/api/v1/overtime/close-month",
          headers: { authorization: `Bearer ${reissueTokenNow(app, seed.adminToken)}` },
          payload: { employeeId: p.D.employeeId, year: 2026, month: 9, confirmGaps: true },
        }),
      );
      expect(closed.statusCode, closed.body).toBe(201);
      expect(await monthRow(app, p.D.employeeId, 2026, 9)).not.toBeNull();
      const res = await getJson<{ employees: Array<{ employeeId: string; status: string }> }>(
        "/api/v1/overtime/close-month/status?year=2026&month=9",
      );
      expect(res.body.employees.find((r) => r.employeeId === p.D.employeeId)?.status).toBe(
        "closed",
      );
    });
  });

  // ── Finding 5 (and finding 1 through the cron) ──────────────────────────────────────────
  describe("after the cron run", () => {
    beforeAll(async () => {
      await withClock(NOW, () => app.tryAutoCloseMonth());
    }, 180_000);

    it("finding 1: the leaver's force-closed month lists gap days only up to the exit day", async () => {
      const row = await monthRow(app, p.L.employeeId, 2026, 9);
      expect(row).not.toBeNull();
      expect(row!.note).toContain("8 Lücke(n)");
      expect(row!.note).toContain("2026-09-10");
      expect(row!.note).not.toContain("2026-09-11");
      expect(await monthRow(app, p.L.employeeId, 2026, 10)).toBeNull();
    });

    it("finding 5: a deactivated login without an exit date is not force-closed over gaps", async () => {
      expect(await monthRow(app, p.Q.employeeId, 2026, 9)).toBeNull();
      expect(await monthRow(app, p.Q.employeeId, 2026, 10)).toBeNull();
      const snaps = await app.prisma.saldoSnapshot.count({ where: { employeeId: p.Q.employeeId } });
      expect(snaps).toBe(0);
    });

    it("finding 5: months without gaps still close for that person (no daily gap rule)", async () => {
      expect(await monthRow(app, p.Q2.employeeId, 2026, 9)).not.toBeNull();
      expect(await monthRow(app, p.Q2.employeeId, 2026, 10)).not.toBeNull();
    });

    it("finding 5: an ACTIVE login without an exit date keeps today's behaviour (force-closed)", async () => {
      const row = await monthRow(app, p.Q3.employeeId, 2026, 9);
      expect(row).not.toBeNull();
      expect(row!.note).toContain("Lücke(n) als 0h geschlossen");
    });

    it("finding 5: the deferred state names the cause EXIT_DATE_MISSING (summary and detailed)", async () => {
      for (const detailed of [false, true]) {
        const state = await getDeferredMonthCloseState(app.prisma, seed.tenant.id, {
          now: NOW,
          detailed,
        });
        const q = state.employees.find((e) => e.employeeId === p.Q.employeeId);
        expect(q?.reason, `detailed=${detailed}`).toBe("EXIT_DATE_MISSING");
        expect(q?.oldestOpenMonth).toEqual({ year: 2026, month: 9 });
        // The active-login force-closed person is not deferred.
        expect(state.employees.map((e) => e.employeeId)).not.toContain(p.Q3.employeeId);
      }
    });

    it("finding 5: the manager notification says the exit date is missing", async () => {
      const notes = await app.prisma.notification.findMany({
        where: { userId: seed.adminUser.id, type: "MONTH_CLOSE_BLOCKED" },
      });
      expect(notes.some((n) => n.message.includes("Austrittsdatum fehlt – bitte prüfen"))).toBe(
        true,
      );
    });
  });
});

describe("Issue #668 review - finding 1 through the cron (inside the retro window)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let leaver: PopulationPerson;
  let stayer: PopulationPerson;
  // 5 Oct 2026: September is still inside the retro window (day < 10), so a gap defers it.
  const WINDOW_NOW = new Date("2026-10-05T10:00:00Z");

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "c668");
    await app.prisma.employee.updateMany({
      where: { tenantId: seed.tenant.id },
      data: { isTimeTrackingExempt: true },
    });
    const base = { tenantId: seed.tenant.id, salonId: seed.salonId, hireDate: d("2026-09-01") };
    leaver = await createPopulationPerson(app, {
      ...base,
      tag: "cl",
      loginActive: false,
      exitDate: d("2026-09-10"),
    });
    stayer = await createPopulationPerson(app, { ...base, tag: "cs" });
    for (const person of [leaver, stayer]) {
      await app.prisma.employee.update({
        where: { id: person.employeeId },
        data: { isTimeTrackingExempt: false },
      });
      // Every workday 1.-10.09. is recorded; nothing after the 10th.
      for (const day of ["01", "02", "03", "04", "07", "08", "09", "10"]) {
        const date = `2026-09-${day}`;
        await app.prisma.timeEntry.create({
          data: {
            employeeId: person.employeeId,
            date: new Date(`${date}T00:00:00Z`),
            startTime: new Date(`${date}T07:00:00Z`),
            endTime: new Date(`${date}T15:30:00Z`),
            breakMinutes: 30,
            type: "WORK",
            salonId: seed.salonId,
          },
        });
      }
    }
  }, 180_000);

  afterAll(async () => {
    await cleanup(app, seed.tenant.id);
    await closeTestApp();
  });

  it("a leaver who recorded every day up to the exit day is closed, not deferred over days after it", async () => {
    await withClock(WINDOW_NOW, () => app.tryAutoCloseMonth());
    const row = await monthRow(app, leaver.employeeId, 2026, 9);
    expect(row).not.toBeNull();
    expect(row!.note).toBe("Automatischer Monatsabschluss");
    // Control: the same entries without an exit date leave 14 later workdays open, which defers.
    expect(await monthRow(app, stayer.employeeId, 2026, 9)).toBeNull();
  });
});

describe("Issue #668 review - finding 3 (year-end close of a leaver)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let leaver: PopulationPerson;
  let earlier: PopulationPerson;
  let stillOpen: PopulationPerson;
  const YEAR_NOW = new Date("2027-01-20T10:00:00Z");

  async function zeroMonths(employeeId: string, year: number, from: number, to: number) {
    for (let m = from; m <= to; m++) {
      const r = monthRangeUtc(year, m, TZ);
      await app.prisma.saldoSnapshot.create({
        data: {
          employeeId,
          periodType: "MONTHLY",
          periodStart: r.start,
          periodEnd: r.end,
          workedMinutes: 0,
          expectedMinutes: 0,
          balanceMinutes: 0,
          carryOver: 0,
          closedAt: new Date("2026-12-01T06:00:00Z"),
          superseded: false,
        },
      });
    }
  }

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "y668");
    await app.prisma.employee.updateMany({
      where: { tenantId: seed.tenant.id },
      data: { isTimeTrackingExempt: true },
    });
    const base = { tenantId: seed.tenant.id, salonId: seed.salonId, hireDate: d("2026-01-01") };
    // Left on 30.06.2026, login off, Jan-Jun closed -> the year closes.
    leaver = await createPopulationPerson(app, {
      ...base,
      tag: "yl",
      loginActive: false,
      exitDate: d("2026-06-30"),
    });
    // Left in 2025: nothing to close in 2026, no yearly snapshot may appear.
    earlier = await createPopulationPerson(app, {
      ...base,
      tag: "ye",
      hireDate: d("2025-01-01"),
      loginActive: false,
      exitDate: d("2025-06-30"),
    });
    // Left on 30.06.2026 but only Jan-May closed and June has not been closable -> see below.
    stillOpen = await createPopulationPerson(app, {
      ...base,
      tag: "yo",
      loginActive: false,
      exitDate: d("2026-06-30"),
    });
    for (const person of [leaver, earlier, stillOpen]) {
      await app.prisma.employee.update({
        where: { id: person.employeeId },
        data: { isTimeTrackingExempt: false },
      });
    }
    await zeroMonths(leaver.employeeId, 2026, 1, 6);
    await zeroMonths(earlier.employeeId, 2025, 1, 12);
    await zeroMonths(stillOpen.employeeId, 2026, 1, 5);
    // June of stillOpen stays open because the person is deferred: login off, no more exit date.
    await app.prisma.employee.update({
      where: { id: stillOpen.employeeId },
      data: { exitDate: null },
    });
  }, 180_000);

  afterAll(async () => {
    await cleanup(app, seed.tenant.id);
    await closeTestApp();
  });

  const yearly = (employeeId: string) =>
    app.prisma.saldoSnapshot.count({
      where: { employeeId, periodType: "YEARLY", superseded: false },
    });

  it("a leaver before December gets the YEARLY snapshot and the overtimeAccount update once all employed months are closed", async () => {
    await withClock(YEAR_NOW, () => app.tryAutoCloseMonth());
    expect(await yearly(leaver.employeeId)).toBe(1);
    const acct = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: leaver.employeeId },
    });
    expect(Number(acct?.balanceHours)).toBe(0);
  });

  it("a person who left in an earlier year gets no yearly snapshot for 2026", async () => {
    expect(await yearly(earlier.employeeId)).toBe(0);
  });

  it("a person whose employed months are not all closed gets none", async () => {
    // No exit date, login off: June has gap days and is deferred, so only Jan-May are closed.
    expect(await yearly(stillOpen.employeeId)).toBe(0);
  });
});
