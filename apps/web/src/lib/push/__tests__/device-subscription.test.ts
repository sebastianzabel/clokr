// Issue #608 (D-14, D-11, P-608-18): the browser side of a device opt-in. The permission request is
// the first await of the click (call-order log), a key rotation unsubscribes the old subscription,
// a refused registration rolls the new subscription back, `ready` is bounded, and "this device is
// on" needs the browser AND the server list.
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const log: string[] = [];

const api = vi.hoisted(() => ({
  subscribePushDevice: vi.fn(),
  removePushDevice: vi.fn(),
}));
vi.mock("$lib/api/push", () => api);

import {
  PUSH_FALLBACK_ERROR,
  PUSH_NOT_READY_ERROR,
  disableThisDevice,
  enableThisDevice,
  sha256Hex,
  thisDeviceState,
  urlBase64ToUint8Array,
} from "../device-subscription";
import type { PushDevice } from "$lib/api/push";

const KEY_BYTES = Uint8Array.from({ length: 65 }, (_, i) => (i * 7 + 3) % 256);
const PUBLIC_KEY = Buffer.from(KEY_BYTES).toString("base64url");
const OTHER_KEY = Buffer.from(
  Uint8Array.from({ length: 65 }, (_, i) => (i * 5 + 9) % 256),
).toString("base64url");

interface FakeSub {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer | null };
  toJSON: () => { endpoint: string; keys: { p256dh: string; auth: string } };
  unsubscribe: ReturnType<typeof vi.fn>;
}

function fakeSub(endpoint: string, key: string | null): FakeSub {
  return {
    endpoint,
    options: {
      applicationServerKey: key ? urlBase64ToUint8Array(key).buffer : null,
    },
    toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }),
    unsubscribe: vi.fn(async () => {
      log.push(`unsubscribe:${endpoint}`);
      return true;
    }),
  };
}

interface Setup {
  existing: FakeSub | null;
  created: FakeSub;
  subscribe: ReturnType<typeof vi.fn>;
  getRegistration: ReturnType<typeof vi.fn>;
}

/** Stubs Notification and navigator.serviceWorker; every stub appends to the one call-order log. */
function setup(opts: {
  permission?: NotificationPermission;
  existing?: FakeSub | null;
  ready?: Promise<unknown>;
}): Setup {
  const created = fakeSub("https://push.example/new", PUBLIC_KEY);
  const existing = opts.existing ?? null;
  const subscribe = vi.fn(async () => {
    log.push("subscribe");
    return created;
  });
  const registration = {
    pushManager: {
      getSubscription: vi.fn(async () => existing),
      subscribe,
    },
  };
  const getRegistration = vi.fn(async () => registration);
  vi.stubGlobal("Notification", {
    requestPermission: vi.fn(async () => {
      log.push("permission");
      return opts.permission ?? "granted";
    }),
  });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      get ready() {
        log.push("ready");
        return opts.ready ?? Promise.resolve(registration);
      },
      getRegistration,
    },
  });
  return { existing, created, subscribe, getRegistration };
}

function device(over: Partial<PushDevice> = {}): PushDevice {
  return {
    id: "dev-1",
    deviceLabel: "Chrome auf Android",
    consentedAt: "2026-11-02T10:00:00.000Z",
    lastSuccessAt: null,
    endpointHash: "x",
    ...over,
  };
}

beforeEach(() => {
  log.length = 0;
  api.subscribePushDevice.mockReset();
  api.removePushDevice.mockReset();
  api.subscribePushDevice.mockImplementation(async () => {
    log.push("post");
    return device();
  });
  api.removePushDevice.mockImplementation(async () => {
    log.push("delete");
  });
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", webcrypto);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("urlBase64ToUint8Array / sha256Hex", () => {
  it("round-trips a 65-byte VAPID-length key", () => {
    const bytes = urlBase64ToUint8Array(PUBLIC_KEY);
    expect(bytes.length).toBe(65);
    expect(Array.from(bytes)).toEqual(Array.from(KEY_BYTES));
  });

  it("decodes the url-safe alphabet and missing padding", () => {
    // 0xfb 0xff 0xfe is "-__-" in base64url ("+//+" in base64), length 4 needs no padding;
    // two bytes ("-_8") need one pad.
    expect(Array.from(urlBase64ToUint8Array("-__-"))).toEqual([0xfb, 0xff, 0xfe]);
    expect(Array.from(urlBase64ToUint8Array("-_8"))).toEqual([0xfb, 0xff]);
  });

  it("hashes like the server: sha256('abc')", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("enableThisDevice", () => {
  it("requests the permission before the worker is awaited and before any API call", async () => {
    setup({});
    const result = await enableThisDevice(PUBLIC_KEY);
    expect(result.status).toBe("enabled");
    expect(log).toEqual(["permission", "ready", "subscribe", "post"]);
  });

  it.each([
    ["denied", "denied"],
    ["default", "dismissed"],
  ] as const)(
    "a %s permission is %s and subscribes and posts nothing",
    async (permission, status) => {
      const s = setup({ permission });
      expect(await enableThisDevice(PUBLIC_KEY)).toEqual({ status });
      expect(s.subscribe).not.toHaveBeenCalled();
      expect(api.subscribePushDevice).not.toHaveBeenCalled();
      expect(log).toEqual(["permission"]);
    },
  );

  it("subscribes with userVisibleOnly and the decoded key, then registers sub.toJSON()", async () => {
    const s = setup({});
    const result = await enableThisDevice(PUBLIC_KEY);
    expect(result).toEqual({ status: "enabled", device: device() });
    const args = s.subscribe.mock.calls[0][0] as {
      userVisibleOnly: boolean;
      applicationServerKey: Uint8Array;
    };
    expect(args.userVisibleOnly).toBe(true);
    expect(Array.from(args.applicationServerKey)).toEqual(Array.from(KEY_BYTES));
    expect(api.subscribePushDevice).toHaveBeenCalledWith(s.created.toJSON());
  });

  it("unsubscribes an existing subscription made with another key before subscribing", async () => {
    const stale = fakeSub("https://push.example/stale", OTHER_KEY);
    const s = setup({ existing: stale });
    expect((await enableThisDevice(PUBLIC_KEY)).status).toBe("enabled");
    expect(log).toEqual([
      "permission",
      "ready",
      "unsubscribe:https://push.example/stale",
      "subscribe",
      "post",
    ]);
    expect(s.subscribe).toHaveBeenCalledTimes(1);
  });

  it("reuses an existing subscription that already carries the current key", async () => {
    const same = fakeSub("https://push.example/same", PUBLIC_KEY);
    const s = setup({ existing: same });
    expect((await enableThisDevice(PUBLIC_KEY)).status).toBe("enabled");
    expect(s.subscribe).not.toHaveBeenCalled();
    expect(same.unsubscribe).not.toHaveBeenCalled();
    expect(api.subscribePushDevice).toHaveBeenCalledWith(same.toJSON());
  });

  it("rolls the new browser subscription back when the server refuses and shows its message", async () => {
    const s = setup({});
    api.subscribePushDevice.mockRejectedValue(
      Object.assign(new Error("Du hast bereits 10 Geräte für Push eingerichtet."), {
        status: 409,
      }),
    );
    const result = await enableThisDevice(PUBLIC_KEY);
    expect(result).toEqual({
      status: "error",
      message: "Du hast bereits 10 Geräte für Push eingerichtet.",
    });
    expect(s.created.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("falls back to the calm text for a network failure and still rolls back", async () => {
    const s = setup({});
    api.subscribePushDevice.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await enableThisDevice(PUBLIC_KEY)).toEqual({
      status: "error",
      message: PUSH_FALLBACK_ERROR,
    });
    expect(s.created.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("does not drop a reused subscription when the registration fails", async () => {
    const same = fakeSub("https://push.example/same", PUBLIC_KEY);
    setup({ existing: same });
    api.subscribePushDevice.mockRejectedValue(new TypeError("Failed to fetch"));
    expect((await enableThisDevice(PUBLIC_KEY)).status).toBe("error");
    expect(same.unsubscribe).not.toHaveBeenCalled();
  });

  it("gives up after 10 s when the service worker never becomes ready", async () => {
    vi.useFakeTimers();
    const s = setup({ ready: new Promise(() => {}) });
    const pending = enableThisDevice(PUBLIC_KEY);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ status: "error", message: PUSH_NOT_READY_ERROR });
    expect(s.subscribe).not.toHaveBeenCalled();
    expect(api.subscribePushDevice).not.toHaveBeenCalled();
  });
});

describe("disableThisDevice", () => {
  it("removes the device on the server by endpoint, then unsubscribes the browser", async () => {
    const sub = fakeSub("https://push.example/me", PUBLIC_KEY);
    setup({ existing: sub });
    expect(await disableThisDevice()).toEqual({ status: "disabled" });
    expect(api.removePushDevice).toHaveBeenCalledWith({ endpoint: "https://push.example/me" });
    expect(log).toEqual(["delete", "unsubscribe:https://push.example/me"]);
  });

  it("counts a 404 as success and still unsubscribes", async () => {
    const sub = fakeSub("https://push.example/me", PUBLIC_KEY);
    setup({ existing: sub });
    api.removePushDevice.mockRejectedValue(
      Object.assign(new Error("nicht gefunden"), { status: 404 }),
    );
    expect(await disableThisDevice()).toEqual({ status: "disabled" });
    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("keeps the browser subscription on a network error and reports it", async () => {
    const sub = fakeSub("https://push.example/me", PUBLIC_KEY);
    setup({ existing: sub });
    api.removePushDevice.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await disableThisDevice()).toEqual({ status: "error", message: PUSH_FALLBACK_ERROR });
    expect(sub.unsubscribe).not.toHaveBeenCalled();
  });

  it("is a no-op without a browser subscription", async () => {
    setup({ existing: null });
    expect(await disableThisDevice()).toEqual({ status: "disabled" });
    expect(api.removePushDevice).not.toHaveBeenCalled();
  });
});

describe("thisDeviceState", () => {
  it("is on only when the browser subscription's hash is in the server list", async () => {
    const sub = fakeSub("https://push.example/me", PUBLIC_KEY);
    setup({ existing: sub });
    const hash = await sha256Hex("https://push.example/me");
    expect(
      await thisDeviceState([
        device({ id: "a", endpointHash: "other" }),
        device({ id: "b", endpointHash: hash }),
      ]),
    ).toEqual({ state: "on", deviceId: "b" });
  });

  it("is off when the server does not know this subscription", async () => {
    setup({ existing: fakeSub("https://push.example/me", PUBLIC_KEY) });
    expect(await thisDeviceState([device({ endpointHash: "other" })])).toEqual({
      state: "off",
      deviceId: null,
    });
  });

  it("is off without a browser subscription even if the server lists devices", async () => {
    setup({ existing: null });
    expect(await thisDeviceState([device()])).toEqual({ state: "off", deviceId: null });
  });

  it("is off in a browser without a service worker", async () => {
    expect(await thisDeviceState([device()])).toEqual({ state: "off", deviceId: null });
  });
});
