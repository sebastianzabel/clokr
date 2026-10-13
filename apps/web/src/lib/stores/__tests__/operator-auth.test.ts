// Issue #89 (D-02, T-89-05) — the operator session lives in sessionStorage only, survives a
// blocked storage in memory, and is independent of the tenant session in both directions.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

const loggerMock = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock("$lib/utils/logger", () => ({ clientLogger: loggerMock }));

function memoryStorage(): Storage & { dump(): Record<string, string> } {
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
    dump: () => Object.fromEntries(map),
  } as Storage & { dump(): Record<string, string> };
}

function throwingStorage(): Storage {
  const boom = () => {
    throw new Error("storage blocked");
  };
  return {
    get length() {
      return boom();
    },
    key: boom,
    getItem: boom,
    setItem: boom,
    removeItem: boom,
    clear: boom,
  } as unknown as Storage;
}

const TOKEN_KEY = "clokr.operator.accessToken";
const EXPIRES_KEY = "clokr.operator.expiresAt";
const NOW = 1_800_000_000_000;

let session: ReturnType<typeof memoryStorage>;
let local: ReturnType<typeof memoryStorage>;

beforeEach(() => {
  vi.resetModules();
  session = memoryStorage();
  local = memoryStorage();
  vi.stubGlobal("sessionStorage", session);
  vi.stubGlobal("localStorage", local);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("operator session store", () => {
  it("setSession writes the token and the absolute expiry to sessionStorage", async () => {
    const { setSession } = await import("../operator-auth");
    setSession("op-token", 900, NOW);
    expect(session.getItem(TOKEN_KEY)).toBe("op-token");
    expect(session.getItem(EXPIRES_KEY)).toBe(String(NOW + 900_000));
  });

  it("loadSession returns the session while it is valid and publishes it on the store", async () => {
    const { setSession, loadSession, operatorSession } = await import("../operator-auth");
    setSession("op-token", 900, NOW);
    expect(loadSession(NOW + 1000)).toEqual({ token: "op-token", expiresAt: NOW + 900_000 });
    expect(get(operatorSession)).toEqual({ token: "op-token", expiresAt: NOW + 900_000 });
  });

  it("loadSession returns null and removes both keys once the session expired", async () => {
    const { setSession, loadSession } = await import("../operator-auth");
    setSession("op-token", 900, NOW);
    expect(loadSession(NOW + 900_000)).toBeNull();
    expect(session.getItem(TOKEN_KEY)).toBeNull();
    expect(session.getItem(EXPIRES_KEY)).toBeNull();
  });

  it("loadSession returns null when only one of the two keys is present", async () => {
    session.setItem(TOKEN_KEY, "op-token");
    const { loadSession } = await import("../operator-auth");
    expect(loadSession(NOW)).toBeNull();
    expect(session.getItem(TOKEN_KEY)).toBeNull();
  });

  it("loadSession treats a corrupt expiry as no session", async () => {
    session.setItem(TOKEN_KEY, "op-token");
    session.setItem(EXPIRES_KEY, "not-a-number");
    const { loadSession } = await import("../operator-auth");
    expect(loadSession(NOW)).toBeNull();
  });

  it("clearSession removes both operator keys and nothing else", async () => {
    session.setItem("unrelated", "keep");
    local.setItem("accessToken", "tenant-access");
    local.setItem("refreshToken", "tenant-refresh");
    local.setItem("user", "{}");
    const { setSession, clearSession, currentToken, operatorSession } =
      await import("../operator-auth");
    setSession("op-token", 900, NOW);

    clearSession();

    expect(session.dump()).toEqual({ unrelated: "keep" });
    expect(local.dump()).toEqual({
      accessToken: "tenant-access",
      refreshToken: "tenant-refresh",
      user: "{}",
    });
    expect(currentToken(NOW)).toBeNull();
    expect(get(operatorSession)).toBeNull();
  });

  it("currentToken returns the token only while it has not expired", async () => {
    const { setSession, currentToken } = await import("../operator-auth");
    setSession("op-token", 900, NOW);
    expect(currentToken(NOW + 1)).toBe("op-token");
    expect(currentToken(NOW + 900_000)).toBeNull();
  });

  it("never writes to localStorage", async () => {
    const setItem = vi.spyOn(local, "setItem");
    const removeItem = vi.spyOn(local, "removeItem");
    const { setSession, loadSession, clearSession } = await import("../operator-auth");
    setSession("op-token", 900, NOW);
    loadSession(NOW);
    clearSession();
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });

  it("with a blocked sessionStorage no function throws and the session lives in memory", async () => {
    vi.stubGlobal("sessionStorage", throwingStorage());
    const { setSession, loadSession, currentToken, clearSession } =
      await import("../operator-auth");

    expect(() => setSession("op-token", 900, NOW)).not.toThrow();
    expect(currentToken(NOW + 1)).toBe("op-token");
    expect(loadSession(NOW + 1)).toEqual({ token: "op-token", expiresAt: NOW + 900_000 });
    expect(() => clearSession()).not.toThrow();
    expect(currentToken(NOW + 1)).toBeNull();
    expect(loadSession(NOW + 1)).toBeNull();
  });

  it("with no sessionStorage global at all nothing throws", async () => {
    vi.stubGlobal("sessionStorage", undefined);
    const { setSession, loadSession } = await import("../operator-auth");
    expect(() => setSession("op-token", 900, NOW)).not.toThrow();
    expect(loadSession(NOW + 1)?.token).toBe("op-token");
  });
});

describe("independence from the tenant session", () => {
  it("the tenant authStore.logout() leaves both operator keys in place", async () => {
    local.setItem("accessToken", "tenant-access");
    local.setItem("refreshToken", "tenant-refresh");
    local.setItem("user", JSON.stringify({ id: "u1", permissions: [] }));
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );

    const { setSession } = await import("../operator-auth");
    setSession("op-token", 900, NOW);
    const { authStore } = await import("../auth");

    authStore.logout();

    expect(local.getItem("accessToken")).toBeNull();
    expect(session.getItem(TOKEN_KEY)).toBe("op-token");
    expect(session.getItem(EXPIRES_KEY)).toBe(String(NOW + 900_000));
  });
});
