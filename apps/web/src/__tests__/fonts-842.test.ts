// Issue #842, plan 17 (D-842-15, AC-3) — the type system is Figtree (UI) and JetBrains Mono (code
// only), both self-hosted. No retired family is loaded or named anywhere: not in app.html, not in
// any CSS, Svelte or TypeScript source of src, not as a file in static/fonts. Every Figtree face of
// tokens.css points at a file that exists on disk, so a renamed or deleted woff2 turns this red
// instead of silently falling back to a system font.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { SRC_ROOT, WEB_ROOT, walkFiles } from "./design-source-files";

// Family names that left with the redesign. Spelled as plain data: this file lives under
// __tests__, which the scan below skips.
const RETIRED_FAMILIES = ["Jost", "Cormorant", "Inter Tight", "DM Sans", "Fraunces"];
// The same names as they appear in file names (spaces become dashes or nothing).
const RETIRED_FILE_PATTERN = /jost|cormorant|inter-?tight|dm-?sans|fraunces/i;

export function retiredFamilyHits(text: string): string[] {
  return RETIRED_FAMILIES.filter((name) =>
    new RegExp(`(?<![A-Za-z0-9_-])${name}(?![A-Za-z0-9_-])`).test(text),
  );
}

const SOURCES = walkFiles(SRC_ROOT, [".css", ".svelte", ".ts", ".js"], { includeTests: false });
const APP_HTML = readFileSync(join(SRC_ROOT, "app.html"), "utf8");
const TOKENS_CSS = readFileSync(join(SRC_ROOT, "tokens.css"), "utf8");
const FONT_DIR = join(WEB_ROOT, "static", "fonts");

describe("Issue #842 AC-3 - fonts", () => {
  it("walks a real source tree (anti-vacuity)", () => {
    expect(SOURCES.length).toBeGreaterThan(50);
    expect(SOURCES.some((f) => f.rel === "tokens.css")).toBe(true);
    expect(SOURCES.some((f) => f.rel === "app.css")).toBe(true);
    expect(SOURCES.some((f) => f.rel.includes("__tests__"))).toBe(false);
  });

  it("the matcher fires on a retired family (positive control)", () => {
    expect(retiredFamilyHits('font-family: "Jost", sans-serif;')).toEqual(["Jost"]);
    expect(retiredFamilyHits("font-family: 'Cormorant Garamond', serif;")).toEqual(["Cormorant"]);
    expect(retiredFamilyHits('font-family: "Inter Tight";')).toEqual(["Inter Tight"]);
    expect(retiredFamilyHits('font-family: "Figtree", system-ui;')).toEqual([]);
    expect(retiredFamilyHits("a word like Jostle is not a family")).toEqual([]);
    expect(RETIRED_FILE_PATTERN.test("jost-latin-400.woff2")).toBe(true);
    expect(RETIRED_FILE_PATTERN.test("figtree-latin-wght-normal.woff2")).toBe(false);
  });

  it("no retired family in app.html or any source file of src", () => {
    expect(retiredFamilyHits(APP_HTML), "app.html").toEqual([]);
    const hits = SOURCES.flatMap((f) =>
      retiredFamilyHits(f.text).map((name) => `${f.rel}: ${name}`),
    );
    expect(hits).toEqual([]);
  });

  it("static/fonts holds no file of a retired family", () => {
    const listing = readdirSync(FONT_DIR);
    expect(listing.length).toBeGreaterThan(0);
    expect(listing.filter((name) => RETIRED_FILE_PATTERN.test(name))).toEqual([]);
  });

  it("app.html loads no font from a CDN", () => {
    expect(APP_HTML).not.toMatch(/fonts\.googleapis|fonts\.gstatic|cdn\./i);
  });

  it("every Figtree @font-face url of tokens.css exists in static/fonts", () => {
    const faces = [...TOKENS_CSS.matchAll(/@font-face\s*\{([^}]*)\}/g)]
      .map((m) => m[1])
      .filter((body) => /font-family\s*:\s*["']Figtree["']/.test(body));
    expect(faces.length).toBeGreaterThanOrEqual(1);
    for (const body of faces) {
      const urls = [...body.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]);
      expect(urls.length).toBeGreaterThanOrEqual(1);
      for (const url of urls) {
        expect(url.startsWith("/fonts/"), url).toBe(true);
        expect(existsSync(join(FONT_DIR, url.slice("/fonts/".length))), url).toBe(true);
      }
    }
  });

  it("the preloaded font file exists", () => {
    const preload = /<link[^>]*rel="preload"[^>]*href="(\/fonts\/[^"]+)"/.exec(APP_HTML);
    expect(preload).not.toBeNull();
    expect(existsSync(join(FONT_DIR, preload![1].slice("/fonts/".length)))).toBe(true);
  });
});
