/**
 * Issue #608 (plan 01, the tracer) - one device subscribes and a test push leaves the server with
 * exactly the neutral {title, body, url} payload. `web-push` is mocked: nothing reaches the network.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  seedTestData,
  cleanupTestData,
  soleAuditRow,
  createAdminApiKey,
  removeFixtureApiKeys,
} from "./setup";
import {
  TEST_VAPID,
  CHROME_ANDROID_UA,
  buildPushEnabledApp,
  fakeDeviceSubscription,
  restorePushEnv,
} from "./push-fixtures-608";
import {
  PUSH_TEST_PAYLOAD,
  PUSH_TEST_TTL_SECONDS,
} from "../contexts/platform/notification-push-policy";

const { sendNotificationMock } = vi.hoisted(() => ({ sendNotificationMock: vi.fn() }));

vi.mock("web-push", () => {
  const api = { sendNotification: sendNotificationMock };
  // Cover both `mod.sendNotification` and `mod.default.sendNotification` access.
  return { default: api, ...api };
});

describe("Issue #608 tracer: subscribe a device, send the neutral test push", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let other: Awaited<ReturnType<typeof seedTestData>>;
  let apiKeyToken: string;
  let ip = 0;
  const nextIp = () => `10.60.8.${++ip}`;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    app = await buildPushEnabledApp();
    seed = await seedTestData(app, `-p608-${randomBytes(3).toString("hex")}`);
    other = await seedTestData(app, `-p608b-${randomBytes(3).toString("hex")}`);
    apiKeyToken = (
      await createAdminApiKey(app.prisma, {
        tenantId: seed.tenant.id,
        createdBy: seed.adminUser.id,
      })
    ).token;
  });

  afterAll(async () => {
    await app.prisma.pushSubscription.deleteMany({ where: { tenantId: seed.tenant.id } });
    await removeFixtureApiKeys(app.prisma, seed.tenant.id);
    await app.prisma.pushSubscription.deleteMany({ where: { tenantId: other.tenant.id } });
    await cleanupTestData(app, seed.tenant.id);
    await cleanupTestData(app, other.tenant.id);
    await app.close();
    restorePushEnv();
  });

  beforeEach(() => {
    sendNotificationMock.mockReset();
    sendNotificationMock.mockResolvedValue({ statusCode: 201 });
  });

  it("GET /config offers push with the public key", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/push/config",
      headers: auth(seed.empToken),
      remoteAddress: nextIp(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: true, publicKey: TEST_VAPID.publicKey });
  });

  it("registers a device and then hands the sender exactly the neutral payload", async () => {
    const sub = fakeDeviceSubscription();

    // Subscribe.
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/me/push/subscriptions",
      headers: { ...auth(seed.empToken), "user-agent": CHROME_ANDROID_UA },
      payload: sub,
      remoteAddress: nextIp(),
    });
    expect(created.statusCode).toBe(201);
    const device = created.json();
    expect(Object.keys(device).sort((a, b) => a.localeCompare(b))).toEqual([
      "consentedAt",
      "deviceLabel",
      "endpointHash",
      "id",
      "lastSuccessAt",
    ]);
    expect(device.deviceLabel).toBe("Chrome auf Android");
    expect(device.endpointHash).toBe(createHash("sha256").update(sub.endpoint).digest("hex"));
    expect(device.lastSuccessAt).toBeNull();

    // The row belongs to the token's tenant and user and carries the keys and the consent.
    const row = await app.prisma.pushSubscription.findUniqueOrThrow({ where: { id: device.id } });
    expect(row.tenantId).toBe(seed.tenant.id);
    expect(row.userId).toBe(seed.empUser.id);
    expect(row.endpoint).toBe(sub.endpoint);
    expect(row.p256dh).toBe(sub.keys.p256dh);
    expect(row.auth).toBe(sub.keys.auth);
    expect(row.consentedAt).toBeInstanceOf(Date);
    expect(device.consentedAt).toBe(row.consentedAt.toISOString());

    // The CREATE audit names deviceLabel and consentedAt, never the endpoint or a key.
    const audit = await soleAuditRow(app.prisma, {
      where: { entity: "PushSubscription", entityId: device.id, action: "CREATE" },
    });
    expect(audit.userId).toBe(seed.empUser.id);
    expect(Object.keys(audit.newValue as object).sort((a, b) => a.localeCompare(b))).toEqual([
      "consentedAt",
      "deviceLabel",
    ]);
    const serialised = JSON.stringify(audit);
    expect(serialised).not.toContain(sub.endpoint);
    expect(serialised).not.toContain(sub.keys.p256dh);
    expect(serialised).not.toContain(sub.keys.auth);

    // Send the test push.
    const sent = await app.inject({
      method: "POST",
      url: "/api/v1/me/push/test",
      headers: auth(seed.empToken),
      remoteAddress: nextIp(),
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toEqual({
      devices: [{ id: device.id, deviceLabel: "Chrome auf Android", outcome: "SENT" }],
    });

    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    const [target, payload, options] = sendNotificationMock.mock.calls[0];
    expect(target).toEqual({ endpoint: sub.endpoint, keys: sub.keys });
    const parsed = JSON.parse(payload as string);
    expect(parsed).toEqual(PUSH_TEST_PAYLOAD);
    expect(Object.keys(parsed).sort((a, b) => a.localeCompare(b))).toEqual([
      "body",
      "title",
      "url",
    ]);
    expect(options).toMatchObject({
      vapidDetails: {
        subject: TEST_VAPID.subject,
        publicKey: TEST_VAPID.publicKey,
        privateKey: TEST_VAPID.privateKey,
      },
      TTL: PUSH_TEST_TTL_SECONDS,
      timeout: 10000,
    });

    const after = await app.prisma.pushSubscription.findUniqueOrThrow({ where: { id: device.id } });
    expect(after.lastSuccessAt).toBeInstanceOf(Date);
  });

  it("refuses an endpoint outside the four push services before any write", async () => {
    const before = await app.prisma.pushSubscription.count({ where: { tenantId: seed.tenant.id } });
    const bad = [
      { ...fakeDeviceSubscription(), endpoint: "http://fcm.googleapis.com/fcm/send/abc" },
      fakeDeviceSubscription("fcm.googleapis.com.evil.example"),
      // A sibling under a shared parent domain is not a push service.
      fakeDeviceSubscription("evil.googleapis.com"),
      fakeDeviceSubscription("127.0.0.1"),
    ];
    for (const payload of bad) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/me/push/subscriptions",
        headers: auth(seed.empToken),
        payload,
        remoteAddress: nextIp(),
      });
      expect(res.statusCode, payload.endpoint).toBe(400);
      expect(res.json().code).toBe("PUSH_ENDPOINT_NOT_ALLOWED");
    }
    expect(await app.prisma.pushSubscription.count({ where: { tenantId: seed.tenant.id } })).toBe(
      before,
    );
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it("refuses the parser-differential variants and stores only the canonical endpoint (CR-01, WR-01)", async () => {
    const before = await app.prisma.pushSubscription.count({ where: { tenantId: seed.tenant.id } });
    const base = fakeDeviceSubscription();
    const path = new URL(base.endpoint).pathname;
    for (const endpoint of [
      `https:/fcm.googleapis.com${path}`,
      `https:fcm.googleapis.com${path}`,
      `https://fcm.googleapis.com\t.evil${path}`,
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/me/push/subscriptions",
        headers: auth(seed.empToken),
        payload: { ...base, endpoint },
        remoteAddress: nextIp(),
      });
      expect(res.statusCode, endpoint).toBe(400);
      expect(res.json().code).toBe("PUSH_ENDPOINT_NOT_ALLOWED");
    }
    expect(await app.prisma.pushSubscription.count({ where: { tenantId: seed.tenant.id } })).toBe(
      before,
    );

    // A case / port variant is stored in its canonical form, so it is the SAME row as the plain one.
    const variant = await app.inject({
      method: "POST",
      url: "/api/v1/me/push/subscriptions",
      headers: auth(seed.empToken),
      payload: { ...base, endpoint: `HTTPS://FCM.googleapis.com:443${path}` },
      remoteAddress: nextIp(),
    });
    expect(variant.statusCode).toBe(201);
    const row = await app.prisma.pushSubscription.findUniqueOrThrow({
      where: { id: variant.json().id },
    });
    expect(row.endpoint).toBe(base.endpoint);
    expect(variant.json().endpointHash).toBe(
      createHash("sha256").update(base.endpoint).digest("hex"),
    );
    const plain = await app.inject({
      method: "POST",
      url: "/api/v1/me/push/subscriptions",
      headers: auth(seed.empToken),
      payload: base,
      remoteAddress: nextIp(),
    });
    expect(plain.statusCode).toBe(200);
    expect(plain.json().id).toBe(row.id);
    expect(await app.prisma.pushSubscription.count({ where: { tenantId: seed.tenant.id } })).toBe(
      before + 1,
    );

    // Removing by the non-canonical spelling finds the one row.
    const removed = await app.inject({
      method: "DELETE",
      url: "/api/v1/me/push/subscriptions",
      headers: auth(seed.empToken),
      payload: { endpoint: `HTTPS://FCM.googleapis.com:443${path}` },
      remoteAddress: nextIp(),
    });
    expect(removed.statusCode).toBe(204);
  });

  it("IN-05: refuses malformed keys - wrong length, wrong prefix, off-curve point, short auth", async () => {
    const before = await app.prisma.pushSubscription.count({ where: { tenantId: seed.tenant.id } });
    const good = fakeDeviceSubscription();
    const offCurve = Buffer.concat([Buffer.from([0x04]), randomBytes(64)]).toString("base64url");
    const compressed = Buffer.concat([Buffer.from([0x02]), randomBytes(32)]).toString("base64url");
    const badPrefix = Buffer.concat([
      Buffer.from([0x05]),
      Buffer.from(good.keys.p256dh, "base64url").subarray(1),
    ]).toString("base64url");
    const bad = [
      { ...good, keys: { ...good.keys, p256dh: offCurve } },
      { ...good, keys: { ...good.keys, p256dh: compressed } },
      { ...good, keys: { ...good.keys, p256dh: badPrefix } },
      { ...good, keys: { ...good.keys, auth: randomBytes(15).toString("base64url") } },
      { ...good, keys: { ...good.keys, auth: randomBytes(17).toString("base64url") } },
    ];
    for (const payload of bad) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/me/push/subscriptions",
        headers: auth(seed.empToken),
        payload,
        remoteAddress: nextIp(),
      });
      expect(res.statusCode, JSON.stringify(payload.keys)).toBe(400);
    }
    expect(await app.prisma.pushSubscription.count({ where: { tenantId: seed.tenant.id } })).toBe(
      before,
    );
    // The untouched valid body is accepted (the table above is not refusing everything).
    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/me/push/subscriptions",
      headers: auth(seed.empToken),
      payload: good,
      remoteAddress: nextIp(),
    });
    expect(ok.statusCode).toBe(201);
  });

  it("answers an API key with 400 on every push route", async () => {
    for (const [method, url] of [
      ["GET", "/api/v1/me/push/config"],
      ["POST", "/api/v1/me/push/subscriptions"],
      ["POST", "/api/v1/me/push/test"],
      ["GET", "/api/v1/me/push/subscriptions"],
      ["DELETE", "/api/v1/me/push/subscriptions"],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: auth(apiKeyToken),
        payload: method === "POST" ? fakeDeviceSubscription() : undefined,
        remoteAddress: nextIp(),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(400);
    }
  });

  it("answers an unauthenticated caller with 401", async () => {
    for (const [method, url] of [
      ["GET", "/api/v1/me/push/config"],
      ["POST", "/api/v1/me/push/subscriptions"],
      ["POST", "/api/v1/me/push/test"],
      ["GET", "/api/v1/me/push/subscriptions"],
      ["DELETE", "/api/v1/me/push/subscriptions"],
    ] as const) {
      const res = await app.inject({ method, url, remoteAddress: nextIp() });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  // ── List and remove (plan 02, task 1) ──────────────────────────────────────

  async function register(token: string, sub = fakeDeviceSubscription()) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/me/push/subscriptions",
      headers: { ...auth(token), "user-agent": CHROME_ANDROID_UA },
      payload: sub,
      remoteAddress: nextIp(),
    });
    expect(res.statusCode).toBe(201);
    return { sub, device: res.json() as { id: string; endpointHash: string } };
  }

  const remove = (token: string, body: unknown) =>
    app.inject({
      method: "DELETE",
      url: "/api/v1/me/push/subscriptions",
      headers: auth(token),
      payload: body as object,
      remoteAddress: nextIp(),
    });

  it("lists only the caller's own devices, without the endpoint", async () => {
    await app.prisma.pushSubscription.deleteMany({
      where: { tenantId: { in: [seed.tenant.id, other.tenant.id] } },
    });
    const first = await register(seed.empToken);
    const second = await register(seed.empToken);
    const foreign = await register(seed.adminToken);
    const foreignOtherTenant = await register(other.empToken);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/push/subscriptions",
      headers: auth(seed.empToken),
      remoteAddress: nextIp(),
    });
    expect(res.statusCode).toBe(200);
    const { devices } = res.json() as { devices: Array<Record<string, unknown>> };
    expect(devices.map((d) => d.id)).toEqual([first.device.id, second.device.id]);
    for (const device of devices) {
      expect(Object.keys(device).sort((a, b) => a.localeCompare(b))).toEqual([
        "consentedAt",
        "deviceLabel",
        "endpointHash",
        "id",
        "lastSuccessAt",
      ]);
    }
    // Never an endpoint string, own or foreign.
    for (const sub of [first.sub, second.sub, foreign.sub, foreignOtherTenant.sub]) {
      expect(res.body).not.toContain(sub.endpoint);
    }
    expect(res.body).not.toContain(foreign.device.id);
    expect(res.body).not.toContain(foreignOtherTenant.device.id);
  });

  it.each(["endpoint", "id"] as const)("removes an own device by %s and audits it", async (key) => {
    const { sub, device } = await register(seed.empToken);
    const res = await remove(
      seed.empToken,
      key === "endpoint" ? { endpoint: sub.endpoint } : { id: device.id },
    );
    expect(res.statusCode).toBe(204);
    expect(await app.prisma.pushSubscription.findUnique({ where: { id: device.id } })).toBeNull();

    const audit = await soleAuditRow(app.prisma, {
      where: { entity: "PushSubscription", entityId: device.id, action: "DELETE" },
    });
    expect(audit.userId).toBe(seed.empUser.id);
    expect(Object.keys(audit.oldValue as object).sort((a, b) => a.localeCompare(b))).toEqual([
      "consentedAt",
      "deviceLabel",
    ]);
    expect(audit.newValue).toEqual({ reason: "USER_REMOVED" });
    const serialised = JSON.stringify(audit);
    expect(serialised).not.toContain(sub.endpoint);
    expect(serialised).not.toContain(sub.keys.p256dh);
    expect(serialised).not.toContain(sub.keys.auth);
  });

  it("answers a foreign and an unknown device with one and the same 404", async () => {
    const sameTenant = await register(seed.adminToken);
    const otherTenant = await register(other.empToken);
    const unknownEndpoint = fakeDeviceSubscription().endpoint;

    const misses = [
      await remove(seed.empToken, { id: sameTenant.device.id }),
      await remove(seed.empToken, { id: otherTenant.device.id }),
      await remove(seed.empToken, { id: "7f1c2b9e-3a4d-4e5f-8a6b-0c1d2e3f4a5b" }),
      await remove(seed.empToken, { endpoint: sameTenant.sub.endpoint }),
      await remove(seed.empToken, { endpoint: otherTenant.sub.endpoint }),
      await remove(seed.empToken, { endpoint: unknownEndpoint }),
    ];
    for (const res of misses) expect(res.statusCode).toBe(404);
    for (const res of misses) expect(res.body).toBe(misses[0].body);

    // The foreign rows survive, untouched.
    for (const id of [sameTenant.device.id, otherTenant.device.id]) {
      expect(await app.prisma.pushSubscription.findUnique({ where: { id } })).not.toBeNull();
    }
  });

  it("rejects a delete body with both keys, none, or an extra key", async () => {
    const { sub, device } = await register(seed.empToken);
    for (const body of [
      { id: device.id, endpoint: sub.endpoint },
      {},
      { id: device.id, extra: 1 },
      { id: "not-a-uuid" },
    ]) {
      const res = await remove(seed.empToken, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(
      await app.prisma.pushSubscription.findUnique({ where: { id: device.id } }),
    ).not.toBeNull();
  });

  it("refuses an endpoint longer than 2048 characters with 400", async () => {
    const sub = fakeDeviceSubscription();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/me/push/subscriptions",
      headers: auth(seed.empToken),
      payload: { ...sub, endpoint: `${sub.endpoint}${"a".repeat(2049)}` },
      remoteAddress: nextIp(),
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /test reports SENT, REMOVED (410, row gone) and FAILED (403, row kept) per device", async () => {
    await app.prisma.pushSubscription.deleteMany({ where: { userId: seed.empUser.id } });
    const make = async (label: string) => {
      const sub = fakeDeviceSubscription();
      const row = await app.prisma.pushSubscription.create({
        data: {
          tenantId: seed.tenant.id,
          userId: seed.empUser.id,
          endpoint: sub.endpoint,
          p256dh: sub.keys.p256dh,
          auth: sub.keys.auth,
          deviceLabel: label,
          consentedAt: new Date(),
        },
      });
      return { row, sub };
    };
    const ok = await make("Chrome auf Android");
    const gone = await make("Firefox auf Android");
    const refused = await make("Safari auf iPhone");
    sendNotificationMock.mockImplementation(async (target: { endpoint: string }) => {
      if (target.endpoint === gone.sub.endpoint) {
        throw Object.assign(new Error("gone"), { statusCode: 410, endpoint: target.endpoint });
      }
      if (target.endpoint === refused.sub.endpoint) {
        throw Object.assign(new Error("forbidden"), { statusCode: 403, endpoint: target.endpoint });
      }
      return { statusCode: 201 };
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/me/push/test",
      headers: auth(seed.empToken),
      remoteAddress: nextIp(),
    });
    expect(res.statusCode).toBe(200);
    const outcomes = Object.fromEntries(
      (res.json().devices as Array<{ id: string; outcome: string }>).map((d) => [d.id, d.outcome]),
    );
    expect(outcomes).toEqual({
      [ok.row.id]: "SENT",
      [gone.row.id]: "REMOVED",
      [refused.row.id]: "FAILED",
    });
    expect(await app.prisma.pushSubscription.findUnique({ where: { id: gone.row.id } })).toBeNull();
    expect(
      await app.prisma.pushSubscription.findUnique({ where: { id: refused.row.id } }),
    ).not.toBeNull();
    const audit = await soleAuditRow(app.prisma, {
      where: { entity: "PushSubscription", entityId: gone.row.id, action: "DELETE" },
    });
    expect(audit.newValue).toMatchObject({ reason: "EXPIRED_BY_PUSH_SERVICE" });
    expect(JSON.stringify(res.json())).not.toContain(gone.sub.endpoint);
  });
});
