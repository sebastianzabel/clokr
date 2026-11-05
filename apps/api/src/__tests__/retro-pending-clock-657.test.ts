/**
 * Issue #657 (Phase 657, Plan 02, D-07/D-08/D-14) — the clock next to a pending Zeitnachtrag.
 *
 * A row coupled to a pending Zeitnachtrag (marker: `retroRequestId` + `isInvalid` + reason code
 * `RETRO_APPROVAL_PENDING`) is a REQUEST, not a recorded punch. The two shared selectors of
 * `day-entries.ts` (`openEntryOf`, `latestEndingClosed`) never hand it out, and a closed row it
 * shadows (it lies earlier than the pending one) is not handed out either, so the clock starts a NEW
 * entry instead of re-opening a row across the requested interval. Proved here:
 *
 * - pure: the truth table of `isPendingRetroRow` and both selectors;
 * - AC-657-2: a clock-in in another salon, and one without a salon, starts a new entry next to a
 *   pending Nachtrag, never answers `RETRO_PENDING`, and leaves the pending row bit-identical;
 * - D-14: shadowing, instants inside / before the interval, the open pending row, the previous day,
 *   consolidation (`retro_row`), the `RETRO_PENDING` backstop and the clock salon choice.
 *
 * No person names in fixtures. Every fixture id is a UUID. Days are fixed past Thursdays (one per
 * case) with a faked `Date`, like travel-clock-selectors-92.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { fromZonedTime } from "date-fns-tz";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { addDaysStr, mondayOfWeekStr, TEST_TZ } from "./test-dates";
import {
  isPendingRetroRow,
  latestEndingClosed,
  openEntryOf,
} from "../contexts/time-tracking/day-entries";
import { invalidReasonFields } from "../contexts/time-tracking/invalid-reason";
import { resolveClockEvent } from "../services/clock/resolver";
import { consolidateSameDayEntries } from "../services/clock/consolidate";
import type { ClockEvent, ClockIntent } from "../services/clock/types";

/** Tenant-local instant for `HH:MM` on `dayStr`. */
function instant(dayStr: string, hhmm: string): Date {
  return fromZonedTime(`${dayStr}T${hhmm}:00`, TEST_TZ);
}

type ClockBody = {
  error?: string;
  message?: string;
  code?: string;
  resolution: { kind: string; reason?: string; entry?: { id: string; salonId: string } };
};

type SalonItem = { id: string; name: string };
type ChoiceBody = { fixedSalon: SalonItem | null; offerChoice: boolean };

describe("Issue #657 — pure selectors", () => {
  const at = (hhmm: string) => new Date(`2026-03-10T${hhmm}:00Z`);
  const PENDING = {
    retroRequestId: randomUUID(),
    isInvalid: true,
    invalidReasonCode: "RETRO_APPROVAL_PENDING",
  };
  const APPROVED = {
    retroRequestId: randomUUID(),
    isInvalid: false,
    invalidReasonCode: null,
  };
  const row = (
    id: string,
    from: string,
    to: string | null,
    extra: Record<string, unknown> = {},
  ) => ({ id, startTime: at(from), endTime: to === null ? null : at(to), ...extra });

  it("isPendingRetroRow needs the request id, isInvalid and the exact reason code", () => {
    expect(isPendingRetroRow(row("p", "09:00", "10:00", PENDING))).toBe(true);
    expect(
      isPendingRetroRow(row("a", "09:00", "10:00", { ...PENDING, retroRequestId: null })),
    ).toBe(false);
    expect(isPendingRetroRow(row("b", "09:00", "10:00", { ...PENDING, isInvalid: false }))).toBe(
      false,
    );
    expect(
      isPendingRetroRow(row("c", "09:00", "10:00", { ...PENDING, invalidReasonCode: "OTHER" })),
    ).toBe(false);
    expect(
      isPendingRetroRow(row("d", "09:00", "10:00", { ...PENDING, invalidReasonCode: null })),
    ).toBe(false);
    expect(isPendingRetroRow(row("e", "09:00", "10:00", APPROVED))).toBe(false);
    expect(isPendingRetroRow(row("f", "09:00", "10:00"))).toBe(false);
  });

  it("latestEndingClosed: a pending row later than a closed row shadows it", () => {
    const x = row("x", "07:00", "08:00");
    const p = row("p", "09:00", "10:00", PENDING);
    expect(latestEndingClosed([x, p])).toBeNull();
    expect(latestEndingClosed([p, x])).toBeNull();
  });

  it("latestEndingClosed: a pending row EARLIER than the closed row does not", () => {
    const p = row("p", "06:00", "07:00", PENDING);
    const x = row("x", "08:00", "10:00");
    expect(latestEndingClosed([p, x])).toBe(x);
    expect(latestEndingClosed([x, p])).toBe(x);
  });

  it("latestEndingClosed: an open pending row gives null, a lone pending row gives null", () => {
    const x = row("x", "07:00", "08:00");
    const open = row("p", "09:00", null, PENDING);
    expect(latestEndingClosed([x, open])).toBeNull();
    expect(latestEndingClosed([row("p", "09:00", "10:00", PENDING)])).toBeNull();
  });

  it("latestEndingClosed: an approved Nachtrag row and a marker-less coupled row stay candidates", () => {
    const x = row("x", "07:00", "08:00");
    const approved = row("a", "09:00", "10:00", APPROVED);
    const markerless = row("m", "09:00", "10:00", {
      retroRequestId: randomUUID(),
      isInvalid: true,
      invalidReasonCode: null,
    });
    expect(latestEndingClosed([x, approved])).toBe(approved);
    expect(latestEndingClosed([x, markerless])).toBe(markerless);
  });

  it("openEntryOf skips an open pending row but still returns an ordinary open row", () => {
    const open = row("o", "11:00", null);
    expect(openEntryOf([row("p", "09:00", null, PENDING)])).toBeNull();
    expect(openEntryOf([row("x", "07:00", "08:00"), open])).toBe(open);
  });

  it("a TRAVEL row still never wins next to a pending row", () => {
    const a = row("a", "07:00", "08:00");
    const t = row("t", "08:00", "08:30", { activityKind: "TRAVEL" });
    const p = row("p", "08:30", "10:00", PENDING);
    expect(latestEndingClosed([a, t])).toBe(a);
    expect(latestEndingClosed([a, t, p])).toBeNull();
  });
});

describe("Issue #657 — the clock next to a pending Zeitnachtrag", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: SalonItem;
  let salonB: SalonItem;

  // One distinct past Thursday per case so no case shares a day with another.
  const baseMonday = addDaysStr(mondayOfWeekStr(), -20 * 7);
  const thursdayOf = (weekOffset: number): string => addDaysStr(baseMonday, weekOffset * 7 + 3);
  // Days are handed out in execution order and only ever ascend: a clock START must lie after every
  // closed entry of the employee (T-70b-11, also on LATER days), so a case on an earlier day than a
  // previous case would be refused with ENTRY_OVERLAP by that case's rows.
  let nextWeek = 0;
  const freshDay = (): string => thursdayOf(nextWeek++);
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

  function resolveAt(dayStr: string, hhmm: string, intent: ClockIntent) {
    const event: ClockEvent = {
      employeeId: seed.employee.id,
      tenantId: seed.tenant.id,
      source: "MOBILE",
      intent,
      timestamp: instant(dayStr, hhmm),
      date: dateOf(dayStr),
      dateStr: dayStr,
      actor: { type: "SYSTEM" },
    };
    return resolveClockEvent(app, event);
  }

  /** The state of a day's rows as a comparable snapshot (ids, times, marker, updatedAt). */
  async function snapshot(dayStr: string) {
    const rows = await app.prisma.timeEntry.findMany({
      where: { employeeId: seed.employee.id, date: dateOf(dayStr) },
      orderBy: [{ startTime: "asc" }, { id: "asc" }],
    });
    return rows.map((r) => ({
      id: r.id,
      start: r.startTime.toISOString(),
      end: r.endTime?.toISOString() ?? null,
      deletedAt: r.deletedAt?.toISOString() ?? null,
      isInvalid: r.isInvalid,
      code: r.invalidReasonCode,
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  /** A plain closed (or open) row, written straight through Prisma. */
  async function plainRow(
    dayStr: string,
    from: string,
    to: string | null,
    salonId: string,
    extra: Record<string, unknown> = {},
  ) {
    return app.prisma.timeEntry.create({
      data: {
        employeeId: seed.employee.id,
        date: dateOf(dayStr),
        startTime: instant(dayStr, from),
        endTime: to === null ? null : instant(dayStr, to),
        source: "MANUAL",
        salonId,
        ...extra,
      },
    });
  }

  /** A PENDING Zeitnachtrag request plus its coupled row; `marker` false = the revalidated shape. */
  async function pendingRow(
    dayStr: string,
    from: string,
    to: string | null,
    salonId: string,
    marker = true,
  ) {
    const request = await app.prisma.retroEntryRequest.create({
      data: {
        employeeId: seed.employee.id,
        targetDate: dateOf(dayStr),
        reason: "657 fixture: pending Zeitnachtrag",
        startTime: from,
        endTime: to,
        status: "PENDING",
      },
    });
    const entry = await plainRow(dayStr, from, to, salonId, {
      createdBy: seed.employee.id,
      retroRequestId: request.id,
      isInvalid: marker,
      ...(marker
        ? invalidReasonFields("RETRO_APPROVAL_PENDING")
        : { invalidReasonCode: null, invalidReason: null }),
    });
    return { request, entry };
  }

  const liveRows = (dayStr: string) =>
    app.prisma.timeEntry.findMany({
      where: { employeeId: seed.employee.id, date: dateOf(dayStr), deletedAt: null },
      orderBy: [{ startTime: "asc" }, { id: "asc" }],
    });

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "rp657");
    salonA = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon A" });
    salonB = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon B" });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, seed.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  // ── AC-657-2 ─────────────────────────────────────────────────────────────────────────────
  describe("AC-657-2 — a pending Zeitnachtrag no longer blocks the clock", () => {
    it("a clock-in in ANOTHER salon starts a new entry there; the pending row and its request stay untouched", async () => {
      const day = freshDay();
      const { request, entry } = await pendingRow(day, "08:00", "10:00", salonA.id);
      const before = await snapshot(day);

      const res = await clockIn(day, "11:00", { source: "MOBILE", salonId: salonB.id });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.body).not.toContain("RETRO_PENDING");
      const body = JSON.parse(res.body) as ClockBody;
      expect(body.resolution.kind).toBe("CLOCKED_IN");
      expect(body.resolution.entry!.id).not.toBe(entry.id);
      expect(body.resolution.entry!.salonId).toBe(salonB.id);

      const rows = await liveRows(day);
      expect(rows).toHaveLength(2);
      expect(rows[1].startTime.toISOString()).toBe(instant(day, "11:00").toISOString());
      expect(rows[1].endTime).toBeNull();
      // The pending row is bit-identical, the request still PENDING.
      expect((await snapshot(day)).slice(0, 1)).toEqual(before);
      const req = await app.prisma.retroEntryRequest.findUniqueOrThrow({
        where: { id: request.id },
      });
      expect(req.status).toBe("PENDING");
    });

    it("a clock-in WITHOUT a salon starts a NEW entry and never re-opens the pending row", async () => {
      const day = freshDay();
      const { entry } = await pendingRow(day, "08:00", "10:00", salonA.id);
      const before = await snapshot(day);

      const result = await resolveAt(day, "11:00", "IN");
      expect(result.kind).toBe("CLOCKED_IN");
      if (result.kind !== "CLOCKED_IN") throw new Error("unreachable");
      expect(result.entry.id).not.toBe(entry.id);
      expect(result.entry.endTime).toBeNull();
      expect((await snapshot(day)).slice(0, 1)).toEqual(before);
    });
  });
  // ── D-14: the rest of the clock contract ────────────────────────────────────────────────
  describe("D-14 — a pending row shadows what it covers", () => {
    it("shadowing: X 07-08 + pending 09-10, IN at 10:30 starts a NEW entry; X keeps its end and gets no gap break", async () => {
      const day = freshDay();
      const x = await plainRow(day, "07:00", "08:00", salonA.id);
      await pendingRow(day, "09:00", "10:00", salonA.id);

      const result = await resolveAt(day, "10:30", "IN");
      expect(result.kind).toBe("CLOCKED_IN");
      if (result.kind !== "CLOCKED_IN") throw new Error("unreachable");
      expect(result.entry.id).not.toBe(x.id);
      const xAfter = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: x.id } });
      expect(xAfter.endTime?.toISOString()).toBe(instant(day, "08:00").toISOString());
      expect(await app.prisma.break.count({ where: { timeEntryId: x.id } })).toBe(0);
    });

    it("not shadowed: pending 06-07 EARLIER than X 08-10, IN at 10:30 re-opens X", async () => {
      const day = freshDay();
      await pendingRow(day, "06:00", "07:00", salonA.id);
      const x = await plainRow(day, "08:00", "10:00", salonA.id);

      const result = await resolveAt(day, "10:30", "IN");
      expect(result.kind).toBe("CLOCKED_IN");
      if (result.kind !== "CLOCKED_IN") throw new Error("unreachable");
      expect(result.entry.id).toBe(x.id);
      expect(result.entry.endTime).toBeNull();
    });

    it("an instant INSIDE or BEFORE the pending interval is refused with ENTRY_OVERLAP and writes nothing", async () => {
      const day = freshDay();
      await pendingRow(day, "08:00", "10:00", salonA.id);
      const before = await snapshot(day);

      for (const hhmm of ["09:00", "07:00"]) {
        const result = await resolveAt(day, hhmm, "IN");
        expect(result, hhmm).toEqual({ kind: "CONFLICT", reason: "ENTRY_OVERLAP" });
      }
      expect(await snapshot(day)).toEqual(before);
    });
  });

  describe("D-14 — an open pending row", () => {
    it("refuses IN with ENTRY_OVERLAP; OUT answers RETRO_PENDING with the unchanged message; the row stays open and pending", async () => {
      const day = freshDay();
      const { request, entry } = await pendingRow(day, "08:00", null, salonA.id);
      const before = await snapshot(day);

      expect(await resolveAt(day, "11:00", "IN")).toEqual({
        kind: "CONFLICT",
        reason: "ENTRY_OVERLAP",
      });
      expect(await resolveAt(day, "11:00", "OUT")).toEqual({
        kind: "CONFLICT",
        reason: "RETRO_PENDING",
      });

      const out = await withClock(day, "11:00", () =>
        app.inject({
          method: "POST",
          url: `/api/v1/time-entries/${entry.id}/clock-out`,
          headers: { authorization: `Bearer ${seed.empToken}` },
          payload: {},
        }),
      );
      expect(out.statusCode, out.body).toBe(409);
      const body = JSON.parse(out.body) as ClockBody;
      expect(body.error).toBe("Für diesen Tag liegt ein offener Zeitnachtrag zur Genehmigung vor.");
      expect(body.resolution.reason).toBe("RETRO_PENDING");

      expect(await snapshot(day)).toEqual(before);
      const req = await app.prisma.retroEntryRequest.findUniqueOrThrow({
        where: { id: request.id },
      });
      expect(req.status).toBe("PENDING");
    });

    it("an earlier closed row is not re-opened across an open pending row: IN answers ENTRY_OVERLAP, X untouched", async () => {
      const day = freshDay();
      await plainRow(day, "07:00", "08:00", salonA.id);
      await pendingRow(day, "09:00", null, salonA.id);
      const before = await snapshot(day);

      expect(await resolveAt(day, "11:00", "IN")).toEqual({
        kind: "CONFLICT",
        reason: "ENTRY_OVERLAP",
      });
      expect(await snapshot(day)).toEqual(before);
    });

    it("a pending open row of the PREVIOUS day no longer captures today's clock-in", async () => {
      const day = freshDay();
      const yesterday = addDaysStr(day, -1);
      await pendingRow(yesterday, "22:00", null, salonA.id);
      const before = await snapshot(yesterday);

      const result = await resolveAt(day, "07:00", "IN");
      expect(result.kind).toBe("CLOCKED_IN");
      if (result.kind !== "CLOCKED_IN") throw new Error("unreachable");
      expect(result.entry.date.toISOString().slice(0, 10)).toBe(day);
      expect(await snapshot(yesterday)).toEqual(before);
    });
  });

  describe("D-14 — consolidation never merges across a Zeitnachtrag row", () => {
    it("clock-out of the row after the pending one succeeds (CLOCKED_OUT); X, pending and the new row keep their times", async () => {
      const day = freshDay();
      const x = await plainRow(day, "07:00", "08:00", seed.salonId);
      const { entry: p } = await pendingRow(day, "09:00", "10:00", seed.salonId);
      const inResult = await resolveAt(day, "10:30", "IN");
      expect(inResult.kind).toBe("CLOCKED_IN");
      if (inResult.kind !== "CLOCKED_IN") throw new Error("unreachable");
      const n = inResult.entry;

      const out = await resolveAt(day, "11:00", "OUT");
      expect(out.kind).toBe("CLOCKED_OUT");

      const rows = await liveRows(day);
      expect(rows.map((r) => r.id)).toEqual([x.id, p.id, n.id]);
      expect(rows.map((r) => [r.startTime.toISOString(), r.endTime?.toISOString()])).toEqual([
        [instant(day, "07:00").toISOString(), instant(day, "08:00").toISOString()],
        [instant(day, "09:00").toISOString(), instant(day, "10:00").toISOString()],
        [instant(day, "10:30").toISOString(), instant(day, "11:00").toISOString()],
      ]);
    });

    it("the guard reports merge_skipped with reason retro_row", async () => {
      const day = freshDay();
      const x = await plainRow(day, "07:00", "08:00", seed.salonId);
      const { entry: p } = await pendingRow(day, "09:00", "10:00", seed.salonId);
      const n = await plainRow(day, "10:30", "11:00", seed.salonId);
      const infos: Array<[Record<string, unknown>, string]> = [];
      const log = {
        info: (obj: Record<string, unknown>, msg: string) => infos.push([obj, msg]),
        warn: () => undefined,
        error: () => undefined,
      };
      const result = await app.prisma.$transaction((tx) =>
        consolidateSameDayEntries(tx, seed.tenant.id, n, 4, log as never),
      );
      expect(result).toEqual({ merged: false });
      expect(infos.filter(([, msg]) => msg === "merge_skipped").map(([obj]) => obj.reason)).toEqual(
        ["retro_row"],
      );
      expect((await liveRows(day)).map((r) => r.id)).toEqual([x.id, p.id, n.id]);
    });
  });

  describe("D-14 — the RETRO_PENDING backstop (coupled row without the marker)", () => {
    it("PATCH /revalidate refuses a row coupled to a PENDING request and changes nothing (WR-03)", async () => {
      const day = freshDay();
      const { request, entry } = await pendingRow(day, "08:00", "10:00", salonA.id);

      const revalidate = await app.inject({
        method: "PATCH",
        url: `/api/v1/time-entries/${entry.id}/revalidate`,
        headers: { authorization: `Bearer ${seed.adminToken}` },
        payload: {},
      });
      expect(revalidate.statusCode, revalidate.body).toBe(409);
      expect(JSON.parse(revalidate.body)).toEqual({
        error: "Der Zeitnachtrag zu diesem Eintrag muss zuerst entschieden werden.",
        code: "RETRO_REQUEST_PENDING",
      });
      const after = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
      expect(after.isInvalid).toBe(true);
      expect(after.invalidReasonCode).toBe("RETRO_APPROVAL_PENDING");
      expect(
        (await app.prisma.retroEntryRequest.findUniqueOrThrow({ where: { id: request.id } }))
          .status,
      ).toBe("PENDING");
    });

    it("a coupled row whose request is PENDING but which carries no marker is still refused with RETRO_PENDING", async () => {
      const day = freshDay();
      const { request } = await pendingRow(day, "08:00", "10:00", salonA.id, false);
      expect(
        (await app.prisma.retroEntryRequest.findUniqueOrThrow({ where: { id: request.id } }))
          .status,
      ).toBe("PENDING");

      const res = await clockIn(day, "11:00", { source: "MOBILE" });
      expect(res.statusCode, res.body).toBe(409);
      const body = JSON.parse(res.body) as ClockBody;
      expect(body.error).toBe("Für diesen Tag liegt ein offener Zeitnachtrag zur Genehmigung vor.");
      expect(body.resolution.reason).toBe("RETRO_PENDING");
    });
  });

  describe("D-14 — GET /time-entries/clock-salon follows the selectors", () => {
    const clockSalon = (dayStr: string, hhmm: string) =>
      withClock(dayStr, hhmm, () =>
        app.inject({
          method: "GET",
          url: "/api/v1/time-entries/clock-salon",
          headers: { authorization: `Bearer ${seed.empToken}` },
        }),
      );

    it("a day whose latest row is pending names no fixed salon", async () => {
      const day = freshDay();
      await plainRow(day, "07:00", "08:00", salonA.id);
      await pendingRow(day, "09:00", "10:00", salonB.id);
      const res = await clockSalon(day, "11:00");
      expect(res.statusCode, res.body).toBe(200);
      expect((JSON.parse(res.body) as ChoiceBody).fixedSalon).toBeNull();
    });

    it("with the pending row EARLIER, the later ordinary row still fixes the salon", async () => {
      const day = freshDay();
      await pendingRow(day, "06:00", "07:00", salonB.id);
      await plainRow(day, "08:00", "10:00", salonA.id);
      const res = await clockSalon(day, "11:00");
      expect(res.statusCode, res.body).toBe(200);
      expect((JSON.parse(res.body) as ChoiceBody).fixedSalon).toEqual({
        id: salonA.id,
        name: salonA.name,
      });
    });
  });
});
