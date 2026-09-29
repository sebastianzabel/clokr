// Phase 408 (Issue #408, regression of #378) — POST /auth/refresh now carries the caller's
// CURRENT effective permissions; the web must forward and persist that list on every refresh, and
// (Task 2) load it once on boot for a session cached before #378 shipped.
//
// Why source reads for stores/auth.ts: apps/web/vitest.config.ts declares no `$app` alias by
// design (see that file's own doc comment) and `stores/auth.ts` transitively imports
// `$app/environment`. Mocking "$app/environment" directly does not help — Vite's import-analysis
// plugin fails to resolve the bare specifier before Vitest's mock registry gets a chance to
// intercept it (see version-line.test.ts's comment on the same failure mode). So the store's D-11
// assertions below are structural, string-based checks against its source, the same established
// pattern as nav-guard.test.ts's `readRouteFile`.
//
// Why client.ts CAN be exercised behaviourally: mocking "$stores/auth" (a real, alias-resolvable
// path) replaces the whole module before its own `$app/environment` import is ever transformed —
// established precedent in presence.test.ts. That mock uses a hoisted, mutable `state` object so
// each test can set up a different cached-user shape before importing/calling into client.ts.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function readSource(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    // Fallback: `pnpm --filter @clokr/web test` runs with cwd `apps/web`.
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const CLIENT = readSource("../lib/api/client.ts", "src/lib/api/client.ts");
const STORES_AUTH = readSource("../lib/stores/auth.ts", "src/lib/stores/auth.ts");

describe("Phase 408 (#408) — source-read guards", () => {
  it("WEB-a: doRefresh normalises data.permissions and forwards it as setTokens' third argument", () => {
    const start = CLIENT.indexOf("async function doRefresh(");
    expect(start).toBeGreaterThan(-1);
    const body = CLIENT.slice(start);
    expect(body).toMatch(/Array\.isArray\(\s*data\.permissions\s*\)/);
    expect(body).toMatch(
      /authStore\.setTokens\(\s*data\.accessToken\s*,\s*data\.refreshToken\s*,\s*permissions/,
    );
  });

  it("WEB-b: setTokens accepts an optional permissions param and persists it to localStorage.user", () => {
    expect(STORES_AUTH).toMatch(
      /setTokens\(\s*accessToken:\s*string,\s*refreshToken:\s*string,\s*permissions\?:\s*string\[\]\s*\)/,
    );
    const start = STORES_AUTH.indexOf("setTokens(");
    const end = STORES_AUTH.indexOf("logout()", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = STORES_AUTH.slice(start, end);
    expect(body).toContain('localStorage.setItem("user"');
    expect(body).toContain("permissions");
  });

  it("WEB-c: boot block schedules loadPermissionsIfMissing via queueMicrotask when permissions is undefined", () => {
    // Phase 412 (#412) merged this import with the new ApiError import from the same module.
    expect(STORES_AUTH).toMatch(
      /import \{[^}]*loadPermissionsIfMissing[^}]*\} from "\$api\/client"/,
    );
    const start = STORES_AUTH.indexOf("if (browser && initial.accessToken) {");
    const end = STORES_AUTH.indexOf("return {", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = STORES_AUTH.slice(start, end);
    const iCheck = body.search(/initial\.user\s*&&\s*initial\.user\.permissions\s*===\s*undefined/);
    expect(iCheck).toBeGreaterThan(-1);
    // Phase 412 (#412) added a SEPARATE, sibling queueMicrotask deferral earlier in this same
    // block for hydratePreferencesFromServer() — search for THIS call's own wrapper starting at
    // the permissions-check, not the first queueMicrotask( in the whole boot block.
    const iMicrotask = body.indexOf("queueMicrotask(", iCheck);
    const iLoader = body.indexOf("loadPermissionsIfMissing()", iMicrotask);
    expect(iMicrotask).toBeGreaterThan(iCheck);
    expect(iLoader).toBeGreaterThan(iMicrotask);
  });

  it("WEB-d: loadPermissionsIfMissing exists, reuses tryRefresh() and issues no request of its own", () => {
    const start = CLIENT.indexOf("export async function loadPermissionsIfMissing(");
    expect(start).toBeGreaterThan(-1);
    const end = CLIENT.indexOf("\n}", start);
    expect(end).toBeGreaterThan(start);
    const body = CLIENT.slice(start, end);
    expect(body).toContain("tryRefresh()");
    expect(body).not.toContain("fetch(");
  });
});

// Hoisted mutable auth-store mock: `state` is read synchronously by every `subscribe()` call (the
// pattern `get(authStore)` in client.ts relies on), and each test mutates it before exercising
// client.ts to simulate a different cached session shape.
const authMock = vi.hoisted(() => {
  const state = {
    accessToken: "a1" as string | null,
    refreshToken: "r1" as string | null,
    user: {
      id: "u1",
      email: "u1@test.de",
      role: "EMPLOYEE" as const,
      employeeId: "e1",
      firstName: null as string | null,
      permissions: undefined as string[] | undefined,
    } as {
      id: string;
      email: string;
      role: "EMPLOYEE";
      employeeId: string;
      firstName: string | null;
      permissions?: string[];
    } | null,
  };
  return { state, setTokens: vi.fn(), logout: vi.fn() };
});

vi.mock("$stores/auth", () => ({
  authStore: {
    subscribe: (run: (value: typeof authMock.state) => void) => {
      run(authMock.state);
      return () => {};
    },
    setTokens: authMock.setTokens,
    logout: authMock.logout,
  },
}));

import { api, loadPermissionsIfMissing } from "$api/client";

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

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  authMock.setTokens.mockReset();
  authMock.logout.mockReset();
  authMock.state.accessToken = "a1";
  authMock.state.refreshToken = "r1";
  authMock.state.user = {
    id: "u1",
    email: "u1@test.de",
    role: "EMPLOYEE",
    employeeId: "e1",
    firstName: null,
    permissions: undefined,
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Phase 408 (#408) — behavioural: doRefresh forwards permissions to setTokens", () => {
  it("WEB-r1: a 401-triggered refresh's permissions land as setTokens' third argument", async () => {
    fetchMock
      .mockReturnValueOnce(errorResponse(401)) // initial request
      .mockReturnValueOnce(
        jsonResponse({
          accessToken: "a2",
          refreshToken: "r2",
          permissions: ["leave-request:read:ZUGEWIESEN"],
        }),
      ) // refresh
      .mockReturnValueOnce(jsonResponse({ ok: true })); // retried request

    await api.get("/probe");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const refreshUrl = fetchMock.mock.calls[1][0] as string;
    expect(refreshUrl).toContain("/api/v1/auth/refresh");
    expect(authMock.setTokens).toHaveBeenCalledTimes(1);
    expect(authMock.setTokens.mock.calls[0][2]).toEqual(["leave-request:read:ZUGEWIESEN"]);
    expect(authMock.logout).not.toHaveBeenCalled();
  });

  // Regression guard, not a RED case: an absent/null `permissions` field must never be stored as
  // an empty list — that would freeze a fail-closed UI state until the next login. Passes against
  // the pre-fix source too, because setTokens() today is only ever called with two arguments.
  it("WEB-r2: an absent permissions field yields undefined, never an empty list, as the third argument", async () => {
    fetchMock
      .mockReturnValueOnce(errorResponse(401))
      .mockReturnValueOnce(jsonResponse({ accessToken: "a2", refreshToken: "r2" }))
      .mockReturnValueOnce(jsonResponse({ ok: true }));

    await api.get("/probe");

    expect(authMock.setTokens.mock.calls[0][2]).toBeUndefined();
  });

  it("WEB-r2: permissions: null also yields undefined, never an empty list, as the third argument", async () => {
    fetchMock
      .mockReturnValueOnce(errorResponse(401))
      .mockReturnValueOnce(
        jsonResponse({ accessToken: "a2", refreshToken: "r2", permissions: null }),
      )
      .mockReturnValueOnce(jsonResponse({ ok: true }));

    await api.get("/probe");

    expect(authMock.setTokens.mock.calls[0][2]).toBeUndefined();
  });
});

describe("Phase 408 (#408) — behavioural: loadPermissionsIfMissing() (Task 2, AK-3/AK-4)", () => {
  it("WEB-l1: a cached user without permissions triggers exactly one refresh, whose list is stored", async () => {
    authMock.state.user = {
      id: "u1",
      email: "u1@test.de",
      role: "EMPLOYEE",
      employeeId: "e1",
      firstName: null,
      permissions: undefined,
    };
    fetchMock.mockReturnValueOnce(
      jsonResponse({
        accessToken: "a2",
        refreshToken: "r2",
        permissions: ["leave-request:read:ZUGEWIESEN"],
      }),
    );

    const result = await loadPermissionsIfMissing();

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/auth/refresh");
    expect((options.method ?? "").toUpperCase()).toBe("POST");
    expect(options.body).toBe(JSON.stringify({ refreshToken: "r1" }));
    expect(authMock.setTokens.mock.calls[0][2]).toEqual(["leave-request:read:ZUGEWIESEN"]);
  });

  it("WEB-l2: a cached user with permissions: [] never re-triggers — an empty list is a real answer", async () => {
    authMock.state.user = {
      id: "u1",
      email: "u1@test.de",
      role: "EMPLOYEE",
      employeeId: "e1",
      firstName: null,
      permissions: [],
    };

    const result = await loadPermissionsIfMissing();

    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("WEB-l2: no cached user resolves false without a request", async () => {
    authMock.state.user = null;

    const result = await loadPermissionsIfMissing();

    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("WEB-l3: a 401 refresh answer resolves false — no setTokens, no logout, session stays fail-closed", async () => {
    authMock.state.user = {
      id: "u1",
      email: "u1@test.de",
      role: "EMPLOYEE",
      employeeId: "e1",
      firstName: null,
      permissions: undefined,
    };
    fetchMock.mockReturnValueOnce(errorResponse(401));

    const result = await loadPermissionsIfMissing();

    expect(result).toBe(false);
    expect(authMock.setTokens).not.toHaveBeenCalled();
    expect(authMock.logout).not.toHaveBeenCalled();
  });

  it("WEB-l3: a network error resolves false and never rejects", async () => {
    authMock.state.user = {
      id: "u1",
      email: "u1@test.de",
      role: "EMPLOYEE",
      employeeId: "e1",
      firstName: null,
      permissions: undefined,
    };
    fetchMock.mockReturnValueOnce(Promise.reject(new Error("network down")));

    await expect(loadPermissionsIfMissing()).resolves.toBe(false);
  });

  it("WEB-l4: two concurrent calls reuse the existing refresh dedup — exactly one /auth/refresh fetch", async () => {
    authMock.state.user = {
      id: "u1",
      email: "u1@test.de",
      role: "EMPLOYEE",
      employeeId: "e1",
      firstName: null,
      permissions: undefined,
    };
    fetchMock.mockReturnValueOnce(
      jsonResponse({ accessToken: "a2", refreshToken: "r2", permissions: [] }),
    );

    const [first, second] = await Promise.all([
      loadPermissionsIfMissing(),
      loadPermissionsIfMissing(),
    ]);

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
