/**
 * Issue #610 (Phase 610-01, tracer) - a presence key issues a one-time code for a MAC, the signed-in
 * person previews it and confirms it with consent, and GET /me/wifi lists the QR device.
 *
 * The contract details (TTL, single use, uniform 404, supersede, sanitising, strict bodies, request
 * logs) live in presence-pairing-contract-610.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditRowsFor, cleanupTestData, getTestApp, seedTestData, closeTestApp } from "./setup";
import type { FastifyInstance } from "fastify";
import { PAIRING_CODE_PATTERN, hashPairingCode } from "../contexts/time-tracking/pairing-code";
import {
  confirmCode,
  createPresenceSourceWithKey,
  issueCode,
  previewCode,
  randomTestMac,
} from "./presence-pairing-fixtures-610";

describe("WLAN pairing tracer (Issue #610)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let rawKey: string;
  let sourceId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "pp610");
    ({ rawKey, sourceId } = await createPresenceSourceWithKey(app, data.tenant.id));
  });

  afterAll(async () => {
    try {
      await app.prisma.auditLog.deleteMany({
        where: { entity: { in: ["PresenceDevice", "Employee"] }, entityId: data.employee.id },
      });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("presence-pairing-610 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("key -> code -> preview -> confirm -> GET /me/wifi lists the QR device", async () => {
    const mac = randomTestMac();
    const hostname = "  iPhone von Test  ";

    // ── issue ────────────────────────────────────────────────────────────────
    const issued = await issueCode(app, rawKey, mac, hostname);
    expect(issued.statusCode).toBe(201);
    const issuedBody = JSON.parse(issued.body);
    expect(Object.keys(issuedBody).sort((a, b) => a.localeCompare(b))).toEqual([
      "code",
      "expiresAt",
    ]);
    const code: string = issuedBody.code;
    expect(code).toMatch(PAIRING_CODE_PATTERN);

    // AC-2: issuing a code creates no mapping and changes nobody's consent
    expect(await app.prisma.presenceDevice.count({ where: { tenantId: data.tenant.id } })).toBe(0);
    const before = await app.prisma.employee.findUniqueOrThrow({
      where: { id: data.employee.id },
      select: { wifiPresenceEnabled: true, wifiOptInAt: true },
    });
    expect(before.wifiPresenceEnabled).toBe(false);
    expect(before.wifiOptInAt).toBeNull();

    // ── preview ──────────────────────────────────────────────────────────────
    const preview = await previewCode(app, data.empToken, code);
    expect(preview.statusCode).toBe(200);
    const previewBody = JSON.parse(preview.body);
    expect(previewBody.macTail).toBe(mac.split(":").slice(-2).join(":"));
    expect(previewBody.deviceLabel).toBe("iPhone von Test");
    expect(previewBody.replacesDevice).toBe(false);
    expect(previewBody.alreadyPaired).toBe(false);
    expect(preview.body).not.toContain(mac);

    // ── confirm ──────────────────────────────────────────────────────────────
    const windowStart = Date.now();
    const confirmed = await confirmCode(app, data.empToken, code);
    const windowEnd = Date.now();
    expect(confirmed.statusCode).toBe(201);
    const confirmedBody = JSON.parse(confirmed.body);
    expect(confirmedBody.device.mac).toBe(mac);
    expect(confirmedBody.device.pairedVia).toBe("QR");
    expect(confirmedBody.replacedDevices).toBe(0);
    expect(confirmedBody.wifiPresenceEnabled).toBe(true);

    // ── GET /me/wifi ─────────────────────────────────────────────────────────
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/employees/me/wifi",
      headers: { authorization: `Bearer ${data.empToken}` },
    });
    expect(list.statusCode).toBe(200);
    const listBody = JSON.parse(list.body);
    expect(listBody.wifiPresenceEnabled).toBe(true);
    expect(listBody.devices).toHaveLength(1);
    expect(listBody.devices[0]).toMatchObject({
      mac,
      label: "iPhone von Test",
      pairedVia: "QR",
      lastSeenAt: null,
    });

    // ── consent on the Employee ──────────────────────────────────────────────
    const after = await app.prisma.employee.findUniqueOrThrow({
      where: { id: data.employee.id },
      select: { wifiPresenceEnabled: true, wifiOptInAt: true },
    });
    expect(after.wifiPresenceEnabled).toBe(true);
    expect(after.wifiOptInAt).not.toBeNull();
    expect(after.wifiOptInAt!.getTime()).toBeGreaterThanOrEqual(windowStart - 1000);
    expect(after.wifiOptInAt!.getTime()).toBeLessThanOrEqual(windowEnd + 1000);

    // ── audits: one consent UPDATE and one device CREATE ─────────────────────
    const employeeAudits = await auditRowsFor(app, "Employee", data.employee.id, "UPDATE");
    const consentAudits = employeeAudits.filter(
      (r) => (r.newValue as { consentVia?: string } | null)?.consentVia === "QR_PAIRING",
    );
    expect(consentAudits).toHaveLength(1);
    expect(consentAudits[0].newValue).toMatchObject({ wifiPresenceEnabled: true });
    expect(consentAudits[0].oldValue).toMatchObject({ wifiPresenceEnabled: false });
    const deviceAudits = await auditRowsFor(
      app,
      "PresenceDevice",
      confirmedBody.device.id,
      "CREATE",
    );
    expect(deviceAudits).toHaveLength(1);
    expect(deviceAudits[0].newValue).toMatchObject({
      mac,
      pairedVia: "QR",
      presenceSourceId: sourceId,
    });

    // ── the stored row: consumed, attributed, and never holding the raw code ─
    const row = await app.prisma.presencePairingCode.findFirstOrThrow({
      where: { tenantId: data.tenant.id, mac },
    });
    expect(row.consumedAt).not.toBeNull();
    expect(row.consumedByUserId).toBe(data.empUser.id);
    expect(row.codeHash).toBe(hashPairingCode(code));
    expect(JSON.stringify(row)).not.toContain(code);
  });
});
