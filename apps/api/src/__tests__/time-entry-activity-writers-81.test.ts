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
import type { ClockEvent, ClockIntent } from "../services/clock/types";
import { activityMinutes, entryDurations } from "../contexts/time-tracking";

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
});
