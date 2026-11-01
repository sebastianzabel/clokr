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
  let apiKeyToken: string;
  let ip = 0;
  const nextIp = () => `10.60.8.${++ip}`;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    app = await buildPushEnabledApp();
    seed = await seedTestData(app, `-p608-${randomBytes(3).toString("hex")}`);
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
    await cleanupTestData(app, seed.tenant.id);
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

  it("answers an API key with 400 on every push route", async () => {
    for (const [method, url] of [
      ["GET", "/api/v1/me/push/config"],
      ["POST", "/api/v1/me/push/subscriptions"],
      ["POST", "/api/v1/me/push/test"],
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
    ] as const) {
      const res = await app.inject({ method, url, remoteAddress: nextIp() });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});
