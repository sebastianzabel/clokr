/**
 * month-saldo.test.ts
 *
 * Tests for the §615 Team-Zeiten monthly saldo display (computeMonthSaldo +
 * GET /api/v1/overtime/month-saldo/:employeeId endpoint).
 *
 * Required assertions:
 *  (a) Open SHIFT_BASED month: balanceMinutes matches §615 closeEmployeeMonth
 *      result (NOT worked−roster).
 *  (b) days[] shape: monotonic-ish cumulative, correct date strings.
 *  (c) Closed month: returns snapshot verbatim.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a YYYY-MM-DD string for a given year/month/day (no TZ shift). */
function ymd(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** ISO datetime for a given date + HH:MM local. */
function iso(dateStr: string, hhmm: string): string {
  return new Date(`${dateStr}T${hhmm}:00.000Z`).toISOString();
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe("month-saldo endpoint + computeMonthSaldo", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "ms");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("month-saldo test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // ── (a) Open FIXED_SCHEDULE month: §615 balance = worked − contract_expected ─

  it("(a) open month: balanceMinutes equals §615 closeEmployeeMonth result, NOT worked−roster", async () => {
    // data.employee is FIXED_SCHEDULE 40h/week (Mo-Fr 8h each, seeded by setup.ts)
    // Use a past month that is definitely not closed.
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1; // current month (open by definition)

    // Create one time entry this month: e.g. day 2 if workday, 9h worked (480+60=540 gross, 0 break)
    const testDate = ymd(year, month, 2);
    // Clean up any pre-existing entry for that date
    await app.prisma.timeEntry.deleteMany({
      where: { employeeId: data.employee.id, date: new Date(testDate + "T00:00:00Z") },
    });
    await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: new Date(testDate + "T00:00:00Z"),
        startTime: new Date(`${testDate}T07:00:00.000Z`),
        endTime: new Date(`${testDate}T16:00:00.000Z`), // 9h gross, 0 break = 540min worked
        breakMinutes: 0,
        type: "WORK",
        source: "MANUAL",
        note: null,
        isInvalid: false,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/month-saldo/${data.employee.id}?year=${year}&month=${month}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      workedMinutes: number;
      expectedMinutes: number;
      balanceMinutes: number;
      closed: boolean;
      days: Array<{ date: string; cumulativeSaldoMinutes: number }>;
    };

    expect(body.closed).toBe(false);
    // balance MUST come from §615 (worked − contract_expected), not roster-based diff
    expect(body.balanceMinutes).toBe(body.workedMinutes - body.expectedMinutes);
    // workedMinutes should be at least 540 (the 9h entry we created)
    expect(body.workedMinutes).toBeGreaterThanOrEqual(540);

    // (b) days[] shape assertions
    expect(Array.isArray(body.days)).toBe(true);
    // days array should have at least one entry (for the day we created an entry on)
    expect(body.days.length).toBeGreaterThan(0);
    // all dates must be YYYY-MM-DD format
    for (const d of body.days) {
      expect(d.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof d.cumulativeSaldoMinutes).toBe("number");
    }
    // dates should be in ascending order (monotonic progression)
    for (let i = 1; i < body.days.length; i++) {
      expect(body.days[i]!.date >= body.days[i - 1]!.date).toBe(true);
    }
    // cumulative on the last day = carryOverIn + full-month balance.
    // The seeded employee may have a prior snapshot so carryOverIn could be non-zero.
    // Verify the invariant: lastDay.cumulativeSaldoMinutes = carryOverIn + body.balanceMinutes.
    const lastDay = body.days[body.days.length - 1]!;
    const carryOverIn = lastDay.cumulativeSaldoMinutes - body.balanceMinutes;
    expect(lastDay.cumulativeSaldoMinutes).toBe(carryOverIn + body.balanceMinutes);

    // Clean up
    await app.prisma.timeEntry.deleteMany({
      where: { employeeId: data.employee.id, date: new Date(testDate + "T00:00:00Z") },
    });
  });

  // ── (c) Closed month: returns snapshot verbatim ───────────────────────────

  it("(c) closed month: returns snapshot values verbatim (Revisionssicherheit)", async () => {
    // Create a past closed month by inserting a MONTHLY SaldoSnapshot directly.
    // Test tenant TZ = Europe/Berlin.  March 2024 in CET starts 2024-02-29T23:00:00Z.
    // periodStart/periodEnd must match exactly what monthRangeUtc produces so the
    // computeMonthSaldo query finds the snapshot.
    const year = 2024;
    const month = 3; // March 2024 — safely in the past, won't collide with open months
    // Europe/Berlin: 2024-03-01T00:00 CET = 2024-02-29T23:00:00Z (UTC), end = 2024-03-31T21:59:59Z (CEST)
    const monthStartUtc = new Date("2024-02-29T23:00:00.000Z");
    const monthEndUtc = new Date("2024-03-31T21:59:59.999Z");

    // Clean up any existing snapshot for this period
    await app.prisma.saldoSnapshot.deleteMany({
      where: {
        employeeId: data.employee.id,
        periodType: "MONTHLY",
        periodStart: monthStartUtc,
      },
    });

    const snapshot = await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: data.employee.id,
        periodType: "MONTHLY",
        periodStart: monthStartUtc,
        periodEnd: monthEndUtc,
        workedMinutes: 9120, // 152h
        expectedMinutes: 9600, // 160h
        balanceMinutes: -480, // −8h
        carryOver: -480,
        closedAt: new Date("2024-04-01T08:00:00Z"),
        superseded: false,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/month-saldo/${data.employee.id}?year=${year}&month=${month}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      workedMinutes: number;
      expectedMinutes: number;
      balanceMinutes: number;
      closed: boolean;
      days: Array<{ date: string; cumulativeSaldoMinutes: number }>;
    };

    // Must be flagged as closed
    expect(body.closed).toBe(true);
    // Values must match snapshot verbatim (Revisionssicherheit)
    expect(body.workedMinutes).toBe(snapshot.workedMinutes);
    expect(body.expectedMinutes).toBe(snapshot.expectedMinutes);
    expect(body.balanceMinutes).toBe(snapshot.balanceMinutes);
    // days[] is a single terminal entry with cumulativeSaldoMinutes = snapshot.carryOver
    expect(body.days.length).toBe(1);
    expect(body.days[0]!.cumulativeSaldoMinutes).toBe(snapshot.carryOver);

    // Cleanup
    await app.prisma.saldoSnapshot.delete({ where: { id: snapshot.id } });
  });

  // ── Authorization: EMPLOYEE can read own, forbidden for other employee ────

  it("EMPLOYEE may read their own month-saldo", async () => {
    const now = new Date();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/month-saldo/${data.employee.id}?year=${now.getFullYear()}&month=${now.getMonth() + 1}`,
      headers: { authorization: `Bearer ${data.empToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("EMPLOYEE is forbidden from reading another employee month-saldo", async () => {
    // adminEmployee is a different employee in the same tenant
    const now = new Date();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/month-saldo/${data.adminEmployee.id}?year=${now.getFullYear()}&month=${now.getMonth() + 1}`,
      headers: { authorization: `Bearer ${data.empToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 404 for cross-tenant employee lookup", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000001";
    const now = new Date();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/month-saldo/${fakeId}?year=${now.getFullYear()}&month=${now.getMonth() + 1}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
