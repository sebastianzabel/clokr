/**
 * leave-overtime-balance.test.ts
 *
 * Phase 97-06 (SALDO-DISP-01/04/05) — first automated coverage for
 * GET /api/v1/leave/overtime-balance.
 *
 * Before this plan the endpoint served OvertimeAccount.balanceHours directly — the
 * stale, event-driven value 97-CONTEXT names as the wrong source — with NO live
 * recompute at all and no test coverage. This suite pins the source swap onto
 * computeOvertimeBalanceBreakdown (the same live helper GET /overtime/:employeeId
 * already uses) and the reconciliation identity confirmedMinutes + openMonthMinutes
 * === the rounded lifetime balanceHours (in minutes).
 *
 * Time is frozen via vi.setSystemTime to a fixed instant (never the real wall
 * clock), and every calendar boundary is derived through the tenant-timezone
 * helpers (monthRangeUtc / monthDayBounds) rather than a bare UTC Date slice — this
 * file therefore stays green regardless of the real-world hour it runs at,
 * including the documented pre-existing UTC-vs-tenant-timezone midnight fixture
 * window other suites are flagged for
 * (.planning/phases/98-saldo-ketten-integritaetspruefung/deferred-items.md).
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import { monthRangeUtc, monthDayBounds } from "../utils/timezone";

const TZ = "Europe/Berlin";

// Frozen "now" — Thursday, mid-day UTC (well clear of any midnight boundary in any
// timezone). August 13, 2026 has no seeded time entry, so windowEnd resolves to
// "yesterday" (Aug 12) per the established hasTodayEntries convention.
const FROZEN_NOW = new Date("2026-08-13T10:00:00.000Z");
const PRIOR_YEAR = 2026;
const PRIOR_MONTH = 7; // July 2026 — the CLOSED month whose SaldoSnapshot seeds "Bestätigt"
const SEEDED_CARRY_OVER = 240; // +4:00 — the confirmed figure this test pins
const DIVERGENT_STORED_BALANCE = 999; // deliberately absurd — proves the source swap

// Open-month (August 2026) worked weekdays, each 9h netto (1h over the 8h contract
// target) — gives the live computation a genuine, non-trivial open-month
// contribution to reconcile against. All fall before the frozen "today" (Aug 13).
const OPEN_MONTH_WORKDAYS = ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-10", "2026-08-11"];

describe("GET /api/v1/leave/overtime-balance (Phase 97-06)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "ovb");

    // Closed prior month (July 2026): a non-superseded MONTHLY snapshot with a
    // non-zero carryOver — this is "Bestätigt", read by confirmed-saldo.ts's
    // getConfirmedCarryOver from the active SaldoSnapshot chain end.
    const { start: priorStart, end: priorEnd } = monthRangeUtc(PRIOR_YEAR, PRIOR_MONTH, TZ);
    const { lastDay: priorLastDay } = monthDayBounds(priorStart, priorEnd, TZ);
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: data.employee.id,
        periodType: "MONTHLY",
        periodStart: priorStart,
        periodEnd: priorLastDay,
        workedMinutes: 9120,
        expectedMinutes: 8880,
        balanceMinutes: 0,
        carryOver: SEEDED_CARRY_OVER,
        closedAt: new Date("2026-08-01T06:00:00Z"),
        superseded: false,
      },
    });

    // Open-month activity for the current (August) partial month.
    for (const d of OPEN_MONTH_WORKDAYS) {
      await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date(d + "T00:00:00Z"),
          startTime: new Date(d + "T07:00:00Z"),
          endTime: new Date(d + "T16:30:00Z"),
          breakMinutes: 30,
          type: "WORK",
        },
      });
    }

    // Deliberately divergent stored balance — the endpoint must NOT echo this back;
    // it pins that the source really did move from OvertimeAccount.balanceHours to
    // the live computeOvertimeBalanceBreakdown value.
    await app.prisma.overtimeAccount.update({
      where: { employeeId: data.employee.id },
      data: { balanceHours: DIVERGENT_STORED_BALANCE },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("serves the live balanceHours + split fields, never the stale stored value, and reconciles confirmed+open==total", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FROZEN_NOW);
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/leave/overtime-balance",
        headers: { authorization: `Bearer ${data.empToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      // "Bestätigt" — read straight from the seeded SaldoSnapshot carry-over.
      expect(body.confirmedMinutes).toBe(SEEDED_CARRY_OVER);
      expect(body.hasClosedMonth).toBe(true);
      expect(typeof body.openMonthMinutes).toBe("number");

      // Reconciliation identity: confirmed + open === the SAME rounding the route
      // applies to balanceHours (2-decimal hours -> minutes). This is what proves
      // openMonthMinutes was derived by subtraction, not a second computation path.
      const totalMinutesFromBalance = Math.round(body.balanceHours * 60);
      expect(body.confirmedMinutes + body.openMonthMinutes).toBe(totalMinutesFromBalance);

      // The source-swap pin: no longer the deliberately divergent stored value —
      // would fail if a future edit reverted this endpoint back to the stored read.
      expect(body.balanceHours).not.toBe(DIVERGENT_STORED_BALANCE);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports confirmedMinutes 0 and hasClosedMonth false for an employee with no closed month yet", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FROZEN_NOW);
    try {
      // The admin employee from seedTestData has a WorkSchedule + OvertimeAccount
      // but (deliberately, in this suite) no SaldoSnapshot at all — a "new hire,
      // never closed a month" fixture without needing a third seeded employee.
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/leave/overtime-balance",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.confirmedMinutes).toBe(0);
      expect(body.hasClosedMonth).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Phase 100 (OTC-03) — maxNegativeBalanceMinutes / isNegativeLimitExceeded ──
  // Each case mutates the shared employee's SaldoSnapshot.carryOver (to control
  // confirmedMinutes precisely) and/or the shared tenant's TenantConfig, then resets both in
  // a finally block — mirrors the set/reset idiom already used by
  // leave-overtime-comp-confirmed-check.test.ts.
  describe("maxNegativeBalanceMinutes / isNegativeLimitExceeded (Phase 100)", () => {
    async function setConfirmedMinutes(minutes: number) {
      await app.prisma.saldoSnapshot.updateMany({
        where: { employeeId: data.employee.id },
        data: { carryOver: minutes },
      });
    }
    async function setTolerance(minutes: number | null) {
      await app.prisma.tenantConfig.update({
        where: { tenantId: data.tenant.id },
        data: { maxNegativeBalanceMinutes: minutes },
      });
    }

    afterEach(async () => {
      // Reset to the outer beforeAll's fixture values so later tests in this file are unaffected.
      await setConfirmedMinutes(SEEDED_CARRY_OVER);
      await setTolerance(null);
    });

    it("isNegativeLimitExceeded is true when the confirmed balance is more negative than the configured tolerance", async () => {
      await setTolerance(600); // +10:00 tolerance
      await setConfirmedMinutes(-900); // -15:00 confirmed, past the tolerance
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const res = await app.inject({
          method: "GET",
          url: "/api/v1/leave/overtime-balance",
          headers: { authorization: `Bearer ${data.empToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.maxNegativeBalanceMinutes).toBe(600);
        expect(body.isNegativeLimitExceeded).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("isNegativeLimitExceeded is false when the confirmed balance stays within the configured tolerance", async () => {
      await setTolerance(600); // +10:00 tolerance
      await setConfirmedMinutes(-300); // -5:00 confirmed, still within the tolerance
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const res = await app.inject({
          method: "GET",
          url: "/api/v1/leave/overtime-balance",
          headers: { authorization: `Bearer ${data.empToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.maxNegativeBalanceMinutes).toBe(600);
        expect(body.isNegativeLimitExceeded).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("isNegativeLimitExceeded is always false with no tolerance configured, even for a deeply negative confirmed balance", async () => {
      await setTolerance(null);
      await setConfirmedMinutes(-900); // -15:00 confirmed — still no warning without a limit (D-00b)
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const res = await app.inject({
          method: "GET",
          url: "/api/v1/leave/overtime-balance",
          headers: { authorization: `Bearer ${data.empToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.maxNegativeBalanceMinutes).toBeNull();
        expect(body.isNegativeLimitExceeded).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("both new fields are present (never absent/undefined) on the fail-safe branch", async () => {
      await setTolerance(600);
      // Forces computeOvertimeBalanceBreakdown's OWN internal saldoSnapshot.findFirst call to
      // reject exactly once — the route's outer catch then takes the fail-safe branch. The
      // fallback's own getConfirmedCarryOver call is a SEPARATE, un-mocked saldoSnapshot.findFirst
      // invocation, so it succeeds normally (same idiom as
      // leave-overtime-comp-confirmed-check.test.ts's compute-failure cases).
      vi.spyOn(app.prisma.saldoSnapshot, "findFirst").mockRejectedValueOnce(
        new Error("simulated DB failure"),
      );
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const res = await app.inject({
          method: "GET",
          url: "/api/v1/leave/overtime-balance",
          headers: { authorization: `Bearer ${data.empToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.maxNegativeBalanceMinutes).toBe(600);
        expect(typeof body.isNegativeLimitExceeded).toBe("boolean");
      } finally {
        vi.useRealTimers();
        vi.restoreAllMocks();
      }
    });

    it("IN-01 (code review): isNegativeLimitExceeded is false — never a stale tautology — on the DEEPEST fail-safe branch, when the confirmed-carry-over fallback ALSO fails", async () => {
      await setTolerance(600); // +10:00 tolerance — configuredMinutes is non-null here. The OLD
      // expression (`configuredMinutes != null && 0 < -configuredMinutes`) and the fixed explicit
      // `false` evaluate identically in every case (the old one was provably always false, per
      // Zod's `.min(0)` on configuredMinutes) — this test pins the CORRECT value on the branch the
      // old code never expressed the real intent for, it is not a behavior change.
      //
      // Reject EVERY saldoSnapshot.findFirst call (never "Once", unlike the test above) so BOTH
      // computeOvertimeBalanceBreakdown's internal call AND the fallback's OWN getConfirmedCarryOver
      // call fail — forcing the route past its outer catch (breakdown stays null) AND into the
      // inner `catch (fallbackErr)` block (leave.ts, the deepest fail-safe branch).
      vi.spyOn(app.prisma.saldoSnapshot, "findFirst").mockRejectedValue(
        new Error("simulated DB failure — both compute and fallback"),
      );
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const res = await app.inject({
          method: "GET",
          url: "/api/v1/leave/overtime-balance",
          headers: { authorization: `Bearer ${data.empToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        // hasClosedMonth: false + confirmedMinutes: 0 confirm we actually reached the deepest
        // branch (leave.ts's `catch (fallbackErr)`), not the shallower fail-safe return above it.
        expect(body.confirmedMinutes).toBe(0);
        expect(body.hasClosedMonth).toBe(false);
        expect(body.maxNegativeBalanceMinutes).toBe(600);
        expect(body.isNegativeLimitExceeded).toBe(false);
      } finally {
        vi.useRealTimers();
        vi.restoreAllMocks();
      }
    });
  });
});
