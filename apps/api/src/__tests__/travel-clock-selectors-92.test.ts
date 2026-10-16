/**
 * Issue #92 (Phase 92b-03, D-03/D-06) — the clock, the clock-salon answer, consolidation and the
 * holiday location on a day that holds a travel entry.
 *
 * `latestEndingClosed` is the ONE place that answers "which entry does a re-clock act on" (70b-03);
 * 92b adds the TRAVEL skip there. Proved here, against a real database and through the real routes
 * (fake Date like clock-second-salon-70):
 *
 * - pure: a travel row is never the row a re-clock acts on, and `openEntryOf` never meets one (a
 *   travel row is closed by the database CHECK `TimeEntry_travel_shape_check`);
 * - clock on the day A (salon A) -> travel A->B -> B (salon B): a clock-in without a salon and a
 *   terminal punch re-open B and never touch the travel row; a clock-in with salon A starts a NEW
 *   entry in A;
 * - the clock needs no neighbour hook (the hand-off of 92b-02): a clock START between a travel
 *   entry and its arrival entry is refused by the overlap rule (409 ENTRY_OVERLAP), nothing is
 *   written and every travel row stays anchored;
 * - consolidation never merges into or across a travel row: a crafted, deliberately unanchored day
 *   (written by raw Prisma) keeps every row, with a `merge_skipped` reason `travel_row`;
 * - `GET /time-entries/clock-salon` on the finished travel day names B as the fixed salon and
 *   offers A;
 * - the holiday work location of a travel day is the salon of its earliest entry — always a
 *   non-travel row — with no change in the Unterbau (two salons in different Bundeslaender).
 *
 * No person names in fixtures. Every fixture id is a UUID.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { fromZonedTime } from "date-fns-tz";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { addDaysStr, mondayOfWeekStr, TEST_TZ } from "./test-dates";
import { latestEndingClosed, openEntryOf } from "../contexts/time-tracking/day-entries";
import { travelRowsOrphanedBy } from "../contexts/time-tracking/travel-entry";
import { consolidateSameDayEntries } from "../services/clock/consolidate";
import { getWorkedEntriesInRange } from "../contexts/time-tracking";
import {
  accessContextForJob,
  employeeScopeFor,
  holidaysAtWorkLocation,
} from "../contexts/platform";

/** Tenant-local instant for `HH:MM` on `dayStr`. */
function instant(dayStr: string, hhmm: string): Date {
  return fromZonedTime(`${dayStr}T${hhmm}:00`, TEST_TZ);
}

type ClockBody = {
  error?: string;
  code?: string;
  resolution: { kind: string; reason?: string; entry?: { id: string; salonId: string } };
};

type SalonItem = { id: string; name: string };
type ChoiceBody = {
  offerChoice: boolean;
  preselectedSalonId: string | null;
  salons: SalonItem[];
  fixedSalon: SalonItem | null;
};

const NFC_CARD_ID = `NFC-92B03-${randomUUID()}`;

describe("Issue #92 — pure selectors skip a travel row", () => {
  const at = (hhmm: string) => new Date(`2026-03-10T${hhmm}:00Z`);
  const row = (
    id: string,
    from: string,
    to: string | null,
    activityKind: "UNSPECIFIED" | "TRAVEL" = "UNSPECIFIED",
  ) => ({ id, startTime: at(from), endTime: to === null ? null : at(to), activityKind });

  it("latestEndingClosed over [A, T, B open] returns A, never T", () => {
    const a = row("a", "08:00", "12:00");
    const t = row("t", "12:00", "12:30", "TRAVEL");
    const b = row("b", "12:30", null);
    expect(latestEndingClosed([a, t, b])).toBe(a);
    expect(latestEndingClosed([b, t, a])).toBe(a);
  });

  it("latestEndingClosed over [A, T, B closed] returns B", () => {
    const a = row("a", "08:00", "12:00");
    const t = row("t", "12:00", "12:30", "TRAVEL");
    const b = row("b", "12:30", "14:30");
    expect(latestEndingClosed([a, t, b])).toBe(b);
  });

  it("a day with only a travel row has no row to act on", () => {
    expect(latestEndingClosed([row("t", "12:00", "12:30", "TRAVEL")])).toBeNull();
  });

  it("a travel row ending last does not win a tie either", () => {
    const a = row("a", "08:00", "12:30");
    const t = row("t", "12:00", "12:30", "TRAVEL");
    expect(latestEndingClosed([a, t])).toBe(a);
    expect(latestEndingClosed([t, a])).toBe(a);
  });

  it("openEntryOf over [A, T, B open] returns B, over [A, T, B closed] returns null", () => {
    const a = row("a", "08:00", "12:00");
    const t = row("t", "12:00", "12:30", "TRAVEL");
    const open = row("b", "12:30", null);
    const closed = row("b", "12:30", "14:30");
    expect(openEntryOf([a, t, open])).toBe(open);
    expect(openEntryOf([a, t, closed])).toBeNull();
  });
});

describe("Issue #92 — the clock on a day with a travel entry", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: SalonItem;
  let salonB: SalonItem;
  let salonC: SalonItem;
  let terminalApiKey: string;

  // One distinct past Thursday per case so no case shares a day with another.
  const baseMonday = addDaysStr(mondayOfWeekStr(), -20 * 7);
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

  function clockSalon(dayStr: string, hhmm: string) {
    return withClock(dayStr, hhmm, () =>
      app.inject({
        method: "GET",
        url: "/api/v1/time-entries/clock-salon",
        headers: { authorization: `Bearer ${seed.empToken}` },
      }),
    );
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

  /**
   * A (salon A) 08:00-12:00, T (travel A -> B) 12:00-12:30, B (salon B) `bFrom`-`bTo`, all closed,
   * written straight through Prisma.
   */
  async function travelDay(dayStr: string, bFrom = "12:30", bTo = "14:30") {
    const base = { employeeId: seed.employee.id, date: dateOf(dayStr), source: "MANUAL" as const };
    const a = await app.prisma.timeEntry.create({
      data: {
        ...base,
        startTime: instant(dayStr, "08:00"),
        endTime: instant(dayStr, "12:00"),
        salonId: salonA.id,
      },
    });
    const t = await app.prisma.timeEntry.create({
      data: {
        ...base,
        startTime: instant(dayStr, "12:00"),
        endTime: instant(dayStr, "12:30"),
        salonId: salonA.id,
        activityKind: "TRAVEL",
        travelToSalonId: salonB.id,
      },
    });
    const b = await app.prisma.timeEntry.create({
      data: {
        ...base,
        // A terminal source: a terminal punch toggles (stops) only an entry of its own source,
        // a cross-source punch merely confirms presence.
        source: "NFC",
        startTime: instant(dayStr, bFrom),
        endTime: instant(dayStr, bTo),
        salonId: salonB.id,
      },
    });
    return { a, t, b };
  }

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "tc92");
    salonA = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon A" });
    salonB = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon B" });
    salonC = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon C" });

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
  });

  afterAll(async () => {
    try {
      await app.prisma.terminalApiKey.deleteMany({ where: { tenantId: seed.tenant.id } });
      await cleanupTestData(app, seed.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("clock-in without a salon re-opens B, the travel row stays untouched; out, terminal re-open and stop; a new entry in A starts a NEW row", async () => {
    const day = thursdayOf(0);
    const { a, t, b } = await travelDay(day);
    const tBefore = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: t.id } });

    const reopen = await clockIn(day, "15:00", { source: "MOBILE" });
    expect(reopen.statusCode, reopen.body).toBe(200);
    expect((JSON.parse(reopen.body) as ClockBody).resolution.entry!.id).toBe(b.id);
    const bOpen = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: b.id } });
    expect(bOpen.endTime).toBeNull();
    expect(bOpen.salonId).toBe(salonB.id);
    const gap = await app.prisma.break.findMany({ where: { timeEntryId: b.id } });
    expect(gap).toHaveLength(1);
    expect(gap[0].startTime.toISOString()).toBe(instant(day, "14:30").toISOString());
    expect(gap[0].endTime?.toISOString()).toBe(instant(day, "15:00").toISOString());

    const out = await clockOut(day, "16:00", b.id);
    expect(out.statusCode, out.body).toBe(200);

    // The terminal punches: 16:30 re-opens B again, 17:00 stops it.
    const punchIn = await nfcPunch(day, "16:30");
    expect(punchIn.statusCode, punchIn.body).toBe(200);
    expect(JSON.parse(punchIn.body).action).toBe("IN");
    expect((await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: b.id } })).endTime).toBe(
      null,
    );
    const punchOut = await nfcPunch(day, "17:00");
    expect(punchOut.statusCode, punchOut.body).toBe(200);
    expect(JSON.parse(punchOut.body).action).toBe("OUT");
    const bClosed = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: b.id } });
    expect(bClosed.endTime?.toISOString()).toBe(instant(day, "17:00").toISOString());

    // A clock-in with salon A starts a NEW entry in A (D-11 of 70b); B stays closed at 17:00.
    const inA = await clockIn(day, "17:30", { source: "MOBILE", salonId: salonA.id });
    expect(inA.statusCode, inA.body).toBe(200);
    const created = (JSON.parse(inA.body) as ClockBody).resolution.entry!;
    expect(created.id).not.toBe(a.id);
    expect(created.id).not.toBe(b.id);
    expect(created.salonId).toBe(salonA.id);

    const rows = await liveRows(day);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.id)).toEqual([a.id, t.id, b.id, created.id]);
    expect(rows[3].endTime).toBeNull();

    // The travel row is byte-identical to before: times, kind, salons, no Break, no update.
    const tAfter = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: t.id } });
    expect(tAfter).toEqual(tBefore);
    expect(tAfter.activityKind).toBe("TRAVEL");
    expect(await app.prisma.break.count({ where: { timeEntryId: t.id } })).toBe(0);
    expect(await app.prisma.auditLog.count({ where: { entityId: t.id } })).toBe(0);
    expect(travelRowsOrphanedBy(rows)).toEqual([]);
  });

  it("on a crafted day whose trip is the latest-ending row (arrival entry missing) a re-clock re-opens the salon row before it, never the trip", async () => {
    // Unreachable through the write rules (T3/T6 keep an arrival entry), so it is written by raw
    // Prisma: A 08:00-12:00 salon A and a trip A -> B 12:00-12:30 that ends LAST.
    const day = thursdayOf(5);
    const base = { employeeId: seed.employee.id, date: dateOf(day), source: "MANUAL" as const };
    const a = await app.prisma.timeEntry.create({
      data: {
        ...base,
        startTime: instant(day, "08:00"),
        endTime: instant(day, "12:00"),
        salonId: salonA.id,
      },
    });
    const t = await app.prisma.timeEntry.create({
      data: {
        ...base,
        startTime: instant(day, "12:00"),
        endTime: instant(day, "12:30"),
        salonId: salonA.id,
        activityKind: "TRAVEL",
        travelToSalonId: salonB.id,
      },
    });
    const tBefore = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: t.id } });

    const choice = await clockSalon(day, "13:00");
    expect(choice.statusCode, choice.body).toBe(200);
    expect((JSON.parse(choice.body) as ChoiceBody).fixedSalon).toEqual({
      id: salonA.id,
      name: salonA.name,
    });

    const res = await clockIn(day, "13:00", { source: "MOBILE" });
    expect(res.statusCode, res.body).toBe(200);
    expect((JSON.parse(res.body) as ClockBody).resolution.entry!.id).toBe(a.id);
    expect(await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: t.id } })).toEqual(tBefore);
    expect((await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: a.id } })).endTime).toBe(
      null,
    );
  });

  it("the clock needs no neighbour hook: a START between the travel entry and its arrival entry is refused (409 ENTRY_OVERLAP), nothing is written", async () => {
    const day = thursdayOf(1);
    // B starts at 13:00, so 12:30-13:00 is free after T; the only way into it is a START at 12:40.
    const { t } = await travelDay(day, "13:00", "15:00");
    const before = await liveRows(day);
    const auditBefore = await auditRowsOfDay(day);

    for (const payload of [
      { source: "MOBILE", salonId: salonC.id }, // a third salon
      { source: "MOBILE", salonId: salonA.id }, // the departure salon
      { source: "MOBILE" }, // plain: would re-open B (ends after the instant)
    ]) {
      const res = await clockIn(day, "12:40", payload);
      expect(res.statusCode, res.body).toBe(409);
      const body = JSON.parse(res.body) as ClockBody;
      expect(body.code).toBe("ENTRY_OVERLAP");
      expect(body.resolution.reason).toBe("ENTRY_OVERLAP");
    }
    // The terminal cannot get in either: its punch is a plain re-clock of the latest entry.
    const punch = await nfcPunch(day, "12:40");
    expect(punch.statusCode, punch.body).toBe(409);

    const after = await liveRows(day);
    expect(after).toEqual(before);
    expect(after.every((e) => e.endTime !== null)).toBe(true);
    expect(await auditRowsOfDay(day)).toBe(auditBefore);
    expect(await app.prisma.break.count({ where: { timeEntry: { id: t.id } } })).toBe(0);
    expect(travelRowsOrphanedBy(after)).toEqual([]);
  });

  describe("consolidation never merges into or across a travel row", () => {
    /**
     * A crafted day that bypassed `validateTravelEntry`: P 08:00-12:00 salon B, a TRAVEL row
     * 12:00-12:30 B -> A, and a row O of salon B from 12:30 (shape-valid, deliberately UNANCHORED:
     * no arrival entry in salon A exists). A clock-out of O would extend P over the trip.
     */
    async function craftedDay(dayStr: string, oEnd: string | null) {
      const base = {
        employeeId: seed.employee.id,
        date: dateOf(dayStr),
        source: "MANUAL" as const,
      };
      const p = await app.prisma.timeEntry.create({
        data: {
          ...base,
          startTime: instant(dayStr, "08:00"),
          endTime: instant(dayStr, "12:00"),
          salonId: salonB.id,
        },
      });
      const t = await app.prisma.timeEntry.create({
        data: {
          ...base,
          startTime: instant(dayStr, "12:00"),
          endTime: instant(dayStr, "12:30"),
          salonId: salonB.id,
          activityKind: "TRAVEL",
          travelToSalonId: salonA.id,
        },
      });
      const o = await app.prisma.timeEntry.create({
        data: {
          ...base,
          startTime: instant(dayStr, "12:30"),
          endTime: oEnd === null ? null : instant(dayStr, oEnd),
          salonId: salonB.id,
        },
      });
      return { p, t, o };
    }

    it("a clock-out of the row after the trip merges nothing and fails nothing: P, T and O keep their times", async () => {
      const day = thursdayOf(2);
      const { p, t, o } = await craftedDay(day, null);
      const before = [p, t].map((r) => ({
        id: r.id,
        start: r.startTime.toISOString(),
        end: r.endTime!.toISOString(),
      }));

      const out = await clockOut(day, "13:00", o.id);
      expect(out.statusCode, out.body).toBe(200);
      expect((JSON.parse(out.body) as ClockBody).resolution.kind).not.toBe("CONSOLIDATED");

      const rows = await liveRows(day);
      expect(rows.map((r) => r.id)).toEqual([p.id, t.id, o.id]);
      expect(rows.map((r) => [r.startTime.toISOString(), r.endTime?.toISOString()])).toEqual([
        [before[0].start, before[0].end],
        [before[1].start, before[1].end],
        [instant(day, "12:30").toISOString(), instant(day, "13:00").toISOString()],
      ]);
      expect(await app.prisma.break.count({ where: { timeEntryId: { in: [p.id, t.id] } } })).toBe(
        0,
      );
    });

    it("the guard reports merge_skipped with reason travel_row (before the salon guard)", async () => {
      const day = thursdayOf(3);
      const { p, t, o } = await craftedDay(day, "13:00");
      const infos: Array<[Record<string, unknown>, string]> = [];
      const log = {
        info: (obj: Record<string, unknown>, msg: string) => infos.push([obj, msg]),
        warn: () => undefined,
        error: () => undefined,
      };
      const result = await app.prisma.$transaction((tx) =>
        consolidateSameDayEntries(tx, seed.tenant.id, o, 4, log as never),
      );
      expect(result).toEqual({ merged: false });
      expect(infos.filter(([, msg]) => msg === "merge_skipped").map(([obj]) => obj.reason)).toEqual(
        ["travel_row"],
      );
      const rows = await liveRows(day);
      expect(rows.map((r) => r.id)).toEqual([p.id, t.id, o.id]);
      expect(rows[0].endTime?.toISOString()).toBe(instant(day, "12:00").toISOString());
    });
  });

  it("GET /time-entries/clock-salon on the finished travel day names B as the fixed salon and offers A; with B running it offers nothing", async () => {
    const day = thursdayOf(4);
    const { b } = await travelDay(day);

    const finished = await clockSalon(day, "15:30");
    expect(finished.statusCode, finished.body).toBe(200);
    const choice = JSON.parse(finished.body) as ChoiceBody;
    expect(choice.fixedSalon).toEqual({ id: salonB.id, name: salonB.name });
    expect(choice.offerChoice).toBe(true);
    const offered = choice.salons.map((s) => s.id);
    expect(offered).toContain(salonA.id);
    expect(offered).toContain(salonC.id);
    expect(offered).not.toContain(salonB.id);

    await app.prisma.timeEntry.update({ where: { id: b.id }, data: { endTime: null } });
    const running = await clockSalon(day, "15:30");
    expect(running.statusCode, running.body).toBe(200);
    const runningChoice = JSON.parse(running.body) as ChoiceBody;
    expect(runningChoice.fixedSalon).toEqual({ id: salonB.id, name: salonB.name });
    expect(runningChoice.offerChoice).toBe(false);
    expect(runningChoice.salons).toEqual([]);
  });
});

describe("Issue #92 — the holiday work location of a travel day (no Unterbau change)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let salonBy: { id: string }; // BAYERN: Fronleichnam is a statutory holiday
  let salonNi: { id: string }; // NIEDERSACHSEN: it is not

  // Fronleichnam 2026 = Thursday 2026-06-04 (BAYERN, not NIEDERSACHSEN). No snapshot is closed for
  // June 2026 in this tenant, the rows are written straight through Prisma.
  const DAY = "2026-06-04";
  const dateOf = (dayStr: string) => new Date(`${dayStr}T00:00:00Z`);

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "tc92-hol");
    salonNi = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Salon NI",
      federalState: "NIEDERSACHSEN",
    });
    salonBy = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Salon BY",
      federalState: "BAYERN",
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, seed.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  /** first (08-12) -> travel first->second (12-12:30) -> second (12:30-14:30) for `employeeId`. */
  async function travelDayOf(employeeId: string, first: { id: string }, second: { id: string }) {
    const base = { employeeId, date: dateOf(DAY), source: "MANUAL" as const };
    await app.prisma.timeEntry.create({
      data: {
        ...base,
        startTime: instant(DAY, "08:00"),
        endTime: instant(DAY, "12:00"),
        salonId: first.id,
      },
    });
    await app.prisma.timeEntry.create({
      data: {
        ...base,
        startTime: instant(DAY, "12:00"),
        endTime: instant(DAY, "12:30"),
        salonId: first.id,
        activityKind: "TRAVEL",
        travelToSalonId: second.id,
      },
    });
    await app.prisma.timeEntry.create({
      data: {
        ...base,
        startTime: instant(DAY, "12:30"),
        endTime: instant(DAY, "14:30"),
        salonId: second.id,
      },
    });
  }

  async function holidayOf(employeeId: string): Promise<string | undefined> {
    const scope = employeeScopeFor(
      accessContextForJob(seed.tenant.id, "travel-clock-selectors-92"),
      {
        employeeIds: [employeeId],
      },
    );
    const t2 = await getWorkedEntriesInRange(app.prisma, scope, dateOf(DAY), dateOf(DAY));
    // The T2 rows hold the trip as a third row: the proof is not vacuous.
    expect(t2).toHaveLength(3);
    const earliest = [...t2].sort((x, y) => x.startTime.getTime() - y.startTime.getTime())[0];
    const travel = await app.prisma.timeEntry.findFirstOrThrow({
      where: { employeeId, date: dateOf(DAY), activityKind: "TRAVEL" },
    });
    expect(earliest.id).not.toBe(travel.id);
    const result = await holidaysAtWorkLocation(
      app.prisma,
      seed.tenant.id,
      [employeeId],
      DAY,
      DAY,
      t2,
    );
    return result.get(employeeId)?.get(DAY);
  }

  it("A in the holiday state, then the trip, then B: the day is a holiday (the first salon decides)", async () => {
    await travelDayOf(seed.employee.id, salonBy, salonNi);
    expect(await holidayOf(seed.employee.id)).toBe("Fronleichnam");
  });

  it("A without the holiday, then the trip, then B in the holiday state: no holiday", async () => {
    await travelDayOf(seed.adminEmployee.id, salonNi, salonBy);
    expect(await holidayOf(seed.adminEmployee.id)).toBeUndefined();
  });
});
