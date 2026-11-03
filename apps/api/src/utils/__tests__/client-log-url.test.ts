import { describe, expect, it } from "vitest";
import { clientLogUrl } from "../client-log-url";

const CODE = "ab".repeat(32);

describe("clientLogUrl (review WR-02, Issue #610)", () => {
  it("drops the query string and the fragment", () => {
    expect(clientLogUrl(`/settings/geraet-koppeln?code=${CODE}`)).toBe("/settings/geraet-koppeln");
    expect(clientLogUrl(`https://clokr.example.test/login?next=%2Fx%3Fcode%3D${CODE}#f`)).toBe(
      "https://clokr.example.test/login",
    );
    expect(clientLogUrl(`/a#code=${CODE}`)).toBe("/a");
  });

  it("keeps a plain path, caps the length and ignores non-strings", () => {
    expect(clientLogUrl("/dashboard")).toBe("/dashboard");
    expect(clientLogUrl(`/${"x".repeat(900)}`)).toHaveLength(500);
    expect(clientLogUrl(undefined)).toBeUndefined();
    expect(clientLogUrl(42)).toBeUndefined();
  });
});
