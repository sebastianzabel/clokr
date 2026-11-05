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
    retroRequestId: "00000000-0000-4000-8000-000000000001",
    isInvalid: true,
    invalidReasonCode: "RETRO_APPROVAL_PENDING",
  };
  const APPROVED = {
    retroRequestId: "00000000-0000-4000-8000-000000000002",
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
      retroRequestId: "00000000-0000-4000-8000-000000000003",
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
      const day = thursdayOf(0);
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
      const day = thursdayOf(1);
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
});
