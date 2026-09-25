/**
 * Phase 71b Plan 04 (issue #71, AC-4..AC-7/AC-13) — the three single-employee saldo readers
 * (month-saldo.ts, overtime-balance.ts, recalculate-snapshots.ts) now resolve statutory holidays
 * by WORK LOCATION (§ 2 EFZG) through the Unterbau's central resolver, the same mechanism plans
 * 02/03 already proved for the resolver itself and for Abwesenheiten/Schichtplanung.
 *
 * Fronleichnam 2026 = Thursday 2026-06-04 (BAYERN, not NIEDERSACHSEN) — June 2026 carries no
 * NIEDERSACHSEN statutory holiday. June 2026 has 22 Mo-Fr workdays -> FIXED 40h Mo-Fr (8h/day)
 * June Soll with no holiday at all = 10560 minutes.
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { recalculateSnapshots } from "../contexts/working-time-account/recalculate-snapshots";

describe("Saldo by work location (Phase 71b Plan 04, issue #71, AC-4..AC-7)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let salonAId: string; // BAYERN
  let salonBId: string; // NIEDERSACHSEN, created FIRST — the tenant's default salon
  let e1Id: string; // HOME B, closed WORK entry on 2026-06-04 in salon A
  let e2Id: string; // HOME B, closed WORK entry on 2026-06-04 in salon B
  let e3Id: string; // HOME B + DEPLOYMENT A Thursdays, no June-4 entry
  let e4Id: string; // HOME B only — control
  let e5Id: string; // HOME B + DEPLOYMENT A Thursdays, entry in salon B on 2026-06-04
  let e7Id: string; // HOME A

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-10T10:00:00.000Z"));

    app = await getTestApp();
    const seed = await seedTestData(app, "hwls", { withDefaultSalon: false });
    tenantId = seed.tenant.id;
    adminToken = seed.adminToken;

    const salonB = await createTestSalon(app.prisma, tenantId, { federalState: "NIEDERSACHSEN" });
    salonBId = salonB.id;
    const salonA = await createTestSalon(app.prisma, tenantId, { federalState: "BAYERN" });
    salonAId = salonA.id;

    const passwordHash = await bcrypt.hash("test1234", 10);

    async function createFixedEmployee(label: string) {
      const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const user = await app.prisma.user.create({
        data: {
          email: `hwls-${label}-${suffix}@test.de`,
          passwordHash,
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const employee = await app.prisma.employee.create({
        data: {
          tenantId,
          userId: user.id,
          employeeNumber: `HWLS-${label}-${suffix}`,
          firstName: label,
          lastName: "WorkLocationSaldo",
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

    async function assignHome(employeeId: string, salonId: string) {
      await app.prisma.employeeSalonAssignment.create({
        data: {
          tenantId,
          employeeId,
          salonId,
          kind: "HOME",
          validFrom: new Date("2026-06-01"),
          validUntil: null,
          weekdays: [],
        },
      });
    }
    async function assignDeployment(employeeId: string, salonId: string, weekdays: number[]) {
      await app.prisma.employeeSalonAssignment.create({
        data: {
          tenantId,
          employeeId,
          salonId,
          kind: "DEPLOYMENT",
          validFrom: new Date("2026-06-01"),
          validUntil: null,
          weekdays,
        },
      });
    }
    async function createEntry(employeeId: string, dateStr: string, salonId: string) {
      await app.prisma.timeEntry.create({
        data: {
          employeeId,
          date: new Date(`${dateStr}T00:00:00Z`),
          startTime: new Date(`${dateStr}T08:00:00Z`),
          endTime: new Date(`${dateStr}T16:00:00Z`),
          breakMinutes: 0,
          type: "WORK",
          salonId,
        },
      });
    }

    const e1 = await createFixedEmployee("e1");
    e1Id = e1.id;
    await assignHome(e1Id, salonBId);
    await createEntry(e1Id, "2026-06-04", salonAId);

    const e2 = await createFixedEmployee("e2");
    e2Id = e2.id;
    await assignHome(e2Id, salonBId);
    await createEntry(e2Id, "2026-06-04", salonBId);

    const e3 = await createFixedEmployee("e3");
    e3Id = e3.id;
    await assignHome(e3Id, salonBId);
    await assignDeployment(e3Id, salonAId, [3]); // Thursday (0 = Monday)

    const e4 = await createFixedEmployee("e4");
    e4Id = e4.id;
    await assignHome(e4Id, salonBId);

    const e5 = await createFixedEmployee("e5");
    e5Id = e5.id;
    await assignHome(e5Id, salonBId);
    await assignDeployment(e5Id, salonAId, [3]);
    await createEntry(e5Id, "2026-06-04", salonBId);

    const e7 = await createFixedEmployee("e7");
    e7Id = e7.id;
    await assignHome(e7Id, salonAId);

    // Manual holiday, salon A only (Wednesday) — stacks with Fronleichnam (Thursday) for e7, who
    // is HOME A every day; must not touch e4 (HOME B/NIEDERSACHSEN).
    await app.prisma.publicHoliday.create({
      data: {
        tenantId,
        salonId: salonAId,
        date: new Date("2026-06-10"),
        name: "Stadtfest A",
        federalState: "BAYERN",
        year: 2026,
      },
    });
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("holiday-work-location-saldo cleanup failed:", err);
    }
  });

  async function monthSaldo(employeeId: string) {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/month-saldo/${employeeId}?year=2026&month=6`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as { expectedMinutes: number };
  }

  it("AC-4: one tenant, two Bundesländer, one date — the closed entry's salon decides the June Soll, not a tenant-wide state", async () => {
    const e1Result = await monthSaldo(e1Id);
    expect(e1Result.expectedMinutes).toBe(10080);
    const e2Result = await monthSaldo(e2Id);
    expect(e2Result.expectedMinutes).toBe(10560);
  });

  it("AC-5: a Thursday DEPLOYMENT to BAYERN reduces the Soll with no entry needed; HOME NIEDERSACHSEN alone does not", async () => {
    const e3Result = await monthSaldo(e3Id);
    expect(e3Result.expectedMinutes).toBe(10080);
    const e4Result = await monthSaldo(e4Id);
    expect(e4Result.expectedMinutes).toBe(10560);
  });

  it("AC-6: a closed entry in the HOME salon beats the DEPLOYMENT pattern for the same day", async () => {
    const e5Result = await monthSaldo(e5Id);
    expect(e5Result.expectedMinutes).toBe(10560);
  });

  it("AC-7: a manual holiday of salon A reduces only the Soll of employees resolved to salon A that day", async () => {
    const e7Result = await monthSaldo(e7Id);
    expect(e7Result.expectedMinutes).toBe(9600);
    const e4Result = await monthSaldo(e4Id);
    expect(e4Result.expectedMinutes).toBe(10560);
  });

  it("live balance parity: GET /overtime/:employeeId's lifetime balance reflects the SAME 480-minute (8h) Thursday-deployment reduction as month-saldo, for both employees have zero worked minutes and identical July behavior", async () => {
    async function liveBalanceHours(employeeId: string): Promise<number> {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/${employeeId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { balanceHours: number };
      return Number(body.balanceHours);
    }

    // e3 (deployed to BAYERN on Thursdays -> Fronleichnam reduces its Soll) must show a LESS
    // negative lifetime balance than e4 (HOME NIEDERSACHSEN only, no reduction) by exactly the
    // same 8h (480 min) month-saldo already pins for June — both have zero TimeEntry rows at all,
    // so worked=0 for both, and their DEPLOYMENT pattern is open-ended, so any July Thursdays
    // resolve identically for both (no BAYERN holiday in July) and cancel out of the difference.
    const e3Balance = await liveBalanceHours(e3Id);
    const e4Balance = await liveBalanceHours(e4Id);
    expect(e3Balance - e4Balance).toBeCloseTo(8, 1);
  });
});

describe("AC-13: a locked month is never recomputed, even when a changed salon assignment would now make one of its days a holiday (Phase 71b Plan 04, issue #71)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let employeeId: string;
  let snapshotId: string;
  const JUNE_START = new Date("2026-05-31T22:00:00.000Z"); // June 1 00:00 Berlin (CEST)
  const JUNE_END = new Date("2026-06-30T21:59:59.999Z"); // June 30 23:59:59.999 Berlin (CEST)

  beforeAll(async () => {
    app = await getTestApp();
    const seed = await seedTestData(app, "ac13", { withDefaultSalon: false });
    tenantId = seed.tenant.id;

    const salonB = await createTestSalon(app.prisma, tenantId, { federalState: "NIEDERSACHSEN" });
    const salonA = await createTestSalon(app.prisma, tenantId, { federalState: "BAYERN" });

    const passwordHash = await bcrypt.hash("test1234", 10);
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `ac13-${suffix}@test.de`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `AC13-${suffix}`,
        firstName: "AC13",
        lastName: "LockedMonth",
        hireDate: new Date("2026-01-01"),
      },
    });
    employeeId = employee.id;
    await app.prisma.workSchedule.create({
      data: {
        employeeId,
        type: "FIXED_SCHEDULE",
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2026-01-01"),
      },
    });
    await app.prisma.overtimeAccount.create({ data: { employeeId, balanceHours: 0 } });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId,
        employeeId,
        salonId: salonB.id,
        kind: "HOME",
        validFrom: new Date("2026-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });

    // The canonical "this month is closed" signal isSnapshotLocked() reads — at least one
    // non-deleted TimeEntry in the period with isLocked: true (Monatsabschluss shape).
    await app.prisma.timeEntry.create({
      data: {
        employeeId,
        date: new Date("2026-06-01T00:00:00Z"),
        startTime: new Date("2026-06-01T08:00:00Z"),
        endTime: new Date("2026-06-01T16:00:00Z"),
        breakMinutes: 0,
        type: "WORK",
        isLocked: true,
        lockedAt: new Date("2026-07-01T00:00:00Z"),
        salonId: salonB.id,
      },
    });

    // Distinctive placeholder values a real recompute would NOT reproduce (mirrors the sentinel
    // technique in recalculate-snapshots.test.ts's own locked-month fixture) — if the lock skip
    // were ever bypassed, these would change.
    const snapshot = await app.prisma.saldoSnapshot.create({
      data: {
        employeeId,
        periodType: "MONTHLY",
        periodStart: JUNE_START,
        periodEnd: JUNE_END,
        workedMinutes: 480,
        expectedMinutes: 10560,
        balanceMinutes: -10080,
        carryOver: 9999,
        closedAt: new Date(JUNE_END.getTime() + 24 * 60 * 60_000),
        closedBy: null,
        note: "AC-13 locked-month placeholder — must survive untouched",
      },
    });
    snapshotId = snapshot.id;

    // AFTER the month is closed and locked: a DEPLOYMENT to BAYERN on Thursdays covering June is
    // added. Fronleichnam (Thursday 2026-06-04) would now be a work-location holiday for this
    // employee if June were recomputed — proving the byte-identical assertion below is not
    // vacuous (a broken lock skip WOULD change the stored values).
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId,
        employeeId,
        salonId: salonA.id,
        kind: "DEPLOYMENT",
        validFrom: new Date("2026-01-01"),
        validUntil: null,
        weekdays: [3], // Thursday (0 = Monday)
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("AC-13 locked-month cleanup failed:", err);
    }
  });

  it("reports June in lockedMonthsSkipped and leaves the SaldoSnapshot row byte-identical", async () => {
    const before = await app.prisma.saldoSnapshot.findUniqueOrThrow({ where: { id: snapshotId } });

    const result = await recalculateSnapshots(app, employeeId, JUNE_START);

    expect(result.lockedMonthsSkipped.length).toBe(1);
    expect(result.lockedMonthsSkipped[0].snapshotId).toBe(snapshotId);

    const after = await app.prisma.saldoSnapshot.findUniqueOrThrow({ where: { id: snapshotId } });
    expect(after).toEqual(before);
  });
});
