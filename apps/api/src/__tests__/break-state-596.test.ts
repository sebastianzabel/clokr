/**
 * Issue #596 (#845) — the running break is a server state of the open entry.
 *
 *   AC-1  a break started on one device is visible (GET /time-entries → breakStartedAt) and can be
 *         ended from any other — the state is the entry's, not the browser's
 *   AC-4  a finished break is an ordinary Break row; breakMinutes is the sum of all Break rows
 *   + clocking out during a break ends it first (no break state survives a closed entry)
 *   + starting twice / ending without a running break is a 409, never a silent no-op
 *   + an unknown id and a foreign tenant's id answer the identical 404 (T-100-09)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { fromZonedTime } from "date-fns-tz";
import { getTestApp, seedTestData, cleanupTestData, soleAuditRow } from "./setup";
import { addDaysStr, mondayOfWeekStr, TEST_TZ } from "./test-dates";

function instant(dayStr: string, hhmm: string): Date {
  return fromZonedTime(`${dayStr}T${hhmm}:00`, TEST_TZ);
}

describe("Issue #596 — the running break lives on the server", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let foreign: Awaited<ReturnType<typeof seedTestData>>;
  const baseMonday = addDaysStr(mondayOfWeekStr(), -9 * 7);
  const day = addDaysStr(baseMonday, 3); // a past Thursday

  async function at<T>(hhmm: string, fn: () => Promise<T>): Promise<T> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(instant(day, hhmm));
    try {
      return await fn();
    } finally {
      vi.useRealTimers();
    }
  }
  const auth = (token = seed.empToken) => ({ authorization: `Bearer ${token}` });
  const breakCall = (id: string, action: "start" | "end", token?: string) =>
    app.inject({
      method: "POST",
      url: `/api/v1/time-entries/${id}/break`,
      headers: auth(token),
      payload: { action },
    });

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "brk596");
    foreign = await seedTestData(app, "brk596f");
  });
  afterAll(async () => {
    for (const s of [seed, foreign]) {
      try {
        await cleanupTestData(app, s.tenant.id);
      } catch (err) {
        console.error("Cleanup failed:", err);
      }
    }
  });

  it("start, see on another device, end; clock-out closes a running break", async () => {
    const clockIn = await at("09:00", () =>
      app.inject({
        method: "POST",
        url: "/api/v1/time-entries/clock-in",
        headers: auth(),
        payload: { source: "MOBILE" },
      }),
    );
    expect(clockIn.statusCode, clockIn.body).toBe(200);
    const entryId = (clockIn.json() as { resolution: { entry: { id: string } } }).resolution.entry
      .id;

    const started = await at("12:00", () => breakCall(entryId, "start"));
    expect(started.statusCode, started.body).toBe(200);
    expect(new Date(started.json().breakStartedAt).getTime()).toBe(instant(day, "12:00").getTime());

    // "device B": a plain read sees the running break
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/time-entries?from=${day}&to=${day}`,
      headers: auth(),
    });
    const row = (list.json() as { id: string; breakStartedAt: string | null }[]).find(
      (e) => e.id === entryId,
    );
    expect(row?.breakStartedAt).not.toBeNull();

    const twice = await at("12:05", () => breakCall(entryId, "start"));
    expect(twice.statusCode).toBe(409);
    expect(twice.json().code).toBe("ALREADY_ON_BREAK");

    const ended = await at("12:30", () => breakCall(entryId, "end"));
    expect(ended.statusCode, ended.body).toBe(200);
    expect(ended.json().breakStartedAt).toBeNull();
    expect(ended.json().breakMinutes).toBe(30);
    const rows = await app.prisma.break.findMany({ where: { timeEntryId: entryId } });
    expect(rows).toHaveLength(1);

    const endAgain = await at("12:31", () => breakCall(entryId, "end"));
    expect(endAgain.statusCode).toBe(409);
    expect(endAgain.json().code).toBe("NOT_ON_BREAK");

    // a second break runs into the clock-out: it becomes a Break row, no state is left behind
    expect((await at("14:00", () => breakCall(entryId, "start"))).statusCode).toBe(200);
    const out = await at("14:20", () =>
      app.inject({
        method: "POST",
        url: `/api/v1/time-entries/${entryId}/clock-out`,
        headers: auth(),
        payload: {},
      }),
    );
    expect(out.statusCode, out.body).toBe(200);
    const closed = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entryId } });
    expect(closed.breakStartedAt).toBeNull();
    const breaks = await app.prisma.break.findMany({
      where: { timeEntryId: entryId, isAuto: false },
      orderBy: { startTime: "asc" },
    });
    expect(breaks.map((b) => [b.startTime.getTime(), b.endTime.getTime()])).toEqual([
      [instant(day, "12:00").getTime(), instant(day, "12:30").getTime()],
      [instant(day, "14:00").getTime(), instant(day, "14:20").getTime()],
    ]);

    // a closed entry has no break state
    const late = await breakCall(entryId, "start");
    expect(late.statusCode).toBe(409);
    expect(late.json().code).toBe("NOT_CLOCKED_IN");
  });

  it("POST /:id/break writes BREAK_START and BREAK_APPEND audit rows with actor and before/after", async () => {
    const at2 = (hhmm: string) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(instant(addDaysStr(day, 1), hhmm));
    };
    at2("09:00");
    let entryId: string;
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/clock-in",
        headers: auth(),
        payload: { source: "MOBILE" },
      });
      expect(res.statusCode, res.body).toBe(200);
      entryId = (res.json() as { resolution: { entry: { id: string } } }).resolution.entry.id;
    } finally {
      vi.useRealTimers();
    }
    at2("11:00");
    try {
      expect((await breakCall(entryId, "start")).statusCode).toBe(200);
    } finally {
      vi.useRealTimers();
    }
    at2("11:20");
    try {
      expect((await breakCall(entryId, "end")).statusCode).toBe(200);
    } finally {
      vi.useRealTimers();
    }
    const startRow = await soleAuditRow(app.prisma, {
      where: { action: "BREAK_START", entity: "TimeEntry", entityId: entryId },
    });
    expect(startRow.userId).toBe(seed.empUser.id);
    expect(startRow.oldValue).toMatchObject({ breakStartedAt: null });
    expect((startRow.newValue as { breakStartedAt: string }).breakStartedAt).toBeTruthy();
    const endRow = await soleAuditRow(app.prisma, {
      where: { action: "BREAK_APPEND", entity: "TimeEntry", entityId: entryId },
    });
    expect(endRow.userId).toBe(seed.empUser.id);
    expect(endRow.oldValue).toMatchObject({ breakMinutes: 0 });
    expect(endRow.newValue).toMatchObject({ breakMinutes: 20, breakStatus: "CONFIRMED" });
  });

  it("an unknown id and a foreign tenant's id answer the identical 404", async () => {
    const own = await app.prisma.timeEntry.findFirstOrThrow({
      where: { employeeId: seed.employee.id, deletedAt: null },
    });
    const viaForeign = await breakCall(own.id, "start", foreign.empToken);
    const unknown = await breakCall(randomUUID(), "start", foreign.empToken);
    expect(viaForeign.statusCode).toBe(404);
    expect(viaForeign.body).toBe(unknown.body);
  });
});
