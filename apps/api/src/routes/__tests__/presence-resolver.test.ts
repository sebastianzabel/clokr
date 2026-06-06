/**
 * Phase 76.2 (ARCH-V19-01) — Plan 5 regression test for POST /api/v1/presence/events
 * via the resolver. Final adapter migration; sub-req C step 4 of 4.
 *
 * Coverage:
 *   Block A: connected → no existing entry → resolver creates WIFI TimeEntry (CLOCKED_IN).
 *   Block B: connected → existing WIFI entry → adapter short-circuits, emits
 *            WIFI_PRESENCE_CONFIRMED, no duplicate row.
 *   Block C: connected → existing NFC entry → adapter short-circuits, emits
 *            WIFI_PRESENCE_CONFIRMED on the NFC entry (cross-source dedup).
 *   Block D: disconnected → existing WIFI open entry → resolver closes (CLOCKED_OUT).
 *   Block E: disconnected → no open entry → adapter emits WIFI_NO_OPEN_ENTRY audit,
 *            HTTP 200 (idempotent contract preserved — never 409 on /events).
 *
 * Pre-Task-2 baseline: most blocks pass against the legacy adapter because the
 * DB-state and audit-action assertions match the legacy behavior. Block A is the
 * primary regression check post-Task-2 (the WIFI entry must still be created and
 * the response stays HTTP 200; the resolver emits CLOCK_IN instead of WIFI_CLOCK_IN
 * — Plan 5 documents this rename per D-03 unification, but this test does NOT
 * assert the legacy WIFI_CLOCK_IN action name to remain agnostic to the rename).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHash } from "crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../__tests__/setup";

// Use today's date in UTC; shift covers "now" wall-clock in Europe/Berlin
const TODAY = new Date();
const TODAY_DATE_STR = TODAY.toISOString().slice(0, 10);
const TODAY_UTC_MIDNIGHT = new Date(TODAY_DATE_STR + "T00:00:00Z");
const NOW_ISO = TODAY.toISOString();

// MAC constants — normalized form is lowercase colon-separated
const TEST_MAC_RAW = "AA:BB:CC:DD:EE:11";
const TEST_MAC_NORMALIZED = "aa:bb:cc:dd:ee:11";

// Unique presence-source key per test-run to avoid collisions
const RUN_ID = Date.now().toString(36);
const RAW_KEY = `clk_p5_resolver_${RUN_ID}`;
const KEY_HASH = createHash("sha256").update(RAW_KEY).digest("hex");

describe("POST /presence/events — Phase 76.2 Plan 5 resolver migration", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let presenceSourceId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "presence-resolver");

    // Force tenant timezone to Europe/Berlin and a wide WIFI window so that any
    // "now" timestamp falls inside the shift window. We then create a shift that
    // covers a very wide window around "now" in Berlin local time.
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { timezone: "Europe/Berlin", wifiPresenceWindowMinutes: 720 },
    });

    // Opt the employee into WIFI presence
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { wifiMacs: [TEST_MAC_NORMALIZED], wifiPresenceEnabled: true },
    });

    // Seed an all-day shift on TODAY so the shift-window gate passes for any time
    await app.prisma.shift.create({
      data: {
        employeeId: data.employee.id,
        date: TODAY_UTC_MIDNIGHT,
        startTime: "00:00",
        endTime: "23:59",
        label: "Plan-5 resolver test shift",
      },
    });

    // PresenceSource for Bearer auth on /events
    const src = await app.prisma.presenceSource.create({
      data: {
        tenantId: data.tenant.id,
        name: "Plan-5 Test FritzBox",
        keyHash: KEY_HASH,
        keyPrefix: RAW_KEY.slice(0, 8),
        revokedAt: null,
      },
    });
    presenceSourceId = src.id;
  });

  afterAll(async () => {
    try {
      const entries = await app.prisma.timeEntry.findMany({
        where: { employeeId: data.employee.id },
        select: { id: true },
      });
      await app.prisma.break.deleteMany({
        where: { timeEntryId: { in: entries.map((e) => e.id) } },
      });
      await app.prisma.auditLog.deleteMany({
        where: {
          OR: [{ entityId: { in: entries.map((e) => e.id) } }, { entityId: data.employee.id }],
        },
      });
      await app.prisma.timeEntry.deleteMany({
        where: { employeeId: data.employee.id },
      });
      await app.prisma.shift.deleteMany({
        where: { employeeId: data.employee.id },
      });
      await app.prisma.presenceSource.deleteMany({
        where: { id: presenceSourceId },
      });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("presence-resolver cleanup failed:", err);
    }
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
      where: {
        OR: [{ entityId: { in: entries.map((e) => e.id) } }, { entityId: data.employee.id }],
      },
    });
    await app.prisma.timeEntry.deleteMany({
      where: { employeeId: data.employee.id },
    });
  });

  function postEvent(eventType: "connected" | "disconnected", at: string = NOW_ISO) {
    return app.inject({
      method: "POST",
      url: "/api/v1/presence/events",
      headers: { authorization: `Bearer ${RAW_KEY}` },
      payload: {
        mac: TEST_MAC_RAW,
        eventType,
        timestamp: at,
        adapter: "fritzbox",
      },
    });
  }

  // ── Block A — connected with no existing entry → CLOCKED_IN ────────────────
  it("Block A — connected with no existing entry → 200 + WIFI TimeEntry row created", async () => {
    const res = await postEvent("connected");
    expect(res.statusCode).toBe(200);

    const rows = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id, deletedAt: null, source: "WIFI" },
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].endTime).toBeNull();
  });

  // ── Block B — connected with existing WIFI entry → WIFI_PRESENCE_CONFIRMED ─
  it("Block B — connected with existing open WIFI entry → 200 + WIFI_PRESENCE_CONFIRMED audit, no duplicate row", async () => {
    const startedAt = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago
    const existing = await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: TODAY_UTC_MIDNIGHT,
        startTime: startedAt,
        source: "WIFI",
      },
    });

    const before = new Date();
    const res = await postEvent("connected");
    expect(res.statusCode).toBe(200);

    const rows = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id, deletedAt: null },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(existing.id); // same row, no duplicate

    const audits = await app.prisma.auditLog.findMany({
      where: {
        action: "WIFI_PRESENCE_CONFIRMED",
        entityId: existing.id,
        createdAt: { gte: before },
      },
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  // ── Block C — connected with existing NFC entry → cross-source confirmed ──
  it("Block C — connected with existing NFC entry → 200 + WIFI_PRESENCE_CONFIRMED on NFC entry (cross-source dedup)", async () => {
    const startedAt = new Date(Date.now() - 60 * 60 * 1000); // 60 min ago
    const nfcEntry = await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: TODAY_UTC_MIDNIGHT,
        startTime: startedAt,
        source: "NFC",
      },
    });

    const before = new Date();
    const res = await postEvent("connected");
    expect(res.statusCode).toBe(200);

    const rows = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id, deletedAt: null },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(nfcEntry.id); // NFC entry preserved, no WIFI duplicate

    const audits = await app.prisma.auditLog.findMany({
      where: {
        action: "WIFI_PRESENCE_CONFIRMED",
        entityId: nfcEntry.id,
        createdAt: { gte: before },
      },
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  // ── Block D — disconnected with existing WIFI open entry → CLOCKED_OUT ────
  it("Block D — disconnected with open WIFI entry → 200, entry's endTime is set", async () => {
    const startedAt = new Date(Date.now() - 60 * 60 * 1000); // 60 min ago
    const wifi = await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: TODAY_UTC_MIDNIGHT,
        startTime: startedAt,
        source: "WIFI",
      },
    });

    const res = await postEvent("disconnected");
    expect(res.statusCode).toBe(200);

    const closed = await app.prisma.timeEntry.findUnique({ where: { id: wifi.id } });
    expect(closed).not.toBeNull();
    expect(closed!.endTime).not.toBeNull();
  });

  // ── Block E — disconnected with no open entry → WIFI_NO_OPEN_ENTRY audit ──
  it("Block E — disconnected with no open entry → 200 + WIFI_NO_OPEN_ENTRY audit (idempotent contract)", async () => {
    const before = new Date();
    const res = await postEvent("disconnected");
    expect(res.statusCode).toBe(200);

    const audits = await app.prisma.auditLog.findMany({
      where: {
        action: "WIFI_NO_OPEN_ENTRY",
        entityId: data.employee.id,
        createdAt: { gte: before },
      },
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits[0].purgeable).toBe(true);
  });
});
