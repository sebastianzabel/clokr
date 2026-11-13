/**
 * Issue #594: every day of GET /overtime/month-saldo carries its own Soll, Ist and saldo, so Ich › Konto
 * can open a month's days without the web computing anything. The day shares come from the same
 * to-date closeEmployeeMonth run the cumulative series uses; these tests pin that they add up to the
 * month header and to the step of the cumulative series, day by day.
 *
 * Fixed fake clock (CLAUDE.md, issues #394/#434): "today" is Wednesday 2026-06-10, so the series runs
 * 2026-06-01 .. 2026-06-09 (the live window never includes today, #438).
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

interface Day {
  date: string;
  cumulativeSaldoMinutes: number;
  expectedMinutes?: number;
  workedMinutes?: number;
  balanceMinutes?: number;
}

interface MonthSaldo {
  workedMinutes: number;
  expectedMinutes: number;
  balanceMinutes: number;
  closed: boolean;
  days: Day[];
  dayDetailsWithheld: boolean;
}

describe("Issue #594 — month-saldo day shares", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "msd594");
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { hireDate: new Date("2026-06-01T00:00:00Z") },
    });
    // Mon 1.6. 9 h, Tue 2.6. 6 h, Thu 4.6. 8 h (Wed 3.6. and the rest stay empty).
    const work: Array<[string, string, string]> = [
      ["2026-06-01", "06:00", "15:00"],
      ["2026-06-02", "06:00", "12:00"],
      ["2026-06-04", "06:00", "14:00"],
    ];
    for (const [day, from, to] of work) {
      await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date(`${day}T00:00:00Z`),
          startTime: new Date(`${day}T${from}:00.000Z`),
          endTime: new Date(`${day}T${to}:00.000Z`),
          breakMinutes: 0,
          type: "WORK",
          source: "MANUAL",
          isInvalid: false,
          salonId: data.salonId,
        },
      });
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Issue #594 cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function monthSaldo(token: string): Promise<MonthSaldo> {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/month-saldo/${data.employee.id}?year=2026&month=6`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as MonthSaldo;
  }

  it("every day carries its own Soll, Ist and saldo, and they sum to the month header", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-10T11:00:00.000Z"));
    const body = await monthSaldo(data.empToken);
    expect(body.dayDetailsWithheld).toBe(false);
    expect(body.days.map((d) => d.date)).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
      "2026-06-04",
      "2026-06-05",
      "2026-06-06",
      "2026-06-07",
      "2026-06-08",
      "2026-06-09",
    ]);
    for (const d of body.days) {
      expect(typeof d.expectedMinutes).toBe("number");
      expect(typeof d.workedMinutes).toBe("number");
      expect(typeof d.balanceMinutes).toBe("number");
    }
    const sum = (k: "expectedMinutes" | "workedMinutes" | "balanceMinutes") =>
      body.days.reduce((s, d) => s + (d[k] ?? 0), 0);
    expect(sum("expectedMinutes")).toBe(body.expectedMinutes);
    expect(sum("workedMinutes")).toBe(body.workedMinutes);
    expect(sum("balanceMinutes")).toBe(body.balanceMinutes);
    // non-vacuous: real work and a real Soll are in the month
    expect(body.workedMinutes).toBe((9 + 6 + 8) * 60);
    expect(body.expectedMinutes).toBeGreaterThan(0);
  });

  it("a day's saldo is exactly the step of the cumulative series", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-10T11:00:00.000Z"));
    const body = await monthSaldo(data.empToken);
    let previous = body.days[0].cumulativeSaldoMinutes - (body.days[0].balanceMinutes ?? 0);
    for (const d of body.days) {
      expect(d.cumulativeSaldoMinutes - previous).toBe(d.balanceMinutes);
      previous = d.cumulativeSaldoMinutes;
    }
    // the worked shares sit on the days that were worked
    const worked = Object.fromEntries(body.days.map((d) => [d.date, d.workedMinutes]));
    expect(worked["2026-06-01"]).toBe(9 * 60);
    expect(worked["2026-06-02"]).toBe(6 * 60);
    expect(worked["2026-06-03"]).toBe(0);
    expect(worked["2026-06-04"]).toBe(8 * 60);
  });
});
