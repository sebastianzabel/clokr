/**
 * Issue #605 — the saldo in free days.
 *
 * Part 1 pins the pure kernel (`freeDaysEquivalent`) per schedule type; part 2 pins the additive
 * fields of GET /api/v1/overtime/:employeeId: shown for a positive confirmed balance, absent (null)
 * for a confirmed balance <= 0 and a track-only contract. A tenant without a stored
 * Überstundenausgleich row still gets the conversion: the row is created on the first request.
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { leaveTypeFields } from "../contexts/absence/leave-type";
import { monthRangeUtc, monthDayBounds } from "../contexts/working-time-account/timezone";
import {
  freeDaysEquivalent,
  averageDailySollMinutes,
} from "../contexts/working-time-account/free-days-equivalent";

const TZ = "Europe/Berlin";
const ctx = { tz: TZ, todayDay: "2026-08-13" };

const fixed = (hours: number[], weekly: number) => ({
  type: "FIXED_SCHEDULE",
  weeklyHours: weekly,
  sundayHours: hours[0],
  mondayHours: hours[1],
  tuesdayHours: hours[2],
  wednesdayHours: hours[3],
  thursdayHours: hours[4],
  fridayHours: hours[5],
  saturdayHours: hours[6],
});

describe("freeDaysEquivalent (pure kernel, Issue #605)", () => {
  it("FIXED_SCHEDULE 5 x 8 h: 12:30 h is 1.6 days (one decimal, rounded)", () => {
    const r = freeDaysEquivalent({
      balanceMinutes: 750,
      schedule: fixed([0, 8, 8, 8, 8, 8, 0], 40),
      ...ctx,
    });
    expect(r).toEqual({ freeDays: 1.6, dailySollMinutes: 480 });
  });

  it("FIXED_SCHEDULE with uneven days averages over the credited days (4/8/9.5/0/0)", () => {
    const schedule = fixed([0, 4, 8, 9.5, 0, 0, 0], 21.5);
    expect(averageDailySollMinutes(schedule, ctx)).toBe(Math.round((21.5 * 60) / 3));
  });

  it("FLEXTIME takes the Ø-day weeklyHours / workDays, workDays authoritative", () => {
    const schedule = { type: "FLEXTIME", weeklyHours: 40, workDays: [1, 2, 3, 4] };
    expect(averageDailySollMinutes(schedule, ctx)).toBe(600);
  });

  it("SHIFT_BASED takes weeklyHours / contractual workdays, not the roster or workDays", () => {
    const schedule = {
      type: "SHIFT_BASED",
      weeklyHours: 30,
      contractWorkDaysPerWeek: 3,
      workDays: [1, 2, 3, 4, 5],
    };
    expect(averageDailySollMinutes(schedule, ctx)).toBe(600);
  });

  it("MONTHLY_HOURS takes the Ø-day of the current month (August 2026: 21 Mo-Fr days)", () => {
    const schedule = { type: "MONTHLY_HOURS", monthlyHours: 84, overtimeMode: "CARRY_FORWARD" };
    expect(averageDailySollMinutes(schedule, { ...ctx, defaultWorkDays: [1, 2, 3, 4, 5] })).toBe(
      240,
    );
  });

  it("returns null for saldo <= 0", () => {
    const schedule = fixed([0, 8, 8, 8, 8, 8, 0], 40);
    expect(freeDaysEquivalent({ balanceMinutes: 0, schedule, ...ctx })).toBeNull();
    expect(freeDaysEquivalent({ balanceMinutes: -120, schedule, ...ctx })).toBeNull();
  });

  it("returns null for track-only contracts (no monthlyHours, TRACK_ONLY mode)", () => {
    expect(
      freeDaysEquivalent({
        balanceMinutes: 600,
        schedule: { type: "MONTHLY_HOURS", monthlyHours: 0 },
        ...ctx,
      }),
    ).toBeNull();
    expect(
      freeDaysEquivalent({
        balanceMinutes: 600,
        schedule: { ...fixed([0, 8, 8, 8, 8, 8, 0], 40), overtimeMode: "TRACK_ONLY" },
        ...ctx,
      }),
    ).toBeNull();
  });

  it("returns null without a contract or without any daily Soll, and below 0.05 days", () => {
    expect(freeDaysEquivalent({ balanceMinutes: 600, schedule: null, ...ctx })).toBeNull();
    expect(
      freeDaysEquivalent({
        balanceMinutes: 600,
        schedule: { type: "FIXED_SCHEDULE", weeklyHours: 0 },
        ...ctx,
      }),
    ).toBeNull();
    expect(
      freeDaysEquivalent({
        balanceMinutes: 10,
        schedule: fixed([0, 8, 8, 8, 8, 8, 0], 40),
        ...ctx,
      }),
    ).toBeNull();
  });
});

describe("GET /api/v1/overtime/:employeeId freeDaysEquivalent (Issue #605)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  const FROZEN_NOW = new Date("2026-08-13T10:00:00.000Z");

  async function setCarry(minutes: number) {
    await app.prisma.saldoSnapshot.updateMany({
      where: { employeeId: data.employee.id },
      data: { carryOver: minutes },
    });
  }

  async function read() {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FROZEN_NOW);
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/${data.employee.id}`,
        headers: { authorization: `Bearer ${data.empToken}` },
      });
      expect(res.statusCode).toBe(200);
      return JSON.parse(res.body);
    } finally {
      vi.useRealTimers();
    }
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "fde");
    await app.prisma.leaveType.create({
      data: { tenantId: data.tenant.id, ...leaveTypeFields("OVERTIME_COMP") },
    });
    const { start, end } = monthRangeUtc(2026, 7, TZ);
    const { lastDay } = monthDayBounds(start, end, TZ);
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: data.employee.id,
        periodType: "MONTHLY",
        periodStart: start,
        periodEnd: lastDay,
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 4800,
        closedAt: new Date("2026-08-01T06:00:00Z"),
        superseded: false,
      },
    });
  });

  afterEach(async () => {
    await setCarry(4800);
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("serves days and the daily Soll for a positive saldo (8 h contract -> 480 min)", async () => {
    const body = await read();
    // confirmed carry 4800 min = 80 h = 10 days of 480 min, whatever the live total is
    expect(body.confirmedMinutes).toBe(4800);
    expect(body.freeDaysDailySollMinutes).toBe(480);
    expect(body.freeDaysEquivalent).toBe(10);
  });

  it("uses the confirmed balance: a negative live total still shows the confirmed days", async () => {
    await setCarry(480);
    // open-month Soll without entries drives the live total below zero
    const body = await read();
    expect(body.balanceHours).toBeLessThan(0);
    expect(body.freeDaysEquivalent).toBe(1);
  });

  it("serves null when the confirmed balance is <= 0 even though the live total is positive", async () => {
    await setCarry(0);
    await app.prisma.overtimeAccount.update({
      where: { employeeId: data.employee.id },
      data: { balanceHours: 50 },
    });
    // a positive live total without a confirmed one: opening-month entries of 12 h per day
    for (const d of [
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
      "2026-08-10",
      "2026-08-11",
      "2026-08-12",
    ]) {
      await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date(d + "T00:00:00Z"),
          startTime: new Date(d + "T05:00:00Z"),
          endTime: new Date(d + "T18:00:00Z"),
          breakMinutes: 30,
          type: "WORK",
          salonId: data.salonId,
        },
      });
    }
    try {
      const body = await read();
      expect(body.balanceHours).toBeGreaterThan(0);
      expect(body.confirmedMinutes).toBe(0);
      expect(body.freeDaysEquivalent).toBeNull();
    } finally {
      await app.prisma.timeEntry.deleteMany({ where: { employeeId: data.employee.id } });
    }
  });

  it("serves null for a confirmed balance <= 0", async () => {
    await setCarry(-4800);
    const body = await read();
    expect(body.freeDaysEquivalent).toBeNull();
    expect(body.freeDaysDailySollMinutes).toBeNull();
  });

  it("serves null for a track-only contract", async () => {
    await app.prisma.workSchedule.updateMany({
      where: { employeeId: data.employee.id },
      data: { overtimeMode: "TRACK_ONLY" },
    });
    try {
      const body = await read();
      expect(body.freeDaysEquivalent).toBeNull();
    } finally {
      await app.prisma.workSchedule.updateMany({
        where: { employeeId: data.employee.id },
        data: { overtimeMode: "CARRY_FORWARD" },
      });
    }
  });

  // Follow-up 13.11.2026: leave types are created on first use (`ensureLeaveType`), so a tenant
  // in which nobody requested Überstundenausgleich yet has no row - and must still see the days.
  it("serves the conversion when the tenant has no stored Überstundenausgleich row yet", async () => {
    await app.prisma.leaveType.deleteMany({
      where: { tenantId: data.tenant.id, code: "OVERTIME_COMP" },
    });
    try {
      const body = await read();
      expect(body.freeDaysEquivalent).not.toBeNull();
      expect(body.freeDaysEquivalent).toBeGreaterThan(0);
    } finally {
      await app.prisma.leaveType.create({
        data: { tenantId: data.tenant.id, ...leaveTypeFields("OVERTIME_COMP") },
      });
    }
  });
});
