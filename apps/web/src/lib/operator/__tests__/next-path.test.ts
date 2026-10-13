// Issue #89 (D-02, T-89-04) — the `?next=` redirect target of the operator sign-in is accepted
// only when it stays inside the operator console.
import { describe, expect, it } from "vitest";

import { buildSignInUrl, safeNext } from "../next-path";

describe("safeNext (T-89-04)", () => {
  it.each([
    "/betreiber",
    "/betreiber/",
    "/betreiber?x=1",
    "/betreiber/mandanten/0b0e6bbf-6d36-4cd2-8b1c-3d0c7c3c1a11",
    "/betreiber/mandanten?seite=2",
  ])("accepts %s", (raw) => {
    expect(safeNext(raw)).toBe(raw);
  });

  it.each([
    null,
    undefined,
    "",
    "//evil.example",
    "/\\evil",
    "/betreiber\\..\\login",
    "https://evil.example/betreiber",
    "javascript:alert(1)",
    "/betreibers",
    "/betreiber-evil",
    "/login",
    "/betreiber/../login",
    "/betreiber/%2e%2e/login",
    "/betreiber/\nx",
    "betreiber",
    " /betreiber",
  ])("rejects %j", (raw) => {
    expect(safeNext(raw as string | null | undefined)).toBeNull();
  });
});

describe("buildSignInUrl", () => {
  it("encodes a safe path into next", () => {
    expect(buildSignInUrl("/betreiber/mandanten/abc", { expired: false })).toBe(
      "/betreiber/anmelden?next=%2Fbetreiber%2Fmandanten%2Fabc",
    );
  });

  it("appends abgelaufen=1 when the session expired", () => {
    expect(buildSignInUrl("/betreiber/mandanten/abc", { expired: true })).toBe(
      "/betreiber/anmelden?next=%2Fbetreiber%2Fmandanten%2Fabc&abgelaufen=1",
    );
  });

  it("omits next for an unsafe path", () => {
    expect(buildSignInUrl("//evil.example", { expired: false })).toBe("/betreiber/anmelden");
    expect(buildSignInUrl("//evil.example", { expired: true })).toBe(
      "/betreiber/anmelden?abgelaufen=1",
    );
  });

  it("does not loop back to the sign-in page itself", () => {
    expect(buildSignInUrl("/betreiber/anmelden?next=%2Fbetreiber", { expired: true })).toBe(
      "/betreiber/anmelden?abgelaufen=1",
    );
  });
});
