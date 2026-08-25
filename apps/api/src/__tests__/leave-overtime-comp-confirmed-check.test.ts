/**
 * leave-overtime-comp-confirmed-check.test.ts
 *
 * Code review (owner) — POST /leave/requests' OVERTIME_COMP validation used to read
 * OvertimeAccount.balanceHours directly: the same stale, event-driven source 97-CONTEXT names
 * as wrong (v1.8.24 already overrides it at read time everywhere else), and — worse for a WRITE
 * path — the LIVE total (confirmed carry-over + open-month forecast), while the leave form's own
 * affordability UI (97-06) already validates against the CONFIRMED (closed-month) figure only,
 * via getConfirmedCarryOver / GET /leave/overtime-balance. A request could therefore be approved
 * against overtime that was still just a forecast and could erode before month-close.
 *
 * This suite pins the server-side fix onto the SAME source the UI uses (getConfirmedCarryOver),
 * with three required cases: allowed strictly within the confirmed figure, rejected beyond it
 * (even when the stale stored balance would have allowed more), and the compute-failure
 * fail-safe (never 500s, never silently permits an unbounded request).
 *
 * No frozen-time dependency: the OVERTIME_COMP balance check does not read "now" at all (it only
 * compares getScheduledHours for the requested range against getConfirmedCarryOver), so this
 * suite is immune to the documented UTC-vs-tenant-timezone midnight fixture window. That
 * statement is about the BALANCE CHECK only, though — the ROUTE around it (POST /leave/requests)
 * DOES validate the requested date against "today" elsewhere (lead-time / max-advance checks),
 * which is exactly why REQUEST_MONDAY below is computed rather than a fixed literal: a reader
 * must not conclude from this paragraph that a hardcoded future date was ever safe.
 *
 * Phase 100 (OTC-01/OTC-02/OTC-06) note: the two `expect(body.error).toBe("Nicht genug
 * Überstunden")` exact-match assertions this file used to carry are gone by design — Phase 100
 * enriches that string with the applied tolerance (see negative-balance-tolerance.ts /
 * format-hm.ts), and a `tolerance` field was added to the same response body. This is planned,
 * copy-driven test maintenance, not a regression. The same phase also converted REQUEST_MONDAY
 * from a hardcoded literal (`"2026-09-07"`) to the computed, holiday-checked value below — this
 * file previously carried the exact hardcoded-date time-bomb hazard already on record for
 * `shifts.test.ts` (422 via SHIFT_PAST_IMMUTABLE, see `.planning/STATE.md`): once "today" passed
 * the literal, every case here would have started posting a PAST-dated leave request and failed
 * for a reason unrelated to what it tests.
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { getTestApp, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { getHolidays, STATE_MAP } from "../utils/holidays";

/**
 * Computes the next Monday at least 14 days out from "now" (UTC arithmetic, so the produced
 * "YYYY-MM-DD" string is identical regardless of the runner's own timezone), advanced past any
 * NI (Niedersachsen — this file's fixture tenant's federalState) public holiday in a BOUNDED
 * loop.
 *
 * A single-shot retry is not enough: `1. Weihnachtstag` (25 Dec) and `Neujahr` (1 Jan) are
 * exactly 7 days apart, so in a year where 25 Dec falls on a Monday, one +7 advance lands
 * squarely on the other holiday. getHolidays() is called with the CANDIDATE Monday's own year,
 * not "today"'s year — those differ across a Dec→Jan boundary, and checking a January candidate
 * against the wrong year's holiday list would miss Neujahr (a holiday every year).
 *
 * getScheduledHours subtracts holidays, so an un-checked holiday Monday would silently cost 0h
 * and invert every assertion in this file.
 */
function computeRequestMonday(): string {
  const now = new Date();
  let candidate = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 14),
  );
  // Advance to the next Monday on/after the +14-days candidate (getUTCDay: 0=Sun..6=Sat).
  const daysUntilMonday = (8 - candidate.getUTCDay()) % 7;
  candidate = new Date(
    Date.UTC(
      candidate.getUTCFullYear(),
      candidate.getUTCMonth(),
      candidate.getUTCDate() + daysUntilMonday,
    ),
  );

  const MAX_HOLIDAY_ADVANCES = 10; // bounded loop, not a single retry — see docblock above
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

// A Monday, computed dynamically and holiday-checked (see computeRequestMonday above) — the
// schedule below grants exactly 4h on Mondays and 0 on every other weekday, so requesting this
// ONE day needs exactly 4h.
const REQUEST_MONDAY = computeRequestMonday();

describe("POST /leave/requests OVERTIME_COMP — validates against confirmed carry-over, not stale/live balance", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let empToken: string;
  let employeeId: string;

  beforeAll(async () => {
    // Phase 100 — self-verifying guard for REQUEST_MONDAY (see computeRequestMonday()'s own
    // docblock above): assert the invariant rather than merely trusting the computation.
    const requestDate = new Date(REQUEST_MONDAY + "T00:00:00Z");
    expect(requestDate.getUTCDay()).toBe(1); // Monday
    const today = new Date();
    const todayUtcMidnight = Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate(),
    );
    const requestUtcMidnight = Date.UTC(
      requestDate.getUTCFullYear(),
      requestDate.getUTCMonth(),
      requestDate.getUTCDate(),
    );
    const daysOut = Math.round((requestUtcMidnight - todayUtcMidnight) / (24 * 60 * 60 * 1000));
    expect(daysOut).toBeGreaterThanOrEqual(14);
    const requestYearHolidays = getHolidays(requestDate.getUTCFullYear(), STATE_MAP.NIEDERSACHSEN);
    expect(requestYearHolidays.some((h) => h.date === REQUEST_MONDAY)).toBe(false);

    app = await getTestApp();
    const prisma = app.prisma;
    const suffix = "occ-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const tenant = await prisma.tenant.create({
      data: { name: `OCC ${suffix}`, slug: `occ-${suffix}`, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    const passwordHash = await bcrypt.hash("test1234", 10);

    const user = await prisma.user.create({
      data: { email: `occ-${suffix}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    // hireDate/validFrom/periodStart/periodEnd/closedAt below are PAST-anchored fixture dates —
    // they can never expire (only FORWARD-dated literals, like the old REQUEST_MONDAY, are time
    // bombs) — see the file header for why REQUEST_MONDAY itself is computed instead.
    const emp = await prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `OCC-${suffix}`,
        firstName: "OCC",
        lastName: "Employee",
        hireDate: new Date("2024-01-01"),
      },
    });
    employeeId = emp.id;

    // Monday-only, 4h — requesting the one REQUEST_MONDAY day needs exactly 4h.
    await prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
        type: "FIXED_SCHEDULE",
        weeklyHours: 4,
        mondayHours: 4,
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

    // Confirmed carry-over (closed month) = +2:00 (120 min) — LESS than the 4h a Monday costs,
    // so the "rejected beyond confirmed" case below is the realistic default state.
    await prisma.saldoSnapshot.create({
      data: {
        employeeId: emp.id,
        periodType: "MONTHLY",
        periodStart: new Date("2026-07-01T00:00:00Z"),
        periodEnd: new Date("2026-07-31T00:00:00Z"),
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 120, // +2:00 confirmed
        closedAt: new Date("2026-08-01T06:00:00Z"),
        superseded: false,
      },
    });

    // Deliberately divergent, deliberately LARGER stored balance — proves the check no longer
    // reads this source at all (a pre-fix server would have approved a 4h request against it).
    await prisma.overtimeAccount.create({
      data: { employeeId: emp.id, balanceHours: 999 },
    });

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `occ-${suffix}@test.de`, password: "test1234" },
    });
    empToken = JSON.parse(login.body).accessToken;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("leave-overtime-comp-confirmed-check cleanup failed:", err);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects a request beyond the confirmed carry-over, even though the stale stored balance (999h) would have allowed it", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${empToken}` },
      payload: {
        type: "OVERTIME_COMP",
        startDate: REQUEST_MONDAY,
        endDate: REQUEST_MONDAY,
      },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    // Phase 100: full exact-string pin. This is the ONE place in this file (and its Task 2
    // sibling, leave-overtime-comp-tolerance.test.ts) that hardcodes the whole rejection
    // template — every other assertion site below uses .toContain so a future copy tweak only
    // needs updating here, in one place, instead of four.
    expect(body.error).toBe("Nicht genug Überstunden: verfügbar 2:00 Std., benötigt 4:00 Std.");
    expect(body.tolerance).toBe(0); // no tolerance configured anywhere in this fixture (D-00b)
    // available must reflect the CONFIRMED figure (2h), never the stale 999h stored balance —
    // this is the actual source-swap pin.
    expect(body.available).toBeCloseTo(2, 5);
    expect(body.requested).toBeCloseTo(4, 5);
  });

  it("allows a request strictly within the confirmed carry-over", async () => {
    // Bump the confirmed figure above the 4h the Monday costs (replace, not add, so this test
    // is independent of the previous one's fixture value).
    await app.prisma.saldoSnapshot.updateMany({
      where: { employeeId },
      data: { carryOver: 300 }, // +5:00 confirmed — comfortably above the 4h needed
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${empToken}` },
        payload: {
          type: "OVERTIME_COMP",
          startDate: REQUEST_MONDAY,
          endDate: REQUEST_MONDAY,
        },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.typeCode).toBe("OVERTIME_COMP");

      // Clean up the request this test created so it doesn't collide with siblings that
      // re-request the same day (overlap guards elsewhere in this route).
      await app.prisma.leaveRequest.delete({ where: { id: body.id } });
    } finally {
      await app.prisma.saldoSnapshot.updateMany({
        where: { employeeId },
        data: { carryOver: 120 },
      });
    }
  });

  it("compute-failure fail-safe: falls back to the stored balance, permits when the stored balance covers it (never 500s)", async () => {
    vi.spyOn(app.prisma.saldoSnapshot, "findFirst").mockRejectedValueOnce(
      new Error("simulated DB failure"),
    );
    // Stored balance temporarily raised to comfortably cover the 4h request, so this test
    // isolates "does the fallback engage and permit correctly" from the rejection case below.
    await app.prisma.overtimeAccount.update({
      where: { employeeId },
      data: { balanceHours: 10 },
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${empToken}` },
        payload: {
          type: "OVERTIME_COMP",
          startDate: REQUEST_MONDAY,
          endDate: REQUEST_MONDAY,
        },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      await app.prisma.leaveRequest.delete({ where: { id: body.id } });
    } finally {
      await app.prisma.overtimeAccount.update({
        where: { employeeId },
        data: { balanceHours: 999 },
      });
    }
  });

  it("compute-failure fail-safe: falls back to the stored balance, still REJECTS when the stored balance is insufficient (never silently permits)", async () => {
    vi.spyOn(app.prisma.saldoSnapshot, "findFirst").mockRejectedValueOnce(
      new Error("simulated DB failure"),
    );
    await app.prisma.overtimeAccount.update({
      where: { employeeId },
      data: { balanceHours: 0 },
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${empToken}` },
        payload: {
          type: "OVERTIME_COMP",
          startDate: REQUEST_MONDAY,
          endDate: REQUEST_MONDAY,
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toContain("Nicht genug Überstunden");
      expect(body.tolerance).toBe(0); // D-02: fail-safe applies ZERO tolerance, never more
      expect(body.available).toBeCloseTo(0, 5);
    } finally {
      await app.prisma.overtimeAccount.update({
        where: { employeeId },
        data: { balanceHours: 999 },
      });
    }
  });

  it("Phase 100 tracer: a configured tenant-level tolerance permits the exact request the first test proves is rejected without one", async () => {
    // A tenant-level maxNegativeBalanceMinutes high enough to cover the 2h shortfall (confirmed
    // 120min, needed 240min -> shortfall 120min) that the first test in this file proves is
    // rejected without it. No TenantConfig row exists yet for this ad-hoc test tenant (this file
    // builds its own fixture by hand, unlike seedTestData()) — create one, then remove it,
    // mirroring the saldoSnapshot.updateMany set/reset idiom used above in this file.
    await app.prisma.tenantConfig.create({
      data: { tenantId, maxNegativeBalanceMinutes: 600 }, // +10:00 tolerance
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${empToken}` },
        payload: {
          type: "OVERTIME_COMP",
          startDate: REQUEST_MONDAY,
          endDate: REQUEST_MONDAY,
        },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.typeCode).toBe("OVERTIME_COMP");

      // Clean up the request this test created so it doesn't collide with siblings that
      // re-request the same day (overlap guards elsewhere in this route).
      await app.prisma.leaveRequest.delete({ where: { id: body.id } });
    } finally {
      await app.prisma.tenantConfig.deleteMany({ where: { tenantId } });
    }
  });
});
