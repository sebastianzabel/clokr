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

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import { computeMonthSaldo } from "../utils/month-saldo";
import bcrypt from "bcryptjs";

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

    // Create one time entry, 9h worked (480+60=540 gross, 0 break). The header now reflects the
    // TO-DATE (bisher) §615 state (windowEnd = today, or yesterday when no today-entries), so the
    // entry MUST fall within [monthStart, today] to be counted. Use min(day 2, today's day-of-month):
    // when today is the 1st/2nd, place it on today (the hasTodayEntries guard then includes today);
    // otherwise day 2 (a past day, always inside the to-date window).
    const testDay = Math.min(2, now.getDate());
    const testDate = ymd(year, month, testDay);
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
    // cumulative on the last day = carryOverIn + to-date (bisher) balance.
    // Header balanceMinutes is now derived from the SAME last-included-day result the cells use
    // (single source of truth), so the terminal cumulative must equal carryOverIn + body.balanceMinutes.
    // The seeded employee may have a prior snapshot so carryOverIn could be non-zero.
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
      rosterIncomplete?: boolean;
      days: Array<{ date: string; cumulativeSaldoMinutes: number }>;
    };

    // Must be flagged as closed
    expect(body.closed).toBe(true);
    // Values must match snapshot verbatim (Revisionssicherheit)
    expect(body.workedMinutes).toBe(snapshot.workedMinutes);
    expect(body.expectedMinutes).toBe(snapshot.expectedMinutes);
    expect(body.balanceMinutes).toBe(snapshot.balanceMinutes);
    // Phase 97-05 (SALDO-DISP-07) — a closed month is final; an unrostered-remainder warning
    // would be meaningless here. rosterIncomplete must be ABSENT (never a fabricated `false`),
    // regardless of the employee's schedule type (the closed branch returns before scheduleType
    // is even resolved).
    expect(body.rosterIncomplete).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(body, "rosterIncomplete")).toBe(false);
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

// ── rosterIncomplete (Phase 97-05, SALDO-DISP-07) — corrected signal on computeMonthSaldo ──────
//
// CONTEXT's first-proposed signal (rosterToDateMinutes === rosterPeriodMinutes) is trivially true
// at 0 === 0 and collides with the pre-existing "no roster at all" zero-state (which already has
// its own guard in shift-based-saldo.ts and contributes a balanceDelta of 0). The corrected signal
// (97-RESEARCH.md Q4) adds a `rosterPeriodMinutes > 0` guard plus a "days remain in the month"
// clause. This block proves all four required cases directly on computeMonthSaldo — no HTTP layer
// needed — mirroring overtime-live-vs-monthsaldo-parity.test.ts's SALDO-DISP-07 cluster for the
// sibling GET /overtime/:employeeId endpoint (97-01). "Now" is frozen mid-month at 10:00 UTC
// (comfortably inside business hours in Europe/Berlin) so the test never lands in the documented
// UTC-vs-tenant-timezone midnight fixture window.
describe("rosterIncomplete (Phase 97-05, SALDO-DISP-07) — computeMonthSaldo", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let partlyRosteredEmpId: string;
  let fullyRosteredEmpId: string;
  let nonShiftEmpId: string;
  let zeroRosterEmpId: string;

  // "Today" mid-month with NO entry today → windowEnd = yesterday (2026-09-14), leaving a real
  // remainder of the month (through 2026-09-30) a roster COULD still cover.
  const RI_YEAR = 2026;
  const RI_MONTH = 9;
  const RI_NOW = new Date("2026-09-15T10:00:00.000Z");

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const suffix = "msri-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const tenant = await prisma.tenant.create({
      data: {
        name: `MonthSaldoRI ${suffix}`,
        slug: `msri-${suffix}`,
        federalState: "NIEDERSACHSEN",
      },
    });
    tenantId = tenant.id;
    const passwordHash = await bcrypt.hash("test1234", 10);

    // Shared SHIFT_BASED schedule shape — 38h/week, Mo-Fr day-hours set so the contract Ø-Soll is
    // non-zero (only the roster-detection SIGNAL is under test here, not the §615 arithmetic).
    const shiftSchedule = {
      type: "SHIFT_BASED" as const,
      weeklyHours: 38,
      mondayHours: 7.6,
      tuesdayHours: 7.6,
      wednesdayHours: 7.6,
      thursdayHours: 7.6,
      fridayHours: 7.6,
      saturdayHours: 0,
      sundayHours: 0,
      validFrom: new Date("2026-09-01"),
    };

    // (a) Partly-rostered SHIFT_BASED — shifts exist ONLY through Sep 1–14 (all already covered
    // by windowEnd = Sep 14); nothing planned for the remainder of the month.
    {
      const user = await prisma.user.create({
        data: {
          email: `msripartial-${suffix}@test.de`,
          passwordHash,
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const emp = await prisma.employee.create({
        data: {
          tenantId,
          userId: user.id,
          employeeNumber: `MSRIP-${suffix}`,
          firstName: "Partial",
          lastName: "Roster",
          hireDate: new Date("2026-09-01"),
        },
      });
      partlyRosteredEmpId = emp.id;
      await prisma.workSchedule.create({ data: { employeeId: emp.id, ...shiftSchedule } });
      for (const d of [
        "2026-09-01",
        "2026-09-02",
        "2026-09-03",
        "2026-09-04",
        "2026-09-07",
        "2026-09-08",
        "2026-09-09",
        "2026-09-10",
        "2026-09-11",
        "2026-09-14",
      ]) {
        await prisma.shift.create({
          data: {
            employeeId: emp.id,
            date: new Date(d + "T00:00:00Z"),
            startTime: "08:00",
            endTime: "16:00",
          },
        });
      }
      await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });
    }

    // (b) Fully-rostered SHIFT_BASED — same past shifts as (a) PLUS future shifts after
    // windowEnd, so rosterPeriodMinutes (whole month) strictly exceeds rosterToDateMinutes
    // (through yesterday).
    {
      const user = await prisma.user.create({
        data: {
          email: `msrifull-${suffix}@test.de`,
          passwordHash,
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const emp = await prisma.employee.create({
        data: {
          tenantId,
          userId: user.id,
          employeeNumber: `MSRIF-${suffix}`,
          firstName: "Full",
          lastName: "Roster",
          hireDate: new Date("2026-09-01"),
        },
      });
      fullyRosteredEmpId = emp.id;
      await prisma.workSchedule.create({ data: { employeeId: emp.id, ...shiftSchedule } });
      for (const d of [
        "2026-09-01",
        "2026-09-02",
        "2026-09-03",
        "2026-09-04",
        "2026-09-07",
        "2026-09-08",
        "2026-09-09",
        "2026-09-10",
        "2026-09-11",
        "2026-09-14",
        "2026-09-15",
        "2026-09-16",
        "2026-09-17",
        "2026-09-18",
        "2026-09-21",
        "2026-09-22",
        "2026-09-23",
        "2026-09-24",
        "2026-09-25",
        "2026-09-28",
        "2026-09-29",
        "2026-09-30",
      ]) {
        await prisma.shift.create({
          data: {
            employeeId: emp.id,
            date: new Date(d + "T00:00:00Z"),
            startTime: "08:00",
            endTime: "16:00",
          },
        });
      }
      await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });
    }

    // (c) Non-SHIFT_BASED — rosterIncomplete is meaningless (no roster proration at all); the
    // property must be ABSENT from the result, never a fabricated `false`.
    {
      const user = await prisma.user.create({
        data: {
          email: `msrinonshift-${suffix}@test.de`,
          passwordHash,
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const emp = await prisma.employee.create({
        data: {
          tenantId,
          userId: user.id,
          employeeNumber: `MSRIN-${suffix}`,
          firstName: "NonShift",
          lastName: "Fixed",
          hireDate: new Date("2026-09-01"),
        },
      });
      nonShiftEmpId = emp.id;
      await prisma.workSchedule.create({
        data: {
          employeeId: emp.id,
          type: "FIXED_SCHEDULE",
          weeklyHours: 40,
          mondayHours: 8,
          tuesdayHours: 8,
          wednesdayHours: 8,
          thursdayHours: 8,
          fridayHours: 8,
          saturdayHours: 0,
          sundayHours: 0,
          validFrom: new Date("2026-09-01"),
        },
      });
      await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });
    }

    // (d) Zero-roster SHIFT_BASED — no Shift rows AT ALL in the current month. Must NOT be
    // flagged incomplete — this is the 0 === 0 collision the naive signal would have tripped;
    // the pre-existing "nothing rostered" zero-state (shift-based-saldo.ts) already has its own
    // guard and contributes a balanceDelta of 0.
    {
      const user = await prisma.user.create({
        data: {
          email: `msrizero-${suffix}@test.de`,
          passwordHash,
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const emp = await prisma.employee.create({
        data: {
          tenantId,
          userId: user.id,
          employeeNumber: `MSRIZ-${suffix}`,
          firstName: "Zero",
          lastName: "Roster",
          hireDate: new Date("2026-09-01"),
        },
      });
      zeroRosterEmpId = emp.id;
      await prisma.workSchedule.create({ data: { employeeId: emp.id, ...shiftSchedule } });
      await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });
    }
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("month-saldo rosterIncomplete test cleanup failed:", err);
    }
  });

  it("(a) partly-rostered SHIFT_BASED open month → rosterIncomplete === true", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(RI_NOW);
    try {
      const result = await computeMonthSaldo(app, partlyRosteredEmpId, RI_YEAR, RI_MONTH);
      expect(result.rosterIncomplete).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("(b) fully-rostered SHIFT_BASED open month → rosterIncomplete === false", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(RI_NOW);
    try {
      const result = await computeMonthSaldo(app, fullyRosteredEmpId, RI_YEAR, RI_MONTH);
      expect(result.rosterIncomplete).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("(c) non-SHIFT_BASED employee → rosterIncomplete is ABSENT (never a fabricated false)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(RI_NOW);
    try {
      // Direct in-memory call (not JSON round-tripped) — computeMonthSaldo's own contract is
      // that the VALUE is undefined for non-SHIFT_BASED, matching 97-01's identical
      // computeOvertimeBalanceBreakdown convention (plain field assignment). A hasOwnProperty
      // check is meaningful only after JSON serialization (which drops undefined-valued keys,
      // e.g. via reply.send() on the real GET /overtime/month-saldo/:employeeId route) — that
      // wire-level guarantee is exercised by the (c) closed-month HTTP test above and by the
      // sibling GET /overtime/:employeeId coverage in overtime-live-vs-monthsaldo-parity.test.ts.
      const result = await computeMonthSaldo(app, nonShiftEmpId, RI_YEAR, RI_MONTH);
      expect(result.rosterIncomplete).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("(d) zero-roster SHIFT_BASED month → rosterIncomplete === false, not true (0===0 non-collision)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(RI_NOW);
    try {
      const result = await computeMonthSaldo(app, zeroRosterEmpId, RI_YEAR, RI_MONTH);
      expect(result.rosterIncomplete).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
