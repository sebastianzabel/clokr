/**
 * PERF-V1814-01 — N+1 query regression guard for close-month endpoints.
 *
 * Asserts that GET /overtime/close-month/status and
 * GET /overtime/close-month/year-status each issue at most ONE findMany call
 * per Prisma model (saldoSnapshot, timeEntry, leaveRequest, absence,
 * publicHoliday), regardless of employee count.
 *
 * RED state (before Task 3): per-employee fan-out causes multiple findMany
 * calls → assertions fail.
 * GREEN state (after Task 3): bulk-fetch-then-join (fetchCloseMonthData)
 * → each model's findMany called exactly once → assertions pass.
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

/** Create a non-exempt FIXED_WEEKLY employee in the given tenant. */
async function createExtraEmployee(app: FastifyInstance, tenantId: string, idx: number) {
  const s = `pn1-${idx}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
  const user = await app.prisma.user.create({
    data: {
      email: `pn1-${s}@test.de`,
      passwordHash: "x",
      role: "EMPLOYEE",
      isActive: true,
    },
  });
  const emp = await app.prisma.employee.create({
    data: {
      tenantId,
      userId: user.id,
      employeeNumber: `PN1-${s}`.slice(0, 20),
      firstName: "Perf",
      lastName: `N1-${idx}`,
      hireDate: new Date("2024-01-01"),
      isTimeTrackingExempt: false,
    },
  });
  await app.prisma.workSchedule.create({
    data: {
      employeeId: emp.id,
      weeklyHours: 40,
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
      validFrom: new Date("2024-01-01"),
    },
  });
  return { userId: user.id, empId: emp.id };
}

describe("PERF-V1814-01 — close-month N+1 query regression guard", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    // seedTestData creates adminEmployee + employee = 2 non-exempt FIXED_WEEKLY employees.
    // Add 4 more for a total of 6 — proves query count is independent of employee count.
    data = await seedTestData(app, "pn1");
    for (let i = 0; i < 4; i++) {
      await createExtraEmployee(app, data.tenant.id, i);
    }
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("overtime-perf-n1 cleanup failed:", err);
    }
    await closeTestApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Test 1: close-month/status ───────────────────────────────────────────────
  // RED (before Task 3): timeEntry/leaveRequest/absence each called N times (N=6).
  // GREEN (after Task 3): each model called exactly once via fetchCloseMonthData.

  it("close-month/status: each model findMany called ≤1 regardless of employee count", async () => {
    const spies = {
      snapshot: vi.spyOn(app.prisma.saldoSnapshot, "findMany"),
      entries: vi.spyOn(app.prisma.timeEntry, "findMany"),
      leave: vi.spyOn(app.prisma.leaveRequest, "findMany"),
      absences: vi.spyOn(app.prisma.absence, "findMany"),
      holidays: vi.spyOn(app.prisma.publicHoliday, "findMany"),
    };

    // January 2026 is a past month — handler processes it without "future" guard.
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/overtime/close-month/status?year=2026&month=1",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    // Each model must be queried at most once (bulk-fetch-then-join):
    expect(spies.snapshot.mock.calls.length).toBeLessThanOrEqual(1);
    expect(spies.entries.mock.calls.length).toBeLessThanOrEqual(1);
    expect(spies.leave.mock.calls.length).toBeLessThanOrEqual(1);
    expect(spies.absences.mock.calls.length).toBeLessThanOrEqual(1);
    expect(spies.holidays.mock.calls.length).toBeLessThanOrEqual(1);
  });

  // ── Test 2: close-month/year-status ─────────────────────────────────────────
  // RED (before Task 3): per-month + per-employee fan-out → all 5 spies fire many times.
  // GREEN (after Task 3): year-range bulk fetch covers all months in one pass.

  it("close-month/year-status: each model findMany called ≤1 regardless of employee count", async () => {
    const spies = {
      snapshot: vi.spyOn(app.prisma.saldoSnapshot, "findMany"),
      entries: vi.spyOn(app.prisma.timeEntry, "findMany"),
      leave: vi.spyOn(app.prisma.leaveRequest, "findMany"),
      absences: vi.spyOn(app.prisma.absence, "findMany"),
      holidays: vi.spyOn(app.prisma.publicHoliday, "findMany"),
    };

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/overtime/close-month/year-status?year=2026",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(spies.snapshot.mock.calls.length).toBeLessThanOrEqual(1);
    expect(spies.entries.mock.calls.length).toBeLessThanOrEqual(1);
    expect(spies.leave.mock.calls.length).toBeLessThanOrEqual(1);
    expect(spies.absences.mock.calls.length).toBeLessThanOrEqual(1);
    expect(spies.holidays.mock.calls.length).toBeLessThanOrEqual(1);
  });

  // ── Test 3: regression guard — proves O(1) query count at 6 employees ───────
  // Explicitly verifies that adding employees does NOT increase the Prisma call count.
  // This guards against future regressions that re-introduce per-employee loops.

  it("query counts stay ≤1 on both handlers when tenant has 6 employees (scale proof)", async () => {
    const statusSpies = {
      snapshot: vi.spyOn(app.prisma.saldoSnapshot, "findMany"),
      entries: vi.spyOn(app.prisma.timeEntry, "findMany"),
      leave: vi.spyOn(app.prisma.leaveRequest, "findMany"),
      absences: vi.spyOn(app.prisma.absence, "findMany"),
      holidays: vi.spyOn(app.prisma.publicHoliday, "findMany"),
    };

    // February 2026 — different month from Test 1 to avoid any caching effects.
    const statusRes = await app.inject({
      method: "GET",
      url: "/api/v1/overtime/close-month/status?year=2026&month=2",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(statusRes.statusCode).toBe(200);
    expect(statusSpies.snapshot.mock.calls.length).toBeLessThanOrEqual(1);
    expect(statusSpies.entries.mock.calls.length).toBeLessThanOrEqual(1);
    expect(statusSpies.leave.mock.calls.length).toBeLessThanOrEqual(1);
    expect(statusSpies.absences.mock.calls.length).toBeLessThanOrEqual(1);
    expect(statusSpies.holidays.mock.calls.length).toBeLessThanOrEqual(1);

    // Reset spies before testing year-status.
    vi.restoreAllMocks();

    const yearSpies = {
      snapshot: vi.spyOn(app.prisma.saldoSnapshot, "findMany"),
      entries: vi.spyOn(app.prisma.timeEntry, "findMany"),
      leave: vi.spyOn(app.prisma.leaveRequest, "findMany"),
      absences: vi.spyOn(app.prisma.absence, "findMany"),
      holidays: vi.spyOn(app.prisma.publicHoliday, "findMany"),
    };

    const yearRes = await app.inject({
      method: "GET",
      url: "/api/v1/overtime/close-month/year-status?year=2025",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(yearRes.statusCode).toBe(200);
    expect(yearSpies.snapshot.mock.calls.length).toBeLessThanOrEqual(1);
    expect(yearSpies.entries.mock.calls.length).toBeLessThanOrEqual(1);
    expect(yearSpies.leave.mock.calls.length).toBeLessThanOrEqual(1);
    expect(yearSpies.absences.mock.calls.length).toBeLessThanOrEqual(1);
    expect(yearSpies.holidays.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
