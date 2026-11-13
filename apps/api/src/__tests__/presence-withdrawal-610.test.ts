/**
 * Issue #610 (Phase 610-02, Task 2) - withdrawing the WLAN consent removes EVERY device of the person
 * (QR and MANUAL) and the legacy `wifiMacs`, under the same Employee+User row lock the QR confirm takes
 * first; an admin reassign of a MAC is a MANUAL mapping (D-08, D-16, P-610-10, P-610-12).
 */
import { readFileSync } from "fs";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { auditRowsFor, cleanupTestData, closeTestApp, getTestApp, seedTestData } from "./setup";
import {
  confirmCode,
  createPeerEmployee,
  createPresenceSourceWithKey,
  issueCode,
  randomTestMac,
} from "./presence-pairing-fixtures-610";

const ROUTE_FILE = join(__dirname, "../contexts/time-tracking/api/employee-wifi.ts");

describe("consent withdrawal removes every device (Issue #610, D-08)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let rawKey: string;
  let sourceId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "wd610");
    ({ rawKey, sourceId } = await createPresenceSourceWithKey(app, data.tenant.id));
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("presence-withdrawal-610 cleanup failed:", err);
    }
    await closeTestApp();
  });

  function patchWifi(token: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PATCH",
      url: "/api/v1/employees/me/wifi",
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  async function optIn(employeeId: string, wifiMacs: string[] = []): Promise<Date> {
    const wifiOptInAt = new Date(Date.now() - 24 * 3600 * 1000);
    await app.prisma.employee.update({
      where: { id: employeeId },
      data: { wifiPresenceEnabled: true, wifiOptInAt, wifiMacs },
    });
    return wifiOptInAt;
  }

  it("false removes the QR and the MANUAL device and the legacy wifiMacs, keeps wifiOptInAt", async () => {
    const peer = await createPeerEmployee(app, data.tenant.id, "wd-all");
    const bystander = await createPeerEmployee(app, data.tenant.id, "wd-bystander");
    const optInAt = await optIn(peer.employeeId, [randomTestMac(), randomTestMac()]);
    const qr = await app.prisma.presenceDevice.create({
      data: {
        tenantId: data.tenant.id,
        employeeId: peer.employeeId,
        mac: randomTestMac(),
        label: "Handy",
        pairedVia: "QR",
      },
    });
    const manual = await app.prisma.presenceDevice.create({
      data: {
        tenantId: data.tenant.id,
        employeeId: peer.employeeId,
        mac: randomTestMac(),
        pairedVia: "MANUAL",
      },
    });
    const bystanderDevice = await app.prisma.presenceDevice.create({
      data: { tenantId: data.tenant.id, employeeId: bystander.employeeId, mac: randomTestMac() },
    });

    const res = await patchWifi(peer.token, { wifiPresenceEnabled: false });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Object.keys(body).sort((a, b) => a.localeCompare(b))).toEqual([
      "devicesRemoved",
      "wifiOptInAt",
      "wifiPresenceEnabled",
    ]);
    expect(body.wifiPresenceEnabled).toBe(false);
    expect(body.devicesRemoved).toBe(2);
    expect(new Date(body.wifiOptInAt).getTime()).toBe(optInAt.getTime());

    expect(
      await app.prisma.presenceDevice.count({
        where: { tenantId: data.tenant.id, employeeId: peer.employeeId },
      }),
    ).toBe(0);
    const employee = await app.prisma.employee.findUniqueOrThrow({
      where: { id: peer.employeeId },
      select: { wifiPresenceEnabled: true, wifiOptInAt: true, wifiMacs: true },
    });
    expect(employee.wifiPresenceEnabled).toBe(false);
    expect(employee.wifiMacs).toEqual([]);
    expect(employee.wifiOptInAt?.getTime()).toBe(optInAt.getTime());

    for (const device of [qr, manual]) {
      const deleted = await auditRowsFor(app, "PresenceDevice", device.id, "DELETE");
      expect(deleted).toHaveLength(1);
      expect(deleted[0].oldValue).toMatchObject({ mac: device.mac, pairedVia: device.pairedVia });
      expect(deleted[0].newValue).toMatchObject({
        reason: "Einwilligung widerrufen",
        trigger: "CONSENT_WITHDRAWN",
      });
    }
    const employeeAudits = (await auditRowsFor(app, "Employee", peer.employeeId, "UPDATE")).filter(
      (r) =>
        (r.newValue as { wifiPresenceEnabled?: boolean } | null)?.wifiPresenceEnabled === false,
    );
    expect(employeeAudits).toHaveLength(1);
    expect(employeeAudits[0].newValue).toMatchObject({
      wifiPresenceEnabled: false,
      wifiMacsCleared: 2,
    });
    expect(employeeAudits[0].oldValue).toMatchObject({ wifiPresenceEnabled: true });

    // another person's device is untouched
    expect(
      await app.prisma.presenceDevice.findUnique({ where: { id: bystanderDevice.id } }),
    ).not.toBeNull();
  });

  it("true keeps its exact response shape (no devicesRemoved)", async () => {
    const peer = await createPeerEmployee(app, data.tenant.id, "wd-true");
    const res = await patchWifi(peer.token, { wifiPresenceEnabled: true });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(JSON.parse(res.body)).sort((a, b) => a.localeCompare(b))).toEqual([
      "wifiOptInAt",
      "wifiPresenceEnabled",
    ]);
  });

  it("false while already false still removes a leftover device (explicit withdrawal)", async () => {
    const peer = await createPeerEmployee(app, data.tenant.id, "wd-leftover");
    const device = await app.prisma.presenceDevice.create({
      data: { tenantId: data.tenant.id, employeeId: peer.employeeId, mac: randomTestMac() },
    });

    const res = await patchWifi(peer.token, { wifiPresenceEnabled: false });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).devicesRemoved).toBe(1);
    expect(await app.prisma.presenceDevice.findUnique({ where: { id: device.id } })).toBeNull();
  });

  it("an inactive user may still withdraw", async () => {
    const peer = await createPeerEmployee(app, data.tenant.id, "wd-inactive");
    await optIn(peer.employeeId);
    await app.prisma.presenceDevice.create({
      data: { tenantId: data.tenant.id, employeeId: peer.employeeId, mac: randomTestMac() },
    });
    await app.prisma.user.update({ where: { id: peer.userId }, data: { isActive: false } });

    const res = await patchWifi(peer.token, { wifiPresenceEnabled: false });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).devicesRemoved).toBe(1);
  });

  it("source pin: the withdrawal transaction takes lockPresenceOwner as its FIRST statement", () => {
    const source = readFileSync(ROUTE_FILE, "utf8");
    expect(source.length).toBeGreaterThan(0);
    const start = source.indexOf("newVal === false");
    expect(start).toBeGreaterThan(-1);
    const tail = source.slice(start);
    const match = /\$transaction\(\s*async \(tx\)[^{]*\{\s*(?:\/\/[^\n]*\s*)*([^\n]+)/.exec(tail);
    expect(match).not.toBeNull();
    expect(match![1]).toMatch(/await lockPresenceOwner\(tx, employeeId, tenantId\)/);
  });

  it("confirm racing a withdrawal never leaves a device while consent is withdrawn (8 rounds)", async () => {
    const peer = await createPeerEmployee(app, data.tenant.id, "wd-race");
    let withdrawn = 0;
    let paired = 0;

    for (let round = 0; round < 8; round += 1) {
      await app.prisma.presenceDevice.deleteMany({
        where: { tenantId: data.tenant.id, employeeId: peer.employeeId },
      });
      await optIn(peer.employeeId);
      const mac = randomTestMac();
      const issued = await issueCode(app, rawKey, mac, "Rennen");
      expect(issued.statusCode).toBe(201);
      const code = JSON.parse(issued.body).code as string;

      // Alternate which request starts first, with a small stagger, so both interleavings occur.
      const startConfirm = () => confirmCode(app, peer.token, code);
      const startPatch = () => patchWifi(peer.token, { wifiPresenceEnabled: false });
      const stagger = () => new Promise((resolve) => setTimeout(resolve, round % 3));
      const [confirm, patch] =
        round % 2 === 0
          ? await Promise.all([startConfirm(), stagger().then(startPatch)])
          : await Promise.all([startPatch(), stagger().then(startConfirm)]).then(
              ([p, c]) => [c, p] as const,
            );
      expect([200, 201, 404]).toContain(confirm.statusCode);
      expect(patch.statusCode).toBe(200);

      const employee = await app.prisma.employee.findUniqueOrThrow({
        where: { id: peer.employeeId },
        select: { wifiPresenceEnabled: true },
      });
      const devices = await app.prisma.presenceDevice.findMany({
        where: { tenantId: data.tenant.id, employeeId: peer.employeeId },
      });
      if (employee.wifiPresenceEnabled) {
        // the later confirm re-gave consent: exactly one QR device
        expect(devices).toHaveLength(1);
        expect(devices[0].pairedVia).toBe("QR");
        paired += 1;
      } else {
        // never a device while consent is withdrawn
        expect(devices).toHaveLength(0);
        withdrawn += 1;
      }
    }
    console.info(`[610-02 race] rounds ended withdrawn=${withdrawn} paired=${paired}`);
    expect(withdrawn + paired).toBe(8);
  });

  it("an admin reassign of a MAC makes it a MANUAL mapping of the new person, which a QR confirm keeps", async () => {
    const holder = await createPeerEmployee(app, data.tenant.id, "assign-from");
    const target = await createPeerEmployee(app, data.tenant.id, "assign-to");
    const mac = randomTestMac();
    await app.prisma.presenceDevice.create({
      data: { tenantId: data.tenant.id, employeeId: holder.employeeId, mac, pairedVia: "QR" },
    });

    const assigned = await app.inject({
      method: "POST",
      url: `/api/v1/admin/presence-sources/${sourceId}/devices/${encodeURIComponent(mac)}/assign`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId: target.employeeId },
    });
    expect(assigned.statusCode).toBe(200);
    const row = await app.prisma.presenceDevice.findUniqueOrThrow({
      where: { tenantId_mac: { tenantId: data.tenant.id, mac } },
    });
    expect(row.employeeId).toBe(target.employeeId);
    expect(row.pairedVia).toBe("MANUAL");

    // a first admin assignment (create branch) is MANUAL too
    const freshMac = randomTestMac();
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/admin/presence-sources/${sourceId}/devices/${encodeURIComponent(freshMac)}/assign`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId: target.employeeId },
    });
    expect(created.statusCode).toBe(200);
    const freshRow = await app.prisma.presenceDevice.findUniqueOrThrow({
      where: { tenantId_mac: { tenantId: data.tenant.id, mac: freshMac } },
    });
    expect(freshRow.pairedVia).toBe("MANUAL");

    // the target's next QR confirm for another MAC does not delete the admin-assigned devices
    const issued = await issueCode(app, rawKey, randomTestMac(), "Neu");
    const res = await confirmCode(app, target.token, JSON.parse(issued.body).code);
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).replacedDevices).toBe(0);
    const kept = await app.prisma.presenceDevice.findMany({
      where: {
        tenantId: data.tenant.id,
        employeeId: target.employeeId,
        mac: { in: [mac, freshMac] },
      },
    });
    expect(kept).toHaveLength(2);
  });
});
