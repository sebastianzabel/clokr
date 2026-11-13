// Issue #843 (D-843-01 block 6, T-843-18) - urlState parses the URL through an allow-list and
// writes only non-default values. The URL is attacker-controlled input: unknown keys are dropped,
// every key has its own bounded parser, foreign keys of the page (salonId) are left alone.
import { describe, expect, it, vi } from "vitest";
import urlStateSource from "../url-state.ts?raw";
import {
  int,
  oneOf,
  parseUrlState,
  pattern,
  serialiseUrlState,
  text,
  urlState,
  type UrlStateIo,
} from "../url-state";

const schema = {
  q: text({ max: 80 }),
  sort: oneOf(["name", "hire"], "name"),
  dir: oneOf(["asc", "desc"], "asc"),
};

function params(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

describe("parseUrlState", () => {
  it("trims the text, drops unknown keys and falls back on an invalid enum", () => {
    const state = parseUrlState(schema, params("q=%20M%C3%BCller&sort=evil&x=1"));
    expect(state).toEqual({ q: "Müller", sort: "name", dir: "asc" });
    expect(Object.keys(state)).toEqual(["q", "sort", "dir"]);
  });

  it("returns the defaults for an empty query", () => {
    expect(parseUrlState(schema, params(""))).toEqual({ q: "", sort: "name", dir: "asc" });
  });

  it("accepts a valid enum value", () => {
    expect(parseUrlState(schema, params("sort=hire&dir=desc"))).toMatchObject({
      sort: "hire",
      dir: "desc",
    });
  });

  it("cuts a text longer than max and removes control characters", () => {
    const long = parseUrlState(schema, params(`q=${"a".repeat(500)}`));
    expect(long.q).toHaveLength(80);
    const controls = parseUrlState(schema, params(`q=a%00b%0Ac%09d%7Fe`));
    expect(controls.q).toBe("abcde");
  });

  it("does not read prototype keys the URL names", () => {
    const state = parseUrlState(schema, params("__proto__=x&constructor=y&toString=z"));
    expect(Object.keys(state)).toEqual(["q", "sort", "dir"]);
  });
});

describe("parser builders", () => {
  it("pattern accepts a match, rejects the rest and ignores a global flag's lastIndex", () => {
    const p = pattern(/^[a-f0-9-]{36}$/i, "");
    const id = "0b8f6d2e-4c31-4f5a-9d70-123456789abc";
    expect(p.parse(id)).toBe(id);
    expect(p.parse(id)).toBe(id);
    expect(p.parse("not-an-id")).toBe("");
    expect(p.parse(null)).toBe("");
    const sticky = pattern(/^a$/g, "-");
    expect(sticky.parse("a")).toBe("a");
    expect(sticky.parse("a")).toBe("a");
  });

  it("pattern never runs on a very long value", () => {
    const p = pattern(/^a+$/, "");
    expect(p.parse("a".repeat(10_000))).toBe("");
  });

  it("int accepts a number within range and falls back outside it or on junk", () => {
    const p = int({ min: 1, max: 50 }, 1);
    expect(p.parse("7")).toBe(7);
    expect(p.parse("0")).toBe(1);
    expect(p.parse("51")).toBe(1);
    expect(p.parse("7.5")).toBe(1);
    expect(p.parse("1e3")).toBe(1);
    expect(p.parse("abc")).toBe(1);
    expect(p.parse(null)).toBe(1);
    expect(p.serialise(1)).toBeNull();
    expect(p.serialise(7)).toBe("7");
    expect(p.serialise(99)).toBeNull();
  });

  it("oneOf refuses a fallback outside its values", () => {
    expect(() => oneOf(["a", "b"], "c" as never)).toThrow();
  });
});

describe("serialiseUrlState", () => {
  it("writes no table keys for the defaults", () => {
    expect(serialiseUrlState(schema, { q: "", sort: "name", dir: "asc" })).toBe("");
  });

  it("writes only the non-default value", () => {
    expect(serialiseUrlState(schema, { sort: "hire" })).toBe("sort=hire");
  });

  it("never writes a key outside the schema, even when the state carries one", () => {
    const state = { q: "Anna", evil: "1" } as never;
    expect(serialiseUrlState(schema, state)).toBe("q=Anna");
  });

  it("never writes an invalid value", () => {
    expect(serialiseUrlState(schema, { sort: "evil" as never })).toBe("");
  });

  it("keeps the foreign keys of the page and replaces the table keys", () => {
    const query = serialiseUrlState(schema, { q: "Anna" }, "salonId=abc&q=old&sort=hire");
    const out = params(query);
    expect(out.get("salonId")).toBe("abc");
    expect(out.get("q")).toBe("Anna");
    expect(out.has("sort")).toBe(false);
  });

  it("round-trips through parse", () => {
    const query = serialiseUrlState(schema, { q: "Müller", sort: "hire", dir: "desc" });
    expect(parseUrlState(schema, params(query))).toEqual({
      q: "Müller",
      sort: "hire",
      dir: "desc",
    });
  });
});

describe("urlState", () => {
  function setup(href: string) {
    const navigate = vi.fn();
    const io: UrlStateIo = { url: () => new URL(href), navigate };
    return { state: urlState(schema, io), navigate };
  }

  it("reads the state of the injected URL", () => {
    const { state } = setup("http://localhost/admin/employees?q=Anna&sort=bad&salonId=s1");
    expect(state.read()).toEqual({ q: "Anna", sort: "name", dir: "asc" });
  });

  it("navigates once with replaceState, keepFocus and noScroll", () => {
    const { state, navigate } = setup("http://localhost/admin/employees?salonId=s1");
    state.write({ sort: "hire" });
    expect(navigate).toHaveBeenCalledTimes(1);
    const [href, options] = navigate.mock.calls[0];
    expect(href).toBe("/admin/employees?salonId=s1&sort=hire");
    expect(options).toEqual({ replaceState: true, keepFocus: true, noScroll: true });
  });

  it("merges a patch into the current state and keeps the hash", () => {
    const { state, navigate } = setup("http://localhost/p?q=Anna&dir=desc#top");
    state.write({ sort: "hire" });
    expect(navigate.mock.calls[0][0]).toBe("/p?q=Anna&sort=hire&dir=desc#top");
  });

  it("drops a key when it returns to its default", () => {
    const { state, navigate } = setup("http://localhost/p?q=Anna&salonId=s1");
    state.write({ q: "" });
    expect(navigate.mock.calls[0][0]).toBe("/p?salonId=s1");
  });

  it("does not navigate when nothing changes", () => {
    const { state, navigate } = setup("http://localhost/p?q=Anna");
    state.write({ q: "Anna" });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("navigates only to the current path, never to a string it was given", () => {
    const { state, navigate } = setup("http://localhost/p");
    state.write({ q: "https://evil.example/x?y=1" });
    const href = navigate.mock.calls[0][0] as string;
    expect(href.startsWith("/p?q=")).toBe(true);
    expect(href).not.toContain("://evil");
  });
});

describe("url-state source", () => {
  it("is non-vacuous and keeps SvelteKit out of the pure functions", () => {
    expect(urlStateSource.length).toBeGreaterThan(500);
    expect(urlStateSource).not.toMatch(/\{@html/);
    // The only SvelteKit imports are the two the default io needs.
    const imports = urlStateSource.match(/from "\$app\/[a-z]+"/g) ?? [];
    expect(imports.sort()).toEqual(['from "$app/navigation"', 'from "$app/state"']);
  });
});
