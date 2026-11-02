/**
 * Issue #610 (Phase 610-04, Task 1, D-07, P-610-11) - the presence webhook records when a coupled
 * device was last seen. The value is clamped to the request's now, never moves backwards and does not
 * change one answer of the webhook (the pinned WLAN tests assert those answers).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import { createPresenceSourceWithKey, randomTestMac } from "./presence-pairing-fixtures-610";

describe("POST /api/v1/presence/events - lastSeenAt (Issue #610)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let rawKey: string;
  let foreign: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "pls610");
    foreign = await seedTestData(app, "pls610f");
    ({ rawKey } = await createPresenceSourceWithKey(app, data.tenant.id));
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
    await cleanupTestData(app, foreign.tenant.id);
  });

  async function newDevice(employeeId: string, tenantId = data.tenant.id) {
    const mac = randomTestMac();
    const device = await app.prisma.presenceDevice.create({
      data: { tenantId, employeeId, mac, pairedVia: "QR" },
    });
    return { mac, id: device.id };
  }

  function post(
    mac: string,
    timestamp: Date,
    eventType: "connected" | "disconnected" = "connected",
  ) {
    return app.inject({
      method: "POST",
      url: "/api/v1/presence/events",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { mac, eventType, timestamp: timestamp.toISOString(), adapter: "fritzbox" },
    });
  }

  async function lastSeen(id: string) {
    const row = await app.prisma.presenceDevice.findUniqueOrThrow({ where: { id } });
    return row.lastSeenAt;
  }

  it("records the event time of a connected event and answers exactly as before", async () => {
    const { mac, id } = await newDevice(data.employee.id);
    const t = new Date(Date.now() - 3 * 3600_000);
    const res = await post(mac, t);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"ok":true}');
    expect((await lastSeen(id))?.getTime()).toBe(t.getTime());
  });

  it("does not move lastSeenAt backwards on an older event", async () => {
    const { mac, id } = await newDevice(data.employee.id);
    const newer = new Date(Date.now() - 1 * 3600_000);
    const older = new Date(Date.now() - 5 * 3600_000);
    await post(mac, newer);
    const res = await post(mac, older);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"ok":true}');
    expect((await lastSeen(id))?.getTime()).toBe(newer.getTime());
  });

  it("never trusts a future timestamp", async () => {
    const { mac, id } = await newDevice(data.employee.id);
    const before = Date.now();
    const res = await post(mac, new Date(Date.now() + 3600_000));
    const after = Date.now();
    expect(res.statusCode).toBe(200);
    const seen = (await lastSeen(id))?.getTime() ?? 0;
    expect(seen).toBeGreaterThanOrEqual(before);
    expect(seen).toBeLessThanOrEqual(after);
  });

  it("a disconnected event also updates it", async () => {
    const { mac, id } = await newDevice(data.employee.id);
    const t = new Date(Date.now() - 2 * 3600_000);
    const res = await post(mac, t, "disconnected");
    expect(res.statusCode).toBe(200);
    expect((await lastSeen(id))?.getTime()).toBe(t.getTime());
  });

  it("writes no device row for an unknown MAC", async () => {
    const mac = randomTestMac();
    const res = await post(mac, new Date(Date.now() - 60_000));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"ok":true}');
    const rows = await app.prisma.presenceDevice.findMany({ where: { mac } });
    expect(rows).toHaveLength(0);
  });

  it("does not touch a device of another tenant with the same MAC", async () => {
    const mac = randomTestMac();
    const other = await app.prisma.presenceDevice.create({
      data: { tenantId: foreign.tenant.id, employeeId: foreign.employee.id, mac, pairedVia: "QR" },
    });
    const res = await post(mac, new Date(Date.now() - 60_000));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"ok":true}');
    expect(await lastSeen(other.id)).toBeNull();
  });
});
