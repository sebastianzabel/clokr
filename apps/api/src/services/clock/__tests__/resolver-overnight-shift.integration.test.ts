// Phase 376 (Issue #376) — Integration tests: resolveClockEvent must find an open entry from the
// immediately preceding calendar day before concluding NO_OPEN_ENTRY, bounded by the tenant's own
// staleness threshold (D-01/D-02).
//
// Root cause (D-00a, confirmed by code reading, not re-investigated here): `findEntriesOfDay()`
// (day-entries.ts) filters on exact `date` equality only. `resolveClockEvent()` called it once
// with `event.date` — a 23:30 clock-in followed by a 00:30 clock-out tap on the following day
// computed `date = D+1`, found nothing, and (AUTO intent) `decide()` returned `START`, creating a
// second, orphaned entry while the D entry stayed open forever.
//
// Mirrors resolver-reopen.integration.test.ts's structure: one clock read for the whole file
// (resolveClockEvent reads no wall clock of its own — every date arrives on the ClockEvent — so
// CLOKR_TEST_FAKE_CLOCK is not needed here).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { resolveClockEvent } from "../resolver";
import type { ClockEvent, ClockIntent } from "../types";

// DAY_D = UTC midnight of "today", read once at module scope (same idiom as
// resolver-reopen.integration.test.ts's ANCHOR — resolveClockEvent has no wall-clock dependency,
// so a single anchor makes this file fully deterministic).
const DAY_D = (() => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
})();
const DAY_D_PLUS_1 = (() => {
  const d = new Date(DAY_D);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
})();
const DAY_D_MINUS_1 = (() => {
  const d = new Date(DAY_D);
  d.setUTCDate(d.getUTCDate() - 1);
  return d;
})();

function atTime(day: Date, hh: number, mm: number): Date {
  return new Date(day.getTime() + hh * 3600_000 + mm * 60_000);
}

describe("services/clock/resolver — overnight shift crossing midnight (Issue #376)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "resolver-overnight-shift");
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

  // Re-derives date/dateStr per call exactly the way two separate HTTP requests would (never
  // reusing a stale computed value across two resolveClockEvent calls — the actual root cause
  // per D-00a).
  function buildEvent(opts: {
    source: string;
    intent: ClockIntent;
    timestamp: Date;
    dateDay: Date;
  }): ClockEvent {
    return {
      employeeId: data.employee.id,
      tenantId: data.tenant.id,
      source: opts.source,
      intent: opts.intent,
      timestamp: opts.timestamp,
      date: opts.dateDay,
      dateStr: opts.dateDay.toISOString().slice(0, 10),
      actor: { type: "SYSTEM" },
    };
  }

  // ── Test A: AUTO/NFC toggle across midnight (AC1/AC2) ──────────────────────
  it("AC1/AC2: NFC tap at 00:30 closes the entry opened at 23:30 the previous day — no duplicate", async () => {
    const clockIn = await resolveClockEvent(
      app,
      buildEvent({
        source: "NFC",
        intent: "AUTO",
        timestamp: atTime(DAY_D, 23, 30),
        dateDay: DAY_D,
      }),
    );
    expect(clockIn.kind).toBe("CLOCKED_IN");
    if (clockIn.kind !== "CLOCKED_IN") throw new Error("unreachable");
    const openEntryId = clockIn.entry.id;

    const clockOut = await resolveClockEvent(
      app,
      buildEvent({
        source: "NFC",
        intent: "AUTO",
        timestamp: atTime(DAY_D_PLUS_1, 0, 30),
        dateDay: DAY_D_PLUS_1,
      }),
    );
    expect(clockOut.kind).toBe("CLOCKED_OUT");

    const entries = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id, deletedAt: null },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(openEntryId);
    expect(entries[0].endTime).not.toBeNull();
    // D-00d/AC5: TimeEntry.date stays the shift's start day
    expect(entries[0].date.toISOString().slice(0, 10)).toBe(DAY_D.toISOString().slice(0, 10));

    // AC6: exactly one CLOCK_IN + one CLOCK_OUT audit row for this entry
    const auditRows = await app.prisma.auditLog.findMany({
      where: { entityId: openEntryId },
    });
    expect(auditRows.filter((a) => a.action === "CLOCK_IN")).toHaveLength(1);
    expect(auditRows.filter((a) => a.action === "CLOCK_OUT")).toHaveLength(1);
  });

  // ── Test C: D-02 staleness bound — a genuinely stale entry must NOT be closed ──────────────
  it("D-02 bound: a D-1-dated open entry older than the staleness bound is NOT closed by a same-source AUTO tap on D", async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { autoDeleteOpenHours: 14 },
    });

    const staleEntry = await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: DAY_D_MINUS_1,
        startTime: atTime(DAY_D_MINUS_1, 0, 0),
        source: "NFC",
        salonId: data.salonId,
      },
    });

    // Tap at DAY_D 23:00 — 47h after the stale entry's startTime, exceeding both the default 14h
    // autoDeleteOpenHours and the 24h fallback.
    const result = await resolveClockEvent(
      app,
      buildEvent({
        source: "NFC",
        intent: "AUTO",
        timestamp: atTime(DAY_D, 23, 0),
        dateDay: DAY_D,
      }),
    );
    expect(result.kind).toBe("CLOCKED_IN");

    const refetchedStale = await app.prisma.timeEntry.findUnique({ where: { id: staleEntry.id } });
    expect(refetchedStale?.endTime).toBeNull();

    const active = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id, deletedAt: null },
    });
    expect(active).toHaveLength(2);
  });

  // ── Test D: IN intent explicit clock-in across the boundary ─────────────────────────────────
  it("IN intent at 00:30 conflicts ALREADY_CLOCKED_IN instead of starting a duplicate", async () => {
    const clockIn = await resolveClockEvent(
      app,
      buildEvent({
        source: "MOBILE",
        intent: "IN",
        timestamp: atTime(DAY_D, 23, 30),
        dateDay: DAY_D,
      }),
    );
    expect(clockIn.kind).toBe("CLOCKED_IN");

    const secondIn = await resolveClockEvent(
      app,
      buildEvent({
        source: "MOBILE",
        intent: "IN",
        timestamp: atTime(DAY_D_PLUS_1, 0, 30),
        dateDay: DAY_D_PLUS_1,
      }),
    );
    expect(secondIn.kind).toBe("CONFLICT");
    if (secondIn.kind === "CONFLICT") {
      expect(secondIn.reason).toBe("ALREADY_CLOCKED_IN");
    }

    const active = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id, deletedAt: null },
    });
    expect(active).toHaveLength(1);
    expect(active[0].endTime).toBeNull();
  });

  // ── Test E: OUT intent close across the boundary via a different source (WIFI) ──────────────
  it("OUT intent (WIFI) at 00:30 closes the entry opened via WIFI AUTO at 23:30", async () => {
    const clockIn = await resolveClockEvent(
      app,
      buildEvent({
        source: "WIFI",
        intent: "AUTO",
        timestamp: atTime(DAY_D, 23, 30),
        dateDay: DAY_D,
      }),
    );
    expect(clockIn.kind).toBe("CLOCKED_IN");

    const clockOut = await resolveClockEvent(
      app,
      buildEvent({
        source: "WIFI",
        intent: "OUT",
        timestamp: atTime(DAY_D_PLUS_1, 0, 30),
        dateDay: DAY_D_PLUS_1,
      }),
    );
    expect(clockOut.kind).toBe("CLOCKED_OUT");
    if (clockOut.kind === "CLOCKED_OUT" || clockOut.kind === "CONSOLIDATED") {
      expect(clockOut.entry.endTime).not.toBeNull();
    }
  });
});
