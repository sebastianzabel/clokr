/**
 * Phase 69b (Issue #69) — characterization of every path that reads "the time entries of one
 * employee on one day".
 *
 * Written and pinned GREEN against the code BEFORE the day lookups were routed through
 * `findEntriesOfDay()`; its test code must stay unchanged and green afterwards. That is the
 * evidence that the refactor changed no behaviour (Issue #69: saldo and ArbZG findings identical
 * before and after the change).
 *
 * It deliberately enters only through signatures the refactor does NOT change — `checkArbZG`,
 * `resolveClockEvent`, and the HTTP routes (`/time-entries`, `/presence/events`,
 * `/overtime/:employeeId`) — never `checkOneEntryPerDay` or `consolidateSameDayEntries` directly,
 * whose parameter lists gain a `tenantId`. The consolidation predecessor pick is characterized in
 * `services/clock/__tests__/resolver-reopen.integration.test.ts` instead.
 *
 * Not reachable deterministically here: the "winner of a lost race" branch of the WIFI connected
 * handler (`presence.ts`, the `ALREADY_CLOCKED_IN` fallback lookup). It stays covered by
 * `services/clock/__tests__/race.presence.test.ts`.
 *
 * All calendar days are derived from the tenant-TZ "today" via `test-dates.ts` (no absolute date
 * literal, no `toISOString().slice(0, 10)`), so the file cannot expire and survives the midnight
 * harness (`CLOKR_TEST_FAKE_CLOCK`).
 */
import { createHash } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { fromZonedTime } from "date-fns-tz";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { TEST_TZ, todayStr, addDaysStr, utcMidnight, holidayFreeMondayStr } from "./test-dates";
import { checkArbZG } from "../contexts/time-tracking/arbzg";
import { resolveClockEvent } from "../services/clock/resolver";
import type { ClockEvent, ClockIntent } from "../services/clock/types";

const ONE_PER_DAY_MSG =
  "Es existiert bereits ein Eintrag für diesen Tag. Bitte den bestehenden Eintrag bearbeiten.";

/** Tenant-local wall-clock time on `day` as a UTC instant. */
function at(day: string, hhmm: string): Date {
  return fromZonedTime(`${day}T${hhmm}:00`, TEST_TZ);
}

function offsetHours(day: string): number {
  return (at(day, "12:00").getTime() - utcMidnight(day).getTime()) / 3_600_000;
}

// A Monday at least three weeks back (clear of the retro window's "today" edge and of any open
// month logic), in a holiday-free week, with no DST switch between M0 and M0 + 8.
const M0 = holidayFreeMondayStr(-8, "NI", (monday) => {
  if (addDaysStr(monday, 8) > addDaysStr(todayStr(), -21)) return false;
  return offsetHours(monday) === offsetHours(addDaysStr(monday, 8));
});
const M = Array.from({ length: 8 }, (_, i) => addDaysStr(M0, i)); // M[0]..M[7]

const RUN_ID = Date.now().toString(36);
const PRESENCE_KEY = `clk_dlc_${RUN_ID}`;
const W_MAC = "aa:bb:cc:dd:69:0b";

describe("Phase 69b — day-lookup characterization (pinned before the refactor)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let A: string; // ArbZG + saldo
  let B: string; // saldo reference, no entries
  let R: string; // resolver
  let W: string; // WIFI presence
  let P: string; // one-per-day (data.employee — has empToken)
  const extraUserIds: string[] = [];
  let presenceSourceId: string;

  async function makeEmployee(label: string, extra: Record<string, unknown> = {}): Promise<string> {
    const user = await app.prisma.user.create({
      data: {
        email: `dlc-${label}-${RUN_ID}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    extraUserIds.push(user.id);
    const emp = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `DLC-${label}-${RUN_ID}`,
        firstName: "Char",
        lastName: label,
        hireDate: utcMidnight(addDaysStr(M0, -14)),
        ...extra,
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: utcMidnight(addDaysStr(M0, -14)),
      },
    });
    await app.prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });
    return emp.id;
  }

  async function entry(
    employeeId: string,
    day: string,
    from: string,
    to: string | null,
    extra: Record<string, unknown> = {},
  ) {
    return app.prisma.timeEntry.create({
      data: {
        employeeId,
        date: utcMidnight(day),
        startTime: at(day, from),
        endTime: to ? at(day, to) : null,
        breakMinutes: 0,
        source: "MANUAL",
        type: "WORK",
        ...extra,
      },
    });
  }

  function clockEvent(day: string, hhmm: string, source: string, intent: ClockIntent): ClockEvent {
    return {
      employeeId: R,
      tenantId: data.tenant.id,
      source,
      intent,
      timestamp: at(day, hhmm),
      date: utcMidnight(day),
      dateStr: day,
      actor: { type: "SYSTEM" },
    };
  }

  async function liveRows(employeeId: string, day: string) {
    return app.prisma.timeEntry.findMany({
      where: { employeeId, date: utcMidnight(day), deletedAt: null },
      orderBy: { startTime: "asc" },
    });
  }

  async function presence(day: string, hhmm: string, eventType: "connected" | "disconnected") {
    return app.inject({
      method: "POST",
      url: "/api/v1/presence/events",
      headers: { authorization: `Bearer ${PRESENCE_KEY}` },
      payload: { mac: W_MAC, eventType, timestamp: at(day, hhmm).toISOString() },
    });
  }

  async function wifiAudits(action: string, entityId: string) {
    return app.prisma.auditLog.count({ where: { action, entityId } });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "dlc");
    P = data.employee.id;
    A = await makeEmployee("A");
    B = await makeEmployee("B");
    R = await makeEmployee("R");
    W = await makeEmployee("W", { wifiPresenceEnabled: true, wifiMacs: [W_MAC] });

    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { timezone: TEST_TZ, wifiPresenceWindowMinutes: 15 },
    });
    const src = await app.prisma.presenceSource.create({
      data: {
        tenantId: data.tenant.id,
        name: "dlc",
        keyHash: createHash("sha256").update(PRESENCE_KEY).digest("hex"),
        keyPrefix: PRESENCE_KEY.slice(0, 8),
      },
    });
    presenceSourceId = src.id;

    // ── Employee A: one scenario per day ─────────────────────────────────────
    // M0: > 10 h net and > 9 h with < 45 min break.
    await entry(A, M[0], "06:00", "17:00", { breakMinutes: 30 });
    // M1: starts 10 h after M0 ended → rest period violated in both directions.
    await entry(A, M[1], "03:00", "12:00", { breakMinutes: 45 });
    // M2: vocational-school day only, no entry.
    await app.prisma.absence.create({
      data: {
        employeeId: A,
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        startDate: utcMidnight(M[2]),
        endDate: utcMidnight(M[2]),
        days: 1.0,
        createdBy: "dlc-test",
      },
    });
    // M3: early start after the BS day; > 9 h with a 15 min break, waived.
    await entry(A, M[3], "04:00", "13:45", { breakMinutes: 15, breakStatus: "WAIVED" });
    // M4: one live invalid row plus one soft-deleted row (the partial index allows both).
    await entry(A, M[4], "08:00", "12:00", { isInvalid: true });
    await entry(A, M[4], "07:00", "19:00", { deletedAt: new Date() });
    // M5: only a non-WORK row late in the evening (not a day slot, but a rest-period neighbour).
    await entry(A, M[5], "20:00", "23:30", { type: "PUBLIC_HOLIDAY" });
    // M6: starts 6.5 h after M5's row ended.
    await entry(A, M[6], "06:00", "10:00");
    // M7: an open entry.
    await entry(A, M[7], "07:00", null);
  });

  afterAll(async () => {
    try {
      const ids = [A, B, R, W, P].filter(Boolean);
      const entries = await app.prisma.timeEntry.findMany({
        where: { employeeId: { in: ids } },
        select: { id: true },
      });
      const entryIds = entries.map((e) => e.id);
      await app.prisma.auditLog.deleteMany({
        where: { entityId: { in: [...entryIds, ...ids] } },
      });
      await app.prisma.break.deleteMany({ where: { timeEntryId: { in: entryIds } } });
      await app.prisma.timeEntry.deleteMany({ where: { employeeId: { in: ids } } });
      const retro = await app.prisma.retroEntryRequest.findMany({
        where: { employeeId: { in: ids } },
        select: { id: true },
      });
      await app.prisma.auditLog.deleteMany({ where: { entityId: { in: retro.map((r) => r.id) } } });
      await app.prisma.retroEntryRequest.deleteMany({ where: { employeeId: { in: ids } } });
      await app.prisma.presenceSource.deleteMany({ where: { id: presenceSourceId } });
      await cleanupTestData(app, data.tenant.id);
      await app.prisma.user.deleteMany({ where: { id: { in: extraUserIds } } });
    } catch (err) {
      console.error("day-lookup-characterization cleanup failed:", err);
    }
    await closeTestApp();
  });

  // ── checkArbZG: § 3 / § 4 / § 5 per day ────────────────────────────────────
  it("checkArbZG M0: daily max + break too short + rest to the next day", async () => {
    expect(await checkArbZG(app.prisma, A, utcMidnight(M[0]))).toMatchInlineSnapshot(`
      [
        {
          "code": "BREAK_TOO_SHORT",
          "message": "§ 4 ArbZG: Bei über 9 Stunden Arbeitszeit sind mindestens 45 Minuten Pause vorgeschrieben. Erfasst: 30 Min.",
          "severity": "error",
        },
        {
          "code": "MAX_DAILY_EXCEEDED",
          "message": "§ 3 ArbZG: Tägliche Höchstarbeitszeit von 10 Stunden überschritten. Erfasst: 10.5 h.",
          "severity": "error",
        },
        {
          "code": "MIN_REST_VIOLATED",
          "message": "§ 5 ArbZG: Mindestruhezeit zum Folgetag unterschritten. Ruhezeit: 10.0 h.",
          "severity": "warning",
        },
      ]
    `);
  });
  it("checkArbZG M1: rest period to the previous day", async () => {
    expect(await checkArbZG(app.prisma, A, utcMidnight(M[1]))).toMatchInlineSnapshot(`
      [
        {
          "code": "MIN_REST_VIOLATED",
          "message": "§ 5 ArbZG: Mindestruhezeit von 11 Stunden zwischen Arbeitstagen unterschritten. Ruhezeit: 10.0 h.",
          "severity": "warning",
        },
      ]
    `);
  });
  it("checkArbZG M2: BS-only day, rest to the next day's early start", async () => {
    expect(await checkArbZG(app.prisma, A, utcMidnight(M[2]))).toMatchInlineSnapshot(`
      [
        {
          "code": "MIN_REST_VIOLATED",
          "message": "§ 5 ArbZG: Mindestruhezeit zum Folgetag unterschritten. Ruhezeit: 10.0 h.",
          "severity": "warning",
        },
      ]
    `);
  });
  it("checkArbZG M3: waived break, previous day has no slot", async () => {
    expect(await checkArbZG(app.prisma, A, utcMidnight(M[3]))).toMatchInlineSnapshot(`
      [
        {
          "code": "BREAK_TOO_SHORT",
          "message": "§ 4 ArbZG: Bei über 9 Stunden Arbeitszeit sind mindestens 45 Minuten Pause vorgeschrieben. Erfasst: 15 Min.",
          "severity": "warning",
          "waived": true,
        },
      ]
    `);
  });
  it("checkArbZG M4: invalid live row + soft-deleted row", async () => {
    expect(await checkArbZG(app.prisma, A, utcMidnight(M[4]))).toMatchInlineSnapshot(`[]`);
  });
  it("checkArbZG M5: only a non-WORK row", async () => {
    expect(await checkArbZG(app.prisma, A, utcMidnight(M[5]))).toMatchInlineSnapshot(`[]`);
  });
  it("checkArbZG M6: rest period to a non-WORK row on the previous day", async () => {
    expect(await checkArbZG(app.prisma, A, utcMidnight(M[6]))).toMatchInlineSnapshot(`
      [
        {
          "code": "MIN_REST_VIOLATED",
          "message": "§ 5 ArbZG: Mindestruhezeit von 11 Stunden zwischen Arbeitstagen unterschritten. Ruhezeit: 6.5 h.",
          "severity": "warning",
        },
      ]
    `);
  });
  it("checkArbZG M7: open entry only", async () => {
    expect(await checkArbZG(app.prisma, A, utcMidnight(M[7]))).toMatchInlineSnapshot(`[]`);
  });

  // ── Saldo: A minus the identically configured, entry-less B ────────────────
  it("overtime saldo difference A − B", async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
    try {
      const get = async (id: string) => {
        const res = await app.inject({
          method: "GET",
          url: `/api/v1/overtime/${id}`,
          headers: { authorization: `Bearer ${data.adminToken}` },
        });
        expect(res.statusCode).toBe(200);
        return Math.round(JSON.parse(res.body).balanceHours * 60);
      };
      const diff = (await get(A)) - (await get(B));
      expect(diff).toMatchInlineSnapshot(`2415`);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Resolver: open / closed / reopen / confirm / conflict on one day ────────
  it("resolver sequence on one day: START, STOP, REOPEN, CONFIRM, ALREADY_CLOCKED_IN, STOP", async () => {
    const infoSpy = vi.spyOn(app.log, "info");
    try {
      const d = M[3];
      const r1 = await resolveClockEvent(app, clockEvent(d, "08:00", "NFC", "AUTO"));
      expect(r1.kind).toBe("CLOCKED_IN");
      const id = r1.kind === "CLOCKED_IN" ? r1.entry.id : "";

      const r2 = await resolveClockEvent(app, clockEvent(d, "12:00", "NFC", "AUTO"));
      expect(r2.kind).toBe("CLOCKED_OUT");
      expect(
        infoSpy.mock.calls.some(
          (c) =>
            c[1] === "merge_skipped" && (c[0] as { reason?: string }).reason === "no_predecessor",
        ),
      ).toBe(true);

      const r3 = await resolveClockEvent(app, clockEvent(d, "12:45", "NFC", "AUTO"));
      expect(r3.kind).toBe("CLOCKED_IN");
      expect(r3.kind === "CLOCKED_IN" ? r3.entry.id : "").toBe(id);
      const breaks = await app.prisma.break.findMany({ where: { timeEntryId: id } });
      expect(breaks).toHaveLength(1);

      const r4 = await resolveClockEvent(app, clockEvent(d, "13:00", "MOBILE", "AUTO"));
      expect(r4).toMatchObject({ kind: "CONFIRMED", entryId: id });

      const r5 = await resolveClockEvent(app, clockEvent(d, "13:05", "MOBILE", "IN"));
      expect(r5).toMatchObject({ kind: "CONFLICT", reason: "ALREADY_CLOCKED_IN" });

      const r6 = await resolveClockEvent(app, clockEvent(d, "16:30", "NFC", "OUT"));
      expect(r6.kind).toBe("CLOCKED_OUT");

      const rows = await liveRows(R, d);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(id);
      expect(rows[0].startTime.toISOString()).toBe(at(d, "08:00").toISOString());
      expect(rows[0].endTime?.toISOString()).toBe(at(d, "16:30").toISOString());
      expect(rows[0].breakMinutes).toBe(45);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("resolver: OUT without any entry → NOT_CLOCKED_IN", async () => {
    const r = await resolveClockEvent(app, clockEvent(M[1], "17:00", "NFC", "OUT"));
    expect(r).toMatchObject({ kind: "CONFLICT", reason: "NOT_CLOCKED_IN" });
  });

  it("resolver: OUT with only a closed entry → NOT_CLOCKED_IN", async () => {
    await entry(R, M[2], "08:00", "12:00");
    const r = await resolveClockEvent(app, clockEvent(M[2], "17:00", "NFC", "OUT"));
    expect(r).toMatchObject({ kind: "CONFLICT", reason: "NOT_CLOCKED_IN" });
  });

  it("resolver: closed row coupled to a PENDING Nachtrag → RETRO_PENDING", async () => {
    const req = await app.prisma.retroEntryRequest.create({
      data: { employeeId: R, targetDate: utcMidnight(M[4]), reason: "dlc", status: "PENDING" },
    });
    await entry(R, M[4], "08:00", "12:00", { retroRequestId: req.id, isInvalid: true });
    const r = await resolveClockEvent(app, clockEvent(M[4], "13:00", "NFC", "IN"));
    expect(r).toMatchObject({ kind: "CONFLICT", reason: "RETRO_PENDING" });
  });

  it("resolver: an open invalid row is closed and stays invalid", async () => {
    const open = await entry(R, M[0], "08:00", null, { isInvalid: true });
    const r = await resolveClockEvent(app, clockEvent(M[0], "16:00", "NFC", "OUT"));
    expect(r.kind).toBe("CLOCKED_OUT");
    const after = await app.prisma.timeEntry.findUnique({ where: { id: open.id } });
    expect(after?.endTime?.toISOString()).toBe(at(M[0], "16:00").toISOString());
    expect(after?.isInvalid).toBe(true);
  });

  it("resolver: a soft-deleted closed row is invisible — IN creates a new row", async () => {
    const gone = await entry(R, M[5], "08:00", "12:00", { deletedAt: new Date() });
    const r = await resolveClockEvent(app, clockEvent(M[5], "13:00", "NFC", "IN"));
    expect(r.kind).toBe("CLOCKED_IN");
    expect(r.kind === "CLOCKED_IN" ? r.entry.id : gone.id).not.toBe(gone.id);
    expect(await liveRows(R, M[5])).toHaveLength(1);
  });

  // ── WIFI presence: dedup against existing rows ─────────────────────────────
  it("WIFI: connected on a day with a MANUAL row confirms it, no new row", async () => {
    const d = M[1];
    await app.prisma.shift.create({
      data: { employeeId: W, date: utcMidnight(d), startTime: "09:00", endTime: "17:00" },
    });
    const manual = await entry(W, d, "08:55", "17:00");
    const res = await presence(d, "09:05", "connected");
    expect(res.statusCode).toBe(200);
    expect(await liveRows(W, d)).toHaveLength(1);
    expect(await wifiAudits("WIFI_PRESENCE_CONFIRMED", manual.id)).toBe(1);
  });

  it("WIFI: connected twice → one WIFI row, second confirms it; disconnected closes it", async () => {
    const d = M[2];
    await app.prisma.shift.create({
      data: { employeeId: W, date: utcMidnight(d), startTime: "09:00", endTime: "17:00" },
    });
    expect((await presence(d, "09:02", "connected")).statusCode).toBe(200);
    const rows1 = await liveRows(W, d);
    expect(rows1).toHaveLength(1);
    expect(rows1[0].source).toBe("WIFI");
    expect((await presence(d, "09:10", "connected")).statusCode).toBe(200);
    expect(await liveRows(W, d)).toHaveLength(1);
    expect(await wifiAudits("WIFI_PRESENCE_CONFIRMED", rows1[0].id)).toBe(1);
    expect((await presence(d, "17:05", "disconnected")).statusCode).toBe(200);
    const rows2 = await liveRows(W, d);
    expect(rows2).toHaveLength(1);
    expect(rows2[0].endTime?.toISOString()).toBe(at(d, "17:05").toISOString());
  });

  it("WIFI: disconnected without an entry → WIFI_NO_OPEN_ENTRY", async () => {
    const d = M[3];
    await app.prisma.shift.create({
      data: { employeeId: W, date: utcMidnight(d), startTime: "09:00", endTime: "17:00" },
    });
    expect((await presence(d, "17:05", "disconnected")).statusCode).toBe(200);
    expect(await wifiAudits("WIFI_NO_OPEN_ENTRY", W)).toBe(1);
    expect(await liveRows(W, d)).toHaveLength(0);
  });

  it("WIFI: a soft-deleted MANUAL row is invisible — connected creates a WIFI row", async () => {
    const d = M[4];
    await app.prisma.shift.create({
      data: { employeeId: W, date: utcMidnight(d), startTime: "09:00", endTime: "17:00" },
    });
    await entry(W, d, "08:00", "12:00", { deletedAt: new Date() });
    expect((await presence(d, "09:03", "connected")).statusCode).toBe(200);
    const rows = await liveRows(W, d);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("WIFI");
  });

  // ── One entry per day: POST / PUT / grant transaction ──────────────────────
  it("one-per-day: POST on a day with a live row → 409", async () => {
    await entry(P, M[0], "08:00", "12:00");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: P,
        date: M[0],
        startTime: at(M[0], "13:00").toISOString(),
        endTime: at(M[0], "15:00").toISOString(),
      },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe(ONE_PER_DAY_MSG);
  });

  it("one-per-day: POST on a day with only a soft-deleted row → 201", async () => {
    await entry(P, M[1], "08:00", "12:00", { deletedAt: new Date() });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: P,
        date: M[1],
        startTime: at(M[1], "13:00").toISOString(),
        endTime: at(M[1], "15:00").toISOString(),
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it("one-per-day: PUT on the same row excludes itself → 200", async () => {
    const [row] = await liveRows(P, M[0]);
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/time-entries/${row.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        date: M[0],
        startTime: at(M[0], "08:00").toISOString(),
        endTime: at(M[0], "12:15").toISOString(),
        reason: "dlc characterization",
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it("one-per-day inside the grant transaction → 409, grant stays APPROVED", async () => {
    const grant = await app.prisma.retroEntryRequest.create({
      data: { employeeId: P, targetDate: utcMidnight(M[0]), reason: "dlc", status: "APPROVED" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: {
        employeeId: P,
        date: M[0],
        startTime: at(M[0], "13:00").toISOString(),
        endTime: at(M[0], "15:00").toISOString(),
        grantId: grant.id,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe(ONE_PER_DAY_MSG);
    const after = await app.prisma.retroEntryRequest.findUnique({ where: { id: grant.id } });
    expect(after?.status).toBe("APPROVED");
  });
});
