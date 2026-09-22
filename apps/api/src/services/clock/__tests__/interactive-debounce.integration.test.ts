// Phase 307 Plan 01 — the debounce guard asks "who is clicking RIGHT NOW", not "which channel
// created this row". D-01 corrected: `event.source` on the clock-out route is `entry.source`
// (time-entries.ts:518, read this session) — the entry's PROVENANCE, not the caller's channel.
// A branch on `event.source` would answer the wrong question. `ClockEvent.interactive`, set
// exclusively by the adapter, answers the right one — see types.ts's docblock.
//
// describe A exercises the resolver against the database (mirrors
// resolver-debounce.integration.test.ts's beforeAll/afterAll/beforeEach shape and its
// `buildEventAt` helper, extended with an `interactive` option).
// describe B is a static, anti-vacuity-gated count over the five adapter call sites — the
// mechanical proof that every one of them names the property explicitly (CONTEXT.md D-08 /
// future-source.test.ts's "one new adapter file" guarantee).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { resolveClockEvent } from "../resolver";
import type { ClockEvent, ClockIntent } from "../types";

// A local literal, not a shared threshold import — Task 3 (thresholds.ts) does not exist yet
// when this describe A is authored, and describe A's assertions concern resolver BEHAVIOR
// (does an interactive STOP inside the window close normally?), not the constant's name.
const DEBOUNCE_WINDOW_MS = 60_000;

describe("services/clock/resolver — D-01 interactive-source debounce (interactive-debounce.integration)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "interactive-debounce");
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
   * Build a clock event with an explicit timestamp (not relative to "now") and, unlike
   * resolver-debounce.integration.test.ts's version, an explicit `interactive` toggle. When
   * `opts.interactive` is omitted the resulting event OMITS the `interactive` key entirely —
   * not `interactive: undefined` — to faithfully exercise "the field was never set" (the same
   * shape future-source.test.ts's literal has), not "the field was set to undefined".
   */
  function buildEventAt(opts: {
    source: string;
    intent: ClockIntent;
    timestamp: Date;
    date: Date;
    dateStr: string;
    interactive?: boolean;
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
      ...(opts.interactive !== undefined ? { interactive: opts.interactive } : {}),
    };
  }

  // ── A1 (D-01): interactive STOP within 60s closes normally, never DEBOUNCE_NOOP ───────────
  it("A1: interactive STOP within 60s closes the entry (CLOCKED_OUT or CONSOLIDATED), not DEBOUNCE_NOOP", async () => {
    const anchor = new Date();
    anchor.setHours(9, 0, 0, 0);
    const dateStr = anchor.toISOString().slice(0, 10);
    const date = new Date(`${dateStr}T00:00:00.000Z`);

    const inTime = new Date(anchor.getTime());
    const outTime = new Date(anchor.getTime() + 30_000); // 30s later — inside the debounce window

    const inResult = await resolveClockEvent(
      app,
      buildEventAt({
        source: "MOBILE",
        intent: "IN",
        timestamp: inTime,
        date,
        dateStr,
        interactive: true,
      }),
    );
    expect(inResult.kind).toBe("CLOCKED_IN");

    const outResult = await resolveClockEvent(
      app,
      buildEventAt({
        source: "MOBILE",
        intent: "OUT",
        timestamp: outTime,
        date,
        dateStr,
        interactive: true,
      }),
    );

    // Pre-change (unmodified resolver.ts): this is DEBOUNCE_NOOP — the reported bug. The RED
    // output of this assertion, captured verbatim before the resolver.ts edit, is quoted in
    // 307-01-SUMMARY.md.
    expect(["CLOCKED_OUT", "CONSOLIDATED"]).toContain(outResult.kind);

    const entries = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id, deletedAt: null },
    });
    expect(entries.length).toBe(1);
    expect(entries[0].endTime).not.toBeNull();
  });

  // ── A2 (D-02, the guard stays): non-interactive STOP within 60s is still a NO-OP ──────────
  it("A2: non-interactive STOP within 60s is still DEBOUNCE_NOOP, entry stays open", async () => {
    const anchor = new Date();
    anchor.setHours(10, 0, 0, 0);
    const dateStr = anchor.toISOString().slice(0, 10);
    const date = new Date(`${dateStr}T00:00:00.000Z`);

    const inTime = new Date(anchor.getTime());
    const outTime = new Date(anchor.getTime() + 30_000);

    const inResult = await resolveClockEvent(
      app,
      buildEventAt({ source: "NFC", intent: "IN", timestamp: inTime, date, dateStr }),
    );
    expect(inResult.kind).toBe("CLOCKED_IN");

    const outResult = await resolveClockEvent(
      app,
      buildEventAt({ source: "NFC", intent: "OUT", timestamp: outTime, date, dateStr }),
    );
    expect(outResult.kind).toBe("DEBOUNCE_NOOP");

    const entries = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id, deletedAt: null },
    });
    expect(entries.length).toBe(1);
    expect(entries[0].endTime).toBeNull();
  });

  // ── A3 (D-02, the actual assurance): no zero/near-zero row survives a non-interactive
  //     double-tap. Not inferred from A2's endTime === null — measured directly. ─────────────
  it("A3: after a non-interactive double-tap, no non-deleted row has endTime set, and none is a sub-60s artifact", async () => {
    const anchor = new Date();
    anchor.setHours(11, 0, 0, 0);
    const dateStr = anchor.toISOString().slice(0, 10);
    const date = new Date(`${dateStr}T00:00:00.000Z`);

    const inTime = new Date(anchor.getTime());
    const outTime = new Date(anchor.getTime() + 30_000);

    await resolveClockEvent(
      app,
      buildEventAt({ source: "NFC", intent: "IN", timestamp: inTime, date, dateStr }),
    );
    const outResult = await resolveClockEvent(
      app,
      buildEventAt({ source: "NFC", intent: "OUT", timestamp: outTime, date, dateStr }),
    );
    expect(outResult.kind).toBe("DEBOUNCE_NOOP");

    const rows = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id, deletedAt: null },
    });

    const closedRows = rows.filter((r) => r.endTime !== null);
    expect(closedRows.length).toBe(0);

    const nearZeroOrClosedRows = rows.filter(
      (r) => r.endTime !== null && r.endTime.getTime() - r.startTime.getTime() < DEBOUNCE_WINDOW_MS,
    );
    expect(nearZeroOrClosedRows.length).toBe(0);
  });
});

// ── describe B: static, anti-vacuity-gated proof that all five adapter call sites name
//    `interactive` explicitly — the mechanical form of "every channel answered the question,
//    at the adapter, not as a list inside the resolver". ─────────────────────────────────────
describe("services/clock adapters — D-08 every ClockEvent construction site names `interactive` explicitly (interactive-debounce.integration, static)", () => {
  // __dirname is apps/api/src/services/clock/__tests__ — three levels up is apps/api/src.
  const SRC_ROOT = join(__dirname, "..", "..", "..");
  const TIME_ENTRIES_PATH = join(SRC_ROOT, "contexts/time-tracking/api/time-entries.ts");
  const PRESENCE_PATH = join(SRC_ROOT, "contexts/time-tracking/api/presence.ts");

  const timeEntriesSource = readFileSync(TIME_ENTRIES_PATH, "utf-8");
  const presenceSource = readFileSync(PRESENCE_PATH, "utf-8");

  // Anti-vacuity gate FIRST: if this fails, nothing below it proves anything (a moved or
  // emptied file must turn this gate red, never let the negative counts below pass vacuously).
  it("B0 (anti-vacuity gate): both adapter files are loaded, non-trivial, and mention ClockEvent", () => {
    expect(timeEntriesSource.length).toBeGreaterThan(1000);
    expect(presenceSource.length).toBeGreaterThan(1000);
    expect(timeEntriesSource).toContain("ClockEvent");
    expect(presenceSource).toContain("ClockEvent");
  });

  it("B1: time-entries.ts has exactly three `: ClockEvent = {` construction sites", () => {
    const matches = timeEntriesSource.match(/: ClockEvent = \{/g) ?? [];
    expect(matches.length).toBe(3);
  });

  it("B2: time-entries.ts names `interactive` explicitly at all three sites — two true, one false", () => {
    const trueCount = (timeEntriesSource.match(/interactive: true/g) ?? []).length;
    const falseCount = (timeEntriesSource.match(/interactive: false/g) ?? []).length;
    expect(trueCount).toBe(2);
    expect(falseCount).toBe(1);
  });

  it("B3: presence.ts has exactly two `: ClockEvent = {` construction sites", () => {
    const matches = presenceSource.match(/: ClockEvent = \{/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it("B4: presence.ts names `interactive: false` at both sites — no `interactive: true` anywhere", () => {
    const trueCount = (presenceSource.match(/interactive: true/g) ?? []).length;
    const falseCount = (presenceSource.match(/interactive: false/g) ?? []).length;
    expect(trueCount).toBe(0);
    expect(falseCount).toBe(2);
  });
});
