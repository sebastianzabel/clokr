/**
 * Issue #81 (D-03, D-05, D-07) — every TimeEntry writer outside the time-entries route keeps a
 * recorded activity allocation truthful: the clock re-open and the consolidation never let time
 * nobody classified inherit a kind (never fabricate) and never drop a share (never lose); clock
 * starts stay UNSPECIFIED; a retro approval with a manager correction obeys the share rule.
 *
 * Harness copied from `services/clock/__tests__/resolver-reopen.integration.test.ts`: one ANCHOR
 * (today 12:00Z) for every event, because `resolveClockEvent` reads no clock of its own.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { resolveClockEvent } from "../services/clock/resolver";
import { consolidateSameDayEntries } from "../services/clock/consolidate";
import type { ClockEvent, ClockIntent } from "../services/clock/types";
import { activityMinutes, entryDurations } from "../contexts/time-tracking";
import { invalidReasonFields } from "../contexts/time-tracking/invalid-reason";

const ANCHOR = (() => {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  return d;
})();

describe("Issue #81 (D-07) — clock re-open of a classified entry", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  async function wipeEntries() {
    const entries = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id },
      select: { id: true },
    });
    const ids = entries.map((e) => e.id);
    await app.prisma.break.deleteMany({ where: { timeEntryId: { in: ids } } });
    await app.prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } });
    await app.prisma.timeEntry.deleteMany({ where: { employeeId: data.employee.id } });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "act81clk");
  });

  afterAll(async () => {
    await wipeEntries();
    await cleanupTestData(app, data.tenant.id);
    await closeTestApp();
  });

  beforeEach(wipeEntries);

  function buildEvent(opts: { intent: ClockIntent; hoursAgo: number }): ClockEvent {
    const timestamp = new Date(ANCHOR.getTime() - opts.hoursAgo * 3600 * 1000);
    const dateStr = timestamp.toISOString().slice(0, 10);
    return {
      employeeId: data.employee.id,
      tenantId: data.tenant.id,
      source: "MOBILE",
      intent: opts.intent,
      timestamp,
      date: new Date(`${dateStr}T00:00:00.000Z`),
      dateStr,
      actor: { type: "SYSTEM" },
    };
  }

  /** IN 4h ago → OUT 3h ago: one closed entry with 60 working minutes. */
  async function closedMorning() {
    await resolveClockEvent(app, buildEvent({ intent: "IN", hoursAgo: 4 }));
    await resolveClockEvent(app, buildEvent({ intent: "OUT", hoursAgo: 3 }));
    return app.prisma.timeEntry.findFirstOrThrow({
      where: { employeeId: data.employee.id, deletedAt: null },
    });
  }

  async function sharesOf(id: string) {
    return app.prisma.timeEntryActivityShare.findMany({
      where: { timeEntryId: id },
      select: { kind: true, minutes: true },
      orderBy: { kind: "asc" },
    });
  }

  async function lastReopenAudit(id: string) {
    return app.prisma.auditLog.findFirstOrThrow({
      where: { entityId: id, action: "CLOCK_REOPEN" },
      orderBy: { createdAt: "desc" },
    });
  }

  it("materialises the classified remainder; the time after the re-open stays UNSPECIFIED", async () => {
    const entry = await closedMorning();
    await app.prisma.timeEntry.update({
      where: { id: entry.id },
      data: {
        activityKind: "PRODUCTIVE",
        activityShares: { create: [{ kind: "SETUP_CLEANING", minutes: 20 }] },
      },
    });

    const reopen = await resolveClockEvent(app, buildEvent({ intent: "IN", hoursAgo: 2 }));
    expect(reopen.kind).toBe("CLOCKED_IN");
    const open = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(open.endTime).toBeNull();
    expect(open.activityKind).toBe("UNSPECIFIED");
    const openShares = await sharesOf(entry.id);
    expect(openShares).toEqual([
      { kind: "PRODUCTIVE", minutes: 40 },
      { kind: "SETUP_CLEANING", minutes: 20 },
    ]);
    expect(activityMinutes(open, openShares)).toEqual({
      UNSPECIFIED: 0,
      PRODUCTIVE: 0,
      SETUP_CLEANING: 0,
    });

    const audit = await lastReopenAudit(entry.id);
    expect(audit.oldValue).toMatchObject({
      activityKind: "PRODUCTIVE",
      activityShares: [{ kind: "SETUP_CLEANING", minutes: 20 }],
    });
    expect(audit.newValue).toMatchObject({
      activityKind: "UNSPECIFIED",
      activityShares: [
        { kind: "SETUP_CLEANING", minutes: 20 },
        { kind: "PRODUCTIVE", minutes: 40 },
      ],
    });

    await resolveClockEvent(app, buildEvent({ intent: "OUT", hoursAgo: 0 }));
    const closedAgain = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(closedAgain.endTime).not.toBeNull();
    const finalShares = await sharesOf(entry.id);
    const minutes = activityMinutes(closedAgain, finalShares);
    expect(minutes).toEqual({ PRODUCTIVE: 40, SETUP_CLEANING: 20, UNSPECIFIED: 120 });
    const sum = finalShares.reduce((acc, s) => acc + s.minutes, 0);
    expect(sum).toBeLessThanOrEqual(entryDurations(closedAgain).workingMinutes);
  });

  it("an UNSPECIFIED entry with a share keeps kind and shares; the audit shape is unchanged", async () => {
    const entry = await closedMorning();
    await app.prisma.timeEntry.update({
      where: { id: entry.id },
      data: { activityShares: { create: [{ kind: "SETUP_CLEANING", minutes: 20 }] } },
    });
    await resolveClockEvent(app, buildEvent({ intent: "IN", hoursAgo: 2 }));
    const open = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(open.activityKind).toBe("UNSPECIFIED");
    expect(await sharesOf(entry.id)).toEqual([{ kind: "SETUP_CLEANING", minutes: 20 }]);
    const audit = await lastReopenAudit(entry.id);
    expect(Object.keys(audit.oldValue as object).sort()).toEqual(["endTime"]);
    // Today's CLOCK_REOPEN shape (emitClockAudit adds the actor) — no activity keys.
    expect(Object.keys(audit.newValue as object).sort()).toEqual([
      "actor",
      "breakMinutes",
      "endTime",
      "gapBreakId",
    ]);
  });

  it("an unclassified entry without shares re-opens exactly as before", async () => {
    const entry = await closedMorning();
    await resolveClockEvent(app, buildEvent({ intent: "IN", hoursAgo: 2 }));
    const open = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(open.endTime).toBeNull();
    expect(open.activityKind).toBe("UNSPECIFIED");
    expect(await sharesOf(entry.id)).toEqual([]);
    const audit = await lastReopenAudit(entry.id);
    // Today's CLOCK_REOPEN shape (emitClockAudit adds the actor) — no activity keys.
    expect(Object.keys(audit.newValue as object).sort()).toEqual([
      "actor",
      "breakMinutes",
      "endTime",
      "gapBreakId",
    ]);
  });

  it("a clock start creates an UNSPECIFIED entry without shares (D-03)", async () => {
    const res = await resolveClockEvent(app, buildEvent({ intent: "IN", hoursAgo: 1 }));
    expect(res.kind).toBe("CLOCKED_IN");
    const entry = await app.prisma.timeEntry.findFirstOrThrow({
      where: { employeeId: data.employee.id, deletedAt: null },
    });
    expect(entry.activityKind).toBe("UNSPECIFIED");
    expect(await sharesOf(entry.id)).toEqual([]);
  });

  it("POST /clock-in ignores an activityKind in the body (D-03, Zod strips the key)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries/clock-in",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { activityKind: "PRODUCTIVE" },
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    const entry = await app.prisma.timeEntry.findFirstOrThrow({
      where: { employeeId: data.employee.id, deletedAt: null },
    });
    expect(entry.activityKind).toBe("UNSPECIFIED");
    expect(await sharesOf(entry.id)).toEqual([]);
  });
});

describe("Issue #81 (D-07) — consolidation never drops nor stretches an allocation", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  // A fixed past day and another day for the second real row (the partial unique index forbids two
  // live rows on one day — same technique as time-entry-salon-clock.test.ts).
  const day = "2026-02-10";
  const otherDay = "2026-02-11";
  const at = (d: string, hm: string) => new Date(`${d}T${hm}:00.000Z`);

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "act81con");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("time-entry-activity-writers-81 cleanup failed:", err);
    }
  });

  beforeEach(async () => {
    const entries = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id },
      select: { id: true },
    });
    const ids = entries.map((e) => e.id);
    await app.prisma.break.deleteMany({ where: { timeEntryId: { in: ids } } });
    await app.prisma.timeEntry.deleteMany({ where: { employeeId: data.employee.id } });
  });

  /** Predecessor 08:00–12:00 on `day`, second real row passed as 13:00–17:00 on `day`. */
  async function pair(opts: {
    predecessor?: Record<string, unknown>;
    second?: Record<string, unknown>;
  }) {
    const predecessor = await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        salonId: data.salonId,
        date: new Date(`${day}T00:00:00Z`),
        startTime: at(day, "08:00"),
        endTime: at(day, "12:00"),
        ...opts.predecessor,
      },
    });
    const second = await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        salonId: data.salonId,
        date: new Date(`${otherDay}T00:00:00Z`),
        startTime: at(otherDay, "13:00"),
        endTime: at(otherDay, "17:00"),
        ...opts.second,
      },
    });
    const result = await app.prisma.$transaction((tx) =>
      consolidateSameDayEntries(
        tx,
        data.tenant.id,
        {
          ...second,
          date: new Date(`${day}T00:00:00Z`),
          startTime: at(day, "13:00"),
          endTime: at(day, "17:00"),
        } as never,
        4,
        app.log,
      ),
    );
    return { predecessor, second, result };
  }

  async function row(id: string) {
    return app.prisma.timeEntry.findUniqueOrThrow({
      where: { id },
      include: {
        activityShares: { select: { kind: true, minutes: true }, orderBy: { kind: "asc" } },
      },
    });
  }

  it("a classified second row is not merged away (kind set)", async () => {
    const { predecessor, second, result } = await pair({
      second: { activityKind: "SETUP_CLEANING" },
    });
    expect(result.merged).toBe(false);
    expect((await row(second.id)).deletedAt).toBeNull();
    expect((await row(predecessor.id)).endTime?.getTime()).toBe(at(day, "12:00").getTime());
  });

  it("an UNSPECIFIED second row with a share is not merged away", async () => {
    const { second, result } = await pair({
      second: { activityShares: { create: [{ kind: "SETUP_CLEANING", minutes: 30 }] } },
    });
    expect(result.merged).toBe(false);
    const after = await row(second.id);
    expect(after.deletedAt).toBeNull();
    expect(after.activityShares).toEqual([{ kind: "SETUP_CLEANING", minutes: 30 }]);
  });

  it("a classified predecessor keeps its minutes as a share; the merged-in time is UNSPECIFIED", async () => {
    const { predecessor, result } = await pair({ predecessor: { activityKind: "PRODUCTIVE" } });
    expect(result.merged).toBe(true);
    const after = await row(predecessor.id);
    expect(after.activityKind).toBe("UNSPECIFIED");
    expect(after.activityShares).toEqual([{ kind: "PRODUCTIVE", minutes: 240 }]);
    expect(activityMinutes(after, after.activityShares)).toEqual({
      PRODUCTIVE: 240,
      SETUP_CLEANING: 0,
      UNSPECIFIED: 240,
    });
    if (result.merged) {
      expect(result.after.activityShares).toEqual([{ kind: "PRODUCTIVE", minutes: 240 }]);
      expect(result.before.activityShares).toEqual([]);
    }
  });

  it("two unclassified rows merge exactly as before", async () => {
    const { predecessor, second, result } = await pair({});
    expect(result.merged).toBe(true);
    const after = await row(predecessor.id);
    expect(after.activityKind).toBe("UNSPECIFIED");
    expect(after.activityShares).toEqual([]);
    expect(after.endTime?.getTime()).toBe(at(day, "17:00").getTime());
    expect((await row(second.id)).deletedAt).not.toBeNull();
  });
});

describe("Issue #81 (D-05, D-07) — retro approval with a manager correction obeys the share rule", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  // A past day well inside the month that is not closed (no lock in this tenant).
  const targetDate = (() => {
    const d = new Date(ANCHOR.getTime() - 20 * 86_400_000);
    return d.toISOString().slice(0, 10);
  })();

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "act81ret");
  });

  afterAll(async () => {
    try {
      await app.prisma.timeEntry.deleteMany({ where: { employeeId: data.employee.id } });
      await app.prisma.retroEntryRequest.deleteMany({ where: { employeeId: data.employee.id } });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("time-entry-activity-writers-81 retro cleanup failed:", err);
    }
  });

  beforeEach(async () => {
    await app.prisma.timeEntry.deleteMany({ where: { employeeId: data.employee.id } });
    await app.prisma.retroEntryRequest.deleteMany({ where: { employeeId: data.employee.id } });
  });

  /** A coupled pending Nachtrag (08:00–17:00Z, 45 min break) with kind PRODUCTIVE + share 400. */
  async function pendingWithShare() {
    const request = await app.prisma.retroEntryRequest.create({
      data: {
        employeeId: data.employee.id,
        targetDate: new Date(targetDate),
        reason: "Issue 81 fixture: pending Nachtrag with an activity share",
        startTime: "08:00",
        endTime: "17:00",
        breakMinutes: 45,
        status: "PENDING",
      },
    });
    const entry = await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        salonId: data.salonId,
        date: new Date(targetDate),
        startTime: new Date(`${targetDate}T08:00:00.000Z`),
        endTime: new Date(`${targetDate}T17:00:00.000Z`),
        breakMinutes: 45,
        source: "MANUAL",
        isInvalid: true,
        ...invalidReasonFields("RETRO_APPROVAL_PENDING"),
        retroRequestId: request.id,
        activityKind: "PRODUCTIVE",
        activityShares: { create: [{ kind: "SETUP_CLEANING", minutes: 400 }] },
      },
    });
    return { request, entry };
  }

  async function review(id: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/retro-entry-requests/${id}/review`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload,
    });
  }

  async function entryWithShares(id: string) {
    return app.prisma.timeEntry.findUniqueOrThrow({
      where: { id },
      include: { activityShares: { select: { kind: true, minutes: true } } },
    });
  }

  it("a correction below the shares answers 409 before any write", async () => {
    const { request, entry } = await pendingWithShare();
    const res = await review(request.id, {
      status: "APPROVED",
      startTime: "08:00",
      endTime: "14:00",
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(JSON.parse(res.body).error).toBe(
      "Die zugeordnete Tätigkeitszeit übersteigt die Arbeitszeit des Eintrags.",
    );
    const reqAfter = await app.prisma.retroEntryRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(reqAfter.status).toBe("PENDING");
    const after = await entryWithShares(entry.id);
    expect(after.isInvalid).toBe(true);
    expect(after.startTime.getTime()).toBe(entry.startTime.getTime());
    expect(after.endTime?.getTime()).toBe(entry.endTime?.getTime());
    expect(after.activityShares).toEqual([{ kind: "SETUP_CLEANING", minutes: 400 }]);
  });

  it("a fitting correction releases the entry with its shares; the audit carries them", async () => {
    const { request, entry } = await pendingWithShare();
    const res = await review(request.id, {
      status: "APPROVED",
      startTime: "08:00",
      endTime: "17:00",
    });
    expect(res.statusCode, res.body).toBe(200);
    const after = await entryWithShares(entry.id);
    expect(after.isInvalid).toBe(false);
    expect(after.activityKind).toBe("PRODUCTIVE");
    expect(after.activityShares).toEqual([{ kind: "SETUP_CLEANING", minutes: 400 }]);
    const audit = await app.prisma.auditLog.findFirstOrThrow({
      where: { entityId: entry.id, action: "MANAGER_CORRECTION" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit.oldValue).toMatchObject({
      activityShares: [{ kind: "SETUP_CLEANING", minutes: 400 }],
    });
    expect(audit.newValue).toMatchObject({
      activityShares: [{ kind: "SETUP_CLEANING", minutes: 400 }],
    });
  });

  it("an approval without correction keeps the shares (no check needed)", async () => {
    const { request, entry } = await pendingWithShare();
    const res = await review(request.id, { status: "APPROVED" });
    expect(res.statusCode, res.body).toBe(200);
    const after = await entryWithShares(entry.id);
    expect(after.isInvalid).toBe(false);
    expect(after.activityShares).toEqual([{ kind: "SETUP_CLEANING", minutes: 400 }]);
  });

  it("a rejection soft-deletes the entry and keeps its share rows (never lost)", async () => {
    const { request, entry } = await pendingWithShare();
    const res = await review(request.id, {
      status: "REJECTED",
      reviewNote: "Nicht nachvollziehbar",
    });
    expect(res.statusCode, res.body).toBe(200);
    const after = await entryWithShares(entry.id);
    expect(after.deletedAt).not.toBeNull();
    expect(after.activityShares).toEqual([{ kind: "SETUP_CLEANING", minutes: 400 }]);
  });
});
