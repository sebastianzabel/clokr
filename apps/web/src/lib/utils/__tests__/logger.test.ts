// Issue #149 — the client error-logging chain was completely dead: `logger.ts` read a
// localStorage key `"auth"` that `$stores/auth` never writes (it writes `accessToken`,
// `refreshToken` and `user` as three separate keys), so every delivery went out without an
// `Authorization` header and `POST /api/v1/logs/client` (behind `requireAuth`) answered 401.
// The `.catch(() => {})` swallowed that silently for years.
//
// These tests pin the OUTCOME of the chain, not its shape: which header actually leaves the
// client, whether a broken delivery becomes audible, and whether the client stays inside the
// endpoint's 5-requests-per-minute budget.
//
// Fresh module per test (`vi.resetModules()` + dynamic import): the logger keeps queue,
// cooldown and "already reported" state at module scope, and a session-scoped rule can only be
// tested against a fresh session.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// This workspace's jsdom exposes no `localStorage` (neither on `window` nor globally), so the
// real storage the logger reads has to be supplied per test. An in-memory Storage stub keeps the
// KEY NAMES — the whole subject of #149 — as the thing under test.
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage;
}

// Mirrors of the module-private constants in ../logger. Kept as literals on purpose: if the
// logger's timing changes, these tests must be re-read rather than silently follow along.
const FLUSH_DELAY_MS = 5_000;
const MIN_SEND_INTERVAL_MS = 15_000;
const RATE_LIMIT_COOLDOWN_MS = 60_000;

const LOG_ENDPOINT = "/api/v1/logs/client";

type ClientLogger = (typeof import("../logger"))["clientLogger"];

let clientLogger: ClientLogger;
let fetchMock: ReturnType<typeof vi.fn>;
/** Everything `console.warn` received during the test, one joined line per call. */
let warnLines: string[] = [];
/**
 * `window` outlives `vi.resetModules()`: a listener installed by one test's module instance
 * would still be attached — and still enqueue into that instance's queue — during the next
 * test, which is exactly how this file first measured two requests where one was expected.
 * Every listener added during a test is therefore removed again afterwards.
 */
let addedListeners: Array<[string, EventListener]> = [];

function response(status: number): Response {
  return { ok: status >= 200 && status < 300, status } as Response;
}

/** Console lines the logger emits about a BROKEN DELIVERY (not the error being logged). */
function deliveryWarnings(): string[] {
  return warnLines.filter((line) => line.includes("could not reach"));
}

function headerOf(callIndex: number, name: string): string | undefined {
  const init = fetchMock.mock.calls[callIndex]?.[1] as RequestInit | undefined;
  return (init?.headers as Record<string, string> | undefined)?.[name];
}

function bodyOf(callIndex: number): Record<string, unknown> {
  const init = fetchMock.mock.calls[callIndex]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? "{}"));
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal("localStorage", memoryStorage());
  fetchMock = vi.fn().mockResolvedValue(response(200));
  vi.stubGlobal("fetch", fetchMock);
  warnLines = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnLines.push(args.map((a) => String(a)).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation(() => {});

  addedListeners = [];
  const realAdd = window.addEventListener.bind(window) as (
    type: string,
    handler: EventListener,
    options?: unknown,
  ) => void;
  vi.spyOn(window, "addEventListener").mockImplementation(((
    type: string,
    handler: EventListener,
    options?: unknown,
  ) => {
    if (typeof handler === "function") addedListeners.push([type, handler]);
    realAdd(type, handler, options);
  }) as unknown as typeof window.addEventListener);

  ({ clientLogger } = await import("../logger"));
});

afterEach(() => {
  for (const [type, handler] of addedListeners) window.removeEventListener(type, handler);
  addedListeners = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("clientLogger — token keys (Issue #149)", () => {
  it("sends the Bearer token from the `accessToken` key that $stores/auth actually writes", async () => {
    localStorage.setItem("accessToken", "token-149");
    localStorage.setItem("user", JSON.stringify({ id: "user-149" }));

    clientLogger.error("boom");
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(LOG_ENDPOINT);
    expect(headerOf(0, "Authorization")).toBe("Bearer token-149");
  });

  it("takes userId from the `user` key's JSON payload", async () => {
    localStorage.setItem("accessToken", "token-149");
    localStorage.setItem("user", JSON.stringify({ id: "user-149", email: "x@example.test" }));

    clientLogger.error("boom");
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);

    expect(bodyOf(0).userId).toBe("user-149");
  });

  it("a corrupt `user` entry costs the userId but NOT the token", async () => {
    localStorage.setItem("accessToken", "token-149");
    localStorage.setItem("user", "{not json");

    clientLogger.error("boom");
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);

    expect(headerOf(0, "Authorization")).toBe("Bearer token-149");
    expect(bodyOf(0).userId).toBeUndefined();
  });

  it("ignores a legacy `auth` object — that key is written by nobody", async () => {
    // The pre-fix implementation read exactly this shape. A session that only has it is an
    // unauthenticated session, and must be treated as one.
    localStorage.setItem(
      "auth",
      JSON.stringify({ accessToken: "legacy-token", user: { id: "legacy-user" } }),
    );

    clientLogger.error("boom");
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(deliveryWarnings()).toHaveLength(1);
  });
});

describe("clientLogger — a broken delivery is audible once per session (Issue #149)", () => {
  it("warns once when there is no token at all, instead of posting into a guaranteed 401", async () => {
    clientLogger.error("boom");
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(deliveryWarnings()).toHaveLength(1);
  });

  it("warns exactly once across repeated HTTP failures — no per-attempt storm", async () => {
    localStorage.setItem("accessToken", "token-149");
    fetchMock.mockResolvedValue(response(401));

    clientLogger.error("first");
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
    clientLogger.error("second");
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS + MIN_SEND_INTERVAL_MS);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(deliveryWarnings()).toHaveLength(1);
  });

  it("warns once on a network-level rejection too", async () => {
    localStorage.setItem("accessToken", "token-149");
    fetchMock.mockRejectedValue(new Error("Failed to fetch"));

    clientLogger.error("boom");
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);

    expect(deliveryWarnings()).toHaveLength(1);
    expect(deliveryWarnings()[0]).toContain("Failed to fetch");
  });
});

describe("clientLogger — rate limit (5 requests/minute, Issue #149)", () => {
  it("spaces deliveries so a burst of errors stays inside the endpoint's budget", async () => {
    localStorage.setItem("accessToken", "token-149");

    for (let i = 0; i < 8; i++) clientLogger.error(`burst-${i}`);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("backs off for a full window after 429 and does not retry the rejected entry", async () => {
    localStorage.setItem("accessToken", "token-149");
    fetchMock.mockResolvedValue(response(429));

    clientLogger.error("a");
    clientLogger.error("b");
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Still inside the cooldown: nothing goes out, and 429 is backpressure, not an outage —
    // it must not masquerade as the "logging is broken" warning.
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_COOLDOWN_MS - 1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(deliveryWarnings()).toHaveLength(0);

    // After the cooldown the NEXT entry goes out — the 429'd one is not re-sent.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(1).message).toBe("b");
  });
});

describe("clientLogger.install()", () => {
  it("registers the global handlers only once, even when called twice", () => {
    clientLogger.install();
    clientLogger.install();

    expect(addedListeners.filter(([type]) => type === "error")).toHaveLength(1);
    expect(addedListeners.filter(([type]) => type === "unhandledrejection")).toHaveLength(1);
  });

  it("a window 'error' event reaches the endpoint with the Bearer token", async () => {
    localStorage.setItem("accessToken", "token-149");
    clientLogger.install();

    window.dispatchEvent(new ErrorEvent("error", { message: "window-level boom" }));
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(headerOf(0, "Authorization")).toBe("Bearer token-149");
    expect(bodyOf(0).message).toBe("window-level boom");
  });
});
