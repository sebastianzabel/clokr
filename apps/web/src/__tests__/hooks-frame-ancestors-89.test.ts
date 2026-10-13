// @vitest-environment node
// Issue #89 (T-89-10, RESEARCH Pitfall 8) - the operator console cannot be framed.
//
// Every document response under /betreiber carries the CSP framing directive and the legacy
// framing header; a tenant page keeps exactly the headers it had before this phase. The legacy
// header is sent whatever CSP_MODE says, so a CSP-off deployment stays protected.
import type { RequestEvent } from "@sveltejs/kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handle } from "../hooks.server";

interface Result {
  response: Response;
  nonce: string;
}

async function run(pathname: string): Promise<Result> {
  const locals: Record<string, unknown> = {};
  const event = {
    url: new URL(`http://localhost${pathname}`),
    request: new Request(`http://localhost${pathname}`),
    getClientAddress: () => "127.0.0.1",
    locals,
  } as unknown as RequestEvent;

  const response = await handle({
    event,
    resolve: async () =>
      new Response("<html><head></head><body><script></script></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
  });
  return { response, nonce: String(locals.nonce) };
}

/** The tenant CSP as it was before this phase, pinned on purpose: it must not move. */
function pinnedTenantCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

let previousMode: string | undefined;

beforeEach(() => {
  previousMode = process.env.CSP_MODE;
  delete process.env.CSP_MODE;
});

afterEach(() => {
  if (previousMode === undefined) delete process.env.CSP_MODE;
  else process.env.CSP_MODE = previousMode;
});

describe("operator pages refuse framing", () => {
  it.each(["/betreiber", "/betreiber/anmelden", "/betreiber/mandanten/some-id"])(
    "%s carries the CSP framing directive and the legacy header",
    async (pathname) => {
      const { response, nonce } = await run(pathname);
      expect(nonce.length, "a nonce was generated").toBeGreaterThan(10);
      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
      expect(response.headers.get("Content-Security-Policy")).toBe(
        `${pinnedTenantCsp(nonce)}; frame-ancestors 'none'`,
      );
    },
  );

  it("sends the legacy header even when the CSP is switched off", async () => {
    process.env.CSP_MODE = "off";
    const { response } = await run("/betreiber/anmelden");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Content-Security-Policy")).toBeNull();
    expect(response.headers.get("Content-Security-Policy-Report-Only")).toBeNull();
  });

  it("adds the directive to the report-only header in report-only mode", async () => {
    process.env.CSP_MODE = "report-only";
    const { response, nonce } = await run("/betreiber");
    expect(response.headers.get("Content-Security-Policy-Report-Only")).toBe(
      `${pinnedTenantCsp(nonce)}; frame-ancestors 'none'`,
    );
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("does not match a sibling path that merely starts with the same letters", async () => {
    const { response } = await run("/betreiber-extra");
    expect(response.headers.get("X-Frame-Options")).toBeNull();
  });
});

describe("tenant pages keep their headers unchanged", () => {
  it.each(["/dashboard", "/login", "/"])(
    "%s has the pinned CSP and no framing header",
    async (pathname) => {
      const { response, nonce } = await run(pathname);
      expect(response.headers.get("Content-Security-Policy")).toBe(pinnedTenantCsp(nonce));
      expect(response.headers.get("X-Frame-Options")).toBeNull();
    },
  );
});
