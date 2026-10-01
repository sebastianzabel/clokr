/**
 * live-saldo-today-cutoff-438.test.ts
 *
 * Regression suite for issue #438: the LIVE (pre-Monatsabschluss) running saldo must never
 * include today, under any circumstance.
 *
 * Mechanism (see the Befund posted on #438 and 438-CONTEXT.md's root-cause note): the old rule
 * promoted the live window's cutoff from yesterday to today whenever a CLOSED, valid `WORK`
 * TimeEntry existed for today. That was a correct proxy for "today is over" before the clock
 * resolver's REOPEN branch (`apps/api/src/services/clock/resolver.ts:232-256`, commit
 * `446d4bb6`, v1.8.1 "Unified Clock-Trigger Resolver") made a lunch-break clock-out close
 * today's entry exactly like an end-of-day clock-out — a later clock-in reopens it. Between the
 * two taps, "a closed entry exists for today" was true while the day was not over.
 *
 * Planner finding F-1 (438-01-PLAN.md): the literal "offener Tag" case from the issue report
 * also reproduces, via a SECOND path — `overtime-balance.ts`'s `rangeStart` clamp
 * (`cutoffDate < rangeStart ? rangeStart : cutoffDate`). `rangeStart` is the day after the last
 * closed month's snapshot, or the employee's hire date. On the 1st of a month whose previous
 * month was just auto-closed (06:00 Berlin daily cron), or on an employee's hire day, "yesterday"
 * precedes `rangeStart` and the OLD clamp lifted the window up to `[today, today]` — charging
 * today's full Soll against an open entry's zero Ist. Describes B and C below reproduce exactly
 * that.
 *
 * The fix (D-01 + F-1): the live window always ends yesterday, full stop — no promotion to
 * today, and no clamp back up to `rangeStart` when yesterday precedes it (the open period is then
 * simply empty).
 *
 * Every date in this file is a FIXED fake clock (`vi.useFakeTimers` + `vi.setSystemTime`) — never
 * a date-relative fixture (CLAUDE.md, issues #394/#434).
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { saldoSnapshotPeriodBounds } from "./test-dates";
import type { FastifyInstance } from "fastify";

describe("Issue #438 — live saldo today-cutoff regressions", () => {
  // ── Describe A — FIXED_SCHEDULE workday, step by step ───────────────────────────────────────
  // ORDER-DEPENDENT: every `it` below mutates the SAME TimeEntry row (today, 2026-06-10) created
  // in A1 and shares the employee's running saldo across its()s, by design — each step continues
  // from the previous one's on-disk state.
  describe("A — FIXED_SCHEDULE workday, step by step (order-dependent, one shared TimeEntry row)", () => {
    let app: FastifyInstance;
    let data: Awaited<ReturnType<typeof seedTestData>>;

    beforeAll(async () => {
      app = await getTestApp();
      data = await seedTestData(app, "t438a");
      // Lifetime window starts 2026-06-01 — makes the expected hours in this describe exact
      // without a prior employment history to account for.
      await app.prisma.employee.update({
        where: { id: data.employee.id },
        data: { hireDate: new Date("2026-06-01T00:00:00Z") },
      });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    afterAll(async () => {
      vi.useRealTimers();
      try {
        await cleanupTestData(app, data.tenant.id);
      } catch (err) {
        console.error("Issue #438 describe A cleanup failed:", err);
      }
      await closeTestApp();
    });

    async function getBalanceHours(token: string): Promise<number> {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/${data.employee.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      return Number(JSON.parse(res.body).balanceHours);
    }

    it("A0 sanity: no entry — balance reflects 7 workdays (Jun 1-5, 8-9) through yesterday", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-06-10T11:00:00.000Z"));
      const balance = await getBalanceHours(data.adminToken);
      expect(balance).toBeCloseTo(-56, 2);
    });

    it("A1 guard: an OPEN entry for today does not change the balance", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-06-10T11:00:00.000Z"));
      await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date("2026-06-10T00:00:00Z"),
          startTime: new Date("2026-06-10T06:00:00.000Z"),
          endTime: null,
          breakMinutes: 0,
          type: "WORK",
          source: "MANUAL",
          isInvalid: false,
          salonId: data.salonId,
        },
      });
      const balance = await getBalanceHours(data.adminToken);
      expect(balance).toBeCloseTo(-56, 2);
    });

    it("A2 the regression: closing today's entry for a lunch break must NOT promote the cutoff to today (issue #438)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-06-10T11:00:00.000Z"));
      // Clock-out for lunch (REOPEN's later clock-in would null this again) — closes the entry
      // exactly like an end-of-day clock-out would, which is the whole regression.
      await app.prisma.timeEntry.updateMany({
        where: { employeeId: data.employee.id, date: new Date("2026-06-10T00:00:00Z") },
        data: { endTime: new Date("2026-06-10T10:00:00.000Z") },
      });
      const balance = await getBalanceHours(data.adminToken);
      expect(balance).toBeCloseTo(-56, 2);
    });

    it("A3 (D-04): the dashboard KPI agrees with GET /overtime — today still excluded (issue #438)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-06-10T11:00:00.000Z"));
      const overtimeBalance = await getBalanceHours(data.adminToken);
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/",
        headers: { authorization: `Bearer ${data.empToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { overtime: { balanceHours: number } };
      expect(body.overtime.balanceHours).toBeCloseTo(-56, 2);
      expect(body.overtime.balanceHours).toBeCloseTo(overtimeBalance, 2);
    });

    it("A4: a finished afternoon for today still does not move the balance — today is never 'done' early (issue #438)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-06-10T15:05:00.000Z"));
      await app.prisma.timeEntry.updateMany({
        where: { employeeId: data.employee.id, date: new Date("2026-06-10T00:00:00Z") },
        data: { endTime: new Date("2026-06-10T15:00:00.000Z"), breakMinutes: 30 },
      });
      const balance = await getBalanceHours(data.adminToken);
      expect(balance).toBeCloseTo(-56, 2);
    });

    it("A5 rollover: the next calendar day picks up the finished entry (issue #438)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-06-11T08:00:00.000Z"));
      const balance = await getBalanceHours(data.adminToken);
      // Jun 1-10 (8 workdays x 8h = 64h Soll), 8.5h Ist (510 min from A4) → -55.5.
      expect(balance).toBeCloseTo(-55.5, 2);
    });
  });

  // ── Describe B — the 1st of a month after the previous month was closed ─────────────────────
  // Planner finding F-1: the rangeStart clamp lifted the window to [today, today] on this exact
  // calendar boundary — the literal "offener Tag" case from the issue report.
  describe("B — the 1st of a month after the previous month was closed (F-1)", () => {
    let app: FastifyInstance;
    let data: Awaited<ReturnType<typeof seedTestData>>;

    beforeAll(async () => {
      app = await getTestApp();
      data = await seedTestData(app, "t438b");
      // The shape auto-close writes at 06:00 Berlin: September 2026 closed with a +600min
      // (10h) carry-over into October.
      const bounds = saldoSnapshotPeriodBounds(new Date("2026-09-15T00:00:00.000Z"));
      await app.prisma.saldoSnapshot.create({
        data: {
          employeeId: data.employee.id,
          periodType: "MONTHLY",
          periodStart: bounds.start,
          periodEnd: bounds.end,
          workedMinutes: 0,
          expectedMinutes: 0,
          balanceMinutes: 600,
          carryOver: 600,
          closedAt: new Date("2026-10-01T04:00:00.000Z"),
          closedBy: null,
          superseded: false,
        },
      });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    afterAll(async () => {
      vi.useRealTimers();
      try {
        await cleanupTestData(app, data.tenant.id);
      } catch (err) {
        console.error("Issue #438 describe B cleanup failed:", err);
      }
      await closeTestApp();
    });

    it("B1: an OPEN entry on month-start day does not charge today's Soll (issue #438, F-1)", async () => {
      // The issue's own report timestamp: 2026-10-01T07:29:22Z, ~3.5h after the 06:00 Berlin
      // auto-close cron run.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-01T07:29:22.000Z"));
      await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date("2026-10-01T00:00:00Z"),
          startTime: new Date("2026-10-01T05:00:00.000Z"),
          endTime: null,
          breakMinutes: 0,
          type: "WORK",
          source: "MANUAL",
          isInvalid: false,
          salonId: data.salonId,
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        balanceHours: number;
        confirmedMinutes: number;
        openMonthMinutes: number;
        hasClosedMonth: boolean;
      };
      expect(body.hasClosedMonth).toBe(true);
      expect(body.confirmedMinutes).toBe(600);
      expect(body.openMonthMinutes).toBe(0);
      expect(body.balanceHours).toBeCloseTo(10, 2);
    });

    it("B2 (D-04): the dashboard KPI agrees — no month-start Soll charge (issue #438, F-1)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-01T07:29:22.000Z"));
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/",
        headers: { authorization: `Bearer ${data.empToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        overtime: { balanceHours: number; openMonthMinutes: number };
      };
      expect(body.overtime.balanceHours).toBeCloseTo(10, 2);
      expect(body.overtime.openMonthMinutes).toBe(0);
    });
  });

  // ── Describe C — hire day ────────────────────────────────────────────────────────────────────
  // Planner finding F-1: rangeStart == hireDate == today reproduces the same clamp.
  describe("C — hire day (F-1)", () => {
    let app: FastifyInstance;
    let data: Awaited<ReturnType<typeof seedTestData>>;

    beforeAll(async () => {
      app = await getTestApp();
      data = await seedTestData(app, "t438c");
      await app.prisma.employee.update({
        where: { id: data.employee.id },
        data: { hireDate: new Date("2026-06-10T00:00:00Z") },
      });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    afterAll(async () => {
      vi.useRealTimers();
      try {
        await cleanupTestData(app, data.tenant.id);
      } catch (err) {
        console.error("Issue #438 describe C cleanup failed:", err);
      }
      await closeTestApp();
    });

    it("C1: an OPEN entry on the hire day itself does not charge today's Soll (issue #438, F-1)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-06-10T09:00:00.000Z"));
      await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date("2026-06-10T00:00:00Z"),
          startTime: new Date("2026-06-10T06:00:00.000Z"),
          endTime: null,
          breakMinutes: 0,
          type: "WORK",
          source: "MANUAL",
          isInvalid: false,
          salonId: data.salonId,
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        balanceHours: number;
        openMonthMinutes: number;
        hasClosedMonth: boolean;
      };
      expect(body.balanceHours).toBeCloseTo(0, 2);
      expect(body.openMonthMinutes).toBe(0);
      expect(body.hasClosedMonth).toBe(false);
    });
  });
});
