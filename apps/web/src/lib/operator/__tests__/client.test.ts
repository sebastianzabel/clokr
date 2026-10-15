// Issue #89 (D-02, T-89-03) — the operator client sends only the operator token, never refreshes
// and turns a 401/403 into "clear the session, hand the caller a sign-in URL".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function emptyResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: () => Promise.reject(new Error("no body")),
    text: () => Promise.resolve(""),
  } as unknown as Response;
}

const NOW = Date.now();
const fetchMock = vi.fn();
let session: ReturnType<typeof memoryStorage>;
let local: ReturnType<typeof memoryStorage>;

async function load() {
  vi.resetModules();
  const auth = await import("$stores/operator-auth");
  const client = await import("../client");
  return { ...auth, ...client };
}

function headerValues(call: unknown[]): string[] {
  const init = call[1] as RequestInit | undefined;
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return Object.values(headers);
}

beforeEach(() => {
  fetchMock.mockReset();
  session = memoryStorage();
  local = memoryStorage();
  vi.stubGlobal("sessionStorage", session);
  vi.stubGlobal("localStorage", local);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("operatorApi", () => {
  it("sends every request to /api/v1/operator<path> with the operator token", async () => {
    const { setSession, operatorApi } = await load();
    setSession("op-token", 900, NOW);
    fetchMock.mockResolvedValue(jsonResponse({ id: "t1" }));

    await operatorApi.getTenant("t1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/operator/tenants/t1");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer op-token");
  });

  it("listTenants reads /tenants with the operator token", async () => {
    const { setSession, operatorApi } = await load();
    setSession("op-token", 900, NOW);
    fetchMock.mockResolvedValue(jsonResponse([{ id: "t1" }]));

    await expect(operatorApi.listTenants()).resolves.toEqual([{ id: "t1" }]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/operator/tenants");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer op-token");
  });

  it("getDashboard reads /dashboard with the operator token", async () => {
    const { setSession, operatorApi } = await load();
    setSession("op-token", 900, NOW);
    const body = { inactivityDays: 30, totals: { tenants: 1 }, tenants: [] };
    fetchMock.mockResolvedValue(jsonResponse(body));

    await expect(operatorApi.getDashboard()).resolves.toEqual(body);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/operator/dashboard");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer op-token");
  });

  it("createTenant posts the body as given to /tenants with the operator token", async () => {
    const { setSession, operatorApi } = await load();
    setSession("op-token", 900, NOW);
    fetchMock.mockResolvedValue(jsonResponse({ invitationMailSent: true }, 201));
    const body = {
      name: "Beispiel",
      slug: "beispiel",
      federalState: "BERLIN" as const,
      admin: { email: "a@example.invalid", firstName: "A", lastName: "B" },
    };

    await expect(operatorApi.createTenant(body)).resolves.toEqual({ invitationMailSent: true });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/operator/tenants");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify(body));
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer op-token");
  });

  it("createTenant surfaces the 409 code and keeps the session", async () => {
    const { setSession, operatorApi, currentToken } = await load();
    setSession("op-token", 900, NOW);
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "Dieser Kurzname ist bereits vergeben.", code: "SLUG_TAKEN" }, 409),
    );

    const err = await operatorApi
      .createTenant({
        name: "x",
        slug: "xxx",
        federalState: "BERLIN",
        admin: { email: "a@example.invalid", firstName: "A", lastName: "B" },
      })
      .catch((e: unknown) => e);

    expect(err).toMatchObject({ status: 409, code: "SLUG_TAKEN" });
    expect(currentToken()).toBe("op-token");
  });

  it("renameTenant patches {name} on /tenants/:id with the operator token", async () => {
    const { setSession, operatorApi } = await load();
    setSession("op-token", 900, NOW);
    fetchMock.mockResolvedValue(jsonResponse({ id: "t1", name: "Neu" }));

    await expect(operatorApi.renameTenant("t1", "Neu")).resolves.toEqual({ id: "t1", name: "Neu" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/operator/tenants/t1");
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(JSON.stringify({ name: "Neu" }));
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer op-token");
  });

  it("deactivateTenant posts {reason} to /tenants/:id/deactivate", async () => {
    const { setSession, operatorApi } = await load();
    setSession("op-token", 900, NOW);
    fetchMock.mockResolvedValue(jsonResponse({ id: "t1" }));

    await operatorApi.deactivateTenant("t1", "Vertrag beendet");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/operator/tenants/t1/deactivate");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ reason: "Vertrag beendet" }));
  });

  it("reactivateTenant and resendInvitation post without a body", async () => {
    const { setSession, operatorApi } = await load();
    setSession("op-token", 900, NOW);
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "t1" }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ invitationMailSent: false }));

    await operatorApi.reactivateTenant("t1");
    await expect(operatorApi.resendInvitation("t1")).resolves.toEqual({
      invitationMailSent: false,
    });

    const [reactivateUrl, reactivateInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(reactivateUrl).toBe("/api/v1/operator/tenants/t1/reactivate");
    expect(reactivateInit.method).toBe("POST");
    expect(reactivateInit.body).toBeUndefined();
    const [resendUrl, resendInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(resendUrl).toBe("/api/v1/operator/tenants/t1/resend-admin-invitation");
    expect(resendInit.method).toBe("POST");
    expect(resendInit.body).toBeUndefined();
  });

  it("encodes the tenant id in every lifecycle path", async () => {
    const { setSession, operatorApi } = await load();
    setSession("op-token", 900, NOW);
    fetchMock.mockResolvedValue(jsonResponse({}));

    await operatorApi.renameTenant("a/b", "x");
    await operatorApi.reactivateTenant("a/b");

    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/operator/tenants/a%2Fb");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/v1/operator/tenants/a%2Fb/reactivate");
  });

  it("listSalons reads /tenants/:id/salons", async () => {
    const { setSession, operatorApi } = await load();
    setSession("op-token", 900, NOW);
    fetchMock.mockResolvedValue(jsonResponse([]));

    await expect(operatorApi.listSalons("t1")).resolves.toEqual([]);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/operator/tenants/t1/salons");
  });

  it("createSalon posts the body to /tenants/:id/salons with the operator token", async () => {
    const { setSession, operatorApi } = await load();
    setSession("op-token", 900, NOW);
    fetchMock.mockResolvedValue(jsonResponse({ id: "s1" }, 201));
    const body = {
      name: "Salon Beispiel",
      openingHours: [{ day: 0, open: "08:00", close: "20:00", closed: false }],
      federalState: "NIEDERSACHSEN" as const,
    };

    await operatorApi.createSalon("t1", body as never);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/operator/tenants/t1/salons");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify(body));
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer op-token");
  });

  it("updateSalon patches exactly the given keys, including an explicit null", async () => {
    const { setSession, operatorApi } = await load();
    setSession("op-token", 900, NOW);
    fetchMock.mockResolvedValue(jsonResponse({ id: "s1" }));

    await operatorApi.updateSalon("a/b", "s/1", { coupling: null });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/operator/tenants/a%2Fb/salons/s%2F1");
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(JSON.stringify({ coupling: null }));
  });

  it("deactivateSalon and activateSalon POST to the salon lifecycle routes without a body", async () => {
    const { setSession, operatorApi } = await load();
    setSession("op-token", 900, NOW);
    fetchMock.mockResolvedValue(jsonResponse({ id: "s1" }));

    await operatorApi.deactivateSalon("a/b", "s/1");
    await operatorApi.activateSalon("a/b", "s/1");

    const [deactivateUrl, deactivateInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(deactivateUrl).toBe("/api/v1/operator/tenants/a%2Fb/salons/s%2F1/deactivate");
    expect(deactivateInit.method).toBe("POST");
    expect(deactivateInit.body).toBeUndefined();
    const [activateUrl, activateInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(activateUrl).toBe("/api/v1/operator/tenants/a%2Fb/salons/s%2F1/activate");
    expect(activateInit.method).toBe("POST");
    expect(activateInit.body).toBeUndefined();
    expect((activateInit.headers as Record<string, string>).Authorization).toBe("Bearer op-token");
  });

  it("never sends the tenant localStorage token, in any header", async () => {
    local.setItem("accessToken", "tenant-token");
    local.setItem("refreshToken", "tenant-refresh");
    const { setSession, operatorApi } = await load();
    setSession("op-token", 900, NOW);
    fetchMock.mockResolvedValue(jsonResponse([]));

    await operatorApi.listSalons("t1");

    for (const call of fetchMock.mock.calls) {
      const values = headerValues(call).join(" ");
      expect(values).not.toContain("tenant-token");
      expect(values).not.toContain("tenant-refresh");
    }
  });

  it("an unauthenticated request carries no Authorization header, even with a session", async () => {
    const { setSession, request } = await load();
    setSession("op-token", 900, NOW);
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await request("POST", "/auth/login", { body: { email: "a@example.invalid" }, auth: false });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("authorization");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ email: "a@example.invalid" }));
  });

  it("a 401 clears the session, calls the handler once with a sign-in URL and throws", async () => {
    const { setSession, operatorApi, setUnauthorizedHandler, OperatorApiError, currentToken } =
      await load();
    setSession("op-token", 900, NOW);
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    fetchMock.mockResolvedValue(jsonResponse({ error: "Nicht angemeldet" }, 401));
    window.history.replaceState({}, "", "/betreiber/mandanten/t1?x=1");

    await expect(operatorApi.listSalons("t1")).rejects.toBeInstanceOf(OperatorApiError);

    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry, no refresh
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      "/betreiber/anmelden?next=%2Fbetreiber%2Fmandanten%2Ft1%3Fx%3D1&abgelaufen=1",
    );
    expect(currentToken()).toBeNull();
    expect(session.dump()).toEqual({});
  });

  it("a 403 behaves like a 401", async () => {
    const { setSession, operatorApi, setUnauthorizedHandler } = await load();
    setSession("op-token", 900, NOW);
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    fetchMock.mockResolvedValue(jsonResponse({ error: "Zugriff verweigert" }, 403));

    await expect(operatorApi.getTenant("t1")).rejects.toMatchObject({ status: 403 });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(session.dump()).toEqual({});
  });

  it("a 401 on an unauthenticated request keeps the session and calls no handler", async () => {
    const { setSession, request, setUnauthorizedHandler, currentToken } = await load();
    setSession("op-token", 900, NOW);
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    fetchMock.mockResolvedValue(jsonResponse({ error: "Anmeldung fehlgeschlagen" }, 401));

    await expect(request("POST", "/auth/login", { body: {}, auth: false })).rejects.toMatchObject({
      status: 401,
      message: "Anmeldung fehlgeschlagen",
    });

    expect(handler).not.toHaveBeenCalled();
    expect(currentToken()).toBe("op-token");
  });

  it("never calls a refresh endpoint", async () => {
    const { setSession, operatorApi } = await load();
    setSession("op-token", 900, NOW);
    fetchMock.mockResolvedValue(jsonResponse({}, 401));

    await operatorApi.getTenant("t1").catch(() => undefined);

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("refresh"))).toBe(false);
  });

  it("204 resolves undefined", async () => {
    const { setSession, request } = await load();
    setSession("op-token", 900, NOW);
    fetchMock.mockResolvedValue(emptyResponse(204));

    await expect(request("POST", "/auth/logout")).resolves.toBeUndefined();
  });

  it("a JSON error body becomes an OperatorApiError with status, code and message", async () => {
    const { setSession, operatorApi } = await load();
    setSession("op-token", 900, NOW);
    const body = { error: "Konflikt", message: "Details", code: "SLUG_TAKEN" };
    fetchMock.mockResolvedValue(jsonResponse(body, 409));

    const err = await operatorApi.getTenant("t1").catch((e: unknown) => e);

    expect(err).toMatchObject({
      name: "OperatorApiError",
      status: 409,
      code: "SLUG_TAKEN",
      message: "Konflikt: Details",
      data: body,
    });
  });

  it("an error without a JSON body falls back to a generic message and no code", async () => {
    const { setSession, operatorApi } = await load();
    setSession("op-token", 900, NOW);
    fetchMock.mockResolvedValue(emptyResponse(500));

    const err = await operatorApi.getTenant("t1").catch((e: unknown) => e);

    expect(err).toMatchObject({ status: 500, code: undefined, message: "Fehler" });
  });
});

describe("operatorApi sign-in calls", () => {
  it("probeSurface maps a 404 to off and sends no Authorization header", async () => {
    const { setSession, operatorApi } = await load();
    setSession("op-token", 900, NOW);
    fetchMock.mockResolvedValue(jsonResponse({ error: "Nicht gefunden" }, 404));

    await expect(operatorApi.probeSurface()).resolves.toBe("off");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/operator/auth/me");
    expect(init.method).toBe("GET");
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("authorization");
  });

  it("probeSurface maps the tokenless 401 to on, without clearing or redirecting", async () => {
    const { setSession, operatorApi, setUnauthorizedHandler, currentToken } = await load();
    setSession("op-token", 900, NOW);
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    fetchMock.mockResolvedValue(jsonResponse({ error: "Unauthorized" }, 401));

    await expect(operatorApi.probeSurface()).resolves.toBe("on");

    expect(handler).not.toHaveBeenCalled();
    expect(currentToken()).toBe("op-token");
  });

  it("probeSurface treats a network failure as on (the form then reports the real error)", async () => {
    const { operatorApi } = await load();
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(operatorApi.probeSurface()).resolves.toBe("on");
  });

  it("login posts email and password without a token", async () => {
    const { setSession, operatorApi } = await load();
    setSession("op-token", 900, NOW);
    fetchMock.mockResolvedValue(jsonResponse({ challengeToken: "c1", expiresIn: 300 }));

    await expect(operatorApi.login("op@example.invalid", "pw")).resolves.toEqual({
      challengeToken: "c1",
      expiresIn: 300,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/operator/auth/login");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ email: "op@example.invalid", password: "pw" }));
    expect(
      Object.keys(init.headers as Record<string, string>).map((k) => k.toLowerCase()),
    ).not.toContain("authorization");
  });

  it("verify sends exactly the one factor it is given", async () => {
    const { operatorApi } = await load();
    fetchMock.mockResolvedValue(jsonResponse({ accessToken: "a1", expiresIn: 900 }));

    await operatorApi.verify("c1", { code: "123456" });
    await operatorApi.verify("c1", { recoveryCode: "AAAA-BBBB" });

    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/operator/auth/verify");
    expect((fetchMock.mock.calls[0][1] as RequestInit).body).toBe(
      JSON.stringify({ challengeToken: "c1", code: "123456" }),
    );
    expect((fetchMock.mock.calls[1][1] as RequestInit).body).toBe(
      JSON.stringify({ challengeToken: "c1", recoveryCode: "AAAA-BBBB" }),
    );
  });

  it("a 401 from login or verify throws OperatorApiError and never triggers the handler", async () => {
    const { setSession, operatorApi, setUnauthorizedHandler, OperatorApiError, currentToken } =
      await load();
    setSession("op-token", 900, NOW);
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    fetchMock.mockResolvedValue(jsonResponse({ error: "Anmeldung fehlgeschlagen" }, 401));

    const a = await operatorApi.login("a@example.invalid", "x").catch((e: unknown) => e);
    const b = await operatorApi.verify("c", { code: "000000" }).catch((e: unknown) => e);

    expect(a).toBeInstanceOf(OperatorApiError);
    expect(b).toMatchObject({ status: 401, message: "Anmeldung fehlgeschlagen" });
    expect(handler).not.toHaveBeenCalled();
    expect(currentToken()).toBe("op-token");
  });

  it("me uses the operator token", async () => {
    const { setSession, operatorApi } = await load();
    setSession("op-token", 900, NOW);
    fetchMock.mockResolvedValue(
      jsonResponse({ id: "o1", email: "op@example.invalid", displayName: "Op", lastLoginAt: null }),
    );

    await operatorApi.me();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/operator/auth/me");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer op-token");
  });
});
