// Issue #546 — regression shield for the clock buttons ("Einstempeln" / "Ausstempeln", the loading
// spinner and the keyboard focus ring).
//
// Defect (measured in Chromium before the fix): a light label on a light 92 % fill = 1.00..1.19:1,
// and the loading spinner arc on the same fill = 1.00:1. Root cause: a PAGE rule composed its own
// colours for the card button and lost the cascade against the global `.btn-primary:hover` rule.
//
// Since #845 the clock lives in the Stage block and its buttons are the global `.btn` / `.btn-primary`
// recipes, whose label contrast in all six theme x mode combinations is pinned by
// `btn-primary-contrast-840.test.ts`. The shield therefore proves, from the stylesheets themselves,
// that nothing can reintroduce the defect class:
//   1. markup   - exactly one primary stage button (label + spinner), the others plain `.btn`;
//   2. cascade  - neither the page's `<style>` nor the Stage block declares a colour, fill, border
//                 colour, outline or shadow for a button, so no page/block rule can beat the recipe;
//   3. spinner  - the page's spinner draws in `currentColor`, i.e. with the label's proven contrast,
//                 on every button it sits in (the old `--brand-ink` arc vanished on a light surface).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import postcss from "postcss";
import { describe, expect, it } from "vitest";

function readSource(url: URL, fallback: string): string {
  try {
    return readFileSync(fileURLToPath(url), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), fallback), "utf8");
  }
}

const PAGE = readSource(
  new URL("../../../routes/(app)/dashboard/+page.svelte", import.meta.url),
  "src/routes/(app)/dashboard/+page.svelte",
);
const STAGE = readSource(
  new URL("../../components/ui/Stage.svelte", import.meta.url),
  "src/lib/components/ui/Stage.svelte",
);
const DAY_STATE = readSource(
  new URL("../day-state.ts", import.meta.url),
  "src/lib/dashboard/day-state.ts",
);

function styleOf(source: string): string {
  const blocks = [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  expect(blocks).toHaveLength(1);
  return blocks[0];
}

interface Decl {
  selector: string;
  prop: string;
  value: string;
}
function declarations(css: string): Decl[] {
  const out: Decl[] = [];
  postcss.parse(css).walkDecls((d) => {
    const rule = d.parent as postcss.Rule;
    if (rule?.type === "rule") out.push({ selector: rule.selector, prop: d.prop, value: d.value });
  });
  return out;
}

const PAGE_DECLS = declarations(styleOf(PAGE));
const STAGE_DECLS = declarations(styleOf(STAGE));

/** The stage actions snippet of the page (where the clock buttons live). */
const ACTIONS = (() => {
  const stage = PAGE.indexOf("<Stage ");
  const start = PAGE.indexOf("{#snippet actions()}", stage);
  const end = PAGE.indexOf("{/snippet}", start);
  expect(stage).toBeGreaterThan(-1);
  expect(start).toBeGreaterThan(stage);
  return PAGE.slice(start, end);
})();
const BUTTONS = [...ACTIONS.matchAll(/<button\b([\s\S]*?)>([\s\S]*?)<\/button\s*>/g)].map((m) => ({
  classes: /\sclass="([^"]*)"/.exec(m[1])?.[1].split(/\s+/).filter(Boolean) ?? [],
  body: m[2],
}));

const PAINT =
  /^(color|background|background-color|background-image|border-color|outline|outline-color|box-shadow)$/;
const BUTTONISH = /(^|[\s>+~(,])(button|\.btn(-primary)?|\.stage-actions)\b/;

describe("clock buttons (Issue #546) - markup", () => {
  it("parses real CSS and finds the stage buttons (anti-vacuity)", () => {
    expect(PAGE_DECLS.length).toBeGreaterThan(200);
    expect(STAGE_DECLS.length).toBeGreaterThan(5);
    expect(BUTTONS.length).toBeGreaterThanOrEqual(3);
  });

  it("renders exactly one primary button with the label and the spinner", () => {
    const primaries = BUTTONS.filter((b) => b.classes.includes("btn-primary"));
    expect(primaries).toHaveLength(1);
    expect(primaries[0].body).toContain("{primaryLabel}");
    expect(primaries[0].body).toMatch(
      /\{#if clockLoading\}\s*<span class="btn-spinner"><\/span>\s*\{\/if\}/,
    );
    expect(primaries[0].classes).toEqual(["btn", "btn-primary"]);
  });

  it("every other stage button is a global recipe (outline, or primary only while a break runs)", () => {
    const others = BUTTONS.filter((x) => !x.classes.includes("btn-primary"));
    for (const b of others) {
      // the break toggle composes its variant through class: directives (checked below)
      expect(b.classes).toEqual(
        b.classes.includes("btn-outline") ? ["btn", "btn-outline"] : ["btn"],
      );
    }
    const toggle = [...ACTIONS.matchAll(/<button\b([\s\S]*?)>/g)]
      .map((m) => m[1])
      .find((open) => open.includes("onclick={handleBreakToggle}"));
    expect(toggle).toContain("class:btn-primary={breakStartedAt}");
    expect(toggle).toContain("class:btn-outline={!breakStartedAt}");
  });

  it("primaryClockLabel can only return the two labels the CTA renders", () => {
    expect(DAY_STATE).toContain(
      'primaryClockLabel(day: DayState): "Einstempeln" | "Ausstempeln" | null',
    );
  });
});

describe("clock buttons (Issue #546) - cascade", () => {
  it("no page rule paints a button: the global recipe cannot be out-specified from here", () => {
    const offenders = PAGE_DECLS.filter((d) => PAINT.test(d.prop) && BUTTONISH.test(d.selector));
    expect(offenders).toEqual([]);
  });

  it("the Stage block sizes its buttons and paints none of them", () => {
    const sized = STAGE_DECLS.filter((d) => /stage-actions/.test(d.selector));
    expect(sized.some((d) => d.prop === "min-height")).toBe(true); // positive control
    expect(sized.filter((d) => PAINT.test(d.prop))).toEqual([]);
  });

  it("the matcher would catch a painting rule (positive control)", () => {
    const probe = declarations(".stage-actions :global(button) { color: white; }");
    expect(probe.filter((d) => PAINT.test(d.prop) && BUTTONISH.test(d.selector))).toHaveLength(1);
  });
});

describe("clock buttons (Issue #546) - spinner", () => {
  it("the spinner arc draws in currentColor, so it carries the label's contrast", () => {
    const spinner = PAGE_DECLS.filter((d) => d.selector === ".btn-spinner");
    const top = spinner.find((d) => d.prop === "border-top-color");
    const ring = spinner.find((d) => d.prop === "border");
    expect(top?.value).toBe("currentColor");
    expect(ring?.value).toMatch(/color-mix\(in srgb, currentColor \d+%, transparent\)/);
    expect(spinner.map((d) => d.value).join(" ")).not.toMatch(
      /--brand-ink|#[0-9a-f]{3,6}\b|white/i,
    );
  });
});
