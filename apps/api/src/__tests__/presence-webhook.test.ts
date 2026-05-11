/**
 * Integration tests for POST /api/v1/presence/events
 * Covers REQ-01 through REQ-09 as defined in 25-03-PLAN.md
 *
 * Test date: 2026-01-15 (Thursday)
 * Shift: 09:00–17:00 Europe/Berlin = 08:00–16:00 UTC (winter, UTC+1)
 * Test timestamp for in-window events: 2026-01-15T08:05:00.000Z (5 min after shift start)
 * Tenant timezone: Europe/Berlin (set in TenantConfig)
 */
import { createHash } from "crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

// ── Test constants ──────────────────────────────────────────────────────────
const TEST_MAC_RAW = "AA:BB:CC:DD:EE:FF";
const TEST_MAC_NORMALIZED = "aa:bb:cc:dd:ee:ff";
const TEST_DATE = new Date("2026-01-15T00:00:00Z"); // date key for TimeEntry
const IN_WINDOW_TIMESTAMP = "2026-01-15T08:05:00.000Z"; // 5 min after shift start (09:00 Berlin = 08:00 UTC)
const OUT_WINDOW_TIMESTAMP = "2026-01-15T12:00:00.000Z"; // midday — far from shift bounds
const DISCONNECT_TIMESTAMP = "2026-01-15T16:05:00.000Z"; // 5 min after shift end (17:00 Berlin = 16:00 UTC)

// Use unique keys per test run to avoid conflicts from leftover data
const RUN_ID = Date.now().toString(36);
const RAW_KEY = `clk_pwh_active_${RUN_ID}`;
const KEY_HASH = createHash("sha256").update(RAW_KEY).digest("hex");

const REVOKED_RAW_KEY = `clk_pwh_revoked_${RUN_ID}`;
const REVOKED_KEY_HASH = createHash("sha256").update(REVOKED_RAW_KEY).digest("hex");

// ── Describe block ──────────────────────────────────────────────────────────
describe("POST /api/v1/presence/events", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let presenceSourceId: string;
  let revokedSourceId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "pwh");

    const prisma = app.prisma;

    // Ensure tenant TZ is Europe/Berlin so our timestamps match the window calculations
    await prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { timezone: "Europe/Berlin", wifiPresenceWindowMinutes: 15 },
    });

    // Create an active PresenceSource with our unique run key
    const activeSource = await prisma.presenceSource.create({
      data: {
        tenantId: data.tenant.id,
        name: "Test FritzBox",
        keyHash: KEY_HASH,
        keyPrefix: RAW_KEY.slice(0, 8),
        revokedAt: null,
      },
    });
    presenceSourceId = activeSource.id;

    // Create a revoked PresenceSource for REQ-02
    const revokedSource = await prisma.presenceSource.create({
      data: {
        tenantId: data.tenant.id,
        name: "Revoked Source",
        keyHash: REVOKED_KEY_HASH,
        keyPrefix: REVOKED_RAW_KEY.slice(0, 8),
        revokedAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
    revokedSourceId = revokedSource.id;

    // Create a shift for the test employee on 2026-01-15 (09:00–17:00 Berlin)
    await prisma.shift.create({
      data: {
        employeeId: data.employee.id,
        date: TEST_DATE,
        startTime: "09:00",
        endTime: "17:00",
        label: "Testschicht",
      },
    });
  });

  afterAll(async () => {
    try {
      const prisma = app.prisma;

      // Clean up TimeEntry rows created during tests
      await prisma.timeEntry.deleteMany({
        where: { employeeId: data.employee.id },
      });

      // Clean up PresenceSource rows created during this test run
      await prisma.presenceSource.deleteMany({
        where: { id: { in: [presenceSourceId, revokedSourceId].filter(Boolean) } },
      });

      // Clean up AuditLog rows for this tenant's employees
      // AuditLog has no tenantId — clean by entityId (employee or entry IDs)
      await prisma.auditLog.deleteMany({
        where: {
          action: { startsWith: "WIFI_" },
          entityId: data.employee.id,
        },
      });

      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("presence-webhook test cleanup failed:", err);
    }
  });

  // Helper: configure employee wifiMacs and wifiPresenceEnabled
  async function setupEmployee(opts: { wifiMacs: string[]; wifiPresenceEnabled: boolean }) {
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: {
        wifiMacs: opts.wifiMacs,
        wifiPresenceEnabled: opts.wifiPresenceEnabled,
      },
    });
  }

  // Helper: clean TimeEntry rows created on TEST_DATE
  async function cleanTimeEntries() {
    await app.prisma.timeEntry.deleteMany({
      where: { employeeId: data.employee.id, date: TEST_DATE },
    });
  }

  // ── REQ-01: Valid Bearer key returns 200 ──────────────────────────────────
  it("REQ-01: valid Bearer key returns 200", async () => {
    await setupEmployee({ wifiMacs: [], wifiPresenceEnabled: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/presence/events",
      headers: { authorization: `Bearer ${RAW_KEY}` },
      payload: {
        mac: "00:11:22:33:44:55", // unknown MAC — won't create any entry
        eventType: "connected",
        timestamp: IN_WINDOW_TIMESTAMP,
        adapter: "fritzbox",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  // ── REQ-02: Revoked key returns 401 ──────────────────────────────────────
  it("REQ-02: revoked Bearer key returns 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/presence/events",
      headers: { authorization: `Bearer ${REVOKED_RAW_KEY}` },
      payload: {
        mac: TEST_MAC_RAW,
        eventType: "connected",
        timestamp: IN_WINDOW_TIMESTAMP,
      },
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/Presence-Key/);
  });

  // ── REQ-02b: Unknown key returns 401 ─────────────────────────────────────
  it("REQ-02b: unknown Bearer key returns 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/presence/events",
      headers: { authorization: `Bearer clk_completely_unknown_key_${RUN_ID}` },
      payload: {
        mac: TEST_MAC_RAW,
        eventType: "connected",
        timestamp: IN_WINDOW_TIMESTAMP,
      },
    });

    expect(res.statusCode).toBe(401);
  });

  // ── REQ-03: Unknown MAC → 200 + purgeable WIFI_UNKNOWN_MAC AuditLog ──────
  it("REQ-03: unknown MAC returns 200 and writes purgeable WIFI_UNKNOWN_MAC audit log", async () => {
    // Use a valid but unregistered MAC (normalizeMac requires exactly 12 hex chars)
    const unknownMac = "de:ad:be:ef:00:01";

    const before = new Date();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/presence/events",
      headers: { authorization: `Bearer ${RAW_KEY}` },
      payload: {
        mac: unknownMac,
        eventType: "connected",
        timestamp: IN_WINDOW_TIMESTAMP,
        adapter: "fritzbox",
      },
    });

    expect(res.statusCode).toBe(200);

    const log = await app.prisma.auditLog.findFirst({
      where: { action: "WIFI_UNKNOWN_MAC", createdAt: { gte: before } },
      orderBy: { createdAt: "desc" },
    });
    expect(log).not.toBeNull();
    expect(log!.purgeable).toBe(true);
    expect(log!.entityId).toBeNull();
  });

  // ── REQ-04: Opt-out employee → 200 + purgeable WIFI_OPT_OUT AuditLog ────
  it("REQ-04: wifiPresenceEnabled=false returns 200 and writes purgeable WIFI_OPT_OUT audit log", async () => {
    await setupEmployee({ wifiMacs: [TEST_MAC_NORMALIZED], wifiPresenceEnabled: false });

    const before = new Date();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/presence/events",
      headers: { authorization: `Bearer ${RAW_KEY}` },
      payload: {
        mac: TEST_MAC_RAW,
        eventType: "connected",
        timestamp: IN_WINDOW_TIMESTAMP,
        adapter: "fritzbox",
      },
    });

    expect(res.statusCode).toBe(200);

    const log = await app.prisma.auditLog.findFirst({
      where: {
        action: "WIFI_OPT_OUT",
        entityId: data.employee.id,
        createdAt: { gte: before },
      },
      orderBy: { createdAt: "desc" },
    });
    expect(log).not.toBeNull();
    expect(log!.purgeable).toBe(true);

    // No TimeEntry should be created
    const entry = await app.prisma.timeEntry.findFirst({
      where: { employeeId: data.employee.id, date: TEST_DATE },
    });
    expect(entry).toBeNull();
  });

  // ── REQ-05: No shift → 200 + purgeable WIFI_NO_SHIFT AuditLog ────────────
  it("REQ-05: no shift on date returns 200 and writes purgeable WIFI_NO_SHIFT audit log", async () => {
    // Use a different date that has no shift (Jan 20 — no shift seeded for that date)
    const noShiftTimestamp = "2026-01-20T08:05:00.000Z";

    await setupEmployee({ wifiMacs: [TEST_MAC_NORMALIZED], wifiPresenceEnabled: true });

    const before = new Date();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/presence/events",
      headers: { authorization: `Bearer ${RAW_KEY}` },
      payload: {
        mac: TEST_MAC_RAW,
        eventType: "connected",
        timestamp: noShiftTimestamp,
        adapter: "fritzbox",
      },
    });

    expect(res.statusCode).toBe(200);

    const log = await app.prisma.auditLog.findFirst({
      where: {
        action: "WIFI_NO_SHIFT",
        entityId: data.employee.id,
        createdAt: { gte: before },
      },
      orderBy: { createdAt: "desc" },
    });
    expect(log).not.toBeNull();
    expect(log!.purgeable).toBe(true);

    // No TimeEntry should be created for that date
    const entry = await app.prisma.timeEntry.findFirst({
      where: { employeeId: data.employee.id, date: new Date("2026-01-20T00:00:00Z") },
    });
    expect(entry).toBeNull();
  });

  // ── REQ-06: Existing NFC entry → 200 + WIFI_PRESENCE_CONFIRMED (dedup) ───
  it("REQ-06: existing NFC entry causes WIFI_PRESENCE_CONFIRMED, no new TimeEntry", async () => {
    await setupEmployee({ wifiMacs: [TEST_MAC_NORMALIZED], wifiPresenceEnabled: true });
    await cleanTimeEntries();

    // Create an existing NFC entry for the day
    const nfcEntry = await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: TEST_DATE,
        startTime: new Date("2026-01-15T08:00:00Z"),
        source: "NFC",
      },
    });

    const before = new Date();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/presence/events",
      headers: { authorization: `Bearer ${RAW_KEY}` },
      payload: {
        mac: TEST_MAC_RAW,
        eventType: "connected",
        timestamp: IN_WINDOW_TIMESTAMP,
        adapter: "fritzbox",
      },
    });

    expect(res.statusCode).toBe(200);

    // AuditLog must have WIFI_PRESENCE_CONFIRMED referencing the NFC entry
    const log = await app.prisma.auditLog.findFirst({
      where: {
        action: "WIFI_PRESENCE_CONFIRMED",
        entityId: nfcEntry.id,
        createdAt: { gte: before },
      },
      orderBy: { createdAt: "desc" },
    });
    expect(log).not.toBeNull();

    // TimeEntry count stays at 1 (no second entry created)
    const entries = await app.prisma.timeEntry.findMany({
      where: { employeeId: data.employee.id, date: TEST_DATE, deletedAt: null },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe("NFC");

    await cleanTimeEntries();
  });

  // ── REQ-08: connected, no existing entry → TimeEntry created (WIFI_CLOCK_IN) ──
  it("REQ-08: connected event with no existing entry creates WIFI TimeEntry and WIFI_CLOCK_IN audit log", async () => {
    await setupEmployee({ wifiMacs: [TEST_MAC_NORMALIZED], wifiPresenceEnabled: true });
    await cleanTimeEntries();

    const before = new Date();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/presence/events",
      headers: { authorization: `Bearer ${RAW_KEY}` },
      payload: {
        mac: TEST_MAC_RAW,
        eventType: "connected",
        timestamp: IN_WINDOW_TIMESTAMP,
        adapter: "fritzbox",
      },
    });

    expect(res.statusCode).toBe(200);

    // TimeEntry must exist with source=WIFI
    const entry = await app.prisma.timeEntry.findFirst({
      where: { employeeId: data.employee.id, date: TEST_DATE, deletedAt: null, source: "WIFI" },
    });
    expect(entry).not.toBeNull();
    expect(entry!.source).toBe("WIFI");
    expect(entry!.endTime).toBeNull();

    // AuditLog must have WIFI_CLOCK_IN
    const log = await app.prisma.auditLog.findFirst({
      where: {
        action: "WIFI_CLOCK_IN",
        entityId: entry!.id,
        createdAt: { gte: before },
      },
      orderBy: { createdAt: "desc" },
    });
    expect(log).not.toBeNull();
    expect(log!.purgeable).toBe(false);

    await cleanTimeEntries();
  });

  // ── REQ-09: disconnected, open WIFI entry → endTime set + WIFI_CLOCK_OUT ─
  it("REQ-09: disconnected event sets endTime on open WIFI entry and writes WIFI_CLOCK_OUT audit log", async () => {
    await setupEmployee({ wifiMacs: [TEST_MAC_NORMALIZED], wifiPresenceEnabled: true });
    await cleanTimeEntries();

    // Create an open WIFI entry for the employee
    const openEntry = await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: TEST_DATE,
        startTime: new Date(IN_WINDOW_TIMESTAMP),
        source: "WIFI",
        endTime: null,
      },
    });

    const before = new Date();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/presence/events",
      headers: { authorization: `Bearer ${RAW_KEY}` },
      payload: {
        mac: TEST_MAC_RAW,
        eventType: "disconnected",
        timestamp: DISCONNECT_TIMESTAMP,
        adapter: "fritzbox",
      },
    });

    expect(res.statusCode).toBe(200);

    // TimeEntry.endTime must now be set
    const updated = await app.prisma.timeEntry.findUnique({
      where: { id: openEntry.id },
    });
    expect(updated).not.toBeNull();
    expect(updated!.endTime).not.toBeNull();
    expect(updated!.endTime!.toISOString()).toBe(new Date(DISCONNECT_TIMESTAMP).toISOString());

    // AuditLog must have WIFI_CLOCK_OUT
    const log = await app.prisma.auditLog.findFirst({
      where: {
        action: "WIFI_CLOCK_OUT",
        entityId: openEntry.id,
        createdAt: { gte: before },
      },
      orderBy: { createdAt: "desc" },
    });
    expect(log).not.toBeNull();
    expect(log!.purgeable).toBe(false);

    await cleanTimeEntries();
  });

  // ── REQ-10: enrollment via PresenceDevice (admin/MA UI path) ──
  // Regression test: webhook MUST look up MAC in PresenceDevice table, not only Employee.wifiMacs.
  // Without this, MACs enrolled via admin/wifi-presence or /settings UI never trigger stamping.
  it("REQ-10: MAC enrolled via PresenceDevice triggers clock-in", async () => {
    await setupEmployee({ wifiMacs: [], wifiPresenceEnabled: true });
    await cleanTimeEntries();

    // Enroll the MAC ONLY via PresenceDevice (the path used by admin + self-service UIs)
    await app.prisma.presenceDevice.deleteMany({
      where: { tenantId: data.tenant.id, mac: TEST_MAC_NORMALIZED },
    });
    await app.prisma.presenceDevice.create({
      data: {
        tenantId: data.tenant.id,
        employeeId: data.employee.id,
        mac: TEST_MAC_NORMALIZED,
        label: "Test Phone",
      },
    });

    const before = new Date();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/presence/events",
      headers: { authorization: `Bearer ${RAW_KEY}` },
      payload: {
        mac: TEST_MAC_RAW,
        eventType: "connected",
        timestamp: IN_WINDOW_TIMESTAMP,
        adapter: "fritzbox",
      },
    });

    expect(res.statusCode).toBe(200);

    // TimeEntry created with source=WIFI
    const entry = await app.prisma.timeEntry.findFirst({
      where: { employeeId: data.employee.id, source: "WIFI" },
    });
    expect(entry).not.toBeNull();

    // No WIFI_UNKNOWN_MAC was written
    const unknownLog = await app.prisma.auditLog.findFirst({
      where: { action: "WIFI_UNKNOWN_MAC", createdAt: { gte: before } },
    });
    expect(unknownLog).toBeNull();

    await cleanTimeEntries();
    await app.prisma.presenceDevice.deleteMany({
      where: { tenantId: data.tenant.id, mac: TEST_MAC_NORMALIZED },
    });
  });
});
