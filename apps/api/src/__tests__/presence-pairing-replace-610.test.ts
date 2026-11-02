/**
 * Issue #610 (Phase 610-02, Task 1) - a QR pairing REPLACES the person's previous QR device
 * (D-07, "ersetzt, nicht angehaeuft"), keeps MANUAL devices, refreshes the own MAC instead of
 * refusing it, and refuses an inactive person with the uniform 404.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { auditRowsFor, cleanupTestData, closeTestApp, getTestApp, seedTestData } from "./setup";
import { isPresenceDeviceMacConflict } from "../contexts/time-tracking/presence-pairing";
import { PAIRING_CODE_INVALID_ERROR } from "../contexts/time-tracking/pairing-code";
import {
  confirmCode,
  createPeerEmployee,
  createPresenceSourceWithKey,
  issueCode,
  randomTestMac,
} from "./presence-pairing-fixtures-610";

describe("QR pairing replaces and refreshes (Issue #610, D-07)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let rawKey: string;
  let sourceId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "pr610");
    ({ rawKey, sourceId } = await createPresenceSourceWithKey(app, data.tenant.id));
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("presence-pairing-replace-610 cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function codeFor(mac: string): Promise<string> {
    const issued = await issueCode(app, rawKey, mac, "Neues Handy");
    expect(issued.statusCode).toBe(201);
    return JSON.parse(issued.body).code as string;
  }

  it("replaces the previous QR device, keeps the MANUAL one, leaves exactly one QR device", async () => {
    const peer = await createPeerEmployee(app, data.tenant.id, "replace");
    const macA = randomTestMac();
    const macB = randomTestMac();
    const macC = randomTestMac();
    const deviceA = await app.prisma.presenceDevice.create({
      data: { tenantId: data.tenant.id, employeeId: peer.employeeId, mac: macA, pairedVia: "QR" },
    });
    const deviceB = await app.prisma.presenceDevice.create({
      data: {
        tenantId: data.tenant.id,
        employeeId: peer.employeeId,
        mac: macB,
        pairedVia: "MANUAL",
      },
    });

    const res = await confirmCode(app, peer.token, await codeFor(macC));
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.replacedDevices).toBe(1);
    expect(body.device.mac).toBe(macC);

    const devices = await app.prisma.presenceDevice.findMany({
      where: { tenantId: data.tenant.id, employeeId: peer.employeeId },
      orderBy: [{ mac: "asc" }],
    });
    expect(devices.map((d) => d.mac).sort((a, b) => a.localeCompare(b))).toEqual(
      [macB, macC].sort((a, b) => a.localeCompare(b)),
    );
    // the MANUAL device survives untouched
    expect(devices.find((d) => d.id === deviceB.id)?.pairedVia).toBe("MANUAL");
    // exactly one QR device, and it is the new one
    const qr = devices.filter((d) => d.pairedVia === "QR");
    expect(qr).toHaveLength(1);
    expect(qr[0].mac).toBe(macC);
    expect(devices.some((d) => d.id === deviceA.id)).toBe(false);

    const deleted = await auditRowsFor(app, "PresenceDevice", deviceA.id, "DELETE");
    expect(deleted).toHaveLength(1);
    expect(deleted[0].oldValue).toMatchObject({ mac: macA, pairedVia: "QR" });
    expect(deleted[0].newValue).toMatchObject({
      reason: "Neu gekoppelt",
      trigger: "REPLACED_BY_QR_PAIRING",
    });
    const created = await auditRowsFor(app, "PresenceDevice", body.device.id, "CREATE");
    expect(created).toHaveLength(1);
    // the MANUAL device was not audited as deleted
    expect(await auditRowsFor(app, "PresenceDevice", deviceB.id, "DELETE")).toHaveLength(0);
  });

  it("refreshes the own QR device for the same MAC: 200, same row, newer addedAt, UPDATE audit", async () => {
    const peer = await createPeerEmployee(app, data.tenant.id, "refresh");
    const mac = randomTestMac();
    const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    const device = await app.prisma.presenceDevice.create({
      data: {
        tenantId: data.tenant.id,
        employeeId: peer.employeeId,
        mac,
        pairedVia: "QR",
        addedAt: old,
      },
    });

    const res = await confirmCode(app, peer.token, await codeFor(mac));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.device.id).toBe(device.id);
    expect(body.device.pairedVia).toBe("QR");
    expect(body.replacedDevices).toBe(0);
    expect(new Date(body.device.addedAt).getTime()).toBeGreaterThan(old.getTime());

    expect(
      await app.prisma.presenceDevice.count({
        where: { tenantId: data.tenant.id, employeeId: peer.employeeId },
      }),
    ).toBe(1);
    const updates = await auditRowsFor(app, "PresenceDevice", device.id, "UPDATE");
    expect(updates).toHaveLength(1);
    expect(updates[0].oldValue).toMatchObject({ pairedVia: "QR" });
    expect(updates[0].newValue).toMatchObject({ pairedVia: "QR" });
    expect(await auditRowsFor(app, "PresenceDevice", device.id, "CREATE")).toHaveLength(0);
  });

  it("turns the own MANUAL device for the same MAC into a QR device (200)", async () => {
    const peer = await createPeerEmployee(app, data.tenant.id, "manual");
    const mac = randomTestMac();
    const device = await app.prisma.presenceDevice.create({
      data: { tenantId: data.tenant.id, employeeId: peer.employeeId, mac, pairedVia: "MANUAL" },
    });

    const res = await confirmCode(app, peer.token, await codeFor(mac));
    expect(res.statusCode).toBe(200);
    const row = await app.prisma.presenceDevice.findUniqueOrThrow({ where: { id: device.id } });
    expect(row.pairedVia).toBe("QR");
    const updates = await auditRowsFor(app, "PresenceDevice", device.id, "UPDATE");
    expect(updates).toHaveLength(1);
    expect(updates[0].oldValue).toMatchObject({ pairedVia: "MANUAL" });
    expect(updates[0].newValue).toMatchObject({ pairedVia: "QR" });
  });

  it("a MAC mapped to another person is still refused with 409 and the code stays unconsumed", async () => {
    const owner = await createPeerEmployee(app, data.tenant.id, "owner");
    const other = await createPeerEmployee(app, data.tenant.id, "other");
    const mac = randomTestMac();
    await app.prisma.presenceDevice.create({
      data: { tenantId: data.tenant.id, employeeId: owner.employeeId, mac, pairedVia: "QR" },
    });
    const code = await codeFor(mac);

    const res = await confirmCode(app, other.token, code);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("PRESENCE_DEVICE_TAKEN");
    const row = await app.prisma.presencePairingCode.findFirstOrThrow({
      where: { tenantId: data.tenant.id, mac },
    });
    expect(row.consumedAt).toBeNull();
    expect(
      await app.prisma.presenceDevice.count({
        where: { tenantId: data.tenant.id, employeeId: other.employeeId },
      }),
    ).toBe(0);
  });

  it("a person whose user is inactive cannot pair: uniform 404, no device, code unconsumed", async () => {
    const peer = await createPeerEmployee(app, data.tenant.id, "inactive");
    await app.prisma.user.update({ where: { id: peer.userId }, data: { isActive: false } });
    const mac = randomTestMac();

    const res = await confirmCode(app, peer.token, await codeFor(mac));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual(PAIRING_CODE_INVALID_ERROR);
    expect(
      await app.prisma.presenceDevice.count({
        where: { tenantId: data.tenant.id, employeeId: peer.employeeId },
      }),
    ).toBe(0);
    const row = await app.prisma.presencePairingCode.findFirstOrThrow({
      where: { tenantId: data.tenant.id, mac },
    });
    expect(row.consumedAt).toBeNull();
    expect(row.presenceSourceId).toBe(sourceId);
  });
});

describe("isPresenceDeviceMacConflict (pure)", () => {
  it("is true for a P2002 on PresenceDevice [tenantId, mac] in the structured shapes", () => {
    expect(
      isPresenceDeviceMacConflict({
        code: "P2002",
        meta: { target: ["tenantId", "mac"] },
      }),
    ).toBe(true);
    expect(
      isPresenceDeviceMacConflict({
        code: "P2002",
        meta: {
          driverAdapterError: {
            cause: { constraint: { index: "PresenceDevice_tenantId_mac_key" } },
          },
        },
      }),
    ).toBe(true);
  });

  it("is false for another unique violation and for non-unique errors", () => {
    expect(
      isPresenceDeviceMacConflict({
        code: "P2002",
        meta: { target: ["codeHash"] },
      }),
    ).toBe(false);
    expect(
      isPresenceDeviceMacConflict({
        code: "P2002",
        meta: { driverAdapterError: { cause: { constraint: { index: "User_email_key" } } } },
      }),
    ).toBe(false);
    expect(isPresenceDeviceMacConflict({ code: "P2025" })).toBe(false);
    expect(isPresenceDeviceMacConflict(new Error("boom"))).toBe(false);
    expect(isPresenceDeviceMacConflict(null)).toBe(false);
  });
});
