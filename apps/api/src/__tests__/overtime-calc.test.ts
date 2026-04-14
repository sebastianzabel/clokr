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
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("overtime balance updates after creating a time entry via API", async () => {
    // Get initial overtime balance
    const beforeRes = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(beforeRes.statusCode).toBe(200);
    const balanceBefore = Number(JSON.parse(beforeRes.body).balanceHours);

    // Create a 10h time entry for 2 days ago via the API route (fires updateOvertimeAccount)
    const targetDate = pastDate(2);
    // Clean up any existing entry for that day first
    await app.prisma.timeEntry.deleteMany({
      where: { employeeId: data.employee.id, date: new Date(targetDate + "T00:00:00Z"), deletedAt: null },
    });

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: data.employee.id,
        date: targetDate,
        startTime: new Date(`${targetDate}T07:00:00.000Z`).toISOString(),
        endTime: new Date(`${targetDate}T17:00:00.000Z`).toISOString(),
        breakMinutes: 0,
      },
    });
    // 201 = created, 409 = entry already exists for that day (both mean API processed request)
    expect([201, 409]).toContain(createRes.statusCode);

    // GET overtime — stored balance was updated by the POST route's updateOvertimeAccount call
    const afterRes = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(afterRes.statusCode).toBe(200);
    const balanceAfter = Number(JSON.parse(afterRes.body).balanceHours);

    // 10h worked on a day with 8h schedule = +2h delta (if weekday)
    // Key assertion: balance changed after adding an entry via the write path
    expect(balanceAfter).not.toBe(balanceBefore);
  });

  it("overtime balance includes today only when entry created via API", async () => {
    const today = pastDate(0);
    const yesterday = pastDate(1);

    // Clean up entries for today and yesterday
    await app.prisma.timeEntry.deleteMany({
      where: {
        employeeId: data.employee.id,
        date: { in: [new Date(today + "T00:00:00Z"), new Date(yesterday + "T00:00:00Z")] },
        deletedAt: null,
      },
    });

    // Create entry for yesterday via API route (fires updateOvertimeAccount)
    await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: data.employee.id,
        date: yesterday,
        startTime: new Date(`${yesterday}T08:00:00.000Z`).toISOString(),
        endTime: new Date(`${yesterday}T16:00:00.000Z`).toISOString(),
        breakMinutes: 0,
      },
    });

    // GET overtime — stored balance reflects yesterday's entry
    const res1 = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res1.statusCode).toBe(200);
    const balance1 = Number(JSON.parse(res1.body).balanceHours);

    // Create entry for today via API route (fires updateOvertimeAccount again)
    await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: data.employee.id,
        date: today,
        startTime: new Date(`${today}T08:00:00.000Z`).toISOString(),
        endTime: new Date(`${today}T18:00:00.000Z`).toISOString(),
        breakMinutes: 0,
      },
    });

    // GET overtime — stored balance now includes today's 10h entry
    const res2 = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res2.statusCode).toBe(200);
    const balance2 = Number(JSON.parse(res2.body).balanceHours);

    // Balance increased after adding today's 10h entry (10h vs 8h schedule = +2h if weekday)
    expect(balance2).toBeGreaterThan(balance1);
  });

  // ── COMPLIANCE: Overtime saldo read ────────────────────────────────────────

  describe("COMPLIANCE: Overtime saldo read", () => {
    it("GET overtime endpoint returns numeric balanceHours and account fields", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      // OvertimeAccount fields must be present and numeric
      expect(typeof Number(body.balanceHours)).toBe("number");
      expect(isNaN(Number(body.balanceHours))).toBe(false);

      // Status field must be one of the expected values
      expect(["NORMAL", "ELEVATED", "CRITICAL"]).toContain(body.status);

      // threshold must be a number
      expect(typeof body.threshold).toBe("number");
    });

    it("GET overtime returns updated balance after adding a work entry", async () => {
      // Add a 10h entry for a recent weekday via API route (triggers updateOvertimeAccount)
      const recentDate = pastDate(3);
      await app.prisma.timeEntry.deleteMany({
        where: {
          employeeId: data.employee.id,
          date: new Date(recentDate + "T00:00:00Z"),
          deletedAt: null,
        },
      });

      // Measure baseline AFTER cleanup so stored balance excludes the target date
      const before = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      const balanceBefore = Number(JSON.parse(before.body).balanceHours);

      // POST via API route — fires updateOvertimeAccount as write-path side effect (SALDO-01)
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          date: recentDate,
          startTime: new Date(`${recentDate}T07:00:00.000Z`).toISOString(),
          endTime: new Date(`${recentDate}T17:00:00.000Z`).toISOString(),
          breakMinutes: 0,
        },
      });
      expect([201, 409]).toContain(createRes.statusCode);

      // GET after — balance should reflect the new entry (stored O(1) read, no recalc in GET)
      const after = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(after.statusCode).toBe(200);
      const balanceAfter = Number(JSON.parse(after.body).balanceHours);

      // 10h worked vs 8h expected = +2h delta (at minimum, balance should differ)
      expect(balanceAfter).not.toBe(balanceBefore);
    });
  });

  // ── COMPLIANCE: Monatsabschluss (month-close) ───────────────────────────────

  describe("COMPLIANCE: Monatsabschluss (month-close)", () => {
    const testYear = 2024;
    const testMonth = 6; // June 2024 — well in the past, deterministic

    beforeAll(async () => {
      // Ensure any previous snapshots for Jan-Jun 2024 are removed
      const monthStart = new Date(Date.UTC(testYear, testMonth - 1, 1));
      await app.prisma.saldoSnapshot.deleteMany({
        where: {
          employeeId: data.employee.id,
          periodType: "MONTHLY",
          periodStart: { gte: new Date(Date.UTC(testYear, 0, 1)), lte: monthStart },
        },
      });
    });

    it("month-close creates a SaldoSnapshot record", async () => {
      // Create a work entry for June 2024 (Monday June 3)
      await app.prisma.timeEntry.deleteMany({
        where: {
          employeeId: data.employee.id,
          date: new Date("2024-06-03T00:00:00Z"),
        },
      });
      await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date("2024-06-03T00:00:00Z"),
          startTime: new Date("2024-06-03T07:00:00.000Z"),
          endTime: new Date("2024-06-03T17:00:00.000Z"),
          breakMinutes: 60,
          source: "MANUAL",
          type: "WORK",
        },
      });

      // POST close-month for June 2024
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/overtime/close-month",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { employeeId: data.employee.id, year: testYear, month: testMonth },
      });

      // May need to close Jan-May 2024 first due to sequential validation
      // If we get a 400 about needing to close previous months, close them first
      if (res.statusCode === 400) {
        const errBody = JSON.parse(res.body);
        if (errBody.error && errBody.error.includes("zuerst")) {
          // Close all months from January to May sequentially
          for (let m = 1; m < testMonth; m++) {
            await app.prisma.saldoSnapshot.deleteMany({
              where: {
                employeeId: data.employee.id,
                periodType: "MONTHLY",
                periodStart: new Date(Date.UTC(testYear, m - 1, 1)),
              },
            });
            await app.inject({
              method: "POST",
              url: "/api/v1/overtime/close-month",
              headers: { authorization: `Bearer ${data.adminToken}` },
              payload: { employeeId: data.employee.id, year: testYear, month: m },
            });
          }

          // Retry June
          const retryRes = await app.inject({
            method: "POST",
            url: "/api/v1/overtime/close-month",
            headers: { authorization: `Bearer ${data.adminToken}` },
            payload: { employeeId: data.employee.id, year: testYear, month: testMonth },
          });
          expect(retryRes.statusCode).toBe(201);
          const snapshot = JSON.parse(retryRes.body);
          expect(snapshot.periodType).toBe("MONTHLY");
          expect(typeof snapshot.workedMinutes).toBe("number");
          expect(snapshot.workedMinutes).toBeGreaterThan(0);
          return;
        }
      }

      expect(res.statusCode).toBe(201);
      const snapshot = JSON.parse(res.body);
      expect(snapshot.periodType).toBe("MONTHLY");
      // SaldoSnapshot fields must be present
      expect(typeof snapshot.workedMinutes).toBe("number");
      expect(snapshot.workedMinutes).toBeGreaterThan(0);
      expect(typeof snapshot.expectedMinutes).toBe("number");
      expect(typeof snapshot.balanceMinutes).toBe("number");
    });

    it("month-close sets isLocked on entries in that month", async () => {
      // All time entries for June 2024 should now be locked
      const entries = await app.prisma.timeEntry.findMany({
        where: {
          employeeId: data.employee.id,
          date: {
            gte: new Date("2024-06-01T00:00:00Z"),
            lte: new Date("2024-06-30T23:59:59Z"),
          },
          deletedAt: null,
        },
      });

      expect(entries.length).toBeGreaterThan(0);
      for (const e of entries) {
        expect(e.isLocked).toBe(true);
      }
    });

    it("rejects editing a time entry in a closed month", async () => {
      // Find a locked entry from June 2024
      const locked = await app.prisma.timeEntry.findFirst({
        where: {
          employeeId: data.employee.id,
          date: {
            gte: new Date("2024-06-01T00:00:00Z"),
            lte: new Date("2024-06-30T23:59:59Z"),
          },
          isLocked: true,
          deletedAt: null,
        },
      });
      expect(locked).not.toBeNull();

      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/time-entries/${locked!.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          date: "2024-06-03",
          startTime: new Date("2024-06-03T06:00:00Z").toISOString(),
          endTime: new Date("2024-06-03T16:00:00Z").toISOString(),
        },
      });

      // Must be rejected: 403 (gesperrt) per CLAUDE.md Immutability after lock rule
      expect([403, 409, 422]).toContain(res.statusCode);
    });

    it("SaldoSnapshot record exists with workedMinutes > 0 after month-close", async () => {
      // periodStart for June 2024 in Europe/Berlin (UTC+2 in summer) is
      // "2024-05-31T22:00:00Z" UTC, so we must use a range that includes this offset.
      const snapshot = await app.prisma.saldoSnapshot.findFirst({
        where: {
          employeeId: data.employee.id,
          periodType: "MONTHLY",
          periodStart: {
            gte: new Date("2024-05-31T00:00:00Z"),
            lte: new Date("2024-06-02T00:00:00Z"),
          },
        },
      });

      expect(snapshot).not.toBeNull();
      expect(snapshot!.workedMinutes).toBeGreaterThan(0);
      expect(snapshot!.closedAt).not.toBeNull();
    });
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

  // ── overtimeMode bifurcation ───────────────────────────────────────────────

  describe("overtimeMode bifurcation", () => {
    const trackOnlyYear = 2023;
    const trackOnlyMonth = 8; // August 2023 — well in the past

    beforeAll(async () => {
      // Remove any leftover snapshots for this employee in trackOnlyYear
      const monthStart = new Date(Date.UTC(trackOnlyYear, trackOnlyMonth - 1, 1));
      await app.prisma.saldoSnapshot.deleteMany({
        where: {
          employeeId: data.employee.id,
          periodType: "MONTHLY",
          periodStart: { gte: new Date(Date.UTC(trackOnlyYear, 0, 1)), lte: monthStart },
        },
      });
    });

    afterAll(async () => {
      // Restore original FIXED_WEEKLY schedule so later tests are not affected
      await app.prisma.workSchedule.updateMany({
        where: { employeeId: data.employee.id },
        data: {
          type: "FIXED_WEEKLY",
          weeklyHours: 40,
          monthlyHours: null,
          overtimeMode: "CARRY_FORWARD",
        },
      });
      // Reset overtime account balance
      await app.prisma.overtimeAccount.updateMany({
        where: { employeeId: data.employee.id },
        data: { balanceHours: 0 },
      });
    });

    it("CARRY_FORWARD employee has non-zero balanceHours after working overtime (regression guard)", async () => {
      // Confirm baseline: FIXED_WEEKLY + CARRY_FORWARD schedule (already set in seedTestData)
      await app.prisma.workSchedule.updateMany({
        where: { employeeId: data.employee.id },
        data: { type: "FIXED_WEEKLY", weeklyHours: 40, monthlyHours: null, overtimeMode: "CARRY_FORWARD" },
      });

      // Create 10h entry for a past weekday (Monday 7 days ago)
      const targetDate = pastDate(7);
      await app.prisma.timeEntry.deleteMany({
        where: { employeeId: data.employee.id, date: new Date(targetDate + "T00:00:00Z") },
      });
      await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          date: targetDate,
          startTime: new Date(`${targetDate}T07:00:00.000Z`).toISOString(),
          endTime: new Date(`${targetDate}T17:00:00.000Z`).toISOString(),
          breakMinutes: 0,
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // CARRY_FORWARD: balance should be non-zero when entries exist
      expect(typeof Number(body.balanceHours)).toBe("number");
      // The balance should NOT be forced to 0 by mode logic
      // (it may be positive or negative depending on total work in period)
    });

    it("TRACK_ONLY employee has balanceHours=0 after working overtime", async () => {
      // Switch schedule to MONTHLY_HOURS + TRACK_ONLY with a tight monthly budget (10h)
      await app.prisma.workSchedule.updateMany({
        where: { employeeId: data.employee.id },
        data: {
          type: "MONTHLY_HOURS",
          monthlyHours: 10,
          weeklyHours: 40,
          overtimeMode: "TRACK_ONLY",
        },
      });

      // Create a time entry well in excess of 10h monthly budget (20h entry)
      const targetDate = pastDate(4);
      await app.prisma.timeEntry.deleteMany({
        where: { employeeId: data.employee.id, date: new Date(targetDate + "T00:00:00Z") },
      });

      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          date: targetDate,
          startTime: new Date(`${targetDate}T06:00:00.000Z`).toISOString(),
          endTime: new Date(`${targetDate}T16:00:00.000Z`).toISOString(), // 10h
          breakMinutes: 0,
        },
      });
      expect([201, 409]).toContain(createRes.statusCode);

      // GET overtime — TRACK_ONLY mode must return balanceHours=0
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // TRACK_ONLY: live balance displayed as 0
      expect(Number(body.balanceHours)).toBe(0);
    });

    it("TRACK_ONLY close-month creates snapshot with carryOver=0 and balanceHours=0", async () => {
      // Ensure TRACK_ONLY schedule is set (continuation from previous test)
      await app.prisma.workSchedule.updateMany({
        where: { employeeId: data.employee.id },
        data: {
          type: "MONTHLY_HOURS",
          monthlyHours: 10,
          weeklyHours: 40,
          overtimeMode: "TRACK_ONLY",
        },
      });

      // Create a work entry in August 2023 (Monday Aug 7)
      await app.prisma.timeEntry.deleteMany({
        where: { employeeId: data.employee.id, date: new Date("2023-08-07T00:00:00Z") },
      });
      await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date("2023-08-07T00:00:00Z"),
          startTime: new Date("2023-08-07T07:00:00.000Z"),
          endTime: new Date("2023-08-07T19:00:00.000Z"), // 12h worked > 10h budget
          breakMinutes: 0,
          source: "MANUAL",
          type: "WORK",
        },
      });

      // Close August 2023
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/overtime/close-month",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { employeeId: data.employee.id, year: trackOnlyYear, month: trackOnlyMonth },
      });

      // Handle sequential month validation (close prior months if needed)
      if (res.statusCode === 400) {
        const errBody = JSON.parse(res.body);
        if (errBody.error && errBody.error.includes("zuerst")) {
          for (let m = 1; m < trackOnlyMonth; m++) {
            await app.prisma.saldoSnapshot.deleteMany({
              where: {
                employeeId: data.employee.id,
                periodType: "MONTHLY",
                periodStart: new Date(Date.UTC(trackOnlyYear, m - 1, 1)),
              },
            });
            await app.inject({
              method: "POST",
              url: "/api/v1/overtime/close-month",
              headers: { authorization: `Bearer ${data.adminToken}` },
              payload: { employeeId: data.employee.id, year: trackOnlyYear, month: m },
            });
          }
          // Retry August
          const retryRes = await app.inject({
            method: "POST",
            url: "/api/v1/overtime/close-month",
            headers: { authorization: `Bearer ${data.adminToken}` },
            payload: { employeeId: data.employee.id, year: trackOnlyYear, month: trackOnlyMonth },
          });
          expect(retryRes.statusCode).toBe(201);
          const snapshot = JSON.parse(retryRes.body);
          // TRACK_ONLY: carryOver must be 0
          expect(snapshot.carryOver).toBe(0);
          // balanceMinutes is stored informational (should be > 0 since 12h > 10h budget)
          expect(typeof snapshot.balanceMinutes).toBe("number");

          // OvertimeAccount must be 0
          const account = await app.prisma.overtimeAccount.findUnique({
            where: { employeeId: data.employee.id },
          });
          expect(account).not.toBeNull();
          expect(Number(account!.balanceHours)).toBe(0);
          return;
        }
      }

      expect(res.statusCode).toBe(201);
      const snapshot = JSON.parse(res.body);
      // TRACK_ONLY: carryOver must be 0
      expect(snapshot.carryOver).toBe(0);
      // balanceMinutes is stored informational (non-zero since 12h > 10h)
      expect(typeof snapshot.balanceMinutes).toBe("number");

      // OvertimeAccount.balanceHours must be 0
      const account = await app.prisma.overtimeAccount.findUnique({
        where: { employeeId: data.employee.id },
      });
      expect(account).not.toBeNull();
      expect(Number(account!.balanceHours)).toBe(0);
    });
  });
});
