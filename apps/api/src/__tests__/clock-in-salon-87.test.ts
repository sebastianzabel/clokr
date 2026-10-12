/**
 * Issue #87 (Phase 87b-02), D-01/D-04/D-12 — the web clock-in (`POST /time-entries/clock-in`,
 * source MOBILE) may name the salon the new entry belongs to. The clock resolver hands the id to
 * the one entry-salon rule (`resolveEntrySalon`); this file proves the route-level write path:
 *
 * - the entry carries the CHOSEN salon, a deviation from the weekly pattern is never an error,
 *   a warning or a marker (AC-4/AC-5);
 * - without a salonId the pattern chain applies exactly as before (D-01);
 * - a foreign tenant's salon and an unknown id answer the byte-identical 404 in every state —
 *   no open entry, a closed entry of the day (REOPEN) and an open entry (T-100-09, D-12);
 * - a deactivated salon answers 400 SALON_INACTIVE, a null or malformed id 400 Validierungsfehler;
 * - re-clocking a finished day reopens its entry and never moves its salon: a differing explicit
 *   salon is a 409 SALON_DIFFERS_FROM_DAY_ENTRY and leaves the entry untouched (D-04).
 *
 * Mutation proofs (recorded here, not re-run by CI), both on services/clock/resolver.ts:
 * - M1, removing the conditional `explicitSalonId` spread in START, turns red: the tracer, AC-5,
 *   the START foreign/unknown 404, the START inactive 400 and the on-behalf case;
 * - M2, removing the differing-salon comparison in REOPEN, turns red: "REOPEN: a differing salon
 *   answers 409 SALON_DIFFERS_FROM_DAY_ENTRY and changes nothing (D-04)".
 *
 * No person names in fixtures. Every fixture id is a UUID.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { fromZonedTime } from "date-fns-tz";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { addDaysStr, mondayOfWeekStr, TEST_TZ } from "./test-dates";

/** Tenant-local instant for `HH:MM` on `dayStr`. */
function instant(dayStr: string, hhmm: string): Date {
  return fromZonedTime(`${dayStr}T${hhmm}:00`, TEST_TZ);
}

type ClockInBody = {
  resolution: { kind: string; entry: { id: string; salonId: string } };
  warnings?: unknown;
};

describe("Issue #87 — clock-in with a chosen salon (write path)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  let salonC: { id: string };
  let salonInactive: { id: string };
  let foreign: Awaited<ReturnType<typeof seedTestData>>;

  // One distinct past Thursday per case: the one-entry-per-day index allows a single non-deleted
  // row per employee and day, so no case ever shares a day with another.
  const baseMonday = addDaysStr(mondayOfWeekStr(), -14 * 7);
  const thursdayOf = (weekOffset: number): string => addDaysStr(baseMonday, weekOffset * 7 + 3);

  /** POST /clock-in at `hhmm` of `dayStr` (tenant time) with the employee's token. */
  async function clockIn(
    dayStr: string,
    hhmm: string,
    payload: Record<string, unknown>,
    token?: string,
  ) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(instant(dayStr, hhmm));
    try {
      return await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/clock-in",
        headers: { authorization: `Bearer ${token ?? seed.empToken}` },
        payload,
      });
    } finally {
      vi.useRealTimers();
    }
  }

  /** A finished day entry 08:00-12:00 for the employee on `dayStr`, booked to `salonId`. */
  async function seedClosedEntry(dayStr: string, salonId: string, opts: { locked?: boolean } = {}) {
    return app.prisma.timeEntry.create({
      data: {
        employeeId: seed.employee.id,
        date: new Date(`${dayStr}T00:00:00Z`),
        startTime: instant(dayStr, "08:00"),
        endTime: instant(dayStr, "12:00"),
        source: "MOBILE",
        isLocked: opts.locked ?? false,
        breakMinutes: 0,
        salonId,
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "cis87");
    foreign = await seedTestData(app, "cis87-foreign");
    salonInactive = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Salon X (deaktiviert)",
      isActive: false,
    });
    salonA = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon A (HOME)" });
    salonB = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Salon B (Thursday DEPLOYMENT)",
    });
    salonC = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Salon C (never assigned)",
    });

    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: seed.tenant.id,
        employeeId: seed.employee.id,
        salonId: salonA.id,
        kind: "HOME",
        validFrom: new Date("2020-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: seed.tenant.id,
        employeeId: seed.employee.id,
        salonId: salonB.id,
        kind: "DEPLOYMENT",
        validFrom: new Date("2020-01-01"),
        validUntil: null,
        weekdays: [3], // Thursday
      },
    });
  });

  afterAll(async () => {
    for (const tenantId of [seed.tenant.id, foreign.tenant.id]) {
      try {
        await cleanupTestData(app, tenantId);
      } catch (err) {
        console.error("Test cleanup failed:", err);
      }
    }
  });

  it("tracer: a Thursday clock-in naming salon A lands on A although the pattern says B", async () => {
    const res = await clockIn(thursdayOf(0), "09:00", { source: "MOBILE", salonId: salonA.id });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as ClockInBody;
    expect(body.resolution.kind).toBe("CLOCKED_IN");
    expect(body.resolution.entry.salonId).toBe(salonA.id);
    const row = await app.prisma.timeEntry.findUniqueOrThrow({
      where: { id: body.resolution.entry.id },
    });
    expect(row.salonId).toBe(salonA.id);
  });

  it("without a salonId the same Thursday still lands on the pattern salon B (D-01)", async () => {
    const res = await clockIn(thursdayOf(1), "09:00", { source: "MOBILE" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as ClockInBody;
    expect(body.resolution.entry.salonId).toBe(salonB.id);
  });

  it("AC-5: a deviating choice is no warning, no marker and no extra audit action", async () => {
    const res = await clockIn(thursdayOf(2), "09:00", { source: "MOBILE", salonId: salonC.id });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as ClockInBody;
    expect(body.warnings).toBeUndefined();
    const row = await app.prisma.timeEntry.findUniqueOrThrow({
      where: { id: body.resolution.entry.id },
    });
    expect(row.salonId).toBe(salonC.id);
    expect(row.isInvalid).toBe(false);
    expect(row.invalidReason).toBeNull();
    const audits = await app.prisma.auditLog.findMany({
      where: { entity: "TimeEntry", entityId: row.id },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("CLOCK_IN");
    expect((audits[0].newValue as { salonId?: string } | null)?.salonId).toBe(salonC.id);
  });

  it("START: a foreign tenant's salon and an unknown id answer the byte-identical 404, nothing is written", async () => {
    const day = thursdayOf(3);
    const resForeign = await clockIn(day, "09:00", { source: "MOBILE", salonId: foreign.salonId });
    const resUnknown = await clockIn(day, "09:00", { source: "MOBILE", salonId: randomUUID() });
    expect(resForeign.statusCode).toBe(404);
    expect(resUnknown.statusCode).toBe(404);
    expect(resForeign.body).toBe(resUnknown.body);
    expect(resForeign.body).toBe(JSON.stringify({ error: "Salon nicht gefunden" }));
    const rows = await app.prisma.timeEntry.count({
      where: { employeeId: seed.employee.id, date: new Date(`${day}T00:00:00Z`) },
    });
    expect(rows).toBe(0);
  });

  it("START: an own deactivated salon answers 400 SALON_INACTIVE and writes nothing", async () => {
    const day = thursdayOf(4);
    const res = await clockIn(day, "09:00", { source: "MOBILE", salonId: salonInactive.id });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: "Salon ist deaktiviert",
      code: "SALON_INACTIVE",
    });
    const rows = await app.prisma.timeEntry.count({
      where: { employeeId: seed.employee.id, date: new Date(`${day}T00:00:00Z`) },
    });
    expect(rows).toBe(0);
  });

  it("a null or malformed salonId answers 400 Validierungsfehler", async () => {
    const day = thursdayOf(5);
    for (const salonId of [null, "not-a-uuid"]) {
      const res = await clockIn(day, "09:00", { source: "MOBILE", salonId });
      expect(res.statusCode).toBe(400);
      expect((JSON.parse(res.body) as { error: string }).error).toBe("Validierungsfehler");
    }
    const rows = await app.prisma.timeEntry.count({
      where: { employeeId: seed.employee.id, date: new Date(`${day}T00:00:00Z`) },
    });
    expect(rows).toBe(0);
  });

  it("REOPEN: a differing salon answers 409 SALON_DIFFERS_FROM_DAY_ENTRY and changes nothing (D-04)", async () => {
    const day = thursdayOf(6);
    const entry = await seedClosedEntry(day, salonA.id);
    const res = await clockIn(day, "13:00", { source: "MOBILE", salonId: salonB.id });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as { error: string; code: string };
    expect(body.code).toBe("SALON_DIFFERS_FROM_DAY_ENTRY");
    expect(body.error).toContain("anderen Salon");
    const after = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(after.endTime?.toISOString()).toBe(instant(day, "12:00").toISOString());
    expect(after.salonId).toBe(salonA.id);
    expect(await app.prisma.break.count({ where: { timeEntryId: entry.id } })).toBe(0);
    expect(await app.prisma.auditLog.count({ where: { entityId: entry.id } })).toBe(0);
  });

  it("REOPEN: the same salon reopens the entry normally and keeps the salon", async () => {
    const day = thursdayOf(7);
    const entry = await seedClosedEntry(day, salonA.id);
    const res = await clockIn(day, "13:00", { source: "MOBILE", salonId: salonA.id });
    expect(res.statusCode).toBe(200);
    expect((JSON.parse(res.body) as ClockInBody).resolution.kind).toBe("CLOCKED_IN");
    const after = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(after.endTime).toBeNull();
    expect(after.salonId).toBe(salonA.id);
    const breaks = await app.prisma.break.findMany({ where: { timeEntryId: entry.id } });
    expect(breaks).toHaveLength(1);
    expect(breaks[0].startTime.toISOString()).toBe(instant(day, "12:00").toISOString());
    expect(breaks[0].endTime?.toISOString()).toBe(instant(day, "13:00").toISOString());
    const reopens = await app.prisma.auditLog.count({
      where: { entityId: entry.id, action: "CLOCK_REOPEN" },
    });
    expect(reopens).toBe(1);
  });

  it("REOPEN: no salonId reopens normally — the 409 never fires without a salonId", async () => {
    const day = thursdayOf(8);
    const entry = await seedClosedEntry(day, salonA.id);
    const res = await clockIn(day, "13:00", { source: "MOBILE" });
    expect(res.statusCode).toBe(200);
    const after = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(after.endTime).toBeNull();
    expect(after.salonId).toBe(salonA.id);
  });

  it("REOPEN: a foreign and an unknown salon answer the byte-identical 404 (validated before the comparison)", async () => {
    const day = thursdayOf(9);
    const entry = await seedClosedEntry(day, salonA.id);
    const resForeign = await clockIn(day, "13:00", { source: "MOBILE", salonId: foreign.salonId });
    const resUnknown = await clockIn(day, "13:00", { source: "MOBILE", salonId: randomUUID() });
    expect(resForeign.statusCode).toBe(404);
    expect(resUnknown.statusCode).toBe(404);
    expect(resForeign.body).toBe(resUnknown.body);
    expect(resForeign.body).toBe(JSON.stringify({ error: "Salon nicht gefunden" }));
    const after = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(after.endTime).not.toBeNull();
  });

  it("REOPEN: an own deactivated salon answers 400 SALON_INACTIVE", async () => {
    const day = thursdayOf(10);
    await seedClosedEntry(day, salonA.id);
    const res = await clockIn(day, "13:00", { source: "MOBILE", salonId: salonInactive.id });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: "Salon ist deaktiviert",
      code: "SALON_INACTIVE",
    });
  });

  it("REOPEN of a locked entry: an unknown salon answers 404 before MONTH_LOCKED, no salonId keeps MONTH_LOCKED", async () => {
    const day = thursdayOf(11);
    await seedClosedEntry(day, salonA.id, { locked: true });
    const resUnknown = await clockIn(day, "13:00", { source: "MOBILE", salonId: randomUUID() });
    expect(resUnknown.statusCode).toBe(404);
    expect(resUnknown.body).toBe(JSON.stringify({ error: "Salon nicht gefunden" }));
    const resPlain = await clockIn(day, "13:00", { source: "MOBILE" });
    expect(resPlain.statusCode).toBe(409);
    expect((JSON.parse(resPlain.body) as { error: string }).error).toBe(
      "Eintrag ist gesperrt und kann nicht bearbeitet werden",
    );
  });

  it("OPEN state: a foreign and an unknown salon both answer the pre-existing 409 Bereits eingestempelt, byte-identical", async () => {
    const day = thursdayOf(12);
    const first = await clockIn(day, "09:00", { source: "MOBILE" });
    expect(first.statusCode).toBe(200);
    const resForeign = await clockIn(day, "09:05", { source: "MOBILE", salonId: foreign.salonId });
    const resUnknown = await clockIn(day, "09:05", { source: "MOBILE", salonId: randomUUID() });
    expect(resForeign.statusCode).toBe(409);
    expect(resUnknown.statusCode).toBe(409);
    expect(resForeign.body).toBe(resUnknown.body);
    expect((JSON.parse(resForeign.body) as { error: string }).error).toBe("Bereits eingestempelt");
  });

  it("a manager clocking in on behalf can name the salon", async () => {
    const day = thursdayOf(13);
    const res = await clockIn(
      day,
      "09:00",
      { employeeId: seed.employee.id, source: "MOBILE", salonId: salonC.id },
      seed.adminToken,
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as ClockInBody;
    expect(body.resolution.entry.salonId).toBe(salonC.id);
  });
});
