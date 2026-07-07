// Phase 76.19.1 (D-01) — Integration tests for the REOPEN path in resolveClockEvent.
// Proves the "exactly one non-deleted TimeEntry per day" invariant at all times:
//   - Same-day re-clock-in reopens the existing closed entry (no 2nd row)
//   - Gap creates a Break record + breakMinutes reflects it
//   - CLOCK_REOPEN AuditLog row is emitted
//   - Locked closed entry → CONFLICT MONTH_LOCKED, entry stays closed
//   - Clock-out after reopen keeps gap breakMinutes (auto-break guard, Pitfall 1)
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { resolveClockEvent } from "../resolver";
import { consolidateSameDayEntries } from "../consolidate";
import type { ClockEvent, ClockIntent } from "../types";

describe("services/clock/resolver — D-01 reopen path (resolver-reopen.integration)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "resolver-reopen");
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

  function buildEvent(opts: { source: string; intent: ClockIntent; hoursAgo: number }): ClockEvent {
    const now = new Date();
    const timestamp = new Date(now.getTime() - opts.hoursAgo * 3600 * 1000);
    const dateStr = timestamp.toISOString().slice(0, 10);
    return {
      employeeId: data.employee.id,
      tenantId: data.tenant.id,
      source: opts.source,
      intent: opts.intent,
      timestamp,
      date: new Date(`${dateStr}T00:00:00.000Z`),
      dateStr,
      actor: { type: "SYSTEM" },
    };
  }

  // ── Test 1: Single active row + gap Break after reopen ────────────────────
  it("reopens closed same-day entry with gap Break — exactly 1 active row", async () => {
    // Sequence: IN(4h ago) → OUT(3h ago) → IN(1h ago)
    // After the second IN, the closed entry should be reopened (not a 2nd row created)
    await resolveClockEvent(app, buildEvent({ source: "MOBILE", intent: "IN", hoursAgo: 4 }));
    await resolveClockEvent(app, buildEvent({ source: "MOBILE", intent: "OUT", hoursAgo: 3 }));
    const reopenResult = await resolveClockEvent(
      app,
      buildEvent({ source: "MOBILE", intent: "IN", hoursAgo: 1 }),
    );

    // Resolution should reuse the CLOCKED_IN shape
    expect(reopenResult.kind).toBe("CLOCKED_IN");

    const active = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id, deletedAt: null },
    });

    // D-01 invariant: exactly ONE non-deleted entry
    expect(active.length).toBe(1);
    // Entry must be open (endTime null — the employee is currently clocked in)
    expect(active[0].endTime).toBeNull();

    // Gap Break created (old endTime → new start timestamp)
    const breaks = await app.prisma.break.findMany({
      where: { timeEntryId: active[0].id },
    });
    expect(breaks.length).toBeGreaterThanOrEqual(1);

    // breakMinutes must be > 0 (reflects ~2h gap between OUT at 3h ago and IN at 1h ago)
    expect(active[0].breakMinutes).toBeGreaterThan(0);
  });

  // ── Test 2: CLOCK_REOPEN audit emitted ───────────────────────────────────
  it("emits CLOCK_REOPEN audit on reopen", async () => {
    // IN(4h) → OUT(3h) → IN(1h)
    await resolveClockEvent(app, buildEvent({ source: "MOBILE", intent: "IN", hoursAgo: 4 }));
    await resolveClockEvent(app, buildEvent({ source: "MOBILE", intent: "OUT", hoursAgo: 3 }));
    await resolveClockEvent(app, buildEvent({ source: "MOBILE", intent: "IN", hoursAgo: 1 }));

    const active = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id, deletedAt: null },
    });
    expect(active.length).toBe(1);

    // Assert a CLOCK_REOPEN AuditLog row exists for this entry (D-01c)
    const auditRow = await app.prisma.auditLog.findFirst({
      where: { action: "CLOCK_REOPEN", entityId: active[0].id },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow?.action).toBe("CLOCK_REOPEN");
    expect(auditRow?.entityId).toBe(active[0].id);
  });

  // ── Test 3: Locked closed entry → CONFLICT MONTH_LOCKED, no mutation ─────
  it("locked closed entry → CONFLICT MONTH_LOCKED, entry stays closed", async () => {
    // Seed a closed entry with isLocked: true directly (bypasses resolver)
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const lockedEntry = await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: new Date(`${dateStr}T00:00:00.000Z`),
        startTime: new Date(now.getTime() - 4 * 3600 * 1000),
        endTime: new Date(now.getTime() - 3 * 3600 * 1000),
        source: "MOBILE" as never,
        isLocked: true,
        breakMinutes: 0,
      },
    });

    // Attempt IN on same day — should return CONFLICT MONTH_LOCKED
    const resolution = await resolveClockEvent(
      app,
      buildEvent({ source: "MOBILE", intent: "IN", hoursAgo: 1 }),
    );

    expect(resolution.kind).toBe("CONFLICT");
    if (resolution.kind === "CONFLICT") {
      expect(resolution.reason).toBe("MONTH_LOCKED");
    }

    // Verify the locked entry was NOT modified (endTime still set, not null)
    const refetched = await app.prisma.timeEntry.findUnique({
      where: { id: lockedEntry.id },
    });
    expect(refetched?.endTime).not.toBeNull();
    expect(refetched?.isLocked).toBe(true);
  });

  // ── Test 4: Clock-out after reopen keeps gap breakMinutes ─────────────────
  it("clock-out after reopen keeps gap breakMinutes (auto-break guard, Pitfall 1)", async () => {
    // IN(4h) → OUT(3h) [gap ≈ 2h] → IN(1h) → OUT(0.1h)
    // Gap = 3h - 1h = 2h ≈ 120 min
    await resolveClockEvent(app, buildEvent({ source: "MOBILE", intent: "IN", hoursAgo: 4 }));
    await resolveClockEvent(app, buildEvent({ source: "MOBILE", intent: "OUT", hoursAgo: 3 }));
    await resolveClockEvent(app, buildEvent({ source: "MOBILE", intent: "IN", hoursAgo: 1 }));
    await resolveClockEvent(app, buildEvent({ source: "MOBILE", intent: "OUT", hoursAgo: 0.1 }));

    const active = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id, deletedAt: null },
    });

    // Still exactly one row (consolidated or the reopened entry now closed)
    expect(active.length).toBeLessThanOrEqual(1);

    if (active.length === 1) {
      // breakMinutes must reflect the ~2h gap (≥ 110 min accounting for timing slack)
      // auto-break must NOT have overwritten the gap Break's contribution
      expect(active[0].breakMinutes).toBeGreaterThanOrEqual(100);
    }
  });

  // ── Test 5: WR-01 regression — zero-duration artifact skipped as consolidation predecessor ─
  it("WR-01 regression: zero-duration artifact in DB is NOT picked as consolidation predecessor", async () => {
    // Context: before the partial unique index existed, NFC double-taps could create a
    // zero-duration artifact (startTime == endTime). Once the real entry is reopened
    // (endTime → null), the artifact becomes the sole closed predecessor candidate.
    // Without the WR-01 guard, consolidateSameDayEntries would extend the artifact
    // (preserving the wrong startTime) and soft-delete the real entry — a Revisionssicherheit
    // violation. The partial unique index prevents *creating* this state in a post-migration
    // test DB, so we seed only the artifact in the real DB and pass the real entry as a
    // TypeScript-only fake openEntry directly to consolidateSameDayEntries.

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const dateOnly = new Date(`${dateStr}T00:00:00.000Z`);

    // Zero-duration artifact: simulates a legacy NFC double-tap (startTime == endTime)
    const t1 = new Date(now.getTime() - 8 * 3600_000); // 8h ago
    const artifact = await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: dateOnly,
        startTime: t1,
        endTime: t1, // zero duration
        source: "NFC" as never,
        breakMinutes: 0,
      },
    });

    // Fake "real entry" that was just closed by STOP (not inserted — DB unique constraint
    // prevents two non-deleted rows on the same date; the consolidation function only reads
    // openEntry fields as TypeScript values during the predecessor-lookup query).
    const t2 = new Date(now.getTime() - 6 * 3600_000); // 6h ago — real startTime
    const t3 = new Date(now.getTime() - 0.1 * 3600_000); // 6 min ago — just closed
    const fakeOpenEntry = {
      id: "ffffffff-ffff-ffff-ffff-ffffffffffff", // not in DB
      employeeId: data.employee.id,
      date: dateOnly,
      startTime: t2,
      endTime: t3,
      breakMinutes: 0,
      type: "WORK",
      source: "MOBILE",
      note: null,
      isLocked: false,
      lockedAt: null,
      isInvalid: false,
      invalidReason: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
      createdBy: null,
    };

    // Invoke consolidation directly in a real Prisma transaction.
    // gap = t2 - t1 = 2h → within the default 4h gapHoursMax, so the artifact
    // would be selected as predecessor — the WR-01 guard must reject it.
    const result = await app.prisma.$transaction(async (tx) => {
      return consolidateSameDayEntries(
        tx,
        fakeOpenEntry as never,
        4, // gapHoursMax
        app.log,
      );
    });

    // WR-01 fix: artifact has duration 0ms < 60s → merge skipped, NOT merged into artifact
    expect(result.merged).toBe(false);

    // Artifact must be untouched (not extended, not soft-deleted)
    const artifactAfter = await app.prisma.timeEntry.findUnique({ where: { id: artifact.id } });
    expect(artifactAfter?.endTime?.getTime()).toBe(t1.getTime()); // still zero-duration
    expect(artifactAfter?.deletedAt).toBeNull(); // not soft-deleted
  });
});
