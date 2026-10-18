/**
 * Issue #612 (D-612-2, T-612-12) — measured response time of `GET /api/v1/reports/period`.
 *
 * 25 fixture persons (hired 2025-01-01, Mo-Fr contract) each with closed MONTHLY snapshots
 * November 2025 to September 2026 (converted period convention, a plausible carry-over chain) and
 * one closed WORK entry on a Monday of every month November 2025 to October 2026. `Date` is faked
 * to 2026-10-15T10:00Z, so October is the running month (live figures) and every earlier month is
 * closed (stored figures). Three sequential requests - one, three and twelve months - each answer
 * 200 and list at least the 25 persons with 1 / 3 / 12 months; each wall time is logged, one line
 * per request, and asserted below a loose ceiling that only guards against an accidental
 * quadratic. The ceiling is NOT the budget: the measured numbers are recorded in the phase SUMMARY.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { createPopulationPerson } from "./population-fixtures-613";
import { saldoSnapshotPeriodBounds } from "./test-dates";

const FAKE_NOW = "2026-10-15T10:00:00.000Z";
const PERSONS = 25;
const CEILING_MS = 60_000;
const ENTRY_DAYS = [
  "2025-11-03",
  "2025-12-01",
  "2026-01-05",
  "2026-02-02",
  "2026-03-02",
  "2026-04-06",
  "2026-05-04",
  "2026-06-01",
  "2026-07-06",
  "2026-08-03",
  "2026-09-07",
  "2026-10-05",
];
// Closed months: November 2025 to September 2026 (the October entry belongs to the running month).
const CLOSED_MONTHS: Array<[number, number]> = [
  [2025, 11],
  [2025, 12],
  [2026, 1],
  [2026, 2],
  [2026, 3],
  [2026, 4],
  [2026, 5],
  [2026, 6],
  [2026, 7],
  [2026, 8],
  [2026, 9],
];

type Period = {
  kpis: { personCount: number };
  rows: Array<{ employeeId: string; monthCount: number; confirmedMonthCount: number }>;
};

describe("Issue #612 — response time of the period report", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  const personIds: string[] = [];

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(FAKE_NOW));
    app = await getTestApp();
    data = await seedTestData(app, "rpp612");
    const seedStart = performance.now();
    const hire = new Date("2025-01-01T00:00:00Z");
    for (let i = 0; i < PERSONS; i++) {
      const p = await createPopulationPerson(app, {
        tenantId: data.tenant.id,
        salonId: data.salonId,
        tag: `PF${String(i).padStart(2, "0")}`,
        hireDate: hire,
      });
      personIds.push(p.employeeId);
    }
    await app.prisma.timeEntry.createMany({
      data: personIds.flatMap((employeeId) =>
        ENTRY_DAYS.map((date) => ({
          employeeId,
          salonId: data.salonId,
          date: new Date(`${date}T00:00:00Z`),
          startTime: new Date(`${date}T08:00:00Z`),
          endTime: new Date(`${date}T16:00:00Z`),
          breakMinutes: 0,
          type: "WORK" as const,
          source: "MANUAL" as const,
        })),
      ),
    });
    await app.prisma.saldoSnapshot.createMany({
      data: personIds.flatMap((employeeId) =>
        CLOSED_MONTHS.map(([year, month], k) => {
          const bounds = saldoSnapshotPeriodBounds(new Date(Date.UTC(year, month - 1, 1)));
          return {
            employeeId,
            periodType: "MONTHLY" as const,
            periodStart: bounds.start,
            periodEnd: bounds.end,
            workedMinutes: 480,
            expectedMinutes: 9600,
            balanceMinutes: -9120,
            carryOver: -9120 * (k + 1),
            closedAt: new Date(),
            closedBy: data.adminUser.id,
          };
        }),
      ),
    });
    console.info(
      `[612-02] perf seed: ${PERSONS} persons, ${PERSONS * ENTRY_DAYS.length} entries, ${
        PERSONS * CLOSED_MONTHS.length
      } snapshots in ${Math.round(performance.now() - seedStart)} ms`,
    );
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("reports-period-perf-612 cleanup failed:", err);
    }
    await closeTestApp();
  });

  for (const [label, from, to, months] of [
    ["1 month", "2026-10", "2026-10", 1],
    ["3 months", "2026-08", "2026-10", 3],
    ["12 months", "2025-11", "2026-10", 12],
  ] as const) {
    it(`${label}: answers 200 for at least ${PERSONS} persons and stays below the ceiling`, async () => {
      const t0 = performance.now();
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/reports/period?from=${from}&to=${to}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      const ms = Math.round(performance.now() - t0);
      expect(res.statusCode, res.body).toBe(200);
      const body = JSON.parse(res.body) as Period;
      const fixtureRows = body.rows.filter((r) => personIds.includes(r.employeeId));
      expect(fixtureRows).toHaveLength(PERSONS);
      for (const r of fixtureRows) expect(r.monthCount, r.employeeId).toBe(months);
      const personMonths = body.rows.reduce((s, r) => s + r.monthCount, 0);
      console.info(
        `[612-02] perf ${label}: ${body.rows.length} persons x ${months} months = ${personMonths} person-months in ${ms} ms (${(
          ms / personMonths
        ).toFixed(1)} ms per person-month)`,
      );
      expect(ms).toBeLessThan(CEILING_MS);
    });
  }
});
