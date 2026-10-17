/**
 * Issue #664 - the bulk closed-month lookups (W2a `getClosedMonthsForDates`, W2b
 * `getClosedMonthsInRange`) matched the converted `periodStart` exactly, so a month closed in the
 * legacy UTC-naive convention read as OPEN and the shift cleanup / Berufsschul generator wrote
 * into it. `sumCarryOverByMonth` counted a person with a legacy AND a converted row of one month
 * twice. Every case below runs the legacy-format month next to a converted-format control and
 * demands the same answer; stored snapshot rows are compared in full before and after.
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, auditRowsFor } from "./setup";
import { legacySaldoSnapshotPeriodBounds, saldoSnapshotPeriodBounds } from "./test-dates";
import { cleanupShiftsForBSAbsence } from "../contexts/scheduling/shift-cleanup";
import { runVocationalSchoolGeneration } from "../contexts/absence/vocational-school-generator";
import {
  getClosedMonthsForDates,
  getClosedMonthsInRange,
  sumCarryOverByMonth,
} from "../contexts/working-time-account";

function todayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}
function daysAgoUtc(n: number): Date {
  const d = todayUtc();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

describe("Issue #664 - a month closed in the legacy format is closed for every lock reader", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let salonId: string;
  let adminUserId: string;
  let legacyEmp: string; // month closed in the legacy UTC-naive convention
  let convertedEmp: string; // control: same month closed in the converted convention

  async function newEmployee(tag: string) {
    const s = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}-${tag}`;
    const user = await app.prisma.user.create({
      data: {
        email: `lg664-${s}@test.de`,
        passwordHash: "unused",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `LG664-${s}`,
        firstName: "Lock",
        lastName: "Legacy664",
        hireDate: daysAgoUtc(365 * 5),
        classification: "AZUBI",
      },
    });
    return employee.id;
  }

  function closedRow(employeeId: string, bounds: { start: Date; end: Date }, carryOver = 60) {
    return app.prisma.saldoSnapshot.create({
      data: {
        employeeId,
        periodType: "MONTHLY",
        periodStart: bounds.start,
        periodEnd: bounds.end,
        workedMinutes: 9660,
        expectedMinutes: 9600,
        balanceMinutes: carryOver,
        carryOver,
        closedAt: new Date("2026-01-01T00:00:00Z"),
        closedBy: adminUserId,
      },
    });
  }

  const snapshotState = (ids: string[]) =>
    app.prisma.saldoSnapshot.findMany({
      where: { employeeId: { in: ids } },
      orderBy: [{ id: "asc" }],
    });

  beforeAll(async () => {
    app = await getTestApp();
    const seed = await seedTestData(app, "lock664");
    tenantId = seed.tenant.id;
    salonId = seed.salonId;
    adminUserId = seed.adminUser.id;
    legacyEmp = await newEmployee("legacy");
    convertedEmp = await newEmployee("converted");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("shift cleanup writes nothing in a legacy-closed month, same answer as a converted one", async () => {
    const now = new Date("2030-05-01T12:00:00Z");
    const month = new Date("2030-06-15T00:00:00Z");
    await closedRow(legacyEmp, legacySaldoSnapshotPeriodBounds(2030, 6));
    await closedRow(convertedEmp, saldoSnapshotPeriodBounds(month));

    const shiftIds: Record<string, string> = {};
    for (const emp of [legacyEmp, convertedEmp]) {
      const shift = await app.prisma.shift.create({
        data: {
          employeeId: emp,
          salonId,
          date: new Date("2030-06-10T00:00:00Z"), // future relative to `now`
          startTime: "08:00",
          endTime: "16:00",
        },
      });
      shiftIds[emp] = shift.id;
    }
    const snapsBefore = await snapshotState([legacyEmp, convertedEmp]);
    const shiftsBefore = await app.prisma.shift.findMany({
      where: { id: { in: Object.values(shiftIds) } },
      orderBy: [{ id: "asc" }],
    });

    const results = [];
    for (const emp of [legacyEmp, convertedEmp]) {
      results.push(
        await cleanupShiftsForBSAbsence(app.prisma, app.audit, {
          tenantId,
          employeeId: emp,
          dates: [new Date("2030-06-10T00:00:00Z")],
          now,
          triggerSource: "PATTERN",
        }),
      );
    }

    for (const r of results) {
      expect(r.lockedSkipped).toBe(1);
      expect(r.futureSoftDeleted).toBe(0);
      expect(r.pastFlagged).toBe(0);
      expect(r.affectedShiftIds).toEqual([]);
    }
    expect(
      await app.prisma.shift.findMany({
        where: { id: { in: Object.values(shiftIds) } },
        orderBy: [{ id: "asc" }],
      }),
    ).toEqual(shiftsBefore);
    for (const id of Object.values(shiftIds)) {
      expect(await auditRowsFor(app, "Shift", id)).toHaveLength(0);
    }
    expect(await snapshotState([legacyEmp, convertedEmp])).toEqual(snapsBefore);
  });

  it("Berufsschul generator creates nothing in a legacy-closed month, same answer as a converted one", async () => {
    const past = daysAgoUtc(95);
    const today = todayUtc();
    const anchor = daysAgoUtc(40);
    const lockStart = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
    const lockEnd = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0));

    for (const emp of [legacyEmp, convertedEmp]) {
      await app.prisma.employeeVocationalSchoolPattern.create({
        data: {
          employeeId: emp,
          dayOfWeek: 0,
          daysOfWeek: [0],
          blockWeeks: [],
          validFrom: past,
          isActive: true,
        },
      });
    }
    await closedRow(
      legacyEmp,
      legacySaldoSnapshotPeriodBounds(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1),
    );
    await closedRow(convertedEmp, saldoSnapshotPeriodBounds(anchor));
    // The 2030 rows of the previous test stay in the table; only the anchor month matters here.
    const snapsBefore = await snapshotState([legacyEmp, convertedEmp]);

    const results = [];
    for (const emp of [legacyEmp, convertedEmp]) {
      results.push(
        await runVocationalSchoolGeneration(app.prisma, app.audit, {
          tenantId,
          employeeId: emp,
          windowStart: past,
          windowEnd: today,
        }),
      );
    }

    expect(results[0].skipped.locked).toBeGreaterThan(0);
    expect(results[0].skipped.locked).toBe(results[1].skipped.locked);
    expect(results[0].created).toBe(results[1].created);
    for (const emp of [legacyEmp, convertedEmp]) {
      const inLocked = await app.prisma.absence.findMany({
        where: {
          employeeId: emp,
          type: "VOCATIONAL_SCHOOL",
          startDate: { gte: lockStart, lte: lockEnd },
          deletedAt: null,
        },
      });
      expect(inLocked).toHaveLength(0);
    }
    expect(await snapshotState([legacyEmp, convertedEmp])).toEqual(snapsBefore);
  });

  it("W2a/W2b name the requested month for a legacy row, like for a converted row", async () => {
    const emp = await newEmployee("facade");
    await closedRow(emp, legacySaldoSnapshotPeriodBounds(2031, 3));
    const monthStart = saldoSnapshotPeriodBounds(new Date("2031-03-15T00:00:00Z")).start;
    const key = `${emp}::${monthStart.toISOString().slice(0, 10)}`;

    const discrete = await getClosedMonthsForDates(app.prisma, [emp], tenantId, [monthStart]);
    expect(discrete.has(key)).toBe(true);
    const range = await getClosedMonthsInRange(app.prisma, [emp], tenantId, monthStart, monthStart);
    expect(range.has(key)).toBe(true);

    // The neighbouring months stay open: the window must not reach into them.
    const april = saldoSnapshotPeriodBounds(new Date("2031-04-15T00:00:00Z")).start;
    const feb = saldoSnapshotPeriodBounds(new Date("2031-02-15T00:00:00Z")).start;
    expect(await getClosedMonthsForDates(app.prisma, [emp], tenantId, [april, feb])).toEqual(
      new Set(),
    );
    expect(await getClosedMonthsInRange(app.prisma, [emp], tenantId, april, april)).toEqual(
      new Set(),
    );
  });

  it("sumCarryOverByMonth counts a person with a legacy AND a converted row of one month once", async () => {
    const both = await newEmployee("sum-both");
    const single = await newEmployee("sum-single");
    const month = new Date("2032-03-15T00:00:00Z");
    const converted = saldoSnapshotPeriodBounds(month);
    const legacy = legacySaldoSnapshotPeriodBounds(2032, 3);
    // Converted row closed first (the one the account reads: smallest periodStart).
    await closedRow(both, converted, 100);
    await closedRow(both, legacy, 999);
    await closedRow(single, converted, 25);
    const before = await snapshotState([both, single]);

    const from = saldoSnapshotPeriodBounds(new Date("2032-01-15T00:00:00Z")).start;
    const groups = await sumCarryOverByMonth(app.prisma, [both, single], tenantId, from);

    // The group sits on the converted STORED date (@db.Date reads back as UTC midnight) and holds
    // both persons' chosen rows: 100 + 25, the legacy 999 is not added.
    const storedDate = new Date(`${converted.start.toISOString().slice(0, 10)}T00:00:00Z`);
    expect(groups).toEqual([{ periodStart: storedDate, carryOver: 125 }]);
    expect(groups.reduce((sum, g) => sum + g.carryOver, 0)).toBe(125);
    expect(await snapshotState([both, single])).toEqual(before);
  });
});
