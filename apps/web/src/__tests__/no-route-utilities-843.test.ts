// Issue #843, plan 03 (D-843-02) - no Tailwind utility classes in route files.
//
// Tailwind runs as a token pipeline only (tailwind-theme.css scans lib/components/ui and nothing
// else), so a utility class in a route file would style nothing in production - and tempt the next
// author to rely on it. A token counts as a utility when Tailwind's own engine emits a rule for it;
// it is a violation when no stylesheet or `<style>` block of the project declares the same class.
// A page-own class that merely shares a utility name (`.table`, `.hidden`) is declared in app.css or
// in the file's own style and passes.
//
// The engine here is a superset on purpose: the default Tailwind theme (spacing, type scale,
// palette) plus the mapped roles of the real tailwind-theme.css block, WITHOUT its `initial`
// resets. The production theme resets the defaults, so `p-4` emits nothing there; the guard still
// has to recognise it as the utility a developer meant.
//
// Anti-vacuity: the route walk has a floor, the engine is proven by positive controls, and the
// classification is proven by negative controls.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { compile } from "tailwindcss";
import { beforeAll, describe, expect, it } from "vitest";

import { extractEmittedClasses, extractScopedClasses } from "../../scripts/lib/class-tokens.mjs";
import { SRC_ROOT, walkFiles } from "./design-source-files";

const ROUTE_FILE_FLOOR = 50;

const read = (rel: string) => readFileSync(resolve(SRC_ROOT, rel), "utf8");

/** Class names a stylesheet mentions in any selector (the same reading lint:ui-classes uses). */
function declaredClasses(css: string): Set<string> {
  const out = new Set<string>();
  for (const m of css.matchAll(/\.([a-zA-Z_-][a-zA-Z0-9_-]*)/g)) out.add(m[1]);
  return out;
}

/** The text between the braces of the `@theme inline { … }` block of tailwind-theme.css. */
function themeBlockWithoutResets(): string {
  const plain = read("tailwind-theme.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const m = /@theme\s+inline\s*\{([^}]*)\}/.exec(plain);
  if (!m) throw new Error("tailwind-theme.css has no @theme inline block");
  return m[1].replace(/--(?:color|radius)-\*\s*:\s*initial\s*;/g, "");
}

let isUtility: (token: string) => boolean;

beforeAll(async () => {
  const defaultTheme = readFileSync(
    resolve(process.cwd(), "node_modules/tailwindcss/theme.css"),
    "utf8",
  );
  const compiler = await compile(
    `${defaultTheme}\n@tailwind utilities;\n@theme inline {${themeBlockWithoutResets()}}`,
  );
  const cache = new Map<string, boolean>();
  isUtility = (token) => {
    let hit = cache.get(token);
    if (hit === undefined) {
      // A rule for the class itself (not the `:root` variables the engine adds for the theme).
      const selector = new RegExp(`(?:^|\\n)\\.${token}[\\s{:,>~+.[]`);
      hit = selector.test(compiler.build([token]));
      cache.set(token, hit);
    }
    return hit;
  };
});

interface Hit {
  file: string;
  token: string;
}

/** Utility tokens a Svelte source emits that neither the global sheets nor its own style declare. */
function utilityHits(file: string, text: string, globals: Set<string>): Hit[] {
  const own = extractScopedClasses(text);
  const hits: Hit[] = [];
  for (const token of extractEmittedClasses(text)) {
    if (globals.has(token) || own.has(token)) continue;
    if (isUtility(token)) hits.push({ file, token });
  }
  return hits;
}

const globals = new Set([
  ...declaredClasses(read("app.css")),
  ...declaredClasses(read("tokens.css")),
]);

describe("no Tailwind utility classes in route files (D-843-02)", () => {
  it("walks a real set of route files (anti-vacuity floor)", () => {
    const routes = walkFiles(join(SRC_ROOT, "routes"), [".svelte"], { includeTests: false });
    expect(routes.length).toBeGreaterThanOrEqual(ROUTE_FILE_FLOOR);
  });

  it("finds no utility class without a recipe in any route file", () => {
    const routes = walkFiles(join(SRC_ROOT, "routes"), [".svelte"], { includeTests: false });
    // Floor on the harvest too: the extractor really reads class tokens out of the walked files.
    const harvested = new Set(routes.flatMap((f) => [...extractEmittedClasses(f.text)]));
    expect(harvested.size).toBeGreaterThanOrEqual(500);
    const hits = routes.flatMap((f) => utilityHits(f.rel, f.text, globals));
    expect(hits.map((h) => `${h.file}: ${h.token}`)).toEqual([]);
  });

  it("positive control: a route body with three utilities is flagged three times", () => {
    const body = `<div class="flex p-4 bg-brand">x</div>`;
    expect(
      utilityHits("fixture.svelte", body, globals)
        .map((h) => h.token)
        .sort(),
    ).toEqual(["bg-brand", "flex", "p-4"]);
  });

  it("positive control: class directives and string parts of interpolations are read too", () => {
    const body = `<div class="card {open ? 'hidden' : ''}" class:inline-flex={wide}></div>`;
    const tokens = utilityHits("fixture.svelte", body, globals).map((h) => h.token);
    expect(tokens).toContain("hidden");
    expect(tokens).toContain("inline-flex");
  });

  it("negative control: a page-own class that shares a utility name passes", () => {
    const body = `<table class="table"></table>\n<style>\n  .table { width: 100%; }\n</style>`;
    expect(isUtility("table")).toBe(true);
    expect(utilityHits("fixture.svelte", body, globals)).toEqual([]);
  });

  it("negative control: a global recipe of app.css passes (sr-only)", () => {
    expect(isUtility("sr-only")).toBe(true);
    expect(globals.has("sr-only")).toBe(true);
    expect(utilityHits("fixture.svelte", `<span class="sr-only">x</span>`, globals)).toEqual([]);
  });

  it("negative control: a :global() declaration in the file's own style passes", () => {
    const body = `<div class="flex"></div>\n<style>\n  :global(.flex) { display: flex; }\n</style>`;
    expect(utilityHits("fixture.svelte", body, globals)).toEqual([]);
  });

  it("negative control: a class that is no utility is not flagged", () => {
    expect(isUtility("kpi-strip-xyz")).toBe(false);
    expect(utilityHits("fixture.svelte", `<div class="kpi-strip-xyz"></div>`, globals)).toEqual([]);
  });
});
