// Phase 412 (Issue #412, follow-up to #408/PR #411) — `hydratePreferencesFromServer()`'s
// boot-time call in `apps/web/src/lib/stores/auth.ts` used to run SYNCHRONOUSLY inside
// `createAuthStore()`, before the module-level `export const authStore = createAuthStore();`
// assignment completed. `client.ts`'s `request()` calls `get(authStore)` as its first
// statement, so that call hit `authStore`'s own TDZ and threw a `ReferenceError` — silently
// swallowed by `hydratePreferencesFromServer()`'s `catch {}`. Result: after a page reload with
// an existing session, `/me/preferences` was never fetched and `prefsHydrated` never became
// `true`, so later preference changes never reached the server.
//
// This file is the AK-412-04 behavioral proof: a REAL (unmocked) module boot of
// `$stores/auth`, with a token already in localStorage, must result in the `/me/preferences`
// fetch happening and `prefsHydrated` flipping to `true`.
//
// Why this needs the new `$app/environment` vitest alias (apps/web/vitest.config.ts): a real,
// unmocked import of `$stores/auth` transitively imports `$app/environment`, which
// vitest.config.ts previously declared no alias for (by design, to avoid pulling in
// SvelteKit's router pipeline — see that file's own comment). Mocking "$app/environment"
// directly does not work either — Vite's import-analysis plugin resolves the bare specifier
// before Vitest's mock registry can intercept it (measured in version-line.test.ts). The new
// alias resolves ONLY `$app/environment` to a tiny local stub
// (src/__tests__/stubs/app-environment.ts), which is what makes this test possible at all.
//
// Deliberately NOT mocking `$stores/auth` or `$api/client` — that would defeat the entire
// point of this test (CONTEXT.md D-07). Only `fetch` and `$lib/utils/logger` are mocked: the
// former because there is no real server, the latter only to observe calls, not because it's
// unresolvable.

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

const loggerMock = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("$lib/utils/logger", () => ({
  clientLogger: loggerMock,
}));

// This workspace's jsdom exposes no `localStorage` (neither on `window` nor globally, see
// apps/web/src/lib/utils/__tests__/logger.test.ts's identical comment) — the real storage
// `$stores/auth`'s boot block reads has to be supplied per test via `vi.stubGlobal`.
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

const VALID_PREFS = {
  theme: "pflaume",
  mode: "light",
  density: "comfortable",
  skin: "editorial",
  language: "de",
};

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response);
}

function errorResponse(status: number) {
  return Promise.resolve({
    ok: false,
    status,
    headers: new Headers(),
    json: () => Promise.reject(new Error("no body")),
    text: () => Promise.resolve(""),
  } as unknown as Response);
}

function seedSession() {
  localStorage.setItem("accessToken", "a1");
  localStorage.setItem("refreshToken", "r1");
  localStorage.setItem(
    "user",
    JSON.stringify({
      id: "u1",
      email: "u1@test.de",
      role: "EMPLOYEE",
      employeeId: "e1",
      firstName: null,
      permissions: [], // already resolved — no loadPermissionsIfMissing() noise in this test
    }),
  );
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  loggerMock.warn.mockReset();
  loggerMock.error.mockReset();
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("Phase 412 (#412) — boot-time preferences hydration (AK-412-01/04)", () => {
  it("a module boot with a valid token fetches /me/preferences and flips prefsHydrated to true", async () => {
    seedSession();
    fetchMock.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/me/preferences")) {
        return jsonResponse(VALID_PREFS);
      }
      return errorResponse(404);
    });

    vi.resetModules();
    await import("$stores/auth"); // fresh module evaluation — exercises the boot block for real
    const { prefsHydrated } = await import("$stores/prefs-state");

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/me/preferences"),
        expect.anything(),
      );
    });
    await vi.waitFor(() => {
      expect(get(prefsHydrated)).toBe(true);
    });
  });

  it("AK-412-03: a non-401 failure (500) is reported via clientLogger.warn", async () => {
    seedSession();
    fetchMock.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/me/preferences")) {
        return errorResponse(500);
      }
      return errorResponse(404);
    });

    vi.resetModules();
    await import("$stores/auth");

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/me/preferences"),
        expect.anything(),
      );
    });
    await vi.waitFor(() => {
      expect(loggerMock.warn).toHaveBeenCalled();
    });
  });

  it("AK-412-03: a 401 stays silent — clientLogger.warn is never called", async () => {
    seedSession();
    fetchMock.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/me/preferences")) {
        return errorResponse(401);
      }
      // 401 on /me/preferences triggers client.ts's auto-refresh path too — answer it
      // with a failing refresh so the flow terminates quickly without a retry loop.
      if (typeof url === "string" && url.includes("/auth/refresh")) {
        return errorResponse(401);
      }
      return errorResponse(404);
    });

    vi.resetModules();
    await import("$stores/auth");

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/me/preferences"),
        expect.anything(),
      );
    });
    // Give any pending microtask/promise chain a chance to settle before asserting silence.
    await new Promise((r) => setTimeout(r, 50));
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it("AK-412-03: a network/offline failure stays silent — clientLogger.warn is never called", async () => {
    seedSession();
    fetchMock.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/me/preferences")) {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return errorResponse(404);
    });

    vi.resetModules();
    await import("$stores/auth");

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/me/preferences"),
        expect.anything(),
      );
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });
});

describe("Phase 412 (#412) — structural regression guard (D-08)", () => {
  it("boot block wraps hydratePreferencesFromServer() in its own queueMicrotask call", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    let src: string;
    try {
      src = readFileSync(fileURLToPath(new URL("../lib/stores/auth.ts", import.meta.url)), "utf8");
    } catch {
      src = readFileSync(resolve(process.cwd(), "src/lib/stores/auth.ts"), "utf8");
    }

    const start = src.indexOf("if (browser && initial.accessToken) {");
    const end = src.indexOf("return {", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);

    const iMicrotask = body.indexOf("queueMicrotask(");
    const iHydrate = body.indexOf("hydratePreferencesFromServer()", iMicrotask);
    expect(iMicrotask).toBeGreaterThan(-1);
    expect(iHydrate).toBeGreaterThan(iMicrotask);

    // Both boot-time calls (prefs + permissions) must be wrapped — two separate
    // queueMicrotask invocations, not merged into one callback (CONTEXT.md "Claude's
    // Discretion").
    const microtaskCount = body.split("queueMicrotask(").length - 1;
    expect(microtaskCount).toBeGreaterThanOrEqual(2);
  });
});
