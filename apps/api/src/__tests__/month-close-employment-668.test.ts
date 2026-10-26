/**
 * Issue #668 - the month-close cron and the deferred close select persons by EMPLOYMENT, not by
 * login state (owner decision 19.10.2026). Also Refs #277 finding 1: the hire month of the yearly
 * close is read in the TENANT time zone, never in the zone of the Node process.
 *
 * Fixture: one tenant (Europe/Berlin), "now" = 18.11.2026, so the ceiling month is October 2026 and
 * September is past its retro window. Every person is FIXED_SCHEDULE without entries; the gaps are
 * force-closed by the cron (closeMonthWithGapsAllowed), which is irrelevant to WHO is selected.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { createPopulationPerson, type PopulationPerson } from "./population-fixtures-613";
import { getDeferredMonthCloseState } from "../contexts/working-time-account/deferred-month-close";
import { periodStartWindow } from "../contexts/working-time-account/snapshot-period";
import { monthRangeUtc } from "../contexts/working-time-account/timezone";
import {
  monthClosePopulationWhere,
  isInMonthClosePopulation,
} from "../contexts/working-time-account/month-close-population";

const NOW = new Date("2026-11-18T10:00:00Z");
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe("Issue #668 - month close selects by employment", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let p: Record<"A" | "B" | "C" | "D" | "E" | "F" | "G", PopulationPerson>;
  let closedRowBefore: unknown;
  let deferredIds: string[];

  const monthsOf = async (employeeId: string) =>
    (
      await app.prisma.saldoSnapshot.findMany({
        where: { employeeId, periodType: "MONTHLY", superseded: false },
        orderBy: { periodStart: "asc" },
      })
    ).map((s) => s.periodStart.toISOString().slice(0, 10));

  async function hasMonth(employeeId: string, year: number, month: number) {
    const { start } = monthRangeUtc(year, month, "Europe/Berlin");
    return (
      (await app.prisma.saldoSnapshot.count({
        where: {
          employeeId,
          periodType: "MONTHLY",
          superseded: false,
          periodStart: periodStartWindow(start),
        },
      })) > 0
    );
  }

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "m668");
    const base = { tenantId: seed.tenant.id, salonId: seed.salonId, hireDate: d("2026-09-01") };
    p = {
      // A: login switched off, employed all along, WITH an exit date after the ceiling -> IS closed
      // (a deactivated login WITHOUT an exit date is the EXIT_DATE_MISSING case, month-close-review-668).
      A: await createPopulationPerson(app, {
        ...base,
        tag: "a",
        loginActive: false,
        exitDate: d("2026-12-31"),
      }),
      // B: active login, left on 31.08. -> NOT closed for September or October.
      B: await createPopulationPerson(app, { ...base, tag: "b", exitDate: d("2026-08-31") }),
      // C: active login, hired 15.10. -> October only.
      C: await createPopulationPerson(app, { ...base, tag: "c", hireDate: d("2026-10-15") }),
      // D: anonymised AFTER leaving on 30.09. (exit date set) -> September, not October.
      D: await createPopulationPerson(app, {
        ...base,
        tag: "d",
        anonymized: true,
        exitDate: d("2026-09-30"),
      }),
      // E: legacy anonymised row without an exit date -> never closed (as before).
      E: await createPopulationPerson(app, { ...base, tag: "e", anonymized: true }),
      // F: login off, left on 15.10. -> September and October, nothing later.
      F: await createPopulationPerson(app, {
        ...base,
        tag: "f",
        loginActive: false,
        exitDate: d("2026-10-15"),
      }),
      // G: login off, September ALREADY closed with figures the cron would never produce.
      G: await createPopulationPerson(app, {
        ...base,
        tag: "g",
        loginActive: false,
        exitDate: d("2026-12-31"),
      }),
    };
    const { start } = monthRangeUtc(2026, 9, "Europe/Berlin");
    const row = await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: p.G.employeeId,
        periodType: "MONTHLY",
        periodStart: start,
        periodEnd: d("2026-09-30"),
        workedMinutes: 123,
        expectedMinutes: 456,
        balanceMinutes: -333,
        carryOver: 77,
        closedAt: new Date("2026-10-02T06:00:00Z"),
        superseded: false,
      },
    });
    closedRowBefore = row;

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      // Deferred state BEFORE the cron has closed anything.
      const state = await getDeferredMonthCloseState(app.prisma, seed.tenant.id, { now: NOW });
      deferredIds = state.employees.map((e) => e.employeeId);
      await app.tryAutoCloseMonth();
    } finally {
      vi.useRealTimers();
    }
  }, 180_000);

  afterAll(async () => {
    try {
      const ids = (
        await app.prisma.employee.findMany({
          where: { tenantId: seed.tenant.id },
          select: { id: true },
        })
      ).map((e) => e.id);
      await app.prisma.saldoSnapshot.deleteMany({ where: { employeeId: { in: ids } } });
      await cleanupTestData(app, seed.tenant.id);
    } catch (err) {
      console.error("668 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("a person whose login is off but who is employed IS closed", async () => {
    expect(await hasMonth(p.A.employeeId, 2026, 9)).toBe(true);
    expect(await hasMonth(p.A.employeeId, 2026, 10)).toBe(true);
  });

  it("an active login without employment in the month is NOT closed (left before / hired after)", async () => {
    expect(await monthsOf(p.B.employeeId)).toEqual([]);
    expect(await hasMonth(p.C.employeeId, 2026, 9)).toBe(false);
    expect(await hasMonth(p.C.employeeId, 2026, 10)).toBe(true);
  });

  it("an anonymised person employed in the month is closed up to the exit month (Lohnkonto, § 41 EStG)", async () => {
    expect(await hasMonth(p.D.employeeId, 2026, 9)).toBe(true);
    expect(await hasMonth(p.D.employeeId, 2026, 10)).toBe(false);
  });

  it("an anonymised legacy row without an exit date is not closed", async () => {
    expect(await monthsOf(p.E.employeeId)).toEqual([]);
  });

  it("a leaver with a login off is closed through the exit month and not beyond", async () => {
    expect(await hasMonth(p.F.employeeId, 2026, 9)).toBe(true);
    expect(await hasMonth(p.F.employeeId, 2026, 10)).toBe(true);
    expect(await hasMonth(p.F.employeeId, 2026, 11)).toBe(false);
  });

  it("an already closed month is unchanged field for field and the next month chains onto it", async () => {
    const after = await app.prisma.saldoSnapshot.findUnique({
      where: { id: (closedRowBefore as { id: string }).id },
    });
    expect(after).toEqual(closedRowBefore);
    const oct = await app.prisma.saldoSnapshot.findFirst({
      where: {
        employeeId: p.G.employeeId,
        periodType: "MONTHLY",
        superseded: false,
        periodStart: periodStartWindow(monthRangeUtc(2026, 10, "Europe/Berlin").start),
      },
    });
    expect(oct).not.toBeNull();
    // October starts from the stored carry-over of the closed September.
    expect(oct!.carryOver - oct!.balanceMinutes).toBe(77);
    // No second September row was written.
    expect(
      await app.prisma.saldoSnapshot.count({
        where: {
          employeeId: p.G.employeeId,
          periodType: "MONTHLY",
          periodStart: periodStartWindow(monthRangeUtc(2026, 9, "Europe/Berlin").start),
        },
      }),
    ).toBe(1);
  });

  it("the deferred close names the same people as the cron: employed with login off yes, not employed no", () => {
    expect(deferredIds).toContain(p.A.employeeId);
    expect(deferredIds).toContain(p.D.employeeId); // anonymised, employed in September
    expect(deferredIds).toContain(p.F.employeeId);
    expect(deferredIds).not.toContain(p.B.employeeId);
    expect(deferredIds).not.toContain(p.E.employeeId);
  });

  it("the in-memory twin agrees with the Prisma filter for every fixture person", async () => {
    const { start, end } = monthRangeUtc(2026, 9, "Europe/Berlin");
    const rows = await app.prisma.employee.findMany({ where: { tenantId: seed.tenant.id } });
    const hits = new Set(
      (
        await app.prisma.employee.findMany({
          where: { tenantId: seed.tenant.id, AND: [monthClosePopulationWhere(start, end)] },
          select: { id: true },
        })
      ).map((r) => r.id),
    );
    for (const r of rows) expect(isInMonthClosePopulation(r, start, end)).toBe(hits.has(r.id));
  });
});

describe("Issue #277 finding 1 - the hire month of the yearly close follows the tenant zone", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let person: PopulationPerson;
  const originalTz = process.env.TZ;

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "y277");
    // 1 July 2026 00:00 Europe/Berlin = 30 June 22:00Z: a process running in UTC reads JUNE.
    person = await createPopulationPerson(app, {
      tenantId: seed.tenant.id,
      salonId: seed.salonId,
      tag: "y",
      hireDate: new Date("2026-06-30T22:00:00.000Z"),
    });
    for (let m = 7; m <= 12; m++) {
      await app.prisma.saldoSnapshot.create({
        data: {
          employeeId: person.employeeId,
          periodType: "MONTHLY",
          periodStart: monthRangeUtc(2026, m, "Europe/Berlin").start,
          periodEnd: monthRangeUtc(2026, m, "Europe/Berlin").end,
          workedMinutes: 0,
          expectedMinutes: 0,
          balanceMinutes: 0,
          carryOver: 0,
          closedAt: new Date("2027-01-02T06:00:00Z"),
          superseded: false,
        },
      });
    }
  }, 120_000);

  afterAll(async () => {
    process.env.TZ = originalTz;
    try {
      const ids = (
        await app.prisma.employee.findMany({
          where: { tenantId: seed.tenant.id },
          select: { id: true },
        })
      ).map((e) => e.id);
      await app.prisma.saldoSnapshot.deleteMany({ where: { employeeId: { in: ids } } });
      await cleanupTestData(app, seed.tenant.id);
    } catch (err) {
      console.error("277 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("a July hire (Berlin) with Jul-Dec closed gets the yearly snapshot although the process runs in UTC", async () => {
    process.env.TZ = "UTC";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2027-01-20T10:00:00Z"));
    try {
      await app.tryAutoCloseMonth();
    } finally {
      vi.useRealTimers();
    }
    const yearly = await app.prisma.saldoSnapshot.count({
      where: { employeeId: person.employeeId, periodType: "YEARLY", superseded: false },
    });
    expect(yearly).toBe(1);
  });
});
