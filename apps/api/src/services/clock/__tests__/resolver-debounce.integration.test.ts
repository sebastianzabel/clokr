// Phase 76.19.1 (D-02) — Integration tests for the 60s debounce guard in resolveClockEvent.
// Proves SC2: a STOP within 60s of START is a NO-OP (entry stays open, no zero-duration row),
// and a STOP after 60s closes the entry normally.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { resolveClockEvent } from "../resolver";
import type { ClockEvent, ClockIntent } from "../types";

describe("services/clock/resolver — D-02 60s debounce guard (resolver-debounce.integration)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "resolver-debounce");
  });

  afterAll(async () => {
    const entries = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id },
      select: { id: true },
    });
    await app.prisma.break.deleteMany({
      where: { timeEntryId: { in: entries.map((e) => e.id) } },
    });
    await app.prisma.auditLog.deleteMany({
      where: { entityId: { in: entries.map((e) => e.id) } },
    });
    await app.prisma.timeEntry.deleteMany({
      where: { employeeId: data.employee.id },
    });
    await cleanupTestData(app, data.tenant.id);
    await closeTestApp();
  });

  beforeEach(async () => {
    const entries = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id },
      select: { id: true },
    });
    await app.prisma.break.deleteMany({
      where: { timeEntryId: { in: entries.map((e) => e.id) } },
    });
    await app.prisma.auditLog.deleteMany({
      where: { entityId: { in: entries.map((e) => e.id) } },
    });
    await app.prisma.timeEntry.deleteMany({
      where: { employeeId: data.employee.id },
    });
  });

  /**
   * Build a clock event with an explicit timestamp (not relative to "now").
   * This lets us control the START→STOP gap precisely in seconds.
   */
  function buildEventAt(opts: {
    source: string;
    intent: ClockIntent;
    timestamp: Date;
    date: Date;
    dateStr: string;
  }): ClockEvent {
    return {
      employeeId: data.employee.id,
      tenantId: data.tenant.id,
      source: opts.source,
      intent: opts.intent,
      timestamp: opts.timestamp,
      date: opts.date,
      dateStr: opts.dateStr,
      actor: { type: "SYSTEM" },
    };
  }

  // ── Test 1: STOP within 60s → DEBOUNCE_NOOP, entry stays open ─────────────
  it("STOP within 60s → DEBOUNCE_NOOP, entry stays open (no zero-duration row)", async () => {
    // Use a fixed date anchor in the past to avoid cross-midnight edge cases
    const anchor = new Date();
    anchor.setHours(9, 0, 0, 0); // 09:00:00 today
    const dateStr = anchor.toISOString().slice(0, 10);
    const date = new Date(`${dateStr}T00:00:00.000Z`);

    // IN at anchor (T+0)
    const inTime = new Date(anchor.getTime());
    // OUT at T+30s (within debounce window)
    const outTime = new Date(anchor.getTime() + 30_000);

    const inResult = await resolveClockEvent(
      app,
      buildEventAt({ source: "NFC", intent: "IN", timestamp: inTime, date, dateStr }),
    );
    expect(inResult.kind).toBe("CLOCKED_IN");

    // STOP 30s later — should be a DEBOUNCE_NOOP
    const outResult = await resolveClockEvent(
      app,
      buildEventAt({ source: "NFC", intent: "OUT", timestamp: outTime, date, dateStr }),
    );
    expect(outResult.kind).toBe("DEBOUNCE_NOOP");

    // Entry must still be open (endTime === null)
    const entries = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id, deletedAt: null },
    });
    expect(entries.length).toBe(1);
    expect(entries[0].endTime).toBeNull();
  });

  // ── Test 2: STOP after 60s → closes normally ──────────────────────────────
  it("STOP after 60s → closes entry normally (CLOCKED_OUT or CONSOLIDATED)", async () => {
    const anchor = new Date();
    anchor.setHours(10, 0, 0, 0); // 10:00:00 today
    const dateStr = anchor.toISOString().slice(0, 10);
    const date = new Date(`${dateStr}T00:00:00.000Z`);

    // IN at anchor (T+0)
    const inTime = new Date(anchor.getTime());
    // OUT at T+300s (5 minutes later — well beyond debounce window)
    const outTime = new Date(anchor.getTime() + 300_000);

    await resolveClockEvent(
      app,
      buildEventAt({ source: "NFC", intent: "IN", timestamp: inTime, date, dateStr }),
    );

    const outResult = await resolveClockEvent(
      app,
      buildEventAt({ source: "NFC", intent: "OUT", timestamp: outTime, date, dateStr }),
    );

    // Must close normally — either CLOCKED_OUT or CONSOLIDATED (cross-source merge)
    expect(["CLOCKED_OUT", "CONSOLIDATED"]).toContain(outResult.kind);

    // Entry must be closed (endTime not null)
    const entries = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id, deletedAt: null },
    });
    expect(entries.length).toBe(1);
    expect(entries[0].endTime).not.toBeNull();
  });
});
