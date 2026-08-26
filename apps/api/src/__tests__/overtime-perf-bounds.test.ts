/**
 * PERF-V1814-03 — Bound/cap regression tests for list endpoints.
 *
 * Tests:
 *   1. GET /time-entries WITHOUT bounds → excludes entries older than 90 days (RED before Task 2)
 *   2. GET /time-entries WITH explicit from/to spanning 200 days → includes the old entry
 *   3. GET /overtime/snapshots/:employeeId → returned length ≤ 120
 *   4. GET /employees → returned length ≤ 1000 (defense-in-depth cap)
 *
 * RED state (before Task 2):
 *   Test 1 FAILS — no default date window on the endpoint, so the 120-day-old entry leaks
 *   into the no-bounds response. Tests 2–4 pass (explicit bounds already honored; caps are
 *   length assertions on small datasets that are trivially ≤ the cap).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { pastDateStr, utcMidnight, dbDateStr } from "./test-dates";
import type { FastifyInstance } from "fastify";

/** Returns the UTC-midnight Date for N days ago, in the tenant timezone. */
function daysAgo(n: number): Date {
  return utcMidnight(pastDateStr(n));
}

/** Returns ISO date string (YYYY-MM-DD) for use in date fields. */
function isoDate(d: Date): string {
  return dbDateStr(d);
}

describe("PERF-V1814-03 — bound/cap regression for list endpoints", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let oldEntryDate: Date; // 120 days ago — outside the 90-day default window
  let recentEntryDate: Date; // 30 days ago — inside the 90-day default window

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "perfbounds");

    oldEntryDate = daysAgo(120);
    recentEntryDate = daysAgo(30);

    // Seed a time entry 120 days ago (outside the 90-day default window)
    await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: oldEntryDate,
        startTime: new Date(oldEntryDate.getTime() + 8 * 60 * 60 * 1000), // 08:00
        endTime: new Date(oldEntryDate.getTime() + 16 * 60 * 60 * 1000), // 16:00
        breakMinutes: 30,
        type: "WORK",
        source: "MANUAL",
      },
    });

    // Seed a time entry 30 days ago (inside the 90-day default window)
    await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: recentEntryDate,
        startTime: new Date(recentEntryDate.getTime() + 8 * 60 * 60 * 1000),
        endTime: new Date(recentEntryDate.getTime() + 16 * 60 * 60 * 1000),
        breakMinutes: 30,
        type: "WORK",
        source: "MANUAL",
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("overtime-perf-bounds cleanup failed:", err);
    }
    await closeTestApp();
  });

  // ── Test 1: no-bounds GET returns only entries within the last 90 days ──────

  it("Test 1 (RED before Task 2): GET /time-entries without bounds excludes entries older than 90 days", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/time-entries?employeeId=${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const entries = JSON.parse(res.body) as Array<{ date: string }>;

    // Cap assertion (always passes — trivial for small dataset)
    expect(entries.length).toBeLessThanOrEqual(1000);

    // Window assertion: no entry should be older than 90 days
    // RED before Task 2: the 120-day-old entry leaks into the response because
    // the endpoint has no default date window — this assertion fails until Task 2 adds it.
    const cutoff = daysAgo(90);
    for (const entry of entries) {
      const entryDate = new Date(entry.date);
      expect(entryDate.getTime()).toBeGreaterThanOrEqual(cutoff.getTime());
    }
  });

  // ── Test 2: explicit bounds → old entry IS returned ──────────────────────

  it("Test 2: GET /time-entries with explicit 200-day window includes entries older than 90 days", async () => {
    const from = isoDate(daysAgo(200));
    const to = isoDate(new Date());

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/time-entries?from=${from}&to=${to}&employeeId=${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const entries = JSON.parse(res.body) as Array<{ date: string }>;

    // The old entry (120 days ago) must be present — explicit bounds override any default window
    const oldEntryIso = isoDate(oldEntryDate);
    const hasOldEntry = entries.some((e) => e.date.startsWith(oldEntryIso));
    expect(hasOldEntry).toBe(true);
  });

  // ── Test 3: snapshot cap ─────────────────────────────────────────────────

  it("Test 3: GET /overtime/snapshots/:employeeId returns at most 120 snapshots", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/snapshots/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const snapshots = JSON.parse(res.body) as unknown[];
    expect(snapshots.length).toBeLessThanOrEqual(120);
  });

  // ── Test 4: employee list cap ────────────────────────────────────────────

  it("Test 4: GET /employees returns at most 1000 employees (defense-in-depth cap)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/employees",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const employees = JSON.parse(res.body) as unknown[];
    expect(employees.length).toBeLessThanOrEqual(1000);
  });
});
