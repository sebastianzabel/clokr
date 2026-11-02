/**
 * Issue #608 (D-04, D-07, D-09, D-10, D-11, D-15, D-17, AC-1, AC-3, AC-4) - `notify()` pushes to
 * every device of the recipient, fire-and-forget, with a payload built from the registry only.
 * `web-push` is mocked: nothing reaches the network. The push-enabled app is built per file
 * because the VAPID set is read once, when config.ts loads.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { inspect } from "node:util";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { seedTestData, cleanupTestData, soleAuditRow } from "./setup";
import { buildPushEnabledApp, fakeDeviceSubscription, restorePushEnv } from "./push-fixtures-608";
import {
  NOTIFICATION_PUSH_POLICY,
  PUSH_FALLBACK_URL,
  PUSH_TITLE,
  safePushUrl,
} from "../contexts/platform/notification-push-policy";

const { sendNotificationMock } = vi.hoisted(() => ({ sendNotificationMock: vi.fn() }));

vi.mock("web-push", () => {
  const api = { sendNotification: sendNotificationMock };
  return { default: api, ...api };
});

/** Shaped like the library's WebPushError: own enumerable fields that carry the endpoint. */
function pushServiceError(statusCode: number, endpoint: string): Error {
  return Object.assign(new Error("Received unexpected response code"), {
    statusCode,
    endpoint,
    headers: { "x-push-endpoint": endpoint },
    body: `rejected ${endpoint}`,
  });
}

describe("Issue #608: notify() pushes to the recipient's devices", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let other: Awaited<ReturnType<typeof seedTestData>>;
  const allEndpoints: string[] = [];
  const logArgs: unknown[][] = [];
  let spies: Array<{ mockRestore: () => void }> = [];

  beforeAll(async () => {
    app = await buildPushEnabledApp();
    seed = await seedTestData(app, `-p608d-${randomBytes(3).toString("hex")}`);
    other = await seedTestData(app, `-p608e-${randomBytes(3).toString("hex")}`);
    // Every argument any logger method receives, for the "no endpoint in any log" proof.
    for (const level of ["warn", "debug", "error", "info"] as const) {
      const spy = vi.spyOn(app.log, level).mockImplementation(((...args: unknown[]) => {
        logArgs.push(args);
      }) as never);
      spies.push(spy);
    }
  });

  afterAll(async () => {
    for (const spy of spies) spy.mockRestore();
    spies = [];
    for (const s of [seed, other]) {
      await app.prisma.pushSubscription.deleteMany({ where: { tenantId: s.tenant.id } });
      await cleanupTestData(app, s.tenant.id);
    }
    await app.close();
    restorePushEnv();
  });

  beforeEach(async () => {
    sendNotificationMock.mockReset();
    sendNotificationMock.mockResolvedValue({ statusCode: 201 });
    await app.prisma.pushSubscription.deleteMany({
      where: { tenantId: { in: [seed.tenant.id, other.tenant.id] } },
    });
  });

  async function addDevice(s: typeof seed, userId: string, label = "Chrome auf Android") {
    const sub = fakeDeviceSubscription();
    allEndpoints.push(sub.endpoint);
    const row = await app.prisma.pushSubscription.create({
      data: {
        tenantId: s.tenant.id,
        userId,
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        deviceLabel: label,
        consentedAt: new Date(),
      },
    });
    return { row, sub };
  }

  async function notifyAndSettle(params: Parameters<FastifyInstance["notify"]>[0]) {
    await app.notify(params);
    await app.settlePushDispatch();
  }

  const callsFor = (endpoint: string) =>
    sendNotificationMock.mock.calls.filter(
      (c) => (c[0] as { endpoint: string }).endpoint === endpoint,
    );

  it("sends nothing to a person without a device, but the in-app row exists", async () => {
    const title = `no-device-${randomBytes(3).toString("hex")}`;
    await notifyAndSettle({
      userId: seed.empUser.id,
      type: "LEAVE_REQUEST",
      title,
      message: "m",
      tenantId: seed.tenant.id,
    });
    expect(sendNotificationMock).not.toHaveBeenCalled();
    expect(await app.prisma.notification.count({ where: { userId: seed.empUser.id, title } })).toBe(
      1,
    );
  });

  it("sends one neutral payload to each of two devices with the registry TTL and the own link", async () => {
    const a = await addDevice(seed, seed.empUser.id);
    const b = await addDevice(seed, seed.empUser.id, "Safari auf iPhone");
    await notifyAndSettle({
      userId: seed.empUser.id,
      type: "LEAVE_REQUEST",
      title: "Urlaubsantrag",
      message: "Eine Nachricht",
      link: "/team/leave?request=abc",
      tenantId: seed.tenant.id,
    });
    expect(sendNotificationMock).toHaveBeenCalledTimes(2);
    for (const d of [a, b]) {
      const calls = callsFor(d.sub.endpoint);
      expect(calls).toHaveLength(1);
      const [target, payload, options] = calls[0];
      expect(target).toEqual({ endpoint: d.sub.endpoint, keys: d.sub.keys });
      const parsed = JSON.parse(payload as string);
      expect(Object.keys(parsed).sort((x, y) => x.localeCompare(y))).toEqual([
        "body",
        "title",
        "url",
      ]);
      const policy = NOTIFICATION_PUSH_POLICY.LEAVE_REQUEST;
      expect(policy.push).toBe("send");
      if (policy.push !== "send") return;
      expect(parsed).toEqual({
        title: PUSH_TITLE,
        body: policy.body,
        url: safePushUrl("/team/leave?request=abc"),
      });
      expect(parsed.title).toBe("Clokr");
      expect(options).toMatchObject({ TTL: policy.ttlSeconds });
      expect(Buffer.byteLength(payload as string)).toBeLessThanOrEqual(1024);
    }
    const after = await app.prisma.pushSubscription.findUniqueOrThrow({ where: { id: a.row.id } });
    expect(after.lastSuccessAt).toBeInstanceOf(Date);
  });

  it("AC-4: the in-app title and message never appear in any payload", async () => {
    const d = await addDevice(seed, seed.empUser.id);
    const title = "Krankmeldung von Testperson Muster";
    const message = "5:30 Std, Saldo -2:00";
    await notifyAndSettle({
      userId: seed.empUser.id,
      type: "LEAVE_REQUEST",
      title,
      message,
      emailSubject: "Betreff mit Name",
      tenantId: seed.tenant.id,
    });
    const [, payload] = callsFor(d.sub.endpoint)[0];
    for (const forbidden of ["Krank", "Muster", "5:30", "Saldo", title, message, "Betreff"]) {
      expect(payload as string, forbidden).not.toContain(forbidden);
    }
  });

  it("falls back to /dashboard for an unsafe link", async () => {
    const d = await addDevice(seed, seed.empUser.id);
    await notifyAndSettle({
      userId: seed.empUser.id,
      type: "CLOCK_OUT_REMINDER",
      title: "t",
      message: "m",
      link: "//evil.example/x",
    });
    const parsed = JSON.parse(callsFor(d.sub.endpoint)[0][1] as string);
    expect(parsed.url).toBe(PUSH_FALLBACK_URL);
  });

  it("still pushes when notify() has no tenantId (the attendance-checker form, D-15)", async () => {
    const d = await addDevice(seed, seed.empUser.id);
    await notifyAndSettle({
      userId: seed.empUser.id,
      type: "CLOCK_OUT_REMINDER",
      title: "t",
      message: "m",
    });
    expect(callsFor(d.sub.endpoint)).toHaveLength(1);
  });

  it("is not gated by the tenant e-mail switches (D-11)", async () => {
    const d = await addDevice(seed, seed.empUser.id);
    await app.prisma.tenantConfig.update({
      where: { tenantId: seed.tenant.id },
      data: { emailNotificationsEnabled: false },
    });
    await notifyAndSettle({
      userId: seed.empUser.id,
      type: "LEAVE_REQUEST",
      title: "t",
      message: "m",
      tenantId: seed.tenant.id,
    });
    expect(callsFor(d.sub.endpoint)).toHaveLength(1);
  });

  describe("recipients that must not receive a push (D-07)", () => {
    afterEach(async () => {
      await app.prisma.tenant.update({
        where: { id: other.tenant.id },
        data: { deactivatedAt: null },
      });
      app.invalidateTenantState(other.tenant.id);
      await app.prisma.user.update({ where: { id: other.empUser.id }, data: { isActive: true } });
    });

    it("a deactivated tenant receives nothing", async () => {
      const d = await addDevice(other, other.empUser.id);
      await app.prisma.tenant.update({
        where: { id: other.tenant.id },
        data: { deactivatedAt: new Date() },
      });
      app.invalidateTenantState(other.tenant.id);
      await notifyAndSettle({
        userId: other.empUser.id,
        type: "LEAVE_REQUEST",
        title: "t",
        message: "m",
        tenantId: other.tenant.id,
      });
      expect(callsFor(d.sub.endpoint)).toHaveLength(0);
    });

    it("an inactive user receives nothing", async () => {
      const d = await addDevice(other, other.empUser.id);
      await app.prisma.user.update({ where: { id: other.empUser.id }, data: { isActive: false } });
      await notifyAndSettle({
        userId: other.empUser.id,
        type: "LEAVE_REQUEST",
        title: "t",
        message: "m",
        tenantId: other.tenant.id,
      });
      expect(callsFor(d.sub.endpoint)).toHaveLength(0);
    });

    it("an active tenant and user of the same setup do receive (the filters are the only difference)", async () => {
      const d = await addDevice(other, other.empUser.id);
      await notifyAndSettle({
        userId: other.empUser.id,
        type: "LEAVE_REQUEST",
        title: "t",
        message: "m",
        tenantId: other.tenant.id,
      });
      expect(callsFor(d.sub.endpoint)).toHaveLength(1);
    });
  });

  it("sends nothing for a never type and nothing for an unregistered type (which warns by name)", async () => {
    await addDevice(seed, seed.empUser.id);
    await notifyAndSettle({
      userId: seed.empUser.id,
      type: "SECTION9_AU_PENDING_EMPLOYEE",
      title: "t",
      message: "m",
      tenantId: seed.tenant.id,
    });
    expect(sendNotificationMock).not.toHaveBeenCalled();

    const before = logArgs.length;
    await notifyAndSettle({
      userId: seed.empUser.id,
      type: "__NOT_REGISTERED__",
      title: "t",
      message: "m",
      tenantId: seed.tenant.id,
    });
    expect(sendNotificationMock).not.toHaveBeenCalled();
    const warned = logArgs
      .slice(before)
      .some((args) => inspect(args).includes("__NOT_REGISTERED__"));
    expect(warned).toBe(true);
  });

  it("notify() resolves while the send is still pending (fire-and-forget)", async () => {
    const d = await addDevice(seed, seed.empUser.id);
    let release: (v: { statusCode: number }) => void = () => {};
    sendNotificationMock.mockImplementation(
      () => new Promise<{ statusCode: number }>((resolve) => (release = resolve)),
    );
    let settled = false;
    const done = app
      .notify({ userId: seed.empUser.id, type: "LEAVE_REQUEST", title: "t", message: "m" })
      .then(() => {
        settled = true;
      });
    await done;
    await vi.waitFor(() => expect(sendNotificationMock).toHaveBeenCalledTimes(1));
    // notify() has returned although the send has not completed.
    expect(settled).toBe(true);
    let settledPush = false;
    const pending = app.settlePushDispatch().then(() => {
      settledPush = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(settledPush).toBe(false);
    release({ statusCode: 201 });
    await pending;
    expect(settledPush).toBe(true);
    const row = await app.prisma.pushSubscription.findUniqueOrThrow({ where: { id: d.row.id } });
    expect(row.lastSuccessAt).toBeInstanceOf(Date);
  });

  it("a rejecting sender or a failing read never makes notify() reject", async () => {
    await addDevice(seed, seed.empUser.id);
    sendNotificationMock.mockRejectedValue(new Error("boom"));
    await expect(
      app.notify({ userId: seed.empUser.id, type: "LEAVE_REQUEST", title: "t", message: "m" }),
    ).resolves.toBeUndefined();
    await app.settlePushDispatch();

    const readSpy = vi
      .spyOn(app.prisma.pushSubscription, "findMany")
      .mockRejectedValue(new Error("database down"));
    try {
      await expect(
        app.notify({ userId: seed.empUser.id, type: "LEAVE_REQUEST", title: "t", message: "m" }),
      ).resolves.toBeUndefined();
      await app.settlePushDispatch();
    } finally {
      readSpy.mockRestore();
    }
    const failureLogged = logArgs.some((args) =>
      inspect(args).includes("Failed to dispatch notification push"),
    );
    expect(failureLogged).toBe(true);
  });

  it("a 410 from the push service deletes the device and audits it in the tenant", async () => {
    const d = await addDevice(seed, seed.empUser.id, "Firefox auf Android");
    sendNotificationMock.mockRejectedValue(pushServiceError(410, d.sub.endpoint));
    await notifyAndSettle({
      userId: seed.empUser.id,
      type: "LEAVE_REQUEST",
      title: "t",
      message: "m",
      tenantId: seed.tenant.id,
    });
    expect(await app.prisma.pushSubscription.findUnique({ where: { id: d.row.id } })).toBeNull();
    const audit = await soleAuditRow(app.prisma, {
      where: { entity: "PushSubscription", entityId: d.row.id, action: "DELETE" },
    });
    expect(audit.userId).toBeNull();
    expect(audit.newValue).toEqual({
      reason: "EXPIRED_BY_PUSH_SERVICE",
      actor: { type: "SYSTEM", tenantId: seed.tenant.id },
    });
    expect(audit.oldValue).toMatchObject({ deviceLabel: "Firefox auf Android" });
    expect(JSON.stringify(audit)).not.toContain(d.sub.endpoint);
  });

  it("a 404 deletes too; a 403 keeps the row and warns with status and host only", async () => {
    const gone = await addDevice(seed, seed.empUser.id);
    const refused = await addDevice(seed, seed.empUser.id);
    sendNotificationMock.mockImplementation(async (target: { endpoint: string }) => {
      throw pushServiceError(target.endpoint === gone.sub.endpoint ? 404 : 403, target.endpoint);
    });
    const before = logArgs.length;
    await notifyAndSettle({
      userId: seed.empUser.id,
      type: "LEAVE_REQUEST",
      title: "t",
      message: "m",
    });
    expect(await app.prisma.pushSubscription.findUnique({ where: { id: gone.row.id } })).toBeNull();
    expect(
      await app.prisma.pushSubscription.findUnique({ where: { id: refused.row.id } }),
    ).not.toBeNull();
    expect(logArgs.slice(before)).toContainEqual([
      { statusCode: 403, host: "fcm.googleapis.com" },
      "Push delivery failed",
    ]);
  });

  it("no log call of this file ever received an endpoint", () => {
    expect(allEndpoints.length).toBeGreaterThan(0);
    expect(logArgs.length).toBeGreaterThan(0);
    const dump = inspect(logArgs, { depth: 12, maxStringLength: 100_000, breakLength: Infinity });
    for (const endpoint of allEndpoints) {
      expect(dump.includes(endpoint), "an endpoint reached a log call").toBe(false);
    }
  });
});
