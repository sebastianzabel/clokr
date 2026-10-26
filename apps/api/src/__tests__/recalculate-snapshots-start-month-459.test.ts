/**
 * Issue #459 - recalculateSnapshots() recomputes the month a change STARTS in.
 *
 * Callers pass the date a change begins (a leave start mid-month, a holiday, a contract date).
 * The lower bound used to be `periodStart >= fromDate`, which skipped the start month's own
 * snapshot (its periodStart is the month start). That mattered for a month that is closed but not
 * locked (e.g. after "Monat entsperren"): its snapshot stayed stale while later months moved.
 *
 * Both storage conventions of SaldoSnapshot.periodStart (Issue #595) are covered, the previous
 * month must stay untouched, and a locked month must still be skipped and reported.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  salonIdForEmployee,
} from "./setup";
import { legacySaldoSnapshotPeriodBounds, saldoSnapshotPeriodBounds } from "./test-dates";
import { recalculateSnapshots } from "../contexts/working-time-account/recalculate-snapshots";

const STALE_WORKED = 9999;

describe("Issue #459 - recalculateSnapshots recomputes the start month", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminUserId: string;
  let salonId: string;
  let counter = 0;

  beforeAll(async () => {
    app = await getTestApp();
    const seed = await seedTestData(app, "recalc-start-459");
    tenantId = seed.tenant.id;
    adminUserId = seed.adminUser.id;
    salonId = seed.salonId;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("recalculate-snapshots-start-month-459 cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function makeEmployee(): Promise<string> {
    const suffix = `${++counter}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `rs459-${suffix}@example.invalid`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `rs459-${suffix}`,
        firstName: "rs459",
        lastName: "Start459",
        hireDate: new Date("2025-06-01T00:00:00Z"),
      },
    });
    const employeeId = employee.id;
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
        workDays: [1, 2, 3, 4, 5],
        validFrom: new Date("2025-06-01T00:00:00Z"),
      },
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId,
        employeeId,
        salonId,
        kind: "HOME",
        validFrom: new Date("2025-06-01T00:00:00Z"),
        validUntil: null,
        weekdays: [],
      },
    });
    return employeeId;
  }

  async function addEntry(employeeId: string, day: string, isLocked: boolean) {
    const start = new Date(`${day}T08:00:00Z`);
    await app.prisma.timeEntry.create({
      data: {
        employeeId,
        date: new Date(`${day}T00:00:00Z`),
        startTime: start,
        endTime: new Date(start.getTime() + 480 * 60_000),
        breakMinutes: 30,
        type: "WORK",
        salonId: await salonIdForEmployee(app.prisma, employeeId),
        isLocked,
      },
    });
  }

  async function addSnapshot(employeeId: string, bounds: { start: Date; end: Date }) {
    return app.prisma.saldoSnapshot.create({
      data: {
        employeeId,
        periodType: "MONTHLY",
        periodStart: bounds.start,
        periodEnd: bounds.end,
        workedMinutes: STALE_WORKED,
        expectedMinutes: 9000,
        balanceMinutes: STALE_WORKED - 9000,
        carryOver: STALE_WORKED - 9000,
        closedAt: new Date("2026-06-01T00:00:00Z"),
        closedBy: adminUserId,
      },
    });
  }

  const march = () => saldoSnapshotPeriodBounds(new Date("2026-03-01T00:00:00Z"));

  it("recomputes a closed-but-unlocked TZ-converted month when the change starts mid-month", async () => {
    const employeeId = await makeEmployee();
    await addEntry(employeeId, "2026-03-02", false);
    const stale = await addSnapshot(employeeId, march());

    // Leave start of 16 March: a calendar day stored as UTC midnight (@db.Date).
    const result = await recalculateSnapshots(app, employeeId, new Date("2026-03-16T00:00:00Z"));

    expect(result.lockedMonthsSkipped).toHaveLength(0);
    const old = await app.prisma.saldoSnapshot.findUnique({ where: { id: stale.id } });
    expect(old?.superseded).toBe(true);
    const active = await app.prisma.saldoSnapshot.findMany({
      where: { employeeId, periodType: "MONTHLY", superseded: false },
    });
    expect(active).toHaveLength(1);
    expect(active[0].id).not.toBe(stale.id);
    expect(active[0].workedMinutes).toBe(450);
  });

  it("recomputes the start month when fromDate is a real instant (contract validFrom style)", async () => {
    const employeeId = await makeEmployee();
    await addEntry(employeeId, "2026-03-02", false);
    const stale = await addSnapshot(employeeId, march());

    await recalculateSnapshots(app, employeeId, new Date("2026-03-15T10:30:00Z"));

    const old = await app.prisma.saldoSnapshot.findUnique({ where: { id: stale.id } });
    expect(old?.superseded).toBe(true);
  });

  it("recomputes a legacy UTC-naive month and leaves the previous month untouched", async () => {
    const employeeId = await makeEmployee();
    await addEntry(employeeId, "2026-04-02", false);
    const previous = await addSnapshot(employeeId, march());
    const legacy = await addSnapshot(employeeId, legacySaldoSnapshotPeriodBounds(2026, 4));

    await recalculateSnapshots(app, employeeId, new Date("2026-04-20T00:00:00Z"));

    const legacyAfter = await app.prisma.saldoSnapshot.findUnique({ where: { id: legacy.id } });
    expect(legacyAfter?.superseded).toBe(true);
    const previousAfter = await app.prisma.saldoSnapshot.findUnique({
      where: { id: previous.id },
    });
    expect(previousAfter?.superseded).toBe(false);
    expect(previousAfter?.workedMinutes).toBe(STALE_WORKED);
  });

  it("still skips and reports a locked start month", async () => {
    const employeeId = await makeEmployee();
    await addEntry(employeeId, "2026-03-02", true);
    const locked = await addSnapshot(employeeId, march());

    const result = await recalculateSnapshots(app, employeeId, new Date("2026-03-16T00:00:00Z"));

    expect(result.lockedMonthsSkipped.map((m) => m.snapshotId)).toEqual([locked.id]);
    const after = await app.prisma.saldoSnapshot.findUnique({ where: { id: locked.id } });
    expect(after?.superseded).toBe(false);
    expect(after?.workedMinutes).toBe(STALE_WORKED);
  });
});
