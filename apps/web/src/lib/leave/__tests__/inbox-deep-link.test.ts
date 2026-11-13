// Issue #840 (D-840-05, T-840-30) - the receiver of the inbox deep links: untrusted query values
// are reduced to uuid ids and a bounded year, anything else is dropped; the parser never throws.
import { describe, it, expect } from "vitest";
import { parseInboxDeepLink } from "../inbox-deep-link";

const ID_A = "3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b";
const ID_B = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

describe("parseInboxDeepLink", () => {
  it("returns a uuid request and section9 id", () => {
    const params = new URLSearchParams({ request: ID_A, section9: ID_B });
    expect(parseInboxDeepLink(params, 2026)).toEqual({
      requestId: ID_A,
      year: null,
      section9Id: ID_B,
    });
  });

  it("lowercases an uppercase uuid", () => {
    const params = new URLSearchParams({ request: ID_A.toUpperCase() });
    expect(parseInboxDeepLink(params, 2026).requestId).toBe(ID_A);
  });

  it("drops anything that is not a uuid", () => {
    for (const bad of [
      "",
      "abc",
      "1",
      "../../etc",
      ID_A + "x",
      "<script>",
      ID_A.replace(/-/g, ""),
    ]) {
      const params = new URLSearchParams({ request: bad, section9: bad });
      expect(parseInboxDeepLink(params, 2026)).toEqual({
        requestId: null,
        year: null,
        section9Id: null,
      });
    }
  });

  it("accepts a 4-digit year within five years of the current year", () => {
    expect(parseInboxDeepLink(new URLSearchParams("year=2027"), 2026).year).toBe(2027);
    expect(parseInboxDeepLink(new URLSearchParams("year=2026"), 2026).year).toBe(2026);
    expect(parseInboxDeepLink(new URLSearchParams("year=2021"), 2026).year).toBe(2021);
    expect(parseInboxDeepLink(new URLSearchParams("year=2031"), 2026).year).toBe(2031);
  });

  it("drops a year outside the window or not a plain 4-digit number", () => {
    for (const bad of [
      "1999",
      "2032",
      "2020",
      "20270",
      "202",
      "2027.5",
      "-2027",
      "abc",
      "",
      " 2027",
      "0x7EB",
    ]) {
      expect(parseInboxDeepLink(new URLSearchParams({ year: bad }), 2026).year, bad).toBeNull();
    }
  });

  it("returns all-null for no parameters and never throws", () => {
    expect(parseInboxDeepLink(new URLSearchParams(), 2026)).toEqual({
      requestId: null,
      year: null,
      section9Id: null,
    });
    expect(() => parseInboxDeepLink(new URLSearchParams("request=%E0%A4%A"), 2026)).not.toThrow();
    expect(() => parseInboxDeepLink(null as unknown as URLSearchParams, 2026)).not.toThrow();
  });
});
