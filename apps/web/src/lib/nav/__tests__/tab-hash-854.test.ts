// Issue #854 - the tab-in-URL rule: alias, unknown, hidden and empty hashes, and the write path.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routerReplace = vi.fn();
vi.mock("$app/navigation", () => ({
  replaceState: (...args: unknown[]) => routerReplace(...args),
}));
vi.mock("$app/state", () => ({
  page: { url: new URL("http://localhost/verwalten/salons/1?x=1"), state: {} },
}));

import { tabFromHash, writeTabHash } from "../tab-hash";

const TABS = ["stammdaten", "oeffnungszeiten", "feiertage"] as const;

describe("tabFromHash", () => {
  it("returns the tab a known hash names, with or without the leading #", () => {
    expect(tabFromHash("#feiertage", TABS)).toBe("feiertage");
    expect(tabFromHash("oeffnungszeiten", TABS)).toBe("oeffnungszeiten");
  });

  it("maps an alias onto its tab", () => {
    expect(tabFromHash("#hours", TABS, { hours: "oeffnungszeiten" })).toBe("oeffnungszeiten");
  });

  it("falls back to the first tab for an unknown hash", () => {
    expect(tabFromHash("#gibt-es-nicht", TABS)).toBe("stammdaten");
  });

  it("falls back to the first tab for an empty hash", () => {
    expect(tabFromHash("", TABS)).toBe("stammdaten");
    expect(tabFromHash("#", TABS)).toBe("stammdaten");
  });

  it("never opens a tab the page hides: an id outside the visible list is the first tab", () => {
    expect(tabFromHash("#feiertage", ["stammdaten", "oeffnungszeiten"])).toBe("stammdaten");
  });

  it("an alias that points at a hidden tab is the first tab too", () => {
    expect(tabFromHash("#holidays", ["stammdaten"], { holidays: "feiertage" })).toBe("stammdaten");
  });

  it("does not resolve prototype keys as aliases", () => {
    expect(tabFromHash("#constructor", TABS, {})).toBe("stammdaten");
    expect(tabFromHash("#__proto__", TABS, {})).toBe("stammdaten");
  });
});

describe("writeTabHash", () => {
  beforeEach(() => {
    routerReplace.mockReset();
  });
  afterEach(() => {
    history.replaceState(null, "", "/");
  });

  it("asks the router to replace the state with the same path and query and the new hash", () => {
    writeTabHash("feiertage");
    expect(routerReplace).toHaveBeenCalledTimes(1);
    expect(routerReplace).toHaveBeenCalledWith("/verwalten/salons/1?x=1#feiertage", {});
  });

  it("falls back to the History API (no new entry) when the router refuses", () => {
    routerReplace.mockImplementation(() => {
      throw new Error("router not initialised");
    });
    history.replaceState(null, "", "/verwalten/salons/1?x=1");
    const before = history.length;
    writeTabHash("oeffnungszeiten");
    expect(location.pathname).toBe("/verwalten/salons/1");
    expect(location.search).toBe("?x=1");
    expect(location.hash).toBe("#oeffnungszeiten");
    expect(history.length).toBe(before);
  });
});
