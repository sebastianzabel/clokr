// @vitest-environment node
// Issue #610 (review WR-01) - the pages that carry a one-time pairing code (the pairing page itself
// and the /login and /otp legs that hold it in ?next=) send `Referrer-Policy: no-referrer`, so the
// code never travels in a Referer header to a sub-request or an ingress access log. Every other
// page keeps the browser default (no header), and the CSP pin of the #89 test is untouched.
import type { RequestEvent } from "@sveltejs/kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sendsNoReferrer } from "$lib/security/no-referrer-paths";
import { handle } from "../hooks.server";

async function run(pathAndQuery: string): Promise<Response> {
  const event = {
    url: new URL(`http://localhost${pathAndQuery}`),
    request: new Request(`http://localhost${pathAndQuery}`),
    getClientAddress: () => "127.0.0.1",
    locals: {},
  } as unknown as RequestEvent;
  return handle({
    event,
    resolve: async () =>
      new Response("<html><head></head><body><script></script></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
  });
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

describe("Referrer-Policy on the pairing legs", () => {
  it.each([
    `/settings/geraet-koppeln?code=${"ab".repeat(32)}`,
    "/settings/geraet-koppeln",
    "/settings/geraet-koppeln/",
    "/login?next=%2Fsettings%2Fgeraet-koppeln%3Fcode%3Dab",
    "/otp?next=%2Fsettings%2Fgeraet-koppeln",
  ])("%s sends no referrer", async (path) => {
    const response = await run(path);
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("is set whatever the CSP mode is", async () => {
    process.env.CSP_MODE = "off";
    const response = await run("/settings/geraet-koppeln");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it.each(["/dashboard", "/settings", "/settings/geraet-koppeln-extra", "/", "/reports"])(
    "%s keeps the browser default",
    async (path) => {
      const response = await run(path);
      expect(response.headers.get("Referrer-Policy")).toBeNull();
    },
  );

  it("sendsNoReferrer names exactly the three paths", () => {
    expect(sendsNoReferrer("/login")).toBe(true);
    expect(sendsNoReferrer("/otp")).toBe(true);
    expect(sendsNoReferrer("/settings/geraet-koppeln")).toBe(true);
    expect(sendsNoReferrer("/forgot-password")).toBe(false);
  });
});
