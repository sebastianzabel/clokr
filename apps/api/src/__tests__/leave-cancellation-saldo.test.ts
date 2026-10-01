/**
 * Issue #446 (finding G2, D-01/D-02/D-03/D-11) — a leave under `CANCELLATION_REQUESTED` stays
 * active and reduces Soll exactly like an `APPROVED` leave, until its cancellation is itself
 * approved (CLAUDE.md § Leave Cancellation Flow: "Leave remains active ... counts for saldo ...
 * until the cancellation is approved"). Before this phase every Arbeitszeitkonto saldo path read
 * leave via `getApprovedLeaveOverlapping` (`status: "APPROVED"` only), so a requested cancellation
 * silently cost the employee the full week back — an audit example of −40 h for a FIXED 40 h
 * employee. Every saldo path (live saldo, month-saldo, Monatsabschluss, snapshot recalc, the
 * auto-close cron and the gap check) must agree with the APPROVED twin.
 *
 * Fixture shape copied from holiday-leave-once-invariant.test.ts: fake clock set BEFORE
 * getTestApp(), a FIXED_SCHEDULE 40h employee helper with an overtimeAccount row, a direct
 * `leaveRequest.create` for the fixture leave.
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import { getTestApp, seedTestData, cleanupTestData, closeTestApp } from "./setup";
import { detectMonthGaps } from "../contexts/working-time-account/month-gap-check";
import { getTenantTimezone } from "../contexts/working-time-account";

describe("Issue #446 — leave under CANCELLATION_REQUESTED still reduces Soll (D-01/D-02/D-11)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let employeeN: string; // no leave
  let employeeA: string; // VACATION 2026-06-08..12 APPROVED
  let employeeC: string; // same week, CANCELLATION_REQUESTED
  let employeeA2: string; // close-month pair: APPROVED
  let employeeC2: string; // close-month pair: CANCELLATION_REQUESTED
  let employeeC3: string; // CANCELLATION_REQUESTED + one isInvalid WORK entry on 2026-06-09 (D-03)

  async function createFixedEmployee(label: string) {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const passwordHash = await bcrypt.hash("test1234", 10);
    const user = await app.prisma.user.create({
      data: {
        email: `lcs446-${label}-${suffix}@test.de`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `LCS446-${label}-${suffix}`,
        firstName: label,
        lastName: "CancellationSaldo",
        hireDate: new Date("2026-06-01"),
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        type: "FIXED_SCHEDULE",
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2026-06-01"),
      },
    });
    await app.prisma.overtimeAccount.create({
      data: { employeeId: employee.id, balanceHours: 0 },
    });
    return employee;
  }

  async function createLeave(employeeId: string, status: "APPROVED" | "CANCELLATION_REQUESTED") {
    await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        startDate: new Date("2026-06-08T00:00:00Z"),
        endDate: new Date("2026-06-12T00:00:00Z"),
        days: 5,
        halfDay: false,
        status,
      },
    });
  }

  async function monthSaldo(employeeId: string) {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/month-saldo/${employeeId}?year=2026&month=6`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as {
      workedMinutes: number;
      expectedMinutes: number;
      balanceMinutes: number;
    };
  }

  async function liveSaldo(employeeId: string) {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/${employeeId}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as { balanceHours: number };
  }

  async function closeMonth(employeeId: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/overtime/close-month",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId, year: 2026, month: 6, confirmGaps: true },
    });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body) as { expectedMinutes: number };
  }

  async function storedMonthlySnapshot(employeeId: string) {
    return app.prisma.saldoSnapshot.findFirst({
      where: { employeeId, periodType: "MONTHLY", superseded: false },
    });
  }

  async function gapDatesFor(employeeId: string) {
    const schedule = await app.prisma.workSchedule.findFirst({ where: { employeeId } });
    const tz = await getTenantTimezone(app.prisma, data.tenant.id);
    const result = await detectMonthGaps(app.prisma, {
      tenantId: data.tenant.id,
      employeeId,
      hireDate: new Date("2026-06-01"),
      schedule: schedule as unknown as Record<string, unknown>,
      month: { year: 2026, month: 6 },
      tz,
    });
    return result.gapDates;
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-10T10:00:00.000Z"));

    app = await getTestApp();
    data = await seedTestData(app, "lcs446");

    const n = await createFixedEmployee("N");
    employeeN = n.id;
    const a = await createFixedEmployee("A");
    employeeA = a.id;
    const c = await createFixedEmployee("C");
    employeeC = c.id;
    const a2 = await createFixedEmployee("A2");
    employeeA2 = a2.id;
    const c2 = await createFixedEmployee("C2");
    employeeC2 = c2.id;
    const c3 = await createFixedEmployee("C3");
    employeeC3 = c3.id;

    await createLeave(employeeA, "APPROVED");
    await createLeave(employeeC, "CANCELLATION_REQUESTED");
    await createLeave(employeeA2, "APPROVED");
    await createLeave(employeeC2, "CANCELLATION_REQUESTED");
    await createLeave(employeeC3, "CANCELLATION_REQUESTED");

    // D-03 fixture: an isInvalid WORK entry on a day of the CANCELLATION_REQUESTED week must not
    // add worked minutes nor a second Soll reduction (leave.test.ts:1199-1215 fixture shape).
    await app.prisma.timeEntry.create({
      data: {
        employeeId: employeeC3,
        date: new Date("2026-06-09"),
        startTime: new Date("2026-06-09T06:00:00Z"),
        endTime: new Date("2026-06-09T14:30:00Z"),
        breakMinutes: 30,
        source: "MANUAL",
        isInvalid: true,
        invalidReason: "Urlaubsstornierung ausstehend",
        invalidReasonCode: "LEAVE_CANCELLATION_PENDING",
        salonId: data.salonId,
      },
    });
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("leave-cancellation-saldo cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("sanity: A's June expectedMinutes is N's minus 2400 (one full leave week, no holiday)", async () => {
    const n = await monthSaldo(employeeN);
    const a = await monthSaldo(employeeA);
    expect(n.expectedMinutes - a.expectedMinutes).toBe(2400);
  });

  it("C (CANCELLATION_REQUESTED) has the SAME expectedMinutes as A (APPROVED) — not N's", async () => {
    const a = await monthSaldo(employeeA);
    const c = await monthSaldo(employeeC);
    expect(c.expectedMinutes).toBe(a.expectedMinutes);
  });

  it("C (CANCELLATION_REQUESTED) has the SAME balanceMinutes as A (APPROVED)", async () => {
    const a = await monthSaldo(employeeA);
    const c = await monthSaldo(employeeC);
    expect(c.balanceMinutes).toBe(a.balanceMinutes);
  });

  it("live saldo: GET /overtime/:employeeId balanceHours of C equals A's (A minus N = +40h)", async () => {
    const n = await liveSaldo(employeeN);
    const a = await liveSaldo(employeeA);
    const c = await liveSaldo(employeeC);
    expect(c.balanceHours).toBe(a.balanceHours);
    expect(a.balanceHours - n.balanceHours).toBe(40);
  });

  it("Monatsabschluss: close-month for a fresh APPROVED/CANCELLATION_REQUESTED pair answers 201 with equal expectedMinutes and equal stored snapshots", async () => {
    const a2Result = await closeMonth(employeeA2);
    const c2Result = await closeMonth(employeeC2);
    expect(c2Result.expectedMinutes).toBe(a2Result.expectedMinutes);

    const a2Snapshot = await storedMonthlySnapshot(employeeA2);
    const c2Snapshot = await storedMonthlySnapshot(employeeC2);
    expect(a2Snapshot).not.toBeNull();
    expect(c2Snapshot).not.toBeNull();
    expect(c2Snapshot?.expectedMinutes).toBe(a2Snapshot?.expectedMinutes);
  });

  it("gap check: a CANCELLATION_REQUESTED leave week is not a Monatsabschluss gap, same as the APPROVED twin", async () => {
    const aGaps = await gapDatesFor(employeeA);
    const cGaps = await gapDatesFor(employeeC);
    expect(cGaps).toEqual(aGaps);
    for (const d of ["2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11", "2026-06-12"]) {
      expect(cGaps).not.toContain(d);
    }
  });

  it("D-03: an isInvalid WORK entry on a CANCELLATION_REQUESTED day adds no worked minutes and no second Soll reduction (C3 identical to C)", async () => {
    const c = await monthSaldo(employeeC);
    const c3 = await monthSaldo(employeeC3);
    expect(c3.expectedMinutes).toBe(c.expectedMinutes);
    expect(c3.workedMinutes).toBe(c.workedMinutes);
  });
});
