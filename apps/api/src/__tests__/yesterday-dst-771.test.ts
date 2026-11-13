/**
 * yesterday-dst-771.test.ts
 *
 * Regression for issue #771: the live window of computeMonthSaldo ends at the tenant-local
 * YESTERDAY (#438: the live saldo never includes today). It used to derive yesterday from
 * `Date.now() - 24 h`, which is wrong around a DST switch: on the 25 h autumn day it yields TODAY
 * in the last hour, and on the day after the 23 h spring day it yields the day before yesterday
 * in the first hour. Fixed clock throughout (never a date-relative fixture).
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { computeMonthSaldo } from "../contexts/working-time-account/month-saldo";
import type { FastifyInstance } from "fastify";

describe("Issue #771 — live window ends at the tenant-local yesterday across DST", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "t771");
    // Employed since before every month used below, so the window is not clipped by hire.
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { hireDate: new Date("2026-01-01T00:00:00Z") },
    });
    await app.prisma.tenantConfig.updateMany({
      where: { tenantId: data.tenant.id },
      data: { timezone: "Europe/Berlin" },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Issue #771 cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function lastLiveDay(now: string, year: number, month: number): Promise<string> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now));
    const res = await computeMonthSaldo(app, data.employee.id, year, month);
    expect(res.closed).toBe(false);
    expect(res.days.length).toBeGreaterThan(0);
    return res.days[res.days.length - 1].date;
  }

  it("autumn 25 h day, last hour (25.10.2026 23:30 CET): yesterday is 24.10., today is not counted", async () => {
    expect(await lastLiveDay("2026-10-25T22:30:00.000Z", 2026, 10)).toBe("2026-10-24");
  });

  it("autumn, 01:30 on 26.10.2026: yesterday is 25.10.", async () => {
    expect(await lastLiveDay("2026-10-26T00:30:00.000Z", 2026, 10)).toBe("2026-10-25");
  });

  it("spring, first hour after the 23 h day (29.03.2027 00:30 CEST): yesterday is 28.03.", async () => {
    expect(await lastLiveDay("2027-03-28T22:30:00.000Z", 2027, 3)).toBe("2027-03-28");
  });

  it("spring, last hour of the 23 h day (28.03.2027 23:30 CEST): yesterday is 27.03.", async () => {
    expect(await lastLiveDay("2027-03-28T21:30:00.000Z", 2027, 3)).toBe("2027-03-27");
  });
});
