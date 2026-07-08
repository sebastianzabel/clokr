import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { resolveClockEvent } from "../resolver";
import type { ClockEvent, ClockIntent } from "../types";

// Phase 76.2 (ARCH-V19-01 sub-req B / TIME-V19-04) — Cross-source same-day consolidation.
// Phase 76.19.1 (SC3) — tightened to =1 invariant now that D-01 (REOPEN) is in place.
//
// Block A: parameterized matrix — each (sourceA, sourceB) pair in (NFC, MOBILE, WIFI) clocks
//          in + out same day → D-01 REOPENs the closed entry → exactly 1 TimeEntry + ≥ 1 Break.
// Block B: D-01 REOPEN with large gap (>consolidationGapHours) → still exactly 1 entry + gap Break.
// Block C: 2026-06-04 prod incident regression — NFC×3 + MOBILE×1 → exactly 1 active TimeEntry
//          (D-01: every subsequent IN REOPENs the same entry; pre-resolver left 3+ rows).

describe("services/clock/consolidate — cross-source same-day consolidation", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "consolidate-cross-source");
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
    // Anchor to NOON UTC today so every hoursAgo offset (all <= 12h in this suite) lands on the
    // SAME UTC day — otherwise a run in the early-morning CEST hours (when `now - 9h` crosses UTC
    // midnight) would spread the events across two dateStr day-keys and the resolver would
    // correctly create two per-day entries, breaking the "exactly 1 active entry per day"
    // assumption. Production derives dateStr in the tenant timezone; the test just needs a stable
    // same-day anchor. (Was: `new Date()` → time-of-day-fragile.)
    const base = new Date();
    base.setUTCHours(12, 0, 0, 0);
    const timestamp = new Date(base.getTime() - opts.hoursAgo * 3600 * 1000);
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

  // ── Block A — Matrix (parameterized over (sourceA, sourceB) pairs) ─────────
  const sources = ["NFC", "MOBILE", "WIFI"] as const;

  for (const sourceA of sources) {
    for (const sourceB of sources) {
      if (sourceA === sourceB) continue;
      it(`Block A — ${sourceA} clock-in/out then ${sourceB} clock-in/out, gap 30 min < 4h → exactly 1 active TimeEntry + ≥ 1 Break`, async () => {
        // Sequence: A IN (4h ago) → A OUT (3h ago) → B IN (2.5h ago, gap=30min) → B OUT (1h ago)
        // D-01: B IN finds the closed A entry (same date) → REOPENs it; no 2nd row created.
        await resolveClockEvent(app, buildEvent({ source: sourceA, intent: "IN", hoursAgo: 4 }));
        await resolveClockEvent(app, buildEvent({ source: sourceA, intent: "OUT", hoursAgo: 3 }));
        await resolveClockEvent(app, buildEvent({ source: sourceB, intent: "IN", hoursAgo: 2.5 }));
        await resolveClockEvent(app, buildEvent({ source: sourceB, intent: "OUT", hoursAgo: 1 }));

        const active = await app.prisma.timeEntry.findMany({
          where: { employeeId: data.employee.id, deletedAt: null },
        });
        expect(active.length).toBe(1);

        const breaks = await app.prisma.break.findMany({
          where: { timeEntryId: { in: active.map((e) => e.id) } },
        });
        expect(breaks.length).toBeGreaterThanOrEqual(1);
      });
    }
  }

  // ── Block B — D-01 REOPEN: same-day re-clock-in after large gap reopens entry with gap Break ──
  // NOTE (76.19.1-02 Rule-1 fix): D-01 REOPEN (Plan 01) changed the START path — a MOBILE IN
  // on the same day as a closed NFC entry now REOPENs the NFC entry (one entry + gap Break)
  // instead of creating a second row (pre-D-01 behavior). The consolidation gap threshold
  // applies only to cross-source STOP merges (Block A), not to REOPEN at START time.
  it("Block B — D-01 REOPEN on same-day MOBILE IN after NFC OUT: exactly 1 active entry + gap Break", async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { consolidationGapHours: 4 },
    });

    // NFC IN at 9h ago, NFC OUT at 5h ago, MOBILE IN at 0.5h ago (gap = 4.5h)
    // D-01: MOBILE IN finds the closed NFC entry (same date) → REOPENs it + creates gap Break.
    // One active entry with endTime=null; no second MOBILE row created.
    await resolveClockEvent(app, buildEvent({ source: "NFC", intent: "IN", hoursAgo: 9 }));
    await resolveClockEvent(app, buildEvent({ source: "NFC", intent: "OUT", hoursAgo: 5 }));
    await resolveClockEvent(app, buildEvent({ source: "MOBILE", intent: "IN", hoursAgo: 0.5 }));

    const allActive = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id, deletedAt: null },
    });
    // D-01 invariant: exactly one non-deleted entry (the reopened NFC entry)
    expect(allActive.length).toBe(1);
    // Entry must be open (employee is currently clocked in via REOPEN)
    expect(allActive[0].endTime).toBeNull();

    // Gap Break must have been created (old endTime → new MOBILE IN timestamp)
    const breaks = await app.prisma.break.findMany({
      where: { timeEntryId: allActive[0].id },
    });
    expect(breaks.length).toBeGreaterThanOrEqual(1);
  });

  // ── Block C — 2026-06-04 prod incident regression ─────────────────────────
  it("Block C — 2026-06-04 prod incident regression: NFC×3 + MOBILE×1 same day → D-01 REOPEN collapses to exactly 1 active TimeEntry", async () => {
    // Force gap window = 4h (default per CONTEXT D-04)
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { consolidationGapHours: 4 },
    });

    // Reproduce the 2026-06-04 prod incident shape:
    //   NFC AUTO at 8.5h ago  → NFC AUTO at 7h ago    (1.5h work → STOP; entry_1 closed)
    //   NFC AUTO at 6.5h ago  → NFC AUTO at 5h ago    (D-01 REOPEN entry_1 + gap Break; then STOP)
    //   MOBILE IN at 4h ago   → MOBILE OUT at 2h ago  (D-01 REOPEN entry_1 + gap Break; then STOP)
    // Pre-resolver: 3 separate TimeEntry rows (the bug — un-merged cross-source).
    // Post-resolver (D-01): every subsequent IN hits CLOSED_SAME_DAY_ENTRY → REOPEN → exactly 1 row.
    await resolveClockEvent(app, buildEvent({ source: "NFC", intent: "AUTO", hoursAgo: 8.5 }));
    await resolveClockEvent(app, buildEvent({ source: "NFC", intent: "AUTO", hoursAgo: 7 }));
    await resolveClockEvent(app, buildEvent({ source: "NFC", intent: "AUTO", hoursAgo: 6.5 }));
    await resolveClockEvent(app, buildEvent({ source: "NFC", intent: "AUTO", hoursAgo: 5 }));
    await resolveClockEvent(app, buildEvent({ source: "MOBILE", intent: "IN", hoursAgo: 4 }));
    await resolveClockEvent(app, buildEvent({ source: "MOBILE", intent: "OUT", hoursAgo: 2 }));

    const active = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id, deletedAt: null },
    });
    // Post-resolver (D-01) invariant: exactly 1 active row (single entry reopened in place).
    expect(active.length).toBe(1);

    // Verify Break rows exist (merge created at least one Break per consolidation).
    const breaks = await app.prisma.break.findMany({
      where: { timeEntryId: { in: active.map((e) => e.id) } },
    });
    expect(breaks.length).toBeGreaterThanOrEqual(1);
  });
});
