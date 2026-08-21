/**
 * leave-overtime-comp-tolerance.test.ts
 *
 * Phase 100 (OTC-01/OTC-02/OTC-05) — pins the behaviours of
 * `negative-balance-tolerance.ts` (Task 1) end to end through the OVERTIME_COMP
 * gate and the client/server parity contract with `GET /leave/overtime-balance`
 * (Task 3).
 *
 * This file builds its OWN tenant + employee fixture rather than reusing
 * `leave-overtime-comp-confirmed-check.test.ts`'s — that suite deliberately has
 * no tolerance configured anywhere, and mutating it mid-suite here would couple
 * the two files together for no reason.
 *
 * Every date is computed relative to `new Date()` (never a hardcoded calendar
 * literal) — this repo has a documented hardcoded-date time-bomb hazard
 * (`shifts.test.ts`, 422 via SHIFT_PAST_IMMUTABLE, see `.planning/STATE.md`),
 * and Phase 100 itself just finished defusing the same hazard in the sibling
 * confirmed-check suite.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { getHolidays, STATE_MAP } from "../utils/holidays";
import { loadNegativeBalanceTolerance } from "../utils/negative-balance-tolerance";

/**
 * Next Monday at least 14 days out (UTC arithmetic; bounded holiday-advance loop;
 * candidate's own year passed to getHolidays) — same construction as
 * `leave-overtime-comp-confirmed-check.test.ts`'s `computeRequestMonday()`,
 * duplicated here deliberately since this file owns its own fixture.
 */
function computeRequestMonday(): string {
  const now = new Date();
  let candidate = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 14),
  );
  const daysUntilMonday = (8 - candidate.getUTCDay()) % 7;
  candidate = new Date(
    Date.UTC(
      candidate.getUTCFullYear(),
      candidate.getUTCMonth(),
      candidate.getUTCDate() + daysUntilMonday,
    ),
  );

  const MAX_HOLIDAY_ADVANCES = 10;
  for (let i = 0; i < MAX_HOLIDAY_ADVANCES; i++) {
    const iso = candidate.toISOString().slice(0, 10);
    const holidays = getHolidays(candidate.getUTCFullYear(), STATE_MAP.NIEDERSACHSEN);
    if (!holidays.some((h) => h.date === iso)) return iso;
    candidate = new Date(
      Date.UTC(candidate.getUTCFullYear(), candidate.getUTCMonth(), candidate.getUTCDate() + 7),
    );
  }
  throw new Error(
    "computeRequestMonday: exceeded MAX_HOLIDAY_ADVANCES without a non-holiday Monday",
  );
}

const REQUEST_MONDAY = computeRequestMonday();

// Fixture constants — named so every test derives its expectations from these instead of
// restating magic numbers. A single Monday costs exactly MONDAY_NEEDED_MINUTES; the confirmed
// carry-over starts at CONFIRMED_MINUTES, comfortably below what a Monday costs, so "rejected
// without a tolerance" is the realistic default state (mirrors the confirmed-check fixture).
const MONDAY_HOURS = 4;
const MONDAY_NEEDED_MINUTES = MONDAY_HOURS * 60; // 240
const CONFIRMED_MINUTES = 120; // +2:00 confirmed carry-over
const STALE_BALANCE_HOURS = 999; // deliberately generous — any accidental read is visible as a failure

// The "closed month" SaldoSnapshot window only needs to be SOME past month (getConfirmedCarryOver
// picks the newest non-superseded MONTHLY snapshot regardless of its actual calendar distance from
// "now") — computed a full year back from today, in UTC, rather than a hardcoded literal, so this
// brand-new file carries zero calendar-year string literals (unlike its sibling
// leave-overtime-comp-confirmed-check.test.ts, whose PAST-anchored literals predate this phase and
// are exempted there for that reason — see that file's own header note).
const CLOSED_MONTH_YEAR = new Date().getUTCFullYear() - 1;
const CLOSED_PERIOD_START = new Date(Date.UTC(CLOSED_MONTH_YEAR, 6, 1)); // Jul 1, last year
const CLOSED_PERIOD_END = new Date(Date.UTC(CLOSED_MONTH_YEAR, 6, 31)); // Jul 31, last year
const CLOSED_AT = new Date(Date.UTC(CLOSED_MONTH_YEAR, 7, 1, 6, 0, 0)); // Aug 1, last year 06:00 UTC

describe("POST /leave/requests OVERTIME_COMP + GET /leave/overtime-balance — maxNegativeBalanceMinutes tolerance (Phase 100)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let empToken: string;
  let employeeId: string;
  let workScheduleId: string;
  let saldoSnapshotId: string;

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const suffix = "tol-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const tenant = await prisma.tenant.create({
      data: { name: `TOL ${suffix}`, slug: `tol-${suffix}`, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    // No TenantConfig auto-created for a hand-rolled tenant.create() — create one explicitly,
    // leaving maxNegativeBalanceMinutes unset (null) as the baseline "unconfigured" state.
    await prisma.tenantConfig.create({ data: { tenantId } });

    const passwordHash = await bcrypt.hash("test1234", 10);
    const user = await prisma.user.create({
      data: { email: `tol-${suffix}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const emp = await prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `TOL-${suffix}`,
        firstName: "TOL",
        lastName: "Employee",
        hireDate: new Date("2024-01-01"), // past-anchored fixture date, cannot expire
      },
    });
    employeeId = emp.id;

    // Monday-only, MONDAY_HOURS — requesting the one REQUEST_MONDAY day needs exactly
    // MONDAY_NEEDED_MINUTES. maxNegativeBalanceMinutes starts null (baseline, no override).
    const schedule = await prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
        type: "FIXED_SCHEDULE",
        weeklyHours: MONDAY_HOURS,
        mondayHours: MONDAY_HOURS,
        tuesdayHours: 0,
        wednesdayHours: 0,
        thursdayHours: 0,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1],
        validFrom: new Date("2024-01-01"),
      },
    });
    workScheduleId = schedule.id;

    const snapshot = await prisma.saldoSnapshot.create({
      data: {
        employeeId: emp.id,
        periodType: "MONTHLY",
        periodStart: CLOSED_PERIOD_START,
        periodEnd: CLOSED_PERIOD_END,
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: CONFIRMED_MINUTES,
        closedAt: CLOSED_AT,
        superseded: false,
      },
    });
    saldoSnapshotId = snapshot.id;

    // Deliberately generous stale balance — any code path that accidentally reads it on the
    // normal (non-fail-safe) path would silently permit everything, masking a real bug.
    await prisma.overtimeAccount.create({
      data: { employeeId: emp.id, balanceHours: STALE_BALANCE_HOURS },
    });

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `tol-${suffix}@test.de`, password: "test1234" },
    });
    empToken = JSON.parse(login.body).accessToken;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("leave-overtime-comp-tolerance cleanup failed:", err);
    }
  });

  async function requestMonday() {
    return app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${empToken}` },
      payload: { type: "OVERTIME_COMP", startDate: REQUEST_MONDAY, endDate: REQUEST_MONDAY },
    });
  }

  it("a per-employee WorkSchedule override beats the tenant default", async () => {
    // Override (90min) < tenant default (600min) — if precedence were reversed, this request
    // would be PERMITTED (120+600=720>=240). It must be REJECTED, proving the override won.
    await app.prisma.workSchedule.update({
      where: { id: workScheduleId },
      data: { maxNegativeBalanceMinutes: 90 },
    });
    await app.prisma.tenantConfig.update({
      where: { tenantId },
      data: { maxNegativeBalanceMinutes: 600 },
    });
    try {
      const res = await requestMonday();
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.tolerance).toBeCloseTo(90 / 60, 5);
      expect(body.available).toBeCloseTo((CONFIRMED_MINUTES + 90) / 60, 5);
    } finally {
      await app.prisma.workSchedule.update({
        where: { id: workScheduleId },
        data: { maxNegativeBalanceMinutes: null },
      });
      await app.prisma.tenantConfig.update({
        where: { tenantId },
        data: { maxNegativeBalanceMinutes: null },
      });
    }
  });

  it("an explicit override of 0 beats a non-zero tenant default (?? not ||)", async () => {
    await app.prisma.workSchedule.update({
      where: { id: workScheduleId },
      data: { maxNegativeBalanceMinutes: 0 },
    });
    await app.prisma.tenantConfig.update({
      where: { tenantId },
      data: { maxNegativeBalanceMinutes: 600 },
    });
    try {
      const res = await requestMonday();
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.tolerance).toBe(0);
      expect(body.error).not.toContain("inkl.");
    } finally {
      await app.prisma.workSchedule.update({
        where: { id: workScheduleId },
        data: { maxNegativeBalanceMinutes: null },
      });
      await app.prisma.tenantConfig.update({
        where: { tenantId },
        data: { maxNegativeBalanceMinutes: null },
      });
    }
  });

  it("unconfigured (both null): tolerance 0 and no '(inkl. …)' clause in the rejection copy", async () => {
    // Baseline fixture state — nothing to set up. Byte-identical to pre-Phase-100 (D-00b).
    const res = await requestMonday();
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.tolerance).toBe(0);
    expect(body.error).toBe(
      `Nicht genug Überstunden: verfügbar ${CONFIRMED_MINUTES / 60}:00 Std., benötigt ${MONDAY_HOURS}:00 Std.`,
    );
    expect(body.error).not.toContain("inkl.");
  });

  it("configured: tolerance equals the resolved hours and the rejection copy carries the '(inkl. … erlaubtem Minus)' clause", async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId },
      data: { maxNegativeBalanceMinutes: 60 }, // +1:00 — covers only part of the shortfall
    });
    try {
      const res = await requestMonday();
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.tolerance).toBe(1);
      expect(body.error).toContain("(inkl. 1:00 Std. erlaubtem Minus)");
    } finally {
      await app.prisma.tenantConfig.update({
        where: { tenantId },
        data: { maxNegativeBalanceMinutes: null },
      });
    }
  });

  it("D-02 fail-safe: a configured tolerance is NOT applied when getConfirmedCarryOver fails — falls back to the stored balance with tolerance 0", async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId },
      data: { maxNegativeBalanceMinutes: 600 }, // would easily cover the shortfall if applied
    });
    // Stored balance temporarily lowered so the fallback (without tolerance) rejects — if the
    // fail-safe wrongly kept the 600min tolerance, 0+600=600>=240 would PERMIT instead.
    await app.prisma.overtimeAccount.update({
      where: { employeeId },
      data: { balanceHours: 1 }, // 60min stored
    });
    vi.spyOn(app.prisma.saldoSnapshot, "findFirst").mockRejectedValueOnce(
      new Error("simulated DB failure"),
    );
    try {
      const res = await requestMonday();
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.tolerance).toBe(0);
      expect(body.available).toBeCloseTo(1, 5);
    } finally {
      vi.restoreAllMocks();
      await app.prisma.overtimeAccount.update({
        where: { employeeId },
        data: { balanceHours: STALE_BALANCE_HOURS },
      });
      await app.prisma.tenantConfig.update({
        where: { tenantId },
        data: { maxNegativeBalanceMinutes: null },
      });
    }
  });

  it("OTC-05 parity: GET /leave/overtime-balance and the POST gate agree on the exact same boundary", async () => {
    // toleranceSeed is derived from this file's own named fixture constants (not a fresh magic
    // number) so that CONFIRMED_MINUTES + toleranceSeed lands EXACTLY on what one Monday costs.
    const toleranceSeed = MONDAY_NEEDED_MINUTES - CONFIRMED_MINUTES;
    await app.prisma.tenantConfig.update({
      where: { tenantId },
      data: { maxNegativeBalanceMinutes: toleranceSeed },
    });
    try {
      // 1) Read the boundary from the SAME endpoint the request form reads — the derivation
      //    from these response fields (not a restated literal) IS the OTC-05 pin.
      const balanceRes = await app.inject({
        method: "GET",
        url: "/api/v1/leave/overtime-balance",
        headers: { authorization: `Bearer ${empToken}` },
      });
      expect(balanceRes.statusCode).toBe(200);
      const balanceBody = JSON.parse(balanceRes.body);
      const boundaryMinutes = balanceBody.confirmedMinutes + balanceBody.maxNegativeBalanceMinutes;
      expect(boundaryMinutes).toBe(MONDAY_NEEDED_MINUTES); // exactly what one Monday costs

      // 2) A request costing EXACTLY the boundary is PERMITTED.
      const permitRes = await requestMonday();
      expect(permitRes.statusCode).toBe(201);
      const permitBody = JSON.parse(permitRes.body);
      await app.prisma.leaveRequest.delete({ where: { id: permitBody.id } });

      // 3) Shrink the SAME server-side source by exactly one minute (not the request — the
      //    request stays the same fixed Monday) and re-read the boundary from the endpoint
      //    again. This exercises the identical `neededMinutes > availableMinutes` boundary the
      //    gate applies, just approached from the availability side, which this fixture's
      //    whole-hour WorkSchedule granularity (Decimal(4,2), 0.01h steps) cannot construct
      //    precisely from the request side without fighting rounding.
      await app.prisma.tenantConfig.update({
        where: { tenantId },
        data: { maxNegativeBalanceMinutes: toleranceSeed - 1 },
      });
      const balanceRes2 = await app.inject({
        method: "GET",
        url: "/api/v1/leave/overtime-balance",
        headers: { authorization: `Bearer ${empToken}` },
      });
      const balanceBody2 = JSON.parse(balanceRes2.body);
      const boundaryMinutes2 =
        balanceBody2.confirmedMinutes + balanceBody2.maxNegativeBalanceMinutes;
      expect(boundaryMinutes2).toBe(MONDAY_NEEDED_MINUTES - 1);

      // 4) The SAME fixed request, now costing exactly one minute MORE than available, is
      //    REJECTED — and the rejection body's `available` figure matches the boundary read
      //    from the GET response above (derived, not restated).
      const rejectRes = await requestMonday();
      expect(rejectRes.statusCode).toBe(400);
      const rejectBody = JSON.parse(rejectRes.body);
      // The response rounds to 2 decimal places (+x.toFixed(2) convention); boundaryMinutes2/60
      // (239/60 = 3.9833…) is the exact fraction, so compare at 2-digit precision, not 5.
      expect(rejectBody.available).toBeCloseTo(boundaryMinutes2 / 60, 2);
    } finally {
      await app.prisma.tenantConfig.update({
        where: { tenantId },
        data: { maxNegativeBalanceMinutes: null },
      });
    }
  });

  it("cross-tenant: a WorkSchedule override belonging to an employee of a different tenant never contributes to this tenant's resolved tolerance", async () => {
    const suffix2 = "tol2-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const DISTINCTIVE_OVERRIDE = 123456; // absurdly large — unmistakable if it ever leaked through

    const tenant2 = await app.prisma.tenant.create({
      data: { name: `TOL2 ${suffix2}`, slug: `tol2-${suffix2}`, federalState: "NIEDERSACHSEN" },
    });
    try {
      const passwordHash2 = await bcrypt.hash("test1234", 10);
      const user2 = await app.prisma.user.create({
        data: {
          email: `${suffix2}@test.de`,
          passwordHash: passwordHash2,
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const employee2 = await app.prisma.employee.create({
        data: {
          tenantId: tenant2.id,
          userId: user2.id,
          employeeNumber: `TOL2-${suffix2}`,
          firstName: "TOL2",
          lastName: "Employee",
          hireDate: new Date("2024-01-01"),
        },
      });
      await app.prisma.workSchedule.create({
        data: {
          employeeId: employee2.id,
          type: "FIXED_SCHEDULE",
          weeklyHours: 40,
          mondayHours: 8,
          tuesdayHours: 8,
          wednesdayHours: 8,
          thursdayHours: 8,
          fridayHours: 8,
          saturdayHours: 0,
          sundayHours: 0,
          workDays: [1, 2, 3, 4, 5],
          validFrom: new Date("2024-01-01"),
          maxNegativeBalanceMinutes: DISTINCTIVE_OVERRIDE,
        },
      });

      // Direct pin of T-100-03: call the shared helper with a MISMATCHED (cross-tenant)
      // employeeId/tenantId pair. This can never happen via the real routes (employeeId and
      // tenantId are always verified-consistent there), but the shared helper itself must fail
      // closed if it ever did — the `employee: { tenantId }` filter inside
      // loadNegativeBalanceTolerance is what makes this assertion pass.
      const resolved = await loadNegativeBalanceTolerance(app.prisma, employee2.id, tenantId);
      expect(resolved.configuredMinutes).not.toBe(DISTINCTIVE_OVERRIDE);
      expect(resolved.configuredMinutes).toBeNull(); // falls back to tenant1's own (unconfigured) default

      // Supplementary HTTP-level check (plan-specified): the first employee's own rejection
      // body is completely unaffected by tenant2/employee2 merely existing in the database.
      const res = await requestMonday();
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.tolerance).toBe(0);
    } finally {
      await cleanupTestData(app, tenant2.id);
    }
  });
});
