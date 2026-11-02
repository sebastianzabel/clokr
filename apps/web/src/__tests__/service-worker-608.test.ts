// Issue #608 (D-12, D-19, AC-3): behaviour of the push-only service worker against a fake worker
// scope, plus source pins that keep it from ever handling network requests.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGIN = "https://app.example";
const FALLBACK = { title: "Clokr", body: "Es gibt etwas Neues in Clokr." };

type Handler = (event: unknown) => void;

interface FakeClient {
  url: string;
  focus: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
}

function fakeClient(path: string, navigateImpl?: () => Promise<unknown>): FakeClient {
  return {
    url: `${ORIGIN}${path}`,
    focus: vi.fn().mockResolvedValue(undefined),
    navigate: vi.fn(navigateImpl ?? (() => Promise.resolve(undefined))),
  };
}

let handlers: Record<string, Handler>;
let registrationShow: ReturnType<typeof vi.fn>;
let matchAll: ReturnType<typeof vi.fn>;
let openWindow: ReturnType<typeof vi.fn>;
let claim: ReturnType<typeof vi.fn>;
let skipWaiting: ReturnType<typeof vi.fn>;
let order: string[];

async function loadWorker() {
  handlers = {};
  order = [];
  registrationShow = vi.fn().mockResolvedValue(undefined);
  matchAll = vi.fn().mockResolvedValue([]);
  openWindow = vi.fn().mockResolvedValue(null);
  claim = vi.fn().mockResolvedValue(undefined);
  skipWaiting = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("self", {
    addEventListener: (type: string, handler: Handler) => {
      order.push(type);
      handlers[type] = handler;
    },
    registration: { showNotification: registrationShow },
    clients: { matchAll, openWindow, claim },
    skipWaiting,
    location: { origin: ORIGIN },
  });
  vi.resetModules();
  await import("../service-worker");
}

function fakeEvent(extra: Record<string, unknown> = {}) {
  const waited: Promise<unknown>[] = [];
  return {
    event: { waitUntil: (p: Promise<unknown>) => waited.push(p), ...extra },
    settled: () => Promise.all(waited),
    waited,
  };
}

function pushEvent(data: { json(): unknown } | null) {
  return fakeEvent({ data });
}

function clickEvent(url: unknown) {
  const close = vi.fn();
  const f = fakeEvent({ notification: { close, data: url === undefined ? undefined : { url } } });
  return { ...f, close };
}

beforeEach(async () => {
  await loadWorker();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listeners", () => {
  it("registers exactly install, activate, push and notificationclick", () => {
    const types = [...order].sort((a, b) => a.localeCompare(b));
    expect(types).toEqual(["activate", "install", "notificationclick", "push"]);
  });

  it("install calls skipWaiting; activate hands clients.claim() to waitUntil", async () => {
    handlers.install({});
    expect(skipWaiting).toHaveBeenCalledTimes(1);
    const { event, settled } = fakeEvent();
    handlers.activate(event);
    await settled();
    expect(claim).toHaveBeenCalledTimes(1);
  });
});

describe("push", () => {
  it("shows the notification inside waitUntil with the payload", async () => {
    const payload = { title: "Clokr", body: "Du bist noch eingestempelt.", url: "/time-entries" };
    const { event, waited, settled } = pushEvent({ json: () => payload });
    handlers.push(event);
    expect(waited).toHaveLength(1);
    await settled();
    expect(registrationShow).toHaveBeenCalledWith("Clokr", {
      body: payload.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      lang: "de",
      data: { url: "/time-entries" },
    });
  });

  it("still shows the fallback for null data", async () => {
    const { event, settled } = pushEvent(null);
    handlers.push(event);
    await settled();
    expect(registrationShow).toHaveBeenCalledTimes(1);
    expect(registrationShow.mock.calls[0][0]).toBe(FALLBACK.title);
    expect(registrationShow.mock.calls[0][1]).toMatchObject({
      body: FALLBACK.body,
      data: { url: "/dashboard" },
    });
  });

  it("still shows the fallback for unreadable data", async () => {
    const garbage = {
      json: () => {
        throw new SyntaxError("not json");
      },
    };
    const { event, settled } = pushEvent(garbage);
    handlers.push(event);
    await settled();
    expect(registrationShow).toHaveBeenCalledTimes(1);
    expect(registrationShow.mock.calls[0][1]).toMatchObject({ body: FALLBACK.body });
  });
});

describe("notificationclick", () => {
  it("closes, focuses the app window and navigates it; skips the operator window", async () => {
    const operator = fakeClient("/betreiber/mandanten");
    const app = fakeClient("/dashboard");
    matchAll.mockResolvedValue([operator, app]);
    const { event, close, settled } = clickEvent("/team/leave?request=1");
    handlers.notificationclick(event);
    await settled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(matchAll).toHaveBeenCalledWith({ type: "window", includeUncontrolled: true });
    expect(app.focus).toHaveBeenCalledTimes(1);
    expect(app.navigate).toHaveBeenCalledWith(`${ORIGIN}/team/leave?request=1`);
    expect(operator.focus).not.toHaveBeenCalled();
    expect(operator.navigate).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
  });

  it("opens a window when navigate rejects", async () => {
    const app = fakeClient("/dashboard", () => Promise.reject(new Error("no navigate")));
    matchAll.mockResolvedValue([app]);
    const { event, settled } = clickEvent("/inbox");
    handlers.notificationclick(event);
    await settled();
    expect(openWindow).toHaveBeenCalledWith(`${ORIGIN}/inbox`);
  });

  it("opens a window when there is none", async () => {
    const { event, settled } = clickEvent("/inbox");
    handlers.notificationclick(event);
    await settled();
    expect(openWindow).toHaveBeenCalledWith(`${ORIGIN}/inbox`);
  });

  it("opens a window when only an operator window exists", async () => {
    const operator = fakeClient("/betreiber");
    matchAll.mockResolvedValue([operator]);
    const { event, settled } = clickEvent("/inbox");
    handlers.notificationclick(event);
    await settled();
    expect(operator.navigate).not.toHaveBeenCalled();
    expect(openWindow).toHaveBeenCalledWith(`${ORIGIN}/inbox`);
  });

  it.each(["//evil.example", "https://evil.example/x", undefined])(
    "never opens a foreign target (%s) - it goes to the dashboard",
    async (hostile) => {
      const { event, settled } = clickEvent(hostile);
      handlers.notificationclick(event);
      await settled();
      expect(openWindow).toHaveBeenCalledWith(`${ORIGIN}/dashboard`);
    },
  );
});

describe("source pins", () => {
  const source = readFileSync(join(__dirname, "../service-worker.ts"), "utf8");
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");

  it("registers only the four listener types", () => {
    expect(source.length).toBeGreaterThan(0);
    const types = [...code.matchAll(/addEventListener\(\s*"([a-z]+)"/g)].map((m) => m[1]);
    expect(types.sort((a, b) => a.localeCompare(b))).toEqual([
      "activate",
      "install",
      "notificationclick",
      "push",
    ]);
    expect(code.match(/addEventListener\(/g)).toHaveLength(4);
  });

  it("never handles network requests, uses the Cache Storage or loads scripts at runtime", () => {
    expect(code).not.toMatch(/"fetch"|'fetch'|\bcaches\b|importScripts|\$app\/|\$service-worker/);
  });
});
