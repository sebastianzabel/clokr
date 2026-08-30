// Phase 118 (Issue #124) — Integration tests for the two generator paths of the
// "clock-out impossible after cancellation-request" defect, plus the retro-pending guard.
//
// D-11 proves both paths that can leave a TimeEntry `isInvalid: true` are actually
// clockable again after 118-01's resolver read-filter fix (D-01):
//   (a) § 8 BUrlG CANCELLATION_REQUESTED leave → IN creates an isInvalid entry → OUT succeeds
//   (b) attendance-checker's "Ausstempeln fehlt" invalidation → OUT succeeds
//   (c) a second IN while an isInvalid entry is open → CONFLICT ALREADY_CLOCKED_IN, never a 500
//   (d) a pending Zeitnachtrag for today → IN and AUTO both get CONFLICT RETRO_PENDING, and the
//       Nachtrag row is provably untouched
// Plus a regression for the D-02/D-03 precision fix: an APPROVED Nachtrag row (retroRequestId
// stays set, isInvalid flips false) must still be REOPEN-able via AUTO — the guard only fires on
// a still-PENDING coupled request.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { resolveClockEvent } from "../resolver";
import type { ClockEvent, ClockIntent } from "../types";

describe("services/clock/resolver — D-11 invalid-entry generator paths + retro guard (resolver-invalid-entry.integration)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  // D-12: every date is derived dynamically from "today" — hardcoded date literals are a
  // known time bomb in this repo (Issue #34, docs/testing.md). The anchor deliberately sits
  // at 12:00 UTC of today: every offset used below (at most ±5h) stays on the SAME UTC
  // calendar day regardless of the hour the suite happens to run at. Per docs/testing.md, a
  // run between 00:00 and 02:00 local is not conclusive either way — repeat outside that
  // window rather than reading a red or green result from within it.
  const todayStr = new Date().toISOString().slice(0, 10);
  const dayDate = new Date(`${todayStr}T00:00:00.000Z`);
  const anchor = new Date(`${todayStr}T12:00:00.000Z`);

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "resolver-invalid");
  });

  afterAll(async () => {
    await cleanupEmployeeState();
    await cleanupTestData(app, data.tenant.id);
    await closeTestApp();
  });

  beforeEach(async () => {
    await cleanupEmployeeState();
  });

  async function cleanupEmployeeState() {
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
    // TimeEntry.retroRequestId is onDelete: Restrict — TimeEntry rows must be gone
    // before their coupled RetroEntryRequest rows can be deleted.
    await app.prisma.timeEntry.deleteMany({
      where: { employeeId: data.employee.id },
    });
    await app.prisma.retroEntryRequest.deleteMany({
      where: { employeeId: data.employee.id },
    });
    await app.prisma.leaveRequest.deleteMany({
      where: { employeeId: data.employee.id },
    });
  }

  function buildEvent(opts: {
    source: string;
    intent: ClockIntent;
    hoursFromAnchor: number;
  }): ClockEvent {
    return {
      employeeId: data.employee.id,
      tenantId: data.tenant.id,
      source: opts.source,
      intent: opts.intent,
      timestamp: new Date(anchor.getTime() + opts.hoursFromAnchor * 3600_000),
      date: dayDate,
      dateStr: todayStr,
      actor: { type: "SYSTEM" },
    };
  }

  async function seedPendingRetro() {
    const request = await app.prisma.retroEntryRequest.create({
      data: {
        employeeId: data.employee.id,
        targetDate: dayDate,
        reason: "118-03 fixture: pending Zeitnachtrag for today",
        startTime: "08:00",
        endTime: "16:00",
        breakMinutes: 30,
        status: "PENDING",
      },
    });
    const entry = await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: dayDate,
        startTime: new Date(`${todayStr}T08:00:00.000Z`),
        endTime: new Date(`${todayStr}T16:00:00.000Z`),
        breakMinutes: 30,
        source: "MANUAL",
        createdBy: data.employee.id,
        isInvalid: true,
        invalidReason: "Nachtrag – Genehmigung ausstehend",
        retroRequestId: request.id,
      },
    });
    return { request, entry };
  }

  // ── Test 1 (D-11a): CANCELLATION_REQUESTED leave — IN creates an isInvalid entry ─────────
  it("D-11a: CANCELLATION_REQUESTED leave → IN succeeds and creates an isInvalid entry", async () => {
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        startDate: dayDate,
        endDate: dayDate,
        days: 1,
        status: "CANCELLATION_REQUESTED",
      },
    });

    const inResult = await resolveClockEvent(
      app,
      buildEvent({ source: "MOBILE", intent: "IN", hoursFromAnchor: -2 }),
    );
    expect(
      inResult.kind,
      "IN under a CANCELLATION_REQUESTED leave must still succeed (§ 8 BUrlG)",
    ).toBe("CLOCKED_IN");
    if (inResult.kind !== "CLOCKED_IN") throw new Error("unreachable");
    expect(inResult.entry.isInvalid).toBe(true);
    expect(inResult.entry.invalidReason).toBe("Urlaubsstornierung ausstehend");
  });

  // ── Test 2 (D-11a, D-04): OUT on that same entry succeeds and does not revalidate it ─────
  it("D-11a/D-04: OUT on a CANCELLATION_REQUESTED-created entry succeeds (CLOCKED_OUT, not CONFLICT) and keeps isInvalid", async () => {
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        startDate: dayDate,
        endDate: dayDate,
        days: 1,
        status: "CANCELLATION_REQUESTED",
      },
    });

    const inResult = await resolveClockEvent(
      app,
      buildEvent({ source: "MOBILE", intent: "IN", hoursFromAnchor: -2 }),
    );
    expect(inResult.kind).toBe("CLOCKED_IN");
    if (inResult.kind !== "CLOCKED_IN") throw new Error("unreachable");

    const outResult = await resolveClockEvent(
      app,
      buildEvent({ source: "MOBILE", intent: "OUT", hoursFromAnchor: 0 }),
    );
    // Issue #124: OUT must find the same entry IN created — before the fix this hit
    // NOT_CLOCKED_IN because the resolver's read filter hid the isInvalid row.
    expect(outResult.kind).toBe("CLOCKED_OUT");
    if (outResult.kind !== "CLOCKED_OUT") throw new Error("unreachable");
    expect(outResult.entry.endTime).not.toBeNull();

    // D-04: the clock path must not silently revalidate — isInvalid/invalidReason belong
    // to whoever set them (the cancellation approval flow, not the clock-out route).
    const reloaded = await app.prisma.timeEntry.findUnique({ where: { id: outResult.entry.id } });
    expect(reloaded?.endTime).not.toBeNull();
    expect(reloaded?.isInvalid).toBe(true);
    expect(reloaded?.invalidReason).toBe("Urlaubsstornierung ausstehend");
  });

  // ── Test 3 (D-11b): attendance-checker-invalidated open entry — OUT succeeds ─────────────
  it("D-11b: attendance-checker-invalidated open entry (isInvalid + 'Ausstempeln fehlt') → OUT succeeds", async () => {
    const inResult = await resolveClockEvent(
      app,
      buildEvent({ source: "MOBILE", intent: "IN", hoursFromAnchor: -3 }),
    );
    expect(inResult.kind).toBe("CLOCKED_IN");
    if (inResult.kind !== "CLOCKED_IN") throw new Error("unreachable");

    // Exactly the write attendance-checker.ts:296-303 performs after autoDeleteOpenHours.
    // D-09: no behavior change to the checker itself, this is purely a regression proof for
    // its output state.
    await app.prisma.timeEntry.update({
      where: { id: inResult.entry.id },
      data: { isInvalid: true, invalidReason: "Ausstempeln fehlt" },
    });

    const outResult = await resolveClockEvent(
      app,
      buildEvent({ source: "MOBILE", intent: "OUT", hoursFromAnchor: 0 }),
    );
    expect(outResult.kind).toBe("CLOCKED_OUT");
    if (outResult.kind !== "CLOCKED_OUT") throw new Error("unreachable");
    expect(outResult.entry.endTime).not.toBeNull();

    const reloaded = await app.prisma.timeEntry.findUnique({ where: { id: outResult.entry.id } });
    expect(reloaded?.isInvalid).toBe(true);
  });

  // ── Test 4 (D-11c): second IN on an open isInvalid entry → CONFLICT, never a 500 ─────────
  it("D-11c: second IN on an open isInvalid entry → CONFLICT ALREADY_CLOCKED_IN, exactly 1 row survives", async () => {
    const inResult = await resolveClockEvent(
      app,
      buildEvent({ source: "MOBILE", intent: "IN", hoursFromAnchor: -3 }),
    );
    expect(inResult.kind).toBe("CLOCKED_IN");
    if (inResult.kind !== "CLOCKED_IN") throw new Error("unreachable");

    await app.prisma.timeEntry.update({
      where: { id: inResult.entry.id },
      data: { isInvalid: true, invalidReason: "Ausstempeln fehlt" },
    });

    // Before Phase 118 this generator path ended in a P2002 → HTTP 500: the old read
    // filter hid the row from the resolver's state lookup, so decide() saw NO_OPEN_ENTRY
    // and attempted a second create() straight into the day-unique index.
    const secondIn = await resolveClockEvent(
      app,
      buildEvent({ source: "MOBILE", intent: "IN", hoursFromAnchor: -1 }),
    );
    expect(secondIn.kind).toBe("CONFLICT");
    if (secondIn.kind !== "CONFLICT") throw new Error("unreachable");
    expect(secondIn.reason).toBe("ALREADY_CLOCKED_IN");

    const rows = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id, deletedAt: null },
    });
    expect(rows).toHaveLength(1);
  });

  // ── Test 5 (D-11d): pending Zeitnachtrag for today → IN and AUTO both 409, row untouched ─
  it("D-11d: pending Zeitnachtrag for today → IN and AUTO both CONFLICT RETRO_PENDING, row bit-identical afterwards", async () => {
    const { request, entry } = await seedPendingRetro();
    const beforeUpdatedAt = entry.updatedAt.getTime();

    const inResult = await resolveClockEvent(
      app,
      buildEvent({ source: "MOBILE", intent: "IN", hoursFromAnchor: -1 }),
    );
    expect(inResult.kind).toBe("CONFLICT");
    if (inResult.kind !== "CONFLICT") throw new Error("unreachable");
    expect(inResult.reason).toBe("RETRO_PENDING");

    const autoResult = await resolveClockEvent(
      app,
      buildEvent({ source: "NFC", intent: "AUTO", hoursFromAnchor: -1 }),
    );
    expect(autoResult.kind).toBe("CONFLICT");
    if (autoResult.kind !== "CONFLICT") throw new Error("unreachable");
    expect(autoResult.reason).toBe("RETRO_PENDING");

    const reloaded = await app.prisma.timeEntry.findUnique({ where: { id: entry.id } });
    expect(reloaded?.endTime).not.toBeNull();
    expect(reloaded?.retroRequestId).toBe(request.id);
    expect(reloaded?.isInvalid).toBe(true);
    // Bit-identical: neither conflict path may have touched the row (no REOPEN, no update).
    expect(reloaded?.updatedAt.getTime()).toBe(beforeUpdatedAt);

    const rows = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id, deletedAt: null },
    });
    expect(rows).toHaveLength(1);

    const reloadedRequest = await app.prisma.retroEntryRequest.findUnique({
      where: { id: request.id },
    });
    expect(reloadedRequest?.status).toBe("PENDING");
  });

  // ── Test 6 (Approved-retro regression): an already-APPROVED Nachtrag row must ────────────
  // ── remain REOPEN-able — the guard is qualified on status: "PENDING", not retroRequestId ──
  it("approved Nachtrag row (retroRequestId still set, isInvalid false) → AUTO still REOPENs, no RETRO_PENDING", async () => {
    const { request, entry } = await seedPendingRetro();

    // The exact state retro-entry-requests.ts:363-365 leaves behind on approval:
    // isInvalid flips false, retroRequestId is deliberately KEPT for the audit link.
    await app.prisma.retroEntryRequest.update({
      where: { id: request.id },
      data: { status: "APPROVED", reviewedAt: new Date() },
    });
    await app.prisma.timeEntry.update({
      where: { id: entry.id },
      data: { isInvalid: false, invalidReason: null },
    });

    // Fixture's endTime is 16:00 UTC on today — pick an offset that is guaranteed to be
    // after it regardless of where the 12:00 UTC anchor falls relative to it.
    const autoResult = await resolveClockEvent(
      app,
      buildEvent({ source: "NFC", intent: "AUTO", hoursFromAnchor: 5 }),
    );
    expect(
      autoResult.kind,
      "an approved Nachtrag is an ordinary closed day row — the retro guard must not block its REOPEN",
    ).toBe("CLOCKED_IN");
  });
});
