// Issue #608 (D-20, T-608-30): the one sign-in target rule of the tenant app.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { authPathWithNext, loginPathWithNext, safeAppNext } from "../login-next";

describe("safeAppNext", () => {
  it.each([
    "/time-entries?highlight=abc",
    "/team/leave?request=1",
    "/dashboard",
    "/loginx",
    "/otpauth",
  ])("accepts %s", (path) => {
    expect(safeAppNext(path)).toBe(path);
  });

  it("accepts a path of exactly 512 characters", () => {
    const path = `/${"a".repeat(511)}`;
    expect(safeAppNext(path)).toBe(path);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
    ["no leading slash", "dashboard"],
    ["protocol-relative", "//evil.example"],
    ["backslash", "/\\evil"],
    ["absolute url", "https://evil.example"],
    ["traversal", "/a/../b"],
    ["encoded slash", "/a%2Fb"],
    ["encoded dots", "/a%2e%2e"],
    ["line break", "/x\n"],
    ["operator root", "/betreiber"],
    ["operator page", "/betreiber/mandanten"],
    ["login", "/login"],
    ["login with next", "/login?next=/x"],
    ["otp", "/otp"],
    ["too long", `/${"a".repeat(512)}`],
  ])("refuses %s", (_label, raw) => {
    expect(safeAppNext(raw)).toBeNull();
  });
});

describe("loginPathWithNext", () => {
  it("carries path and search, encoded", () => {
    expect(loginPathWithNext({ pathname: "/time-entries", search: "?highlight=abc" })).toBe(
      "/login?next=%2Ftime-entries%3Fhighlight%3Dabc",
    );
  });

  it.each([
    ["/login", ""],
    ["/otp", ""],
    ["/betreiber/x", ""],
    ["/", ""],
    ["/a/../b", ""],
  ])("falls back to the bare sign-in page for %s%s", (pathname, search) => {
    expect(loginPathWithNext({ pathname, search })).toBe("/login");
  });
});

describe("authPathWithNext", () => {
  it("adds the target to the OTP page and leaves it out when there is none", () => {
    expect(authPathWithNext("/otp", "/inbox?x=1")).toBe("/otp?next=%2Finbox%3Fx%3D1");
    expect(authPathWithNext("/otp", null)).toBe("/otp");
  });
});

describe("wiring (source pins)", () => {
  const read = (rel: string) => readFileSync(join(__dirname, "../../../", rel), "utf8");

  it("the (app) guard sends the person to /login with the target", () => {
    const layout = read("routes/(app)/+layout.svelte");
    expect(layout).toContain("loginPathWithNext($page.url)");
    // The inactivity timeout keeps its own redirect.
    expect(layout).toContain('goto("/login?reason=timeout")');
  });

  it("the login page forwards the target to the OTP page and uses it after sign-in", () => {
    const login = read("routes/(auth)/login/+page.svelte");
    expect(login).toContain("safeAppNext(");
    expect(login).toContain('authPathWithNext("/otp", next)');
    expect(login).toContain('goto(next ?? "/dashboard")');
    expect(login).not.toContain('goto("/dashboard")');
  });

  it("the OTP page validates the target and uses it after a verified code", () => {
    const otp = read("routes/(auth)/otp/+page.svelte");
    expect(otp).toContain("safeAppNext(");
    expect(otp).toContain('goto(next ?? "/dashboard")');
    expect(otp).not.toContain('goto("/dashboard")');
  });

  it("both forced-logout redirects of the API client keep the target", () => {
    const client = read("lib/api/client.ts");
    expect(client.match(/loginPathWithNext\(window\.location\)/g)).toHaveLength(2);
    expect(client).not.toContain('window.location.href = "/login"');
  });
});
