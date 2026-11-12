/**
 * Issue #596 (#845) — the clock's day goal is today's Soll from the working-time account core
 * (`computeWeekProgress` → `closeEmployeeMonth` for today alone), served as `today.sollMinutes` of
 * GET /dashboard. Never a fixed 8 h: a 32 h Tue–Fri contract owes nothing on Monday and 8 h on
 * Tuesday.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { fromZonedTime } from "date-fns-tz";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import { addDaysStr, mondayOfWeekStr, TEST_TZ } from "./test-dates";

describe("GET /dashboard today.sollMinutes (#596)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  // a past week (a future instant would outlive the token); the fixture records nothing there
  const monday = addDaysStr(mondayOfWeekStr(), -7 * 5);

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "tsoll596");
    // 32 h Tue–Fri (8 h each), valid from the first of an earlier month
    await app.prisma.workSchedule.updateMany({
      where: { employeeId: seed.employee.id },
      data: {
        weeklyHours: 32,
        mondayHours: 0,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [2, 3, 4, 5],
      },
    });
  });
  afterAll(async () => {
    try {
      await cleanupTestData(app, seed.tenant.id);
    } catch (err) {
      console.error("Cleanup failed:", err);
    }
  });

  async function sollOn(dayStr: string): Promise<number | null> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(fromZonedTime(`${dayStr}T10:00:00`, TEST_TZ));
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard",
        headers: { authorization: `Bearer ${seed.empToken}` },
      });
      expect(res.statusCode, res.body).toBe(200);
      return (res.json() as { today: { sollMinutes: number | null } }).today.sollMinutes;
    } finally {
      vi.useRealTimers();
    }
  }

  it("Monday of a Tue–Fri contract has no goal, Tuesday owes 8 h", async () => {
    expect(await sollOn(monday)).toBe(0);
    expect(await sollOn(addDaysStr(monday, 1))).toBe(480);
  });
});
