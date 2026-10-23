/**
 * Issue #728 — an approved HALF-day absence must not block recording working time for the other
 * half of the day (§ 8 BUrlG forbids work DURING leave; the open half is working time).
 *
 * Proves, against a real database and through the real routes:
 *
 * - clock-in succeeds on a day with an approved half-day OVERTIME_COMP request and on one with an
 *   approved half-day VACATION request;
 * - a manual POST succeeds on a day with an approved half-day request, and the month saldo then
 *   shows exactly the half Soll reduction (240 min) plus the recorded Ist (240 min);
 * - a full-day approved request still answers 409 (clock-in and manual POST);
 * - a half-day AND a full-day request on the same day: the full-day one blocks (409).
 *
 * No person names in fixtures.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { fromZonedTime } from "date-fns-tz";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import { addDaysStr, holidayFreeMondayStr, TEST_TZ } from "./test-dates";
import { leaveTypeFields } from "../contexts/absence/leave-type";
import { computeMonthSaldo } from "../contexts/working-time-account/month-saldo";

const instant = (dayStr: string, hhmm: string) => fromZonedTime(`${dayStr}T${hhmm}:00`, TEST_TZ);
const dateOf = (dayStr: string) => new Date(`${dayStr}T00:00:00Z`);

describe("Issue #728 — half-day leave does not block recording", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let overtimeCompTypeId: string;

  // A holiday-free past week: Mon..Fri are one case each.
  const monday = holidayFreeMondayStr(-20);
  const day = (n: number) => addDaysStr(monday, n);

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app);
    const oc = await app.prisma.leaveType.create({
      data: { tenantId: seed.tenant.id, ...leaveTypeFields("OVERTIME_COMP"), color: "#8B5CF6" },
    });
    overtimeCompTypeId = oc.id;
  });

  afterAll(async () => {
    vi.useRealTimers();
    await cleanupTestData(app, seed.tenant.id);
  });

  function leave(dayStr: string, leaveTypeId: string, halfDay: boolean) {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId: seed.employee.id,
        leaveTypeId,
        status: "APPROVED",
        startDate: dateOf(dayStr),
        endDate: dateOf(dayStr),
        halfDay,
        days: halfDay ? 0.5 : 1,
      },
    });
  }

  async function clockIn(dayStr: string) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(instant(dayStr, "13:00"));
    try {
      return await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/clock-in",
        headers: { authorization: `Bearer ${seed.empToken}` },
        payload: {},
      });
    } finally {
      vi.useRealTimers();
    }
  }

  function manualPost(dayStr: string, from: string, to: string) {
    return app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      // Manager token: the employee's own retro window (10 days) would refuse a past day first.
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: {
        employeeId: seed.employee.id,
        date: dayStr,
        startTime: instant(dayStr, from).toISOString(),
        endTime: instant(dayStr, to).toISOString(),
        breakMinutes: 0,
      },
    });
  }

  it("clock-in works on a half-day OVERTIME_COMP day", async () => {
    await leave(day(0), overtimeCompTypeId, true);
    const res = await clockIn(day(0));
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body).resolution.kind).not.toBe("CONFLICT");
  });

  it("clock-in works on a half-day VACATION day", async () => {
    await leave(day(1), seed.vacationType.id, true);
    const res = await clockIn(day(1));
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body).resolution.kind).not.toBe("CONFLICT");
  });

  it("a full-day request still blocks clock-in and manual POST with 409", async () => {
    await leave(day(3), seed.vacationType.id, false);
    const clock = await clockIn(day(3));
    expect(clock.statusCode).toBe(409);
    const manual = await manualPost(day(3), "08:00", "12:00");
    expect(manual.statusCode).toBe(409);
    expect(JSON.parse(manual.body).error).toContain("§ 8 BUrlG");
  });

  it("a half-day plus a full-day request on the same day: the full-day one blocks", async () => {
    await leave(day(4), overtimeCompTypeId, true);
    await leave(day(4), seed.vacationType.id, false);
    const clock = await clockIn(day(4));
    expect(clock.statusCode).toBe(409);
    const manual = await manualPost(day(4), "08:00", "12:00");
    expect(manual.statusCode).toBe(409);
  });

  it("manual POST works on a half-day and the saldo is half Soll reduction plus the recorded Ist", async () => {
    const dayStr = day(2);
    const [y, m] = dayStr.split("-").map(Number);
    const before = await computeMonthSaldo(app, seed.employee.id, y, m);

    await leave(dayStr, seed.vacationType.id, true);
    const res = await manualPost(dayStr, "13:00", "17:00");
    expect(res.statusCode, res.body).toBe(201);

    const after = await computeMonthSaldo(app, seed.employee.id, y, m);
    // 8 h contract day: the half day reduces Soll by 240, the recorded 4 h are Ist.
    expect(before.expectedMinutes - after.expectedMinutes).toBe(240);
    expect(after.workedMinutes - before.workedMinutes).toBe(240);
  });
});
