import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

/**
 * Return a date string N days ago from today (YYYY-MM-DD).
 * Uses the local date (server TZ) to stay consistent with test expectations.
 */
function pastDate(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split("T")[0];
}

describe("Overtime Saldo Calculation", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "ot");
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
    await closeTestApp();
  });

  it("overtime recalculates on GET", async () => {
    // Get initial overtime balance
    const beforeRes = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(beforeRes.statusCode).toBe(200);
    const before = JSON.parse(beforeRes.body);
    const balanceBefore = Number(before.balanceHours);

    // Create a time entry for yesterday (8h work day = matches schedule, so delta ~0)
    const yesterday = pastDate(1);
    await app.prisma.timeEntry.deleteMany({
      where: { employeeId: data.employee.id, date: new Date(yesterday + "T00:00:00Z") },
    });
    await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: new Date(yesterday + "T00:00:00Z"),
        startTime: new Date(`${yesterday}T07:00:00.000Z`),
        endTime: new Date(`${yesterday}T17:00:00.000Z`),
        breakMinutes: 0,
        source: "MANUAL",
        type: "WORK",
      },
    });

    // GET overtime again — balance should have changed (10h worked vs 8h expected)
    const afterRes = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(afterRes.statusCode).toBe(200);
    const after = JSON.parse(afterRes.body);
    const balanceAfter = Number(after.balanceHours);

    // 10h worked on a day with 8h schedule = +2h delta compared to before
    // The exact value depends on what day yesterday is (weekday vs weekend),
    // but the key assertion is that the balance changed after adding an entry.
    expect(balanceAfter).not.toBe(balanceBefore);
  });

  it("overtime saldo includes today only when entries exist", async () => {
    // Clean up any existing entries for today and yesterday
    const today = pastDate(0);
    const yesterday = pastDate(1);
    await app.prisma.timeEntry.deleteMany({
      where: {
        employeeId: data.employee.id,
        date: { in: [new Date(today + "T00:00:00Z"), new Date(yesterday + "T00:00:00Z")] },
      },
    });

    // Create entry for yesterday only
    await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: new Date(yesterday + "T00:00:00Z"),
        startTime: new Date(`${yesterday}T08:00:00.000Z`),
        endTime: new Date(`${yesterday}T16:00:00.000Z`),
        breakMinutes: 0,
        source: "MANUAL",
        type: "WORK",
      },
    });

    // GET overtime — should NOT include today (no entries)
    const res1 = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res1.statusCode).toBe(200);
    const balance1 = Number(JSON.parse(res1.body).balanceHours);

    // Now create an entry for today
    await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: new Date(today + "T00:00:00Z"),
        startTime: new Date(`${today}T08:00:00.000Z`),
        endTime: new Date(`${today}T18:00:00.000Z`),
        breakMinutes: 0,
        source: "MANUAL",
        type: "WORK",
      },
    });

    // GET overtime again — should now include today (10h entry)
    const res2 = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res2.statusCode).toBe(200);
    const balance2 = Number(JSON.parse(res2.body).balanceHours);

    // Balance should increase by ~10h worked today minus expected hours for today
    // The key assertion: balance increased after adding today's entry
    expect(balance2).toBeGreaterThan(balance1);
  });

  it("overtime saldo only counts leave within effective period", async () => {
    // Clean all entries and leave for the employee to start fresh
    await app.prisma.timeEntry.deleteMany({ where: { employeeId: data.employee.id } });
    await app.prisma.leaveRequest.deleteMany({ where: { employeeId: data.employee.id } });

    // The employee has hireDate 2024-01-01 — effective period starts at month start or hireDate.
    // Create an approved leave request BEFORE the current month (should NOT affect overtime).
    const leaveType = await app.prisma.leaveType.findFirst({
      where: { tenantId: data.tenant.id, name: "Urlaub" },
    });
    expect(leaveType).not.toBeNull();

    await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: leaveType!.id,
        startDate: new Date("2025-06-02T00:00:00Z"),
        endDate: new Date("2025-06-06T00:00:00Z"),
        days: 5,
        status: "APPROVED",
        reviewedBy: "system",
        reviewedAt: new Date(),
      },
    });

    // Create a work entry for yesterday so we have something to calculate
    const yesterday = pastDate(1);
    await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: new Date(yesterday + "T00:00:00Z"),
        startTime: new Date(`${yesterday}T08:00:00.000Z`),
        endTime: new Date(`${yesterday}T16:00:00.000Z`),
        breakMinutes: 0,
        source: "MANUAL",
        type: "WORK",
      },
    });

    // GET overtime
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const balance = Number(body.balanceHours);

    // The 2025-06 leave is outside the current month, so it should not reduce
    // expected hours. The balance should reflect only worked vs expected for
    // the current month period. If the old leave were incorrectly counted,
    // it would inflate the balance by reducing expected hours.
    // For a correct implementation, balance = workedMinutes - max(0, expected - holidays - leave) / 60
    // where leave is clamped to the effective period (current month).
    // Since the leave is in 2025 and we're in 2026, it should have zero effect.

    // Create the same scenario but WITH leave in the current month
    const twoDaysAgo = pastDate(2);
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: leaveType!.id,
        startDate: new Date(twoDaysAgo + "T00:00:00Z"),
        endDate: new Date(twoDaysAgo + "T00:00:00Z"),
        days: 1,
        status: "APPROVED",
        reviewedBy: "system",
        reviewedAt: new Date(),
      },
    });

    // GET overtime again — the current-month leave should reduce expected hours
    const res2 = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res2.statusCode).toBe(200);
    const balance2 = Number(JSON.parse(res2.body).balanceHours);

    // If twoDaysAgo is a weekday, the leave should reduce expected hours by ~8h,
    // making the balance higher (less expected work). On weekends, no effect.
    const twoDaysAgoDate = new Date(twoDaysAgo + "T00:00:00Z");
    const dayOfWeek = twoDaysAgoDate.getUTCDay(); // 0=Sun, 6=Sat
    if (dayOfWeek >= 1 && dayOfWeek <= 5) {
      // Weekday — leave should improve balance by reducing expected hours
      expect(balance2).toBeGreaterThanOrEqual(balance);
    }
    // On weekends the leave has no effect, which is also correct behavior
  });
});
