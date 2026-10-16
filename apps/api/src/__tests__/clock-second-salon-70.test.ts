/**
 * Issue #70 (Phase 70b-03, D-02/D-03/D-11, W8) — the clock with several entries per day.
 *
 * Proves, against a real database and through the real routes (fake Date like clock-in-salon-87):
 *
 * - an explicitly DIFFERENT salon on a finished day starts a NEW entry in that salon; the first
 *   entry stays untouched (no Break row, no audit row of its own);
 * - without a salon, or with the salon of the latest-ending entry, the latest-ending entry is
 *   re-opened as before (gap becomes a Break, the salon is kept);
 * - every START is refused with 409 ENTRY_OVERLAP when its instant lies inside or before a closed
 *   entry of the employee — also a LATER closed entry of the same day, because a running entry
 *   counts as running to the end of its day — and nothing is written; a re-open of an entry that
 *   ends after the instant is refused the same way instead of writing a negative gap break;
 * - every START is refused with 409 MONTH_LOCKED on a locked day or in a month with a closed
 *   SaldoSnapshot (Revisionssicherheit, W8);
 * - a running entry still answers "Bereits eingestempelt"; a foreign and an unknown salon answer
 *   the byte-identical 404 (T-100-09), an inactive one 400, on a booked day;
 * - the NFC terminal (no salon input) re-opens the latest entry of a two-salon day;
 * - two parallel clock-ins into a second salon create exactly one open entry.
 *
 * No person names in fixtures. Every fixture id is a UUID.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { fromZonedTime } from "date-fns-tz";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon, auditRowsFor } from "./setup";
import { addDaysStr, mondayOfWeekStr, TEST_TZ } from "./test-dates";

/** Tenant-local instant for `HH:MM` on `dayStr`. */
function instant(dayStr: string, hhmm: string): Date {
  return fromZonedTime(`${dayStr}T${hhmm}:00`, TEST_TZ);
}

type ClockBody = {
  error?: string;
  code?: string;
  resolution: { kind: string; reason?: string; entry?: { id: string; salonId: string } };
};

const CLOSED_MONTH_DAY_LOCKED = "2026-02-17"; // Tuesday of a month that is closed in beforeAll
const CLOSED_MONTH_DAY_FREE = "2026-02-18"; // same month, no entry on it
const NFC_CARD_ID = `NFC-70B03-${randomUUID()}`;

describe("Issue #70 — clock into a second salon (D-02/D-11)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  let salonInactive: { id: string };
  let foreign: Awaited<ReturnType<typeof seedTestData>>;
  let terminalApiKey: string;

  // One distinct past Thursday per case so no case shares a day with another.
  const baseMonday = addDaysStr(mondayOfWeekStr(), -16 * 7);
  const thursdayOf = (weekOffset: number): string => addDaysStr(baseMonday, weekOffset * 7 + 3);
  const dateOf = (dayStr: string) => new Date(`${dayStr}T00:00:00Z`);

  async function withClock<T>(dayStr: string, hhmm: string, fn: () => Promise<T>): Promise<T> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(instant(dayStr, hhmm));
    try {
      return await fn();
    } finally {
      vi.useRealTimers();
    }
  }

  /** POST /clock-in at `hhmm` of `dayStr` (tenant time) with the employee's token. */
  function clockIn(dayStr: string, hhmm: string, payload: Record<string, unknown>) {
    return withClock(dayStr, hhmm, () =>
      app.inject({
        method: "POST",
        url: "/api/v1/time-entries/clock-in",
        headers: { authorization: `Bearer ${seed.empToken}` },
        payload,
      }),
    );
  }

  function clockOut(dayStr: string, hhmm: string, entryId: string) {
    return withClock(dayStr, hhmm, () =>
      app.inject({
        method: "POST",
        url: `/api/v1/time-entries/${entryId}/clock-out`,
        headers: { authorization: `Bearer ${seed.empToken}` },
        payload: {},
      }),
    );
  }

  function nfcPunch(dayStr: string, hhmm: string) {
    return withClock(dayStr, hhmm, () =>
      app.inject({
        method: "POST",
        url: "/api/v1/time-entries/nfc-punch",
        headers: { authorization: `Bearer ${terminalApiKey}` },
        payload: { nfcCardId: NFC_CARD_ID },
      }),
    );
  }

  /** A closed entry `from`-`to` of `dayStr` booked to `salonId`. */
  function seedClosed(
    dayStr: string,
    salonId: string,
    from: string,
    to: string,
    opts: { locked?: boolean } = {},
  ) {
    return app.prisma.timeEntry.create({
      data: {
        employeeId: seed.employee.id,
        date: dateOf(dayStr),
        startTime: instant(dayStr, from),
        endTime: instant(dayStr, to),
        source: "MOBILE",
        isLocked: opts.locked ?? false,
        breakMinutes: 0,
        salonId,
      },
    });
  }

  const liveRows = (dayStr: string) =>
    app.prisma.timeEntry.findMany({
      where: { employeeId: seed.employee.id, date: dateOf(dayStr), deletedAt: null },
      orderBy: [{ startTime: "asc" }, { id: "asc" }],
    });

  /** Every audit row written for the entries of `dayStr` (soft-deleted ones included). */
  async function auditRowsOfDay(dayStr: string): Promise<number> {
    const rows = await app.prisma.timeEntry.findMany({
      where: { employeeId: seed.employee.id, date: dateOf(dayStr) },
      select: { id: true },
    });
    return app.prisma.auditLog.count({ where: { entityId: { in: rows.map((r) => r.id) } } });
  }

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "cs70");
    foreign = await seedTestData(app, "cs70-foreign");
    salonInactive = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Salon X (deaktiviert)",
      isActive: false,
    });
    salonA = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon A" });
    salonB = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon B" });

    // The terminal: a card on the employee and a terminal key of the tenant.
    await app.prisma.employee.update({
      where: { id: seed.employee.id },
      data: { nfcCardId: NFC_CARD_ID },
    });
    terminalApiKey = `clk_${randomBytes(32).toString("hex")}`;
    await app.prisma.terminalApiKey.create({
      data: {
        tenantId: seed.tenant.id,
        name: "Test Terminal",
        keyHash: createHash("sha256").update(terminalApiKey).digest("hex"),
        keyPrefix: terminalApiKey.substring(0, 12) + "...",
      },
    });

    // Close February 2026 (Berlin): Feb 1 00:00 local = Jan 31 23:00 UTC; one locked entry on it.
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
    await seedClosed(CLOSED_MONTH_DAY_LOCKED, salonA.id, "08:00", "12:00", { locked: true });
  });

  afterAll(async () => {
    try {
      await app.prisma.saldoSnapshot.deleteMany({ where: { employeeId: seed.employee.id } });
      await app.prisma.terminalApiKey.deleteMany({ where: { tenantId: seed.tenant.id } });
      for (const tenantId of [seed.tenant.id, foreign.tenant.id])
        await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("tracer: salon A in, out, then salon B starts a NEW entry; entry A is untouched", async () => {
    const day = thursdayOf(0);
    const inA = await clockIn(day, "08:00", { source: "MOBILE", salonId: salonA.id });
    expect(inA.statusCode, inA.body).toBe(200);
    const entryA = (JSON.parse(inA.body) as ClockBody).resolution.entry!;
    const out = await clockOut(day, "12:00", entryA.id);
    expect(out.statusCode, out.body).toBe(200);
    const auditBefore = await auditRowsFor(app, "TimeEntry", entryA.id);

    const inB = await clockIn(day, "12:30", { source: "MOBILE", salonId: salonB.id });
    expect(inB.statusCode, inB.body).toBe(200);
    const body = JSON.parse(inB.body) as ClockBody;
    expect(body.resolution.kind).toBe("CLOCKED_IN");
    expect(body.resolution.entry!.id).not.toBe(entryA.id);
    expect(body.resolution.entry!.salonId).toBe(salonB.id);

    const rows = await liveRows(day);
    expect(rows).toHaveLength(2);
    const [a, b] = rows;
    expect(a.id).toBe(entryA.id);
    expect(a.salonId).toBe(salonA.id);
    expect(a.endTime?.toISOString()).toBe(instant(day, "12:00").toISOString());
    expect(await app.prisma.break.count({ where: { timeEntryId: a.id } })).toBe(0);
    expect(b.salonId).toBe(salonB.id);
    expect(b.startTime.toISOString()).toBe(instant(day, "12:30").toISOString());
    expect(b.endTime).toBeNull();
    // Entry A got no audit row from the second clock-in; the new entry has exactly one CLOCK_IN.
    expect(await auditRowsFor(app, "TimeEntry", entryA.id)).toHaveLength(auditBefore.length);
    expect(await auditRowsFor(app, "TimeEntry", b.id, "CLOCK_IN")).toHaveLength(1);
    expect(await auditRowsFor(app, "TimeEntry", b.id)).toHaveLength(1);
  });

  it("without a salon, the latest entry (salon B) is re-opened: gap break, salon kept", async () => {
    const day = thursdayOf(1);
    await seedClosed(day, salonA.id, "08:00", "12:00");
    const b = await seedClosed(day, salonB.id, "12:30", "16:00");
    const res = await clockIn(day, "17:00", { source: "MOBILE" });
    expect(res.statusCode, res.body).toBe(200);
    expect((JSON.parse(res.body) as ClockBody).resolution.entry!.id).toBe(b.id);
    const after = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.endTime).toBeNull();
    expect(after.salonId).toBe(salonB.id);
    const breaks = await app.prisma.break.findMany({ where: { timeEntryId: b.id } });
    expect(breaks).toHaveLength(1);
    expect(breaks[0].startTime.toISOString()).toBe(instant(day, "16:00").toISOString());
    expect(breaks[0].endTime?.toISOString()).toBe(instant(day, "17:00").toISOString());
    expect(await liveRows(day)).toHaveLength(2);
  });

  it("with the salon of the latest entry, that entry is re-opened", async () => {
    const day = thursdayOf(2);
    await seedClosed(day, salonA.id, "08:00", "12:00");
    const b = await seedClosed(day, salonB.id, "12:30", "16:00");
    const res = await clockIn(day, "17:00", { source: "MOBILE", salonId: salonB.id });
    expect(res.statusCode, res.body).toBe(200);
    expect((JSON.parse(res.body) as ClockBody).resolution.entry!.id).toBe(b.id);
    expect(await liveRows(day)).toHaveLength(2);
    expect(await auditRowsFor(app, "TimeEntry", b.id, "CLOCK_REOPEN")).toHaveLength(1);
  });

  it("an instant inside the latest entry is refused with 409 ENTRY_OVERLAP and writes nothing", async () => {
    const day = thursdayOf(3);
    await seedClosed(day, salonA.id, "08:00", "12:00");
    await seedClosed(day, salonB.id, "12:30", "16:00");
    const auditBefore = await auditRowsOfDay(day);
    const res = await clockIn(day, "15:30", { source: "MOBILE", salonId: salonA.id });
    expect(res.statusCode, res.body).toBe(409);
    const body = JSON.parse(res.body) as ClockBody;
    expect(body.code).toBe("ENTRY_OVERLAP");
    expect(body.error).toBe(
      "Der Eintrag überschneidet sich mit einem bestehenden Eintrag dieses Tages.",
    );
    expect(body.resolution.reason).toBe("ENTRY_OVERLAP");
    expect(await liveRows(day)).toHaveLength(2);
    expect(await auditRowsOfDay(day)).toBe(auditBefore);
  });

  it("an instant BEFORE a later closed entry of the day is refused (an open entry runs to the end of its day)", async () => {
    const day = thursdayOf(4);
    const a = await seedClosed(day, salonA.id, "08:00", "10:00");
    const b = await seedClosed(day, salonB.id, "14:00", "16:00");
    const withSalon = await clockIn(day, "12:00", { source: "MOBILE", salonId: salonA.id });
    expect(withSalon.statusCode, withSalon.body).toBe(409);
    expect((JSON.parse(withSalon.body) as ClockBody).code).toBe("ENTRY_OVERLAP");
    // Without a salon the latest entry (B, ends 16:00) would be re-opened with a NEGATIVE gap break.
    const plain = await clockIn(day, "12:00", { source: "MOBILE" });
    expect(plain.statusCode, plain.body).toBe(409);
    expect((JSON.parse(plain.body) as ClockBody).code).toBe("ENTRY_OVERLAP");
    expect(await app.prisma.break.count({ where: { timeEntryId: { in: [a.id, b.id] } } })).toBe(0);
    const after = await liveRows(day);
    expect(after).toHaveLength(2);
    expect(after.every((e) => e.endTime !== null)).toBe(true);
    expect(await auditRowsOfDay(day)).toBe(0);
  });

  it("W8: a locked entry on the day refuses a START in another salon (MONTH_LOCKED), nothing written", async () => {
    const res = await clockIn(CLOSED_MONTH_DAY_LOCKED, "13:00", {
      source: "MOBILE",
      salonId: salonB.id,
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({
      error: "Eintrag ist gesperrt und kann nicht bearbeitet werden",
      resolution: { kind: "CONFLICT", reason: "MONTH_LOCKED" },
    });
    expect(await liveRows(CLOSED_MONTH_DAY_LOCKED)).toHaveLength(1);
    expect(await auditRowsOfDay(CLOSED_MONTH_DAY_LOCKED)).toBe(0);
  });

  it("W8: a day without any entry in a closed month refuses a START (MONTH_LOCKED), with and without a salon", async () => {
    for (const payload of [{ source: "MOBILE" }, { source: "MOBILE", salonId: salonB.id }]) {
      const res = await clockIn(CLOSED_MONTH_DAY_FREE, "09:00", payload);
      expect(res.statusCode, res.body).toBe(409);
      expect((JSON.parse(res.body) as ClockBody).resolution.reason).toBe("MONTH_LOCKED");
    }
    expect(await liveRows(CLOSED_MONTH_DAY_FREE)).toHaveLength(0);
  });

  it("W8: an UNLOCKED entry on a day of a closed month still refuses a START in another salon", async () => {
    const day = "2026-02-19";
    await seedClosed(day, salonA.id, "08:00", "12:00");
    const res = await clockIn(day, "13:00", { source: "MOBILE", salonId: salonB.id });
    expect(res.statusCode, res.body).toBe(409);
    expect((JSON.parse(res.body) as ClockBody).resolution.reason).toBe("MONTH_LOCKED");
    expect(await liveRows(day)).toHaveLength(1);
  });

  it("a running entry answers 'Bereits eingestempelt' for any salon", async () => {
    const day = thursdayOf(5);
    const first = await clockIn(day, "09:00", { source: "MOBILE", salonId: salonA.id });
    expect(first.statusCode, first.body).toBe(200);
    const res = await clockIn(day, "09:30", { source: "MOBILE", salonId: salonB.id });
    expect(res.statusCode, res.body).toBe(409);
    expect((JSON.parse(res.body) as ClockBody).error).toBe("Bereits eingestempelt");
    expect(await liveRows(day)).toHaveLength(1);
  });

  it("a booked day: foreign and unknown salon answer the byte-identical 404, an inactive one 400", async () => {
    const day = thursdayOf(6);
    await seedClosed(day, salonA.id, "08:00", "12:00");
    const resForeign = await clockIn(day, "13:00", { source: "MOBILE", salonId: foreign.salonId });
    const resUnknown = await clockIn(day, "13:00", { source: "MOBILE", salonId: randomUUID() });
    expect(resForeign.statusCode).toBe(404);
    expect(resUnknown.statusCode).toBe(404);
    expect(resForeign.body).toBe(resUnknown.body);
    expect(resForeign.body).toBe(JSON.stringify({ error: "Salon nicht gefunden" }));
    const resInactive = await clockIn(day, "13:00", {
      source: "MOBILE",
      salonId: salonInactive.id,
    });
    expect(resInactive.statusCode).toBe(400);
    expect(JSON.parse(resInactive.body)).toEqual({
      error: "Salon ist deaktiviert",
      code: "SALON_INACTIVE",
    });
    const rows = await liveRows(day);
    expect(rows).toHaveLength(1);
    expect(rows[0].endTime).not.toBeNull();
    expect(await auditRowsOfDay(day)).toBe(0);
  });

  it("the NFC terminal (no salon input) re-opens the latest entry of a two-salon day", async () => {
    const day = thursdayOf(7);
    await seedClosed(day, salonA.id, "08:00", "12:00");
    const b = await seedClosed(day, salonB.id, "12:30", "16:00");
    const res = await nfcPunch(day, "17:00");
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body).action).toBe("IN");
    const after = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.endTime).toBeNull();
    expect(after.salonId).toBe(salonB.id);
    expect(await liveRows(day)).toHaveLength(2);
  });

  it("two parallel clock-ins into a second salon create exactly one open entry", async () => {
    const day = thursdayOf(8);
    await seedClosed(day, salonA.id, "08:00", "12:00");
    const results = await withClock(day, "12:30", () =>
      Promise.all(
        [0, 1].map(() =>
          app.inject({
            method: "POST",
            url: "/api/v1/time-entries/clock-in",
            headers: { authorization: `Bearer ${seed.empToken}` },
            payload: { source: "MOBILE", salonId: salonB.id },
          }),
        ),
      ),
    );
    expect(results.map((r) => r.statusCode).sort(), results.map((r) => r.body).join(" | ")).toEqual(
      [200, 409],
    );
    const loser = results.find((r) => r.statusCode === 409)!;
    expect((JSON.parse(loser.body) as ClockBody).error).toBe("Bereits eingestempelt");
    const rows = await liveRows(day);
    expect(rows).toHaveLength(2);
    expect(rows.filter((e) => e.endTime === null)).toHaveLength(1);
  });
});
