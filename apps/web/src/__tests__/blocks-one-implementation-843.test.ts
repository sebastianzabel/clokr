// Issue #843 (AC-1, D-843-01, D-843-03, D-843-21) - every design-system block exists ONCE.
//
// The legacy names (PageHead, MonthBar, PeriodSwitcher, KPIStat, Modal, ConfirmDialog, ReasonDialog)
// are delegates of the new blocks and carry no markup of their own for the part the block owns.
// Responsive behaviour of the blocks lives in container queries at exactly two widths, and the
// only viewport width queries among the block files are the Dialog -> Sheet switch and the one
// named exception of the period picker. Every matcher below is proven on in-memory fixtures, and
// every walk states a non-empty floor, so a moved directory turns the guard red.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CONTAINER_NARROW_PX, CONTAINER_WIDE_PX } from "$lib/components/ui/breakpoints";
import { SRC_ROOT, svelteStyleBlocks, walkFiles } from "./design-source-files";

const COMPONENTS = join(SRC_ROOT, "lib/components");
const UI_FILES = walkFiles(join(COMPONENTS, "ui"), [".svelte"], { includeTests: false });
const DEMOS = walkFiles(join(SRC_ROOT, "routes/(app)/admin/bausteine/demos"), [".svelte"], {
  includeTests: false,
});

function source(rel: string): string {
  return readFileSync(join(COMPONENTS, rel), "utf8");
}

/** The template of a Svelte file: no script, no style, no comment. */
export function markupOf(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

/** The CSS of a Svelte file without its comments. */
export function cssOf(text: string): string {
  return svelteStyleBlocks(text)
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

/** True when the template carries an element (or a class: directive) named `scrim`. */
export function rendersScrim(text: string): boolean {
  const markup = markupOf(text);
  return /class\s*=\s*["'{][^"'}]*\bscrim\b/.test(markup) || /class:scrim\b/.test(markup);
}

/** Every `@container` condition with the lengths it names. */
export function containerConditions(css: string): Array<{ condition: string; lengths: string[] }> {
  return [...css.matchAll(/@container\b([^{]*)\{/g)].map((m) => ({
    condition: m[1].trim(),
    lengths: [...m[1].matchAll(/-?\d+(?:\.\d+)?[a-z%]+/g)].map((l) => l[0]),
  }));
}

/** True when the CSS holds a viewport media query on the width (a range or a min/max feature). */
export function hasViewportWidthQuery(css: string): boolean {
  return [...css.matchAll(/@media\b([^{]*)\{/g)].some(
    ([, query]) =>
      /\(\s*(?:min-|max-)?width\s*[:<>=]/.test(query) ||
      /[<>]=?\s*(?:min-|max-)?width\b/.test(query),
  );
}

describe("blocks-one-implementation-843 - the matchers can fail (positive controls)", () => {
  it("rendersScrim finds a scrim element and ignores a comment or a style rule", () => {
    expect(rendersScrim('<div class="scrim" role="presentation"></div>')).toBe(true);
    expect(rendersScrim('<div class="a scrim"></div>')).toBe(true);
    expect(rendersScrim("<div class:scrim={open}></div>")).toBe(true);
    expect(rendersScrim("<!-- a click on the scrim -->\n<div></div>")).toBe(false);
    expect(rendersScrim("<style>.scrim { color: red; }</style><div></div>")).toBe(false);
  });

  it("containerConditions reads the lengths of a condition", () => {
    const found = containerConditions("@container (min-width: 760px) { a { b: c } }");
    expect(found).toEqual([{ condition: "(min-width: 760px)", lengths: ["760px"] }]);
    expect(containerConditions("@container (width > 40em) { a { b: c } }")[0].lengths).toEqual([
      "40em",
    ]);
  });

  it("hasViewportWidthQuery sees width queries only", () => {
    expect(hasViewportWidthQuery("@media (max-width: 640px) { a { b: c } }")).toBe(true);
    expect(hasViewportWidthQuery("@media (width < 640px) { a { b: c } }")).toBe(true);
    expect(hasViewportWidthQuery("@media (prefers-reduced-motion: reduce) { a { b: c } }")).toBe(
      false,
    );
    expect(hasViewportWidthQuery("@media (pointer: coarse) { a { b: c } }")).toBe(false);
  });
});

describe("blocks-one-implementation-843 - delegates only (D-843-01, D-843-14)", () => {
  it("PageHead renders PageHeader and holds no h1 of its own", () => {
    const markup = markupOf(source("layout/PageHead.svelte"));
    expect(markup).toContain("<PageHeader");
    expect(markup).not.toContain("<h1");
  });

  it.each(["MonthBar", "PeriodSwitcher"])("%s renders PeriodPicker and no nav markup", (name) => {
    const markup = markupOf(source(`ui/${name}.svelte`));
    expect(markup).toContain("<PeriodPicker");
    expect(markup).not.toContain("<nav");
  });

  it("KPIStat renders KpiCell", () => {
    expect(markupOf(source("ui/KPIStat.svelte"))).toContain("<KpiCell");
  });

  it.each(["Modal", "ConfirmDialog", "ReasonDialog"])("%s carries no overlay markup", (name) => {
    expect(rendersScrim(source(`ui/${name}.svelte`))).toBe(false);
  });

  it("the overlay exists once: Dialog renders the scrim", () => {
    // The control of the three assertions above - the matcher does see a real scrim.
    expect(rendersScrim(source("ui/Dialog.svelte"))).toBe(true);
  });
});

describe("blocks-one-implementation-843 - container breakpoints (D-843-03)", () => {
  // `max-width: 759.98px` is the exclusive complement of `min-width: 760px` (the same boundary
  // written for a max-width condition), so it counts as the 760 breakpoint.
  const ALLOWED = new Set([
    `${CONTAINER_NARROW_PX}px`,
    `${CONTAINER_WIDE_PX}px`,
    `${CONTAINER_NARROW_PX - 0.02}px`,
    `${CONTAINER_WIDE_PX - 0.02}px`,
  ]);

  it("walks the ui directory (non-vacuity floor)", () => {
    expect(UI_FILES.length).toBeGreaterThanOrEqual(30);
  });

  it("every @container condition in lib/components/ui uses 760 px or 1100 px only", () => {
    const found = UI_FILES.flatMap((file) =>
      containerConditions(cssOf(file.text)).map((c) => ({ file: file.rel, ...c })),
    );
    // At least one container condition exists (the blocks do use them), else this proves nothing.
    expect(found.length).toBeGreaterThanOrEqual(5);
    const offenders = found.filter((c) => c.lengths.some((l) => !ALLOWED.has(l)));
    expect(offenders).toEqual([]);
    // Each length is a width condition at all (a condition with no length would pass vacuously).
    expect(found.filter((c) => c.lengths.length === 0)).toEqual([]);
  });

  it("the guard rejects a stray breakpoint (negative control)", () => {
    const stray = containerConditions("@container (min-width: 800px) { a { b: c } }");
    expect(stray.some((c) => c.lengths.some((l) => !ALLOWED.has(l)))).toBe(true);
  });
});

describe("blocks-one-implementation-843 - viewport width queries among the block files", () => {
  // The block files are the entries every demo file names (the page's block registry), svelte
  // files only (motion/index.ts is a module).
  const entries = [
    ...new Set(
      DEMOS.flatMap((demo) => {
        const list = /entries:\s*\[([\s\S]*?)\]/.exec(demo.text)?.[1] ?? "";
        return [...list.matchAll(/"([^"]+\.svelte)"/g)].map((m) => m[1]);
      }),
    ),
  ].sort();

  // D-843-21: the period picker keeps the viewport rules of MonthBar verbatim - a container on
  // `.month-bar` collapses inside content-sized flex parents and the #553/#564 narrow-viewport spec
  // measures the viewport. Dialog.svelte holds the Dialog -> Sheet switch (D-843-03).
  const EXEMPT: Record<string, string> = {
    "components/ui/Dialog.svelte": "Dialog to Sheet switch (D-843-03)",
    "components/ui/PeriodPicker.svelte": "viewport rules of MonthBar kept verbatim (D-843-21)",
  };

  it("finds the block files of all twelve blocks (non-vacuity floor)", () => {
    expect(DEMOS.length).toBeGreaterThanOrEqual(12);
    expect(entries.length).toBeGreaterThanOrEqual(25);
  });

  it("only the two exempt files hold a viewport width query", () => {
    const withQuery = entries.filter((entry) =>
      hasViewportWidthQuery(cssOf(readFileSync(join(SRC_ROOT, "lib", entry), "utf8"))),
    );
    expect(withQuery.sort()).toEqual(Object.keys(EXEMPT).sort());
  });
});
