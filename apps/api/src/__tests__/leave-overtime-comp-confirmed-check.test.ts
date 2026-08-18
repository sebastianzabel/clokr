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
 * suite is immune to the documented UTC-vs-tenant-timezone midnight fixture window.
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { getTestApp, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";

// A single fixed Monday, far from any "today" boundary — the schedule below grants exactly 4h
// on Mondays and 0 on every other weekday, so requesting this ONE day needs exactly 4h.
const REQUEST_MONDAY = "2026-09-07";

describe("POST /leave/requests OVERTIME_COMP — validates against confirmed carry-over, not stale/live balance", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let empToken: string;
  let employeeId: string;

  beforeAll(async () => {
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
    expect(body.error).toBe("Nicht genug Überstunden");
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
      expect(body.error).toBe("Nicht genug Überstunden");
      expect(body.available).toBeCloseTo(0, 5);
    } finally {
      await app.prisma.overtimeAccount.update({
        where: { employeeId },
        data: { balanceHours: 999 },
      });
    }
  });
});
