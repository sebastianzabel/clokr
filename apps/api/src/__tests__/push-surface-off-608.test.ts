/**
 * Issue #608 (D-01, OWNER-608-VAPID) - without the VAPID set the push write surface does not exist:
 * its routes answer 404, `GET /me/push/config` tells the web that push is off, and the rest of the
 * own-data surface is unchanged. This runs on the DEFAULT test app, which has no VAPID set.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import { fakeDeviceSubscription } from "./push-fixtures-608";

const { sendNotificationMock } = vi.hoisted(() => ({ sendNotificationMock: vi.fn() }));

vi.mock("web-push", () => {
  const api = { sendNotification: sendNotificationMock };
  return { default: api, ...api };
});

describe("Issue #608: push surface off (VAPID unset)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let ip = 0;
  const nextIp = () => `10.60.9.${++ip}`;

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, `-p608off-${randomBytes(3).toString("hex")}`);
  });

  afterAll(async () => {
    await cleanupTestData(app, seed.tenant.id);
  });

  const headers = () => ({ authorization: `Bearer ${seed.empToken}` });

  it("reports push as off and exposes no key", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/push/config",
      headers: headers(),
      remoteAddress: nextIp(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false, publicKey: null });
  });

  it("does not register the push write routes", async () => {
    const cases = [
      { method: "POST", url: "/api/v1/me/push/subscriptions", payload: fakeDeviceSubscription() },
      { method: "POST", url: "/api/v1/me/push/test", payload: {} },
      { method: "GET", url: "/api/v1/me/push/subscriptions", payload: undefined },
      {
        method: "DELETE",
        url: "/api/v1/me/push/subscriptions",
        payload: { id: randomUUID() },
      },
    ] as const;
    for (const c of cases) {
      const res = await app.inject({
        method: c.method,
        url: c.url,
        headers: headers(),
        payload: c.payload,
        remoteAddress: nextIp(),
      });
      expect(res.statusCode, `${c.method} ${c.url}`).toBe(404);
    }
    expect(sendNotificationMock).not.toHaveBeenCalled();
    expect(await app.prisma.pushSubscription.count({ where: { tenantId: seed.tenant.id } })).toBe(
      0,
    );
  });

  it("leaves the rest of the own-data surface unchanged", async () => {
    for (const url of ["/api/v1/me/context", "/api/v1/me/preferences"]) {
      const res = await app.inject({
        method: "GET",
        url,
        headers: headers(),
        remoteAddress: nextIp(),
      });
      expect(res.statusCode, url).toBe(200);
    }
  });
});
