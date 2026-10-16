/**
 * Issue #70 (Phase 70b-02, D-06, W8) — a closed month stays closed for a SECOND entry of a day.
 *
 * With several entries per day, "the day already has an entry" no longer implies "the day is
 * settled", so the month lock must refuse a new, non-overlapping entry on a day of a closed month
 * on its own. The lock step of `validateTimeEntryInvariants` (closed `SaldoSnapshot` of the month)
 * runs before the overlap step and answers 403 with the existing month-lock text; the entry is not
 * written and no CREATE audit row appears. A locked entry (`isLocked`) stays refused for PUT, and
 * the same second entry on an OPEN month is created (control).
 *
 * No person names in fixtures.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { fromZonedTime } from "date-fns-tz";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import { nextWeekdayStr, pastDateStr, TEST_TZ } from "./test-dates";

const CLOSED_DAY = "2026-02-17"; // a Tuesday in a month that is closed below

function at(dayStr: string, hhmm: string): Date {
  return fromZonedTime(`${dayStr}T${hhmm}:00`, TEST_TZ);
}

describe("Issue #70 — month lock per entry (D-06)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let lockedEntryId: string;

  const createAuditCount = () =>
    app.prisma.auditLog.count({
      where: { entity: "TimeEntry", action: "CREATE", userId: seed.adminUser.id },
    });

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "lock70");

    // Close February 2026 (Berlin): Feb 1 00:00 local = Jan 31 23:00 UTC.
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: seed.employee.id,
        periodType: "MONTHLY",
        periodStart: new Date("2026-01-31T23:00:00Z"),
        periodEnd: new Date("2026-02-28T22:59:59Z"),
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date(),
        closedBy: seed.adminEmployee.id,
      },
    });
    const locked = await app.prisma.timeEntry.create({
      data: {
        employeeId: seed.employee.id,
        date: new Date(`${CLOSED_DAY}T00:00:00Z`),
        startTime: at(CLOSED_DAY, "08:00"),
        endTime: at(CLOSED_DAY, "12:00"),
        source: "MANUAL",
        isLocked: true,
        salonId: seed.salonId,
      },
    });
    lockedEntryId = locked.id;
  });

  afterAll(async () => {
    try {
      await app.prisma.saldoSnapshot.deleteMany({ where: { employeeId: seed.employee.id } });
      await cleanupTestData(app, seed.tenant.id);
    } catch {
      // best-effort cleanup
    }
  });

  it("a second, non-overlapping entry on a day of a closed month is refused: 403, no row, no audit row", async () => {
    const auditBefore = await createAuditCount();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: {
        employeeId: seed.employee.id,
        date: CLOSED_DAY,
        startTime: at(CLOSED_DAY, "13:00").toISOString(),
        endTime: at(CLOSED_DAY, "15:00").toISOString(),
        salonId: seed.salonId,
      },
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(JSON.parse(res.body).error).toBe(
      "Monat ist abgeschlossen und kann nicht bearbeitet werden",
    );
    expect(
      await app.prisma.timeEntry.count({
        where: {
          employeeId: seed.employee.id,
          date: new Date(`${CLOSED_DAY}T00:00:00Z`),
          deletedAt: null,
        },
      }),
    ).toBe(1);
    expect(await createAuditCount()).toBe(auditBefore);
  });

  it("the locked entry itself stays refused for PUT", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/time-entries/${lockedEntryId}`,
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: {
        endTime: at(CLOSED_DAY, "11:00").toISOString(),
        reason: "Korrektur nach Rückfrage",
      },
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(JSON.parse(res.body).error).toBe(
      "Eintrag ist gesperrt und kann nicht bearbeitet werden",
    );
    const after = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: lockedEntryId } });
    expect(after.endTime?.toISOString()).toBe(at(CLOSED_DAY, "12:00").toISOString());
  });

  it("control: the same second entry on an OPEN month is created", async () => {
    const openDay = nextWeekdayStr(pastDateStr(5));
    await app.prisma.timeEntry.create({
      data: {
        employeeId: seed.employee.id,
        date: new Date(`${openDay}T00:00:00Z`),
        startTime: at(openDay, "08:00"),
        endTime: at(openDay, "12:00"),
        source: "MANUAL",
        salonId: seed.salonId,
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: {
        employeeId: seed.employee.id,
        date: openDay,
        startTime: at(openDay, "13:00").toISOString(),
        endTime: at(openDay, "15:00").toISOString(),
        salonId: seed.salonId,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
  });
});
