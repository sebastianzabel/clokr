import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { resolveClockEvent } from "../resolver";
import type { ClockEvent, ClockIntent } from "../types";

// Phase 76.2 (ARCH-V19-01 sub-req B / TIME-V19-04) — Cross-source same-day consolidation.
//
// Block A: parameterized matrix — each (sourceA, sourceB) pair in (NFC, MOBILE, WIFI) clocks
//          in + out same day with gap < tenant.consolidationGapHours → 1 TimeEntry + 1 Break.
// Block B: gap > threshold → no merge; merge_skipped { reason: 'gap_exceeded' }.
// Block C: 2026-06-04 prod incident regression — NFC×3 + MOBILE×1 → at most 2 active TimeEntries
//          (post-resolver collapses cross-source same-day rows; pre-resolver left 3+).

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

  // ── Block A — Matrix (parameterized over (sourceA, sourceB) pairs) ─────────
  const sources = ["NFC", "MOBILE", "WIFI"] as const;

  for (const sourceA of sources) {
    for (const sourceB of sources) {
      if (sourceA === sourceB) continue;
      it(`Block A — ${sourceA} clock-in/out then ${sourceB} clock-in/out, gap 30 min < 4h → ≤ 1 active TimeEntry + ≥ 1 Break`, async () => {
        // Sequence: A IN (4h ago) → A OUT (3h ago) → B IN (2.5h ago, gap=30min) → B OUT (1h ago)
        await resolveClockEvent(app, buildEvent({ source: sourceA, intent: "IN", hoursAgo: 4 }));
        await resolveClockEvent(app, buildEvent({ source: sourceA, intent: "OUT", hoursAgo: 3 }));
        await resolveClockEvent(app, buildEvent({ source: sourceB, intent: "IN", hoursAgo: 2.5 }));
        await resolveClockEvent(app, buildEvent({ source: sourceB, intent: "OUT", hoursAgo: 1 }));

        const active = await app.prisma.timeEntry.findMany({
          where: { employeeId: data.employee.id, deletedAt: null },
        });
        expect(active.length).toBeLessThanOrEqual(1);

        const breaks = await app.prisma.break.findMany({
          where: { timeEntryId: { in: active.map((e) => e.id) } },
        });
        expect(breaks.length).toBeGreaterThanOrEqual(1);
      });
    }
  }

  // ── Block B — Gap > consolidationGapHours skips merge ─────────────────────
  it("Block B — gap 4.5h > 4h consolidationGapHours → no merge (2 separate TimeEntries)", async () => {
    // Ensure tenant config has default 4h
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { consolidationGapHours: 4 },
    });

    // NFC IN at 9h ago, NFC OUT at 5h ago, MOBILE IN at 0.5h ago
    // gap between NFC OUT and MOBILE IN = 4.5h > 4h → no merge
    await resolveClockEvent(app, buildEvent({ source: "NFC", intent: "IN", hoursAgo: 9 }));
    await resolveClockEvent(app, buildEvent({ source: "NFC", intent: "OUT", hoursAgo: 5 }));
    await resolveClockEvent(app, buildEvent({ source: "MOBILE", intent: "IN", hoursAgo: 0.5 }));

    const closedNfc = await app.prisma.timeEntry.findFirst({
      where: {
        employeeId: data.employee.id,
        deletedAt: null,
        source: "NFC",
        endTime: { not: null },
      },
    });
    const openMobile = await app.prisma.timeEntry.findFirst({
      where: {
        employeeId: data.employee.id,
        deletedAt: null,
        source: "MOBILE",
        endTime: null,
      },
    });
    expect(closedNfc).toBeDefined();
    expect(openMobile).toBeDefined();
    expect(closedNfc?.id).not.toBe(openMobile?.id);
  });

  // ── Block C — 2026-06-04 prod incident regression ─────────────────────────
  it("Block C — 2026-06-04 prod incident regression: NFC×3 + MOBILE×1 same day, all gap < 4h → resolver collapses to ≤ 2 active TimeEntries via cross-source merge", async () => {
    // Force gap window = 4h (default per CONTEXT D-04)
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { consolidationGapHours: 4 },
    });

    // Reproduce the 2026-06-04 prod incident shape:
    //   NFC IN at  8.5h ago  → NFC OUT at 7h ago     (1.5h work)
    //   NFC IN at  6.5h ago  → NFC OUT at 5h ago     (gap 0.5h, 1.5h work)
    //   MOBILE IN at 4h ago  → MOBILE OUT at 2h ago  (gap 1h, 2h work)
    // Pre-resolver: 3 separate TimeEntry rows (the bug — un-merged cross-source).
    // Post-resolver: cross-source merges collapse to 1 (or rarely 2) active row.
    await resolveClockEvent(app, buildEvent({ source: "NFC", intent: "AUTO", hoursAgo: 8.5 }));
    await resolveClockEvent(app, buildEvent({ source: "NFC", intent: "AUTO", hoursAgo: 7 }));
    await resolveClockEvent(app, buildEvent({ source: "NFC", intent: "AUTO", hoursAgo: 6.5 }));
    await resolveClockEvent(app, buildEvent({ source: "NFC", intent: "AUTO", hoursAgo: 5 }));
    await resolveClockEvent(app, buildEvent({ source: "MOBILE", intent: "IN", hoursAgo: 4 }));
    await resolveClockEvent(app, buildEvent({ source: "MOBILE", intent: "OUT", hoursAgo: 2 }));

    const active = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id, deletedAt: null },
    });
    // Post-resolver invariant: dramatic reduction from prod's 3-row shape.
    // Multiple consecutive consolidations across NFC+MOBILE → ≤ 2 active rows.
    expect(active.length).toBeLessThanOrEqual(2);

    // Verify Break rows exist (merge created at least one Break per consolidation).
    const breaks = await app.prisma.break.findMany({
      where: { timeEntryId: { in: active.map((e) => e.id) } },
    });
    expect(breaks.length).toBeGreaterThanOrEqual(1);
  });
});
