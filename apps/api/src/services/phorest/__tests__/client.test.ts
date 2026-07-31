// Phase 85 — regression tests for the Phorest HTTP client (phorestFetch).
//
// BUG-1 (INT live-test): the base URL carries a path prefix (`/third-party-api-server`). The old
// `new URL(path, baseUrl)` resolved an absolute `path` (leading "/") against the ORIGIN and silently
// dropped that prefix → every real Phorest call 404'd. The fix joins base + path instead. These
// tests pin the full outgoing URL so the prefix can never be dropped again.

import { describe, it, expect, vi, afterEach } from "vitest";
import { phorestFetch, PhorestApiError } from "../client";

const originalFetch = global.fetch;

// Capture the URL phorestFetch actually calls, returning an empty-but-ok JSON body.
function mockOkCapturingUrl(): { calledWith: () => string } {
  let captured = "";
  global.fetch = vi.fn(async (input: unknown) => {
    captured = String(input);
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calledWith: () => captured };
}

const BASE = "https://api-gateway-eu.phorest.com/third-party-api-server";

describe("phorestFetch URL construction (BUG-1 regression)", () => {
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("preserves the base path prefix when the path is absolute (leading slash)", async () => {
    const cap = mockOkCapturingUrl();
    await phorestFetch(BASE, "/api/business/biz-1/branch/branch-1/staff", "user@salon.de", "pw");
    const url = cap.calledWith();
    // The prefix MUST survive — this is the exact failure the old `new URL(path, base)` caused.
    expect(url).toContain("/third-party-api-server/api/business/biz-1/branch/branch-1/staff");
    expect(url.startsWith(`${BASE}/api/business/`)).toBe(true);
  });

  it("does not double the slash between base and path", async () => {
    const cap = mockOkCapturingUrl();
    // Trailing slash on base + leading slash on path must collapse to a single separator.
    await phorestFetch(`${BASE}/`, "/api/business/biz-1/branch/branch-1/staff", "u", "p");
    const url = cap.calledWith();
    expect(url).not.toContain("//api/business");
    expect(url).toContain("/third-party-api-server/api/business/biz-1/branch/branch-1/staff");
  });

  it("appends query params as URL search params", async () => {
    const cap = mockOkCapturingUrl();
    await phorestFetch(BASE, "/api/business/biz-1/branch/branch-1/staff", "u", "p", {
      size: "1",
      page: "0",
    });
    const url = cap.calledWith();
    expect(url).toContain("size=1");
    expect(url).toContain("page=0");
    // Params must not clobber the path prefix.
    expect(url).toContain("/third-party-api-server/api/business/");
  });

  it("sends Basic auth with the global/ username prefix", async () => {
    let authHeader = "";
    global.fetch = vi.fn(async (_input: unknown, init: unknown) => {
      const headers = (init as { headers: Record<string, string> }).headers;
      authHeader = headers.Authorization;
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await phorestFetch(BASE, "/api/business/biz-1/branch/branch-1/staff", "user@salon.de", "pw");
    expect(authHeader.startsWith("Basic ")).toBe(true);
    const decoded = Buffer.from(authHeader.slice("Basic ".length), "base64").toString("utf8");
    expect(decoded).toBe("global/user@salon.de:pw");
  });

  it("throws a typed PhorestApiError carrying the HTTP status on a non-ok response", async () => {
    global.fetch = vi.fn(
      async () => new Response("upstream error body", { status: 401 }),
    ) as unknown as typeof fetch;

    await expect(
      phorestFetch(BASE, "/api/business/biz-1/branch/branch-1/staff", "u", "p"),
    ).rejects.toMatchObject({ name: "PhorestApiError", status: 401 });

    // The raw upstream body must never surface in the thrown message.
    try {
      await phorestFetch(BASE, "/api/business/biz-1/branch/branch-1/staff", "u", "p");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PhorestApiError);
      expect((err as Error).message).not.toContain("upstream error body");
    }
  });
});
