/**
 * Issue #608 (D-05, P-608-07, P-608-08) - re-registering a browser: the same person updates the
 * one row, another person with the SAME keys takes the device over (the old owner's tenant keeps a
 * SYSTEM audit), different keys are refused, and the device cap and the rate limits hold.
 * `web-push` is mocked: nothing reaches the network.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { seedTestData, cleanupTestData, soleAuditRow } from "./setup";
import {
  CHROME_ANDROID_UA,
  buildPushEnabledApp,
  fakeDeviceSubscription,
  restorePushEnv,
} from "./push-fixtures-608";

const { sendNotificationMock } = vi.hoisted(() => ({ sendNotificationMock: vi.fn() }));

vi.mock("web-push", () => {
  const api = { sendNotification: sendNotificationMock };
  return { default: api, ...api };
});

describe("Issue #608: re-registering a browser, device cap and rate limits", () => {
  let app: FastifyInstance;
  let a: Awaited<ReturnType<typeof seedTestData>>;
  let b: Awaited<ReturnType<typeof seedTestData>>;
  let ip = 0;
  // Every inject gets its own address so the route rate limits never interfere (except the 429 cases).
  const nextIp = () => `10.61.${Math.floor(++ip / 250)}.${(ip % 250) + 1}`;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  const subscribe = (token: string, payload: object, remoteAddress = nextIp()) =>
    app.inject({
      method: "POST",
      url: "/api/v1/me/push/subscriptions",
      headers: { ...auth(token), "user-agent": CHROME_ANDROID_UA },
      payload,
      remoteAddress,
    });

  const rowsOf = (endpoint: string) =>
    app.prisma.pushSubscription.findMany({ where: { endpoint } });

  beforeAll(async () => {
    app = await buildPushEnabledApp();
    a = await seedTestData(app, `-p608r-${randomBytes(3).toString("hex")}`);
    b = await seedTestData(app, `-p608s-${randomBytes(3).toString("hex")}`);
  });

  afterAll(async () => {
    for (const seed of [a, b]) {
      await app.prisma.pushSubscription.deleteMany({ where: { tenantId: seed.tenant.id } });
      await cleanupTestData(app, seed.tenant.id);
    }
    await app.close();
    restorePushEnv();
  });

  beforeEach(async () => {
    sendNotificationMock.mockReset();
    sendNotificationMock.mockResolvedValue({ statusCode: 201 });
    for (const seed of [a, b]) {
      await app.prisma.pushSubscription.deleteMany({ where: { tenantId: seed.tenant.id } });
    }
  });

  it("the same person registering the same endpoint again updates the one row", async () => {
    const first = fakeDeviceSubscription();
    const created = await subscribe(a.empToken, first);
    expect(created.statusCode).toBe(201);

    const again = { ...fakeDeviceSubscription(), endpoint: first.endpoint };
    const res = await subscribe(a.empToken, again);
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(created.json().id);

    const rows = await rowsOf(first.endpoint);
    expect(rows).toHaveLength(1);
    expect(rows[0].p256dh).toBe(again.keys.p256dh);
    expect(rows[0].auth).toBe(again.keys.auth);
    expect(rows[0].consentedAt.getTime()).toBeGreaterThanOrEqual(
      new Date(created.json().consentedAt).getTime(),
    );

    const audit = await soleAuditRow(app.prisma, {
      where: { entity: "PushSubscription", entityId: rows[0].id, action: "UPDATE" },
    });
    expect(audit.userId).toBe(a.empUser.id);
    expect(Object.keys(audit.newValue as object).sort((x, y) => x.localeCompare(y))).toEqual([
      "consentedAt",
      "deviceLabel",
    ]);
    expect(JSON.stringify(audit)).not.toContain(again.keys.auth);
  });

  it("another person with the same keys takes the device over; the old tenant sees the SYSTEM audit", async () => {
    const sub = fakeDeviceSubscription();
    const first = await subscribe(a.empToken, sub);
    expect(first.statusCode).toBe(201);
    const oldId = first.json().id as string;

    const takeoverAddress = nextIp();
    const taken = await subscribe(b.empToken, sub, takeoverAddress);
    expect(taken.statusCode).toBe(201);

    const rows = await rowsOf(sub.endpoint);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(b.empUser.id);
    expect(rows[0].tenantId).toBe(b.tenant.id);
    expect(rows[0].id).not.toBe(oldId);
    expect(await app.prisma.pushSubscription.findUnique({ where: { id: oldId } })).toBeNull();

    const del = await soleAuditRow(app.prisma, {
      where: { entity: "PushSubscription", entityId: oldId, action: "DELETE" },
    });
    expect(del.userId).toBeNull();
    expect(del.newValue).toEqual({
      reason: "REASSIGNED",
      actor: { type: "SYSTEM", tenantId: a.tenant.id },
    });
    expect(JSON.stringify(del)).not.toContain(sub.endpoint);
    // WR-02: the row the OLD owner's tenant can read carries nothing of the person who took over.
    expect(del.ipAddress).toBeNull();
    expect(del.userAgent).toBeNull();
    expect(JSON.stringify(del)).not.toContain(b.empUser.id);
    expect(JSON.stringify(del)).not.toContain(b.tenant.id);
    const create = await soleAuditRow(app.prisma, {
      where: { entity: "PushSubscription", entityId: rows[0].id, action: "CREATE" },
    });
    expect(create.userId).toBe(b.empUser.id);
    // The new owner's own CREATE audit keeps the request data.
    expect(create.ipAddress).toBe(takeoverAddress);
    expect(create.userAgent).toBe(CHROME_ANDROID_UA);

    // A's tenant audit list shows the displaced device's deletion, B's does not.
    const listFor = async (token: string) => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/audit-logs?entity=PushSubscription&action=DELETE&limit=200",
        headers: auth(token),
        remoteAddress: nextIp(),
      });
      expect(res.statusCode).toBe(200);
      return (res.json() as { logs: Array<{ id: string }> }).logs.map((l) => l.id);
    };
    expect(await listFor(a.adminToken)).toContain(del.id);
    expect(await listFor(b.adminToken)).not.toContain(del.id);
  });

  it("another person with different keys is refused and nothing is written", async () => {
    const sub = fakeDeviceSubscription();
    const first = await subscribe(a.empToken, sub);
    expect(first.statusCode).toBe(201);
    const before = await app.prisma.pushSubscription.findUniqueOrThrow({
      where: { id: first.json().id },
    });
    const auditsBefore = await app.prisma.auditLog.count({ where: { entity: "PushSubscription" } });

    const guess = { ...fakeDeviceSubscription(), endpoint: sub.endpoint };
    const res = await subscribe(b.empToken, guess);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("PUSH_ENDPOINT_CONFLICT");
    // Only the auth secret wrong, p256dh right, is refused as well.
    const half = await subscribe(b.empToken, {
      ...sub,
      keys: { ...sub.keys, auth: guess.keys.auth },
    });
    expect(half.statusCode).toBe(409);

    const rows = await rowsOf(sub.endpoint);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(before);
    expect(await app.prisma.auditLog.count({ where: { entity: "PushSubscription" } })).toBe(
      auditsBefore,
    );
  });

  it("caps a person at 10 devices; re-registering one of them still works", async () => {
    const own = Array.from({ length: 10 }, () => fakeDeviceSubscription());
    await app.prisma.pushSubscription.createMany({
      data: own.map((s) => ({
        tenantId: a.tenant.id,
        userId: a.empUser.id,
        endpoint: s.endpoint,
        p256dh: s.keys.p256dh,
        auth: s.keys.auth,
        deviceLabel: "Chrome auf Android",
        consentedAt: new Date(),
      })),
    });

    const over = await subscribe(a.empToken, fakeDeviceSubscription());
    expect(over.statusCode).toBe(409);
    expect(over.json().code).toBe("PUSH_DEVICE_LIMIT");
    expect(await app.prisma.pushSubscription.count({ where: { userId: a.empUser.id } })).toBe(10);

    const again = await subscribe(a.empToken, own[3]);
    expect(again.statusCode).toBe(200);
    expect(await app.prisma.pushSubscription.count({ where: { userId: a.empUser.id } })).toBe(10);

    // A full person cannot take over a device either; the old owner keeps it.
    const foreign = fakeDeviceSubscription();
    await app.prisma.pushSubscription.create({
      data: {
        tenantId: b.tenant.id,
        userId: b.empUser.id,
        endpoint: foreign.endpoint,
        p256dh: foreign.keys.p256dh,
        auth: foreign.keys.auth,
        deviceLabel: "Chrome auf Android",
        consentedAt: new Date(),
      },
    });
    const blocked = await subscribe(a.empToken, foreign);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe("PUSH_DEVICE_LIMIT");
    expect((await rowsOf(foreign.endpoint))[0].userId).toBe(b.empUser.id);
  });

  it("two simultaneous registrations of one new endpoint leave exactly one row", async () => {
    const sub = fakeDeviceSubscription();
    const [x, y] = await Promise.all([subscribe(a.empToken, sub), subscribe(a.empToken, sub)]);
    expect(x.statusCode).toBeGreaterThanOrEqual(200);
    expect(x.statusCode).toBeLessThan(300);
    expect(y.statusCode).toBeGreaterThanOrEqual(200);
    expect(y.statusCode).toBeLessThan(300);
    expect(await rowsOf(sub.endpoint)).toHaveLength(1);
  });

  it("limits POST /test to 5 per 10 minutes per address", async () => {
    const address = "10.62.0.1";
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/me/push/test",
        headers: auth(a.empToken),
        remoteAddress: address,
      });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 5).every((c) => c === 200)).toBe(true);
    expect(codes[5]).toBe(429);
  });

  it("limits POST /subscriptions to 20 per minute per address", async () => {
    const address = "10.62.0.2";
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) {
      // A refused endpoint host answers 400 but still counts against the limit.
      const res = await subscribe(a.empToken, fakeDeviceSubscription("evil.example"), address);
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 20).every((c) => c === 400)).toBe(true);
    expect(codes[20]).toBe(429);
  });
});
