/**
 * Issue #617 (D-617-2, P-03, P-09) — the Resturlaub facade learns "verfügbar", "genommen" and
 * "genehmigt" without moving pricing out of the kernel.
 *
 * `takenDays` = counted VACATION days from 1 January up to and including `splitAsOf`,
 * `approvedUpcomingDays` = the days after it through 31 December, both net of confirmed § 9
 * credits and both read from `countedLeaveDaysWithin` (the kernel the `usedDays` heal runs).
 * After the heal `usedDays === takenDays + approvedUpcomingDays` — the identity this file pins
 * for every case. Every scenario passes its own `now` (fixed instants, mid-day UTC), so no
 * assertion depends on the wall clock. Fresh employee per scenario, initials-only (no PII).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { vacationBalanceForRow } from "../facade/vacation-balance";
import { healEntitlementUsedDays } from "../leave-days";
import { leaveTypeFields } from "../leave-type";
import type { FastifyInstance } from "fastify";
import type { LeaveEntitlement } from "@clokr/db";

const NOW = new Date("2026-10-17T10:00:00Z"); // Saturday; tenant-local yesterday = 2026-10-16

function day(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

describe("Issue #617 (D-617-2) — the Resturlaub facade splits taken and approved days", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let sickTypeId: string;
  let educationTypeId: string;

  async function mkEmployee(
    label: string,
    schedule: "FIXED" | "SHIFT_BASED" = "FIXED",
  ): Promise<string> {
    const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `vbs617-${label}-${uid}@example.invalid`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `VBS617-${label}-${uid}`,
        firstName: "T",
        lastName: "T",
        hireDate: day(2024, 1, 1),
      },
    });
    await app.prisma.workSchedule.create({
      data:
        schedule === "FIXED"
          ? {
              employeeId: employee.id,
              type: "FIXED_SCHEDULE",
              mondayHours: 8,
              tuesdayHours: 8,
              wednesdayHours: 8,
              thursdayHours: 8,
              fridayHours: 8,
              saturdayHours: 0,
              sundayHours: 0,
              validFrom: day(2024, 1, 1),
            }
          : {
              employeeId: employee.id,
              type: "SHIFT_BASED",
              weeklyHours: 38,
              contractWorkDaysPerWeek: 4,
              workDays: [2, 3, 4, 5],
              validFrom: day(2024, 1, 1),
            },
    });
    await app.prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
    return employee.id;
  }

  async function mkEntitlement(
    employeeId: string,
    overrides: { totalDays?: number; carriedOverDays?: number; carryOverDeadline?: Date } = {},
  ): Promise<LeaveEntitlement> {
    return app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: 2026,
        totalDays: 30,
        usedDays: 0,
        carriedOverDays: 0,
        isAutoCalculated: true,
        ...overrides,
      },
    });
  }

  async function mkRequest(
    employeeId: string,
    start: Date,
    end: Date,
    days: number,
    opts: {
      status?: "APPROVED" | "PENDING" | "CANCELLATION_REQUESTED" | "CANCELLED" | "REJECTED";
      createdAt?: Date;
      deletedAt?: Date;
      leaveTypeId?: string;
    } = {},
  ) {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: opts.leaveTypeId ?? data.vacationType.id,
        status: opts.status ?? "APPROVED",
        startDate: start,
        endDate: end,
        days,
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
        ...(opts.deletedAt ? { deletedAt: opts.deletedAt } : {}),
      },
    });
  }

  async function balance(ent: LeaveEntitlement, now: Date = NOW, opts: { asOf?: string } = {}) {
    const fresh = await app.prisma.leaveEntitlement.findUniqueOrThrow({ where: { id: ent.id } });
    return vacationBalanceForRow(app.prisma, fresh, data.tenant.id, now, opts);
  }

  /** The `usedDays` heal, then the balance — the order every reader (overview, export) runs. */
  async function healedBalance(
    ent: LeaveEntitlement,
    now: Date = NOW,
    opts: { asOf?: string } = {},
  ) {
    await healEntitlementUsedDays(app.prisma, ent, [data.vacationType.id], data.tenant.id);
    return balance(ent, now, opts);
  }

  function expectIdentities(b: Awaited<ReturnType<typeof balance>>) {
    expect(b.usedDays).toBeCloseTo(b.takenDays + b.approvedUpcomingDays, 2);
    expect(b.availableDays).toBe(
      Math.round((b.entitlementDays + b.carriedOverEffectiveDays) * 100) / 100,
    );
    expect(b.remainingDays).toBeCloseTo(b.availableDays - b.takenDays - b.approvedUpcomingDays, 2);
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "vbs617");
    sickTypeId = (
      await app.prisma.leaveType.create({
        data: { tenantId: data.tenant.id, ...leaveTypeFields("SICK") },
      })
    ).id;
    educationTypeId = (
      await app.prisma.leaveType.create({
        data: { tenantId: data.tenant.id, ...leaveTypeFields("EDUCATION") },
      })
    ).id;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("default split day is tenant-local yesterday: March taken, December upcoming, nothing else", async () => {
    const emp = await mkEmployee("d1");
    const ent = await mkEntitlement(emp);
    await mkRequest(emp, day(2026, 3, 2), day(2026, 3, 3), 2);
    await mkRequest(emp, day(2026, 12, 14), day(2026, 12, 16), 3);
    const b = await healedBalance(ent);
    expect(b.splitAsOf).toBe("2026-10-16");
    expect(b.takenDays).toBe(2);
    expect(b.approvedUpcomingDays).toBe(3);
    expect(b.availableDays).toBe(30);
    expect(b.remainingDays).toBe(25);
    expectIdentities(b);
  });

  it("a request ending on the split day is taken; a request spanning it is split at the day", async () => {
    const emp = await mkEmployee("d2");
    const ent = await mkEntitlement(emp);
    await mkRequest(emp, day(2026, 10, 12), day(2026, 10, 16), 5); // ends on splitAsOf
    const b1 = await healedBalance(ent);
    expect(b1.takenDays).toBe(5);
    expect(b1.approvedUpcomingDays).toBe(0);
    expectIdentities(b1);

    const emp2 = await mkEmployee("d2b");
    const ent2 = await mkEntitlement(emp2);
    await mkRequest(emp2, day(2026, 10, 15), day(2026, 10, 20), 4); // Thu Fri | Mon Tue
    const b2 = await healedBalance(ent2);
    expect(b2.takenDays).toBe(2);
    expect(b2.approvedUpcomingDays).toBe(2);
    expectIdentities(b2);
  });

  it("an explicit asOf moves the split; before 1 January nothing is taken, after 31 December nothing is upcoming", async () => {
    const emp = await mkEmployee("a1");
    const ent = await mkEntitlement(emp);
    await mkRequest(emp, day(2026, 3, 2), day(2026, 3, 3), 2);
    await mkRequest(emp, day(2026, 10, 12), day(2026, 10, 16), 5);
    const b = await healedBalance(ent, NOW, { asOf: "2026-09-30" });
    expect(b.splitAsOf).toBe("2026-09-30");
    expect(b.takenDays).toBe(2);
    expect(b.approvedUpcomingDays).toBe(5);
    expectIdentities(b);

    const early = await balance(ent, NOW, { asOf: "2025-12-31" });
    expect(early.takenDays).toBe(0);
    expect(early.approvedUpcomingDays).toBe(7);
    const late = await balance(ent, NOW, { asOf: "2027-02-01" });
    expect(late.takenDays).toBe(7);
    expect(late.approvedUpcomingDays).toBe(0);
  });

  it("PENDING is neither taken nor upcoming; CANCELLATION_REQUESTED counts; CANCELLED, REJECTED, soft-deleted and other types do not", async () => {
    const emp = await mkEmployee("s1");
    const ent = await mkEntitlement(emp);
    await mkRequest(emp, day(2026, 5, 4), day(2026, 5, 5), 2, { status: "PENDING" });
    await mkRequest(emp, day(2026, 6, 1), day(2026, 6, 2), 2, { status: "CANCELLATION_REQUESTED" });
    await mkRequest(emp, day(2026, 7, 6), day(2026, 7, 7), 2, { status: "CANCELLED" });
    await mkRequest(emp, day(2026, 7, 13), day(2026, 7, 14), 2, { status: "REJECTED" });
    await mkRequest(emp, day(2026, 8, 3), day(2026, 8, 4), 2, {
      deletedAt: new Date("2026-08-01T00:00:00Z"),
    });
    await mkRequest(emp, day(2026, 9, 7), day(2026, 9, 8), 2, { leaveTypeId: educationTypeId });
    const b = await healedBalance(ent);
    expect(b.takenDays).toBe(2); // only the CANCELLATION_REQUESTED one
    expect(b.approvedUpcomingDays).toBe(0);
    expect(b.pendingDays).toBe(2);
    expectIdentities(b);
  });

  it("pendingCreatedByAsOfDays: bounded by the end of the tenant-local split day, pendingDays is not", async () => {
    const emp = await mkEmployee("p1");
    const ent = await mkEntitlement(emp);
    await mkRequest(emp, day(2026, 11, 2), day(2026, 11, 3), 2, {
      status: "PENDING",
      createdAt: new Date("2026-09-29T09:00:00Z"),
    });
    await mkRequest(emp, day(2026, 11, 4), day(2026, 11, 5), 2, {
      status: "PENDING",
      createdAt: new Date("2026-10-05T09:00:00Z"),
    });
    // 30.09. 23:30 Berlin time = 21:30Z — still the Stichtag, counts
    await mkRequest(emp, day(2026, 11, 9), day(2026, 11, 9), 1, {
      status: "PENDING",
      createdAt: new Date("2026-09-30T21:30:00Z"),
    });
    // 30.09. 22:30Z = 01.10. 00:30 Berlin time — after the Stichtag, does not count
    await mkRequest(emp, day(2026, 11, 10), day(2026, 11, 10), 1, {
      status: "PENDING",
      createdAt: new Date("2026-09-30T22:30:00Z"),
    });
    const b = await balance(ent, NOW, { asOf: "2026-09-30" });
    expect(b.pendingDays).toBe(6);
    expect(b.pendingCreatedByAsOfDays).toBe(3);
  });

  it("a half day in the past is taken 0.5", async () => {
    const emp = await mkEmployee("h1");
    const ent = await mkEntitlement(emp);
    await mkRequest(emp, day(2026, 4, 7), day(2026, 4, 7), 0.5);
    const b = await healedBalance(ent);
    expect(b.takenDays).toBe(0.5);
    expect(b.approvedUpcomingDays).toBe(0);
    expectIdentities(b);
  });

  it("a confirmed § 9 credit inside a taken vacation is netted (2 - 1 = 1)", async () => {
    const emp = await mkEmployee("n1");
    const ent = await mkEntitlement(emp);
    const vac = await mkRequest(emp, day(2026, 3, 2), day(2026, 3, 3), 2);
    const sick = await mkRequest(emp, day(2026, 3, 3), day(2026, 3, 3), 1, {
      leaveTypeId: sickTypeId,
    });
    await app.prisma.section9Credit.create({
      data: {
        employeeId: emp,
        sickRequestId: sick.id,
        vacationRequestId: vac.id,
        overlapStart: day(2026, 3, 3),
        overlapEnd: day(2026, 3, 3),
        creditedStart: day(2026, 3, 3),
        creditedEnd: day(2026, 3, 3),
        creditedDays: 1,
        status: "CONFIRMED",
      },
    });
    const b = await healedBalance(ent);
    expect(b.takenDays).toBe(1);
    expect(b.approvedUpcomingDays).toBe(0);
    expectIdentities(b);
  });

  it("a § 9 credit attributed to the later window nets the upcoming days, not the taken ones", async () => {
    const emp = await mkEmployee("n2");
    const ent = await mkEntitlement(emp);
    const vac = await mkRequest(emp, day(2026, 10, 15), day(2026, 10, 20), 4); // Thu Fri | Mon Tue
    const sick = await mkRequest(emp, day(2026, 10, 19), day(2026, 10, 19), 1, {
      leaveTypeId: sickTypeId,
    });
    await app.prisma.section9Credit.create({
      data: {
        employeeId: emp,
        sickRequestId: sick.id,
        vacationRequestId: vac.id,
        overlapStart: day(2026, 10, 19),
        overlapEnd: day(2026, 10, 19),
        creditedStart: day(2026, 10, 19),
        creditedEnd: day(2026, 10, 19),
        creditedDays: 1,
        status: "CONFIRMED",
      },
    });
    const b = await healedBalance(ent);
    expect(b.takenDays).toBe(2);
    expect(b.approvedUpcomingDays).toBe(1);
    expectIdentities(b);
  });

  it("a SHIFT_BASED request spanning the split day keeps taken + upcoming equal to the healed usedDays", async () => {
    const emp = await mkEmployee("sb", "SHIFT_BASED");
    const ent = await mkEntitlement(emp);
    await mkRequest(emp, day(2026, 10, 15), day(2026, 10, 20), 4);
    const b = await healedBalance(ent);
    expect(b.takenDays + b.approvedUpcomingDays).toBe(b.usedDays);
    expect(b.takenDays).toBe(2);
    expect(b.approvedUpcomingDays).toBe(2);
    expectIdentities(b);
  });

  it("a cross-year request is attributed to the 2026 row only with its 2026 share", async () => {
    const emp = await mkEmployee("cy");
    const ent = await mkEntitlement(emp);
    // Tue 29.12.2026 - Thu 07.01.2027: three workdays in 2026 (29, 30, 31), 1 Jan holiday
    await mkRequest(emp, day(2026, 12, 29), day(2027, 1, 7), 7);
    const b = await healedBalance(ent);
    expect(b.takenDays).toBe(0);
    expect(b.approvedUpcomingDays).toBe(3);
    expectIdentities(b);
    const later = await balance(ent, NOW, { asOf: "2026-12-30" });
    expect(later.takenDays).toBe(2);
    expect(later.approvedUpcomingDays).toBe(1);
  });

  it("the default split day follows the tenant time zone, not UTC", async () => {
    const emp = await mkEmployee("tz");
    const ent = await mkEntitlement(emp);
    await mkRequest(emp, day(2026, 10, 31), day(2026, 10, 31), 1);
    // 2026-10-31T23:30Z is 01.11. 00:30 in Berlin: yesterday there is 31.10.
    const b = await healedBalance(ent, new Date("2026-10-31T23:30:00Z"));
    expect(b.splitAsOf).toBe("2026-10-31");
    expect(b.takenDays).toBe(1);
    expect(b.approvedUpcomingDays).toBe(0);
    expectIdentities(b);
  });

  it("availableDays adds the effective carry-over; an expired carry-over drops out", async () => {
    const emp = await mkEmployee("av");
    const ent = await mkEntitlement(emp, {
      totalDays: 30,
      carriedOverDays: 5,
      carryOverDeadline: day(2026, 3, 31),
    });
    await mkRequest(emp, day(2026, 3, 2), day(2026, 3, 3), 2);
    const b = await healedBalance(ent);
    expect(b.carriedOverEffectiveDays).toBeLessThanOrEqual(5);
    expect(b.availableDays).toBe(30 + b.carriedOverEffectiveDays);
    expectIdentities(b);
  });
});
