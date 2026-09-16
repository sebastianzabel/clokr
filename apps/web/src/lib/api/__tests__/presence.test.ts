import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readable } from "svelte/store";

// `$api/client` imports `$stores/auth`, which imports `$app/environment` — a
// specifier apps/web/vitest.config.ts deliberately does not alias. Mocking
// `$stores/auth` (a real, alias-resolvable path) replaces the module before its
// own `$app/environment` import is ever transformed. Same pattern and reason as
// version-line.test.ts; nothing here cares about auth state beyond the header.
vi.mock("$stores/auth", () => ({
  authStore: {
    ...readable({ accessToken: "test-token", refreshToken: null, user: null }),
    logout: vi.fn(),
    setTokens: vi.fn(),
  },
}));

import { getMyWifi, updateMyWifi, addMyDevice, removeMyDevice } from "../presence";

// #238: the four self-service WiFi calls addressed `/me/wifi` from Phase 25
// onward, while the routes have always been registered under the EMPLOYEE
// prefix (`employeeRoutes` at `/api/v1/employees`, app.ts). Every call 404'd
// and the settings page swallowed it, so the section rendered exactly like a
// genuine "opt-in off, no devices" state.
//
// These tests pin the URL the client actually puts on the wire. They assert the
// FULL path including the `/api/v1` prefix the api client prepends, so a change
// on either side has to be deliberate.

const fetchMock = vi.fn();

function jsonResponse(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response);
}

/** The path the request was actually made against, prefix included. */
function requestedPath(call: number): string {
  const url = fetchMock.mock.calls[call][0] as string;
  return url.startsWith("http") ? new URL(url).pathname : url;
}

function requestedMethod(call: number): string {
  return ((fetchMock.mock.calls[call][1] as RequestInit)?.method ?? "GET").toUpperCase();
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("#238 — WiFi self-service addresses the employee routes, not /me", () => {
  it("getMyWifi() requests /api/v1/employees/me/wifi", async () => {
    fetchMock.mockReturnValue(jsonResponse({ wifiPresenceEnabled: false, devices: [] }));
    await getMyWifi();
    expect(requestedPath(0)).toBe("/api/v1/employees/me/wifi");
    expect(requestedMethod(0)).toBe("GET");
  });

  it("updateMyWifi() PATCHes /api/v1/employees/me/wifi", async () => {
    fetchMock.mockReturnValue(jsonResponse({ wifiPresenceEnabled: true }));
    await updateMyWifi(true);
    expect(requestedPath(0)).toBe("/api/v1/employees/me/wifi");
    expect(requestedMethod(0)).toBe("PATCH");
  });

  it("addMyDevice() POSTs /api/v1/employees/me/wifi/devices", async () => {
    fetchMock.mockReturnValue(jsonResponse({ id: "d1", mac: "aa:bb:cc:dd:ee:ff", label: null }));
    await addMyDevice("aa:bb:cc:dd:ee:ff");
    expect(requestedPath(0)).toBe("/api/v1/employees/me/wifi/devices");
    expect(requestedMethod(0)).toBe("POST");
  });

  it("removeMyDevice() DELETEs /api/v1/employees/me/wifi/devices/:id", async () => {
    fetchMock.mockReturnValue(jsonResponse({}));
    await removeMyDevice("d1");
    expect(requestedPath(0)).toBe("/api/v1/employees/me/wifi/devices/d1");
    expect(requestedMethod(0)).toBe("DELETE");
  });

  it("no self-service WiFi call addresses the bare /me prefix", async () => {
    fetchMock.mockReturnValue(jsonResponse({ wifiPresenceEnabled: false, devices: [] }));
    await getMyWifi();
    await updateMyWifi(false);
    await addMyDevice("aa:bb:cc:dd:ee:ff");
    await removeMyDevice("d1");

    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (let i = 0; i < 4; i++) {
      // The regression this guards is exactly `/api/v1/me/wifi…`, which the API
      // answers with Fastify's generic "Route not found".
      expect(requestedPath(i)).not.toMatch(/^\/api\/v1\/me\//);
    }
  });
});
