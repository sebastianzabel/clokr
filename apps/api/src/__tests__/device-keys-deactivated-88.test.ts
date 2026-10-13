/**
 * Phase 88 plan 09 (AC-88-08, D-05) — physical devices of a deactivated tenant get nothing and write
 * nothing. A device key bypasses `requireAuth`, so each device handler asks the tenant state itself; the
 * key stays valid, so reactivation restores the device without re-provisioning.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, seedOperator, cleanupTestData } from "./setup";
import { deactivateTenant, reactivateTenant } from "../contexts/platform/tenant-status";

const TEST_MAC_RAW = "AA:BB:CC:DD:EE:01";
const TEST_MAC_NORMALIZED = "aa:bb:cc:dd:ee:01";
const TEST_DATE = new Date("2026-01-15T00:00:00Z");
const IN_WINDOW_TIMESTAMP = "2026-01-15T08:05:00.000Z"; // 5 min after a 09:00 Berlin shift start

let app: FastifyInstance;
let data: Awaited<ReturnType<typeof seedTestData>>;
let operatorId: string;
let terminalKey: string;
let presenceKey: string;
let nfcCardId: string;
let addressCounter = 0;

function uniqueAddress(): string {
  const n = addressCounter++;
  return `10.90.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const request = { ip: "203.0.113.11", headers: { "user-agent": "vitest-device" } };

async function deactivate() {
  const result = await app.prisma.$transaction((tx) =>
    deactivateTenant(tx, data.tenant.id, { operatorId, reason: "Vertrag beendet", request }),
  );
  expect(result.status).toBe("OK");
  app.invalidateTenantState(data.tenant.id);
}

async function reactivate() {
  const result = await app.prisma.$transaction((tx) =>
    reactivateTenant(tx, data.tenant.id, { operatorId, request }),
  );
  expect(result.status).toBe("OK");
  app.invalidateTenantState(data.tenant.id);
}

function allowedCards(key: string) {
  return app.inject({
    method: "GET",
    url: "/api/v1/terminals/allowed-cards",
    headers: { authorization: `Bearer ${key}` },
    remoteAddress: uniqueAddress(),
  });
}

function nfcPunch(key: string) {
  return app.inject({
    method: "POST",
    url: "/api/v1/time-entries/nfc-punch",
    headers: { authorization: `Bearer ${key}` },
    payload: { nfcCardId },
    remoteAddress: uniqueAddress(),
  });
}

function presenceEvent(key: string) {
  return app.inject({
    method: "POST",
    url: "/api/v1/presence/events",
    headers: { authorization: `Bearer ${key}` },
    payload: {
      mac: TEST_MAC_RAW,
      eventType: "connected",
      timestamp: IN_WINDOW_TIMESTAMP,
      adapter: "fritzbox",
    },
    remoteAddress: uniqueAddress(),
  });
}

async function timeEntryCount(): Promise<number> {
  return app.prisma.timeEntry.count({ where: { employeeId: data.employee.id } });
}

beforeAll(async () => {
  app = await getTestApp();
  data = await seedTestData(app, "devdeact");
  operatorId = (await seedOperator(app)).id;

  nfcCardId = `NFC-DEACT-${randomBytes(6).toString("hex")}`;
  await app.prisma.employee.update({
    where: { id: data.employee.id },
    data: { nfcCardId, wifiMacs: [TEST_MAC_NORMALIZED], wifiPresenceEnabled: true },
  });
  await app.prisma.tenantConfig.update({
    where: { tenantId: data.tenant.id },
    data: { timezone: "Europe/Berlin", wifiPresenceWindowMinutes: 15 },
  });

  terminalKey = `clk_${randomBytes(32).toString("hex")}`;
  await app.prisma.terminalApiKey.create({
    data: {
      tenantId: data.tenant.id,
      name: "Deactivation Terminal",
      keyHash: sha256(terminalKey),
      keyPrefix: terminalKey.slice(0, 12),
    },
  });

  presenceKey = `clk_pwh_deact_${randomBytes(8).toString("hex")}`;
  await app.prisma.presenceSource.create({
    data: {
      tenantId: data.tenant.id,
      name: "Deactivation FritzBox",
      keyHash: sha256(presenceKey),
      keyPrefix: presenceKey.slice(0, 8),
    },
  });

  // A shift on the test day so a connected event inside the window books a presence entry.
  await app.prisma.shift.create({
    data: {
      employeeId: data.employee.id,
      salonId: data.salonId,
      date: TEST_DATE,
      startTime: "09:00",
      endTime: "17:00",
      label: "Testschicht",
    },
  });
});

afterEach(async () => {
  const row = await app.prisma.tenant.findUnique({
    where: { id: data.tenant.id },
    select: { deactivatedAt: true },
  });
  if (row?.deactivatedAt) await reactivate();
});

afterAll(async () => {
  await app.prisma.break.deleteMany({ where: { timeEntry: { employeeId: data.employee.id } } });
  await app.prisma.timeEntry.deleteMany({ where: { employeeId: data.employee.id } });
  await app.prisma.terminalApiKey.deleteMany({ where: { tenantId: data.tenant.id } });
  await app.prisma.presenceSource.deleteMany({ where: { tenantId: data.tenant.id } });
  await cleanupTestData(app, data.tenant.id);
  await closeTestApp();
});

describe("device keys of a deactivated tenant", () => {
  it("terminal allowed-cards answers 403 TENANT_DEACTIVATED and 200 again after reactivation", async () => {
    const before = await allowedCards(terminalKey);
    expect(before.statusCode).toBe(200);
    expect(JSON.parse(before.body).cards).toContain(nfcCardId);

    await deactivate();
    const refused = await allowedCards(terminalKey);
    expect(refused.statusCode).toBe(403);
    expect(JSON.parse(refused.body)).toEqual(app.tenantDeactivatedError);
    expect(refused.body).not.toContain(nfcCardId);

    await reactivate();
    const after = await allowedCards(terminalKey);
    expect(after.statusCode).toBe(200);
    expect(JSON.parse(after.body).cards).toContain(nfcCardId);
  });

  it("NFC punch answers 403, creates no time entry, and works again after reactivation", async () => {
    const entriesBefore = await timeEntryCount();

    await deactivate();
    const refused = await nfcPunch(terminalKey);
    expect(refused.statusCode).toBe(403);
    expect(JSON.parse(refused.body).code).toBe("TENANT_DEACTIVATED");
    expect(await timeEntryCount()).toBe(entriesBefore);

    await reactivate();
    const after = await nfcPunch(terminalKey);
    expect(after.statusCode).toBe(200);
    expect(JSON.parse(after.body).action).toBe("IN");
    expect(await timeEntryCount()).toBe(entriesBefore + 1);

    // Leave no open entry behind for the presence test below.
    await app.prisma.timeEntry.deleteMany({ where: { employeeId: data.employee.id } });
  });

  it("presence events answer 403, write no time entry or audit row, and work again after reactivation", async () => {
    await app.prisma.timeEntry.deleteMany({ where: { employeeId: data.employee.id } });
    const startedAt = new Date();

    await deactivate();
    const refused = await presenceEvent(presenceKey);
    expect(refused.statusCode).toBe(403);
    expect(JSON.parse(refused.body).code).toBe("TENANT_DEACTIVATED");
    expect(await timeEntryCount()).toBe(0);
    const audit = await app.prisma.auditLog.count({
      where: {
        action: { startsWith: "WIFI_" },
        entityId: data.employee.id,
        createdAt: { gte: startedAt },
      },
    });
    expect(audit).toBe(0);

    await reactivate();
    const after = await presenceEvent(presenceKey);
    expect(after.statusCode).toBe(200);
    expect(await timeEntryCount()).toBe(1);
  });

  it("keeps the 401 for an unknown device key, deactivated or not", async () => {
    await deactivate();
    expect((await allowedCards("clk_unknown")).statusCode).toBe(401);
    expect((await nfcPunch("clk_unknown")).statusCode).toBe(401);
    expect((await presenceEvent("clk_unknown")).statusCode).toBe(401);
  });
});
