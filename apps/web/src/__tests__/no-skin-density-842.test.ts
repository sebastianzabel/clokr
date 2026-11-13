// Issue #842, plan 17 (D-842-16, AC-4) — the skin and density axes are gone for good. Neither the
// web app nor the e2e suite may name the retired attributes, dataset keys, stores or the density
// toggle. The theme axis is data-theme x data-mode, nothing else.
//
// The needles are built from fragments so that this file does not match itself.

import { describe, it, expect } from "vitest";

import { E2E_ROOT, SRC_ROOT, walkFiles } from "./design-source-files";

const dash = (a: string, b: string) => [a, b].join("-");
const dot = (a: string, b: string) => [a, b].join(".");
const SKIN = "sk" + "in";
const DENSITY = "dens" + "ity";

const NEEDLES: Array<{ label: string; re: RegExp }> = [
  { label: "skin attribute", re: new RegExp(dash("data", SKIN) + "(?![A-Za-z0-9_-])") },
  { label: "density attribute", re: new RegExp(dash("data", DENSITY) + "(?![A-Za-z0-9_-])") },
  { label: "skin dataset key", re: new RegExp(dot("dataset", SKIN) + "(?![A-Za-z0-9_])") },
  { label: "density dataset key", re: new RegExp(dot("dataset", DENSITY) + "(?![A-Za-z0-9_])") },
  { label: "skin store import", re: new RegExp(`stores/${SKIN}(?![A-Za-z0-9_-])`) },
  { label: "density store import", re: new RegExp(`stores/${DENSITY}(?![A-Za-z0-9_-])`) },
  { label: "density toggle", re: new RegExp("Dens" + "ityToggle") },
];

export function skinDensityHits(text: string): string[] {
  return NEEDLES.filter((n) => n.re.test(text)).map((n) => n.label);
}

const EXTENSIONS = [".ts", ".svelte", ".css", ".html", ".js", ".mjs"];
const WEB_FILES = walkFiles(SRC_ROOT, EXTENSIONS, { includeTests: true });
const E2E_FILES = walkFiles(E2E_ROOT, EXTENSIONS, { includeTests: true });

describe("Issue #842 AC-4 - no skin or density axis", () => {
  it("walks real trees (anti-vacuity)", () => {
    expect(WEB_FILES.length).toBeGreaterThan(50);
    expect(E2E_FILES.length).toBeGreaterThan(10);
    expect(WEB_FILES.some((f) => f.rel === "tokens.css")).toBe(true);
    expect(E2E_FILES.some((f) => f.rel.startsWith("tests/") && f.rel.endsWith(".spec.ts"))).toBe(
      true,
    );
    // The guard walks tests too, so it must see itself.
    expect(WEB_FILES.some((f) => f.rel === "__tests__/no-skin-density-842.test.ts")).toBe(true);
  });

  it("the matchers fire on the retired shapes (positive control)", () => {
    expect(skinDensityHits(`<html ${dash("data", SKIN)}="x">`)).toEqual(["skin attribute"]);
    expect(skinDensityHits(`[${dash("data", DENSITY)}="compact"] {}`)).toEqual([
      "density attribute",
    ]);
    expect(skinDensityHits(`el.${dot("dataset", SKIN)} = "x";`)).toEqual(["skin dataset key"]);
    expect(skinDensityHits(`el.${dot("dataset", DENSITY)} = "x";`)).toEqual([
      "density dataset key",
    ]);
    expect(skinDensityHits(`import { s } from "$stores/${SKIN}";`)).toEqual(["skin store import"]);
    expect(skinDensityHits(`import D from "./Dens${"ity"}Toggle.svelte";`)).toEqual([
      "density toggle",
    ]);
    expect(skinDensityHits('<html data-theme="salz" data-mode="dark">')).toEqual([]);
  });

  it("apps/web/src names no retired skin or density attribute, key, store or toggle", () => {
    const hits = WEB_FILES.flatMap((f) => skinDensityHits(f.text).map((h) => `${f.rel}: ${h}`));
    expect(hits).toEqual([]);
  });

  it("apps/e2e names no retired skin or density attribute, key, store or toggle", () => {
    const hits = E2E_FILES.flatMap((f) => skinDensityHits(f.text).map((h) => `${f.rel}: ${h}`));
    expect(hits).toEqual([]);
  });
});
