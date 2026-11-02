// Issue #608 (D-18, T-608-32, T-608-34): an explicit logout removes this device's push
// registration first - bounded to 3 s, never throwing - in both the Sidebar and the Topbar.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ removePushDevice: vi.fn() }));
vi.mock("$lib/api/push", () => api);

import { removeThisDevicePush } from "../logout";

function stubWorker(sub: { endpoint: string; unsubscribe: () => Promise<boolean> } | null) {
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      getRegistration: vi.fn(async () => ({
        pushManager: { getSubscription: vi.fn(async () => sub) },
      })),
    },
  });
}

beforeEach(() => {
  api.removePushDevice.mockReset();
  api.removePushDevice.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("removeThisDevicePush", () => {
  it("is a no-op in a browser without a service worker", async () => {
    await expect(removeThisDevicePush()).resolves.toBeUndefined();
    expect(api.removePushDevice).not.toHaveBeenCalled();
  });

  it("is a no-op without a registration", async () => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistration: vi.fn(async () => undefined) },
    });
    await expect(removeThisDevicePush()).resolves.toBeUndefined();
    expect(api.removePushDevice).not.toHaveBeenCalled();
  });

  it("is a no-op without a subscription", async () => {
    stubWorker(null);
    await expect(removeThisDevicePush()).resolves.toBeUndefined();
    expect(api.removePushDevice).not.toHaveBeenCalled();
  });

  it("removes the device by endpoint on the server, then unsubscribes the browser", async () => {
    const order: string[] = [];
    api.removePushDevice.mockImplementation(async () => {
      order.push("delete");
    });
    const unsubscribe = vi.fn(async () => {
      order.push("unsubscribe");
      return true;
    });
    stubWorker({ endpoint: "https://push.example/me", unsubscribe });
    await removeThisDevicePush();
    expect(api.removePushDevice).toHaveBeenCalledWith({ endpoint: "https://push.example/me" });
    expect(order).toEqual(["delete", "unsubscribe"]);
  });

  it("swallows a failing API call and still unsubscribes", async () => {
    api.removePushDevice.mockRejectedValue(new TypeError("Failed to fetch"));
    const unsubscribe = vi.fn(async () => true);
    stubWorker({ endpoint: "https://push.example/me", unsubscribe });
    await expect(removeThisDevicePush()).resolves.toBeUndefined();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("is bounded to 3 s when the API call never settles, and still unsubscribes", async () => {
    vi.useFakeTimers();
    api.removePushDevice.mockReturnValue(new Promise(() => {}));
    const unsubscribe = vi.fn(async () => true);
    stubWorker({ endpoint: "https://push.example/me", unsubscribe });
    let done = false;
    const pending = removeThisDevicePush().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(2999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(done).toBe(true);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("never throws when the browser itself fails", async () => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        getRegistration: vi.fn(async () => {
          throw new Error("boom");
        }),
      },
    });
    await expect(removeThisDevicePush()).resolves.toBeUndefined();
  });

  it("never throws when unsubscribe rejects", async () => {
    stubWorker({
      endpoint: "https://push.example/me",
      unsubscribe: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await expect(removeThisDevicePush()).resolves.toBeUndefined();
  });
});

describe("logout wiring (source pins)", () => {
  // The handler body from its declaration to its closing "finally" block.
  function logoutBody(file: string): string {
    const source = readFileSync(resolve(__dirname, "../../components/layout", file), "utf8");
    const start = source.indexOf("async function handleLogout()");
    expect(start).toBeGreaterThan(-1);
    return source.slice(start, source.indexOf("goto(", start));
  }

  it.each(["Sidebar.svelte", "Topbar.svelte"])(
    "%s removes the push registration before /auth/logout and before authStore.logout()",
    (file) => {
      const body = logoutBody(file);
      const push = body.indexOf("await removeThisDevicePush()");
      const server = body.indexOf('"/auth/logout"');
      const local = body.indexOf("authStore.logout()");
      expect(push).toBeGreaterThan(-1);
      expect(server).toBeGreaterThan(push);
      expect(local).toBeGreaterThan(server);
    },
  );

  it.each(["Sidebar.svelte", "Topbar.svelte"])(
    "%s imports the helper from $lib/push/logout",
    (file) => {
      const source = readFileSync(resolve(__dirname, "../../components/layout", file), "utf8");
      expect(source).toContain('from "$lib/push/logout"');
    },
  );
});
