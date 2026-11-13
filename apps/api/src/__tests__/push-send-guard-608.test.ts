/**
 * Issue #608 review CR-01 - behaviour proof that the endpoint guard and the HTTPS request of the
 * `web-push` library agree. The library is the REAL one; only `https.request` is stubbed, so the
 * test sees the exact `hostname` / `port` / `path` Node would have connected to. Pure: no app, no DB.
 */
import { EventEmitter } from "node:events";
import https from "node:https";
import { createECDH, randomBytes } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PUSH_TEST_PAYLOAD } from "../contexts/platform/notification-push-policy";
import { sendWebPush } from "../contexts/platform/push-sender";

vi.mock("../config", async () => {
  const { TEST_VAPID } = await import("./push-fixtures-608");
  return {
    config: {
      VAPID_PUBLIC_KEY: TEST_VAPID.publicKey,
      VAPID_PRIVATE_KEY: TEST_VAPID.privateKey,
      VAPID_SUBJECT: TEST_VAPID.subject,
    },
  };
});

type RequestOptions = { hostname?: string | null; port?: string | null; path?: string | null };

function realKeys(): { p256dh: string; auth: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
  };
}

describe("sendWebPush hands the library only the canonical allow-listed endpoint (CR-01)", () => {
  const requests: RequestOptions[] = [];
  let requestSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    requests.length = 0;
    requestSpy = vi.spyOn(https, "request").mockImplementation(((
      options: RequestOptions,
      callback: (res: EventEmitter & { statusCode: number; headers: object }) => void,
    ) => {
      requests.push(options);
      const req = new EventEmitter() as EventEmitter & {
        write: () => void;
        destroy: () => void;
        end: () => void;
      };
      req.write = () => undefined;
      req.destroy = () => undefined;
      req.end = () => {
        const res = Object.assign(new EventEmitter(), { statusCode: 201, headers: {} });
        callback(res);
        res.emit("end");
      };
      return req;
    }) as unknown as typeof https.request);
  });

  afterEach(() => {
    requestSpy.mockRestore();
  });

  it.each([
    "https:/fcm.googleapis.com/../internal/path",
    "https:fcm.googleapis.com/x",
    "https:///fcm.googleapis.com/x",
    "https://fcm.googleapis.com\t.evil/x",
    "https://localhost/x",
    "https://127.0.0.1/x",
    "http://fcm.googleapis.com/x",
    "not a url",
  ])("sends nothing for %j", async (endpoint) => {
    const result = await sendWebPush({ endpoint, ...realKeys() }, PUSH_TEST_PAYLOAD, 60);
    expect(result).toEqual({ outcome: "FAILED", statusCode: null });
    expect(requests).toHaveLength(0);
  });

  it.each([
    ["https://fcm.googleapis.com/fcm/send/abc", "fcm.googleapis.com", "/fcm/send/abc"],
    ["HTTPS://FCM.googleapis.com:443/fcm/send/abc", "fcm.googleapis.com", "/fcm/send/abc"],
    ["https:\\\\fcm.googleapis.com/fcm/send/abc", "fcm.googleapis.com", "/fcm/send/abc"],
    ["https://web.push.apple.com/a/../x", "web.push.apple.com", "/x"],
  ])("connects to the allow-listed host for %j", async (endpoint, host, path) => {
    const result = await sendWebPush({ endpoint, ...realKeys() }, PUSH_TEST_PAYLOAD, 60);
    expect(result).toEqual({ outcome: "SENT" });
    expect(requests).toHaveLength(1);
    expect(requests[0].hostname).toBe(host);
    expect(requests[0].path).toBe(path);
    // Never a null host (the localhost fallback of the SSRF) and never a foreign port.
    expect(requests[0].hostname).toBeTruthy();
    expect(["", null, undefined]).toContain(requests[0].port);
  });
});
