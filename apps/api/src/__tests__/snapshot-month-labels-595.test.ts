/**
 * Issue #595 (D-03, P-07) - every place that names the month of a stored MONTHLY snapshot does it
 * through `snapshotMonthOf` (the inverse of the window the account reads under), not from the raw
 * stored date. A TZ-converted row of month M is stored on the last day of M-1, so a label taken
 * from the stored date names every such row one month early.
 *
 * Three answers are pinned against real rows in BOTH storage conventions:
 *   - GET /activity (own monthly-close items),
 *   - GET /dashboard/overtime-overview (`snapshots[].month`, one item per month),
 *   - GET /dashboard/overtime-trend (one point per calendar month, `month` = first of the month).
 *
 * Months are chosen relative to today (never hard-coded) so they stay inside the six-month window
 * of the two dashboard reads.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import {
  monthStartUtc,
  saldoSnapshotPeriodBounds,
  legacySaldoSnapshotPeriodBounds,
} from "./test-dates";

const GERMAN_MONTHS = [
  "Januar",
  "Februar",
  "März",
  "April",
  "Mai",
  "Juni",
  "Juli",
  "August",
  "September",
  "Oktober",
  "November",
  "Dezember",
];

/** Calendar year/month `monthsAgo` months before the current tenant-local month. */
function monthAgo(monthsAgo: number): { year: number; month: number } {
  const d = monthStartUtc(monthsAgo);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

const pad = (n: number): string => String(n).padStart(2, "0");

describe("snapshot months are named through snapshotMonthOf (Issue #595, D-03)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  async function createSnapshot(
    employeeId: string,
    bounds: { start: Date; end: Date },
    carryOver: number,
  ) {
    return app.prisma.saldoSnapshot.create({
      data: {
        employeeId,
        periodType: "MONTHLY",
        periodStart: bounds.start,
        periodEnd: bounds.end,
        workedMinutes: 9600,
        expectedMinutes: 9600,
        balanceMinutes: 0,
        carryOver,
        closedAt: new Date(),
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "snl595");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } finally {
      await closeTestApp();
    }
  });

  it("the activity feed names a TZ-converted closed month by its calendar month", async () => {
    const m = monthAgo(3);
    const converted = saldoSnapshotPeriodBounds(monthStartUtc(3));
    // The stored date is the last day of the previous month - the premise of the bug.
    expect(converted.start.getUTCMonth() + 1).not.toBe(m.month);
    await createSnapshot(data.employee.id, converted, 0);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/activity?limit=20",
      headers: { authorization: `Bearer ${data.empToken}` },
    });
    expect(res.statusCode).toBe(200);
    const items = JSON.parse(res.body).items as Array<{ what: string; category: string }>;
    const closes = items.filter((i) => i.category === "close").map((i) => i.what);
    expect(closes).toContain(`Monatsabschluss ${GERMAN_MONTHS[m.month - 1]} ${m.year} bestätigt`);
  });

  it("the overview lists one named item per month and prefers the converted row of a duplicate month", async () => {
    const m = monthAgo(2);
    const legacy = legacySaldoSnapshotPeriodBounds(m.year, m.month);
    const converted = saldoSnapshotPeriodBounds(monthStartUtc(2));
    await createSnapshot(data.adminEmployee.id, legacy, 111);
    await createSnapshot(data.adminEmployee.id, converted, 222);
    // A second month stored in the converted convention only.
    const m1 = monthAgo(1);
    await createSnapshot(data.adminEmployee.id, saldoSnapshotPeriodBounds(monthStartUtc(1)), 333);

    await app.prisma.overtimeAccount.upsert({
      where: { employeeId: data.adminEmployee.id },
      update: {},
      create: { employeeId: data.adminEmployee.id, balanceHours: 0 },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/overtime-overview",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      employees: Array<{
        id: string;
        snapshots: Array<{ month: string | null; carryOver: number; periodStart: string }>;
      }>;
    };
    const row = body.employees.find((e) => e.id === data.adminEmployee.id);
    expect(row).toBeDefined();
    const key = `${m.year}-${pad(m.month)}`;
    const key1 = `${m1.year}-${pad(m1.month)}`;
    const months = row!.snapshots.map((s) => s.month);
    expect(months.filter((x) => x === key)).toHaveLength(1);
    expect(months.filter((x) => x === key1)).toHaveLength(1);
    // The record the account reads is the smallest periodStart: the converted row (stored on the
    // last day of the previous month) sorts before the legacy 1st.
    expect(row!.snapshots.find((s) => s.month === key)!.carryOver).toBe(222);
    expect(row!.snapshots.find((s) => s.month === key1)!.carryOver).toBe(333);
    // Additive: the raw date is still served.
    for (const s of row!.snapshots) expect(typeof s.periodStart).toBe("string");
  });

  it("the trend puts a legacy and a converted row of one month into ONE point with the summed carry-over", async () => {
    const m = monthAgo(4);
    const legacy = legacySaldoSnapshotPeriodBounds(m.year, m.month);
    const converted = saldoSnapshotPeriodBounds(monthStartUtc(4));
    await createSnapshot(data.adminEmployee.id, legacy, 60);
    await createSnapshot(data.employee.id, converted, 30);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/overtime-trend",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const snaps = JSON.parse(res.body).snapshots as Array<{
      month: string;
      teamCarryOverMinutes: number;
    }>;
    const key = `${m.year}-${pad(m.month)}-01`;
    const points = snaps.filter((s) => s.month === key);
    expect(points).toHaveLength(1);
    expect(points[0].teamCarryOverMinutes).toBe(90);
    // Every point is the first of a month and the list is ascending.
    for (const s of snaps) expect(s.month).toMatch(/^\d{4}-\d{2}-01$/);
    const months = snaps.map((s) => s.month);
    expect(months).toEqual([...months].sort());
    // No point names the converted row's STORED month (the month before): nothing is seeded there.
    const stored = converted.start;
    const wrong = `${stored.getUTCFullYear()}-${pad(stored.getUTCMonth() + 1)}-01`;
    expect(snaps.filter((s) => s.month === wrong)).toHaveLength(0);
  });
});
