// Issue #843 (D-843-12, #636) - every text pair of a status recipe reaches 4.5:1 in all six
// combinations.
//
// token-contrast-842 proves the ROLE pairs. This file proves that the recipes actually use proven
// pairs: it reads the real declarations of the badge, chip, note, eyebrow, toast, KPI band and
// Stage rules (app.css and the `<style>` blocks of the block components), takes the `color` and
// the `background` of each recipe, resolves both per combination through the one cascade resolver
// (`token-css.ts` over `token-cascade.ts`) and checks the WCAG contrast. A translucent background
// is composited over the card surface, a recipe without a background of its own is measured on
// the surfaces it is placed on (listed per recipe).
//
// The threshold is never lowered: a failing recipe is fixed in the owning file. A negative
// control at the bottom proves the checker can fail, and floors prove it did not run over an
// empty recipe list.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

import { SRC_ROOT, svelteStyleBlocks } from "./design-source-files";
import {
  COMBINATION_NAMES,
  cardSurface,
  contrast,
  over,
  readAppCss,
  readTokensCss,
  resolveColor,
  type CombinationName,
} from "./token-css";

const TOKENS = readTokensCss();
const FLOOR = 4.5;

const APP = "app.css";
const UI = "lib/components/ui";
const PAGE_HEADER = `${UI}/PageHeader.svelte`;
const DIALOG = `${UI}/Dialog.svelte`;
const PERIOD_PICKER = `${UI}/PeriodPicker.svelte`;
const TOAST_ITEM = `${UI}/ToastItem.svelte`;
const KPI_STRIP = `${UI}/KpiStrip.svelte`;
const KPI_CELL = `${UI}/KpiCell.svelte`;
const STAGE = `${UI}/Stage.svelte`;

interface RuleRef {
  /** Path relative to apps/web/src. */
  file: string;
  /** One selector of the rule, exactly as written (whitespace normalised). */
  selector: string;
}

interface Recipe {
  name: string;
  /** Rules merged in order: a later declaration of `color` / `background` wins. */
  rules: RuleRef[];
  /** Role names the text sits on when no rule declares a background of its own. */
  surfaces?: string[];
}

type CssSource = (file: string) => string[];

/** The CSS chunks of a source file: app.css whole, a Svelte file's `<style>` blocks. */
const readCss: CssSource = (file) => {
  if (file === APP) return [readAppCss()];
  return svelteStyleBlocks(readFileSync(join(SRC_ROOT, file), "utf8"));
};

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Splits a selector list at the commas outside parentheses (`:is(h1, h2)` stays whole). */
export function splitSelectorList(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(norm(current));
      current = "";
    } else current += ch;
  }
  out.push(norm(current));
  return out;
}

interface Painted {
  color?: string;
  background?: string;
}

/** `color` and `background` declared by the top-level rules naming `selector`, in source order. */
export function paintOf(chunks: string[], selector: string): Painted {
  const painted: Painted = {};
  let matched = 0;
  for (const chunk of chunks) {
    postcss.parse(chunk).each((node) => {
      if (node.type !== "rule") return;
      if (!splitSelectorList(node.selector).includes(selector)) return;
      matched++;
      node.each((decl) => {
        if (decl.type !== "decl") return;
        const value = decl.value.trim();
        if (decl.prop === "color") painted.color = value;
        // `transparent` / `none` / `inherit` paint nothing: the surface behind stays the background.
        if (
          (decl.prop === "background" || decl.prop === "background-color") &&
          !/^(?:transparent|none|inherit|initial|unset)$/i.test(value)
        ) {
          painted.background = value;
        }
      });
    });
  }
  if (matched === 0) throw new Error(`selector not found: ${selector}`);
  return painted;
}

interface Failure {
  recipe: string;
  combination: CombinationName;
  ratio: number;
}

interface Measured {
  pairs: number;
  failures: Failure[];
}

/** Measures one recipe in all six combinations. */
export function measure(recipe: Recipe, css: CssSource): Measured {
  let color: string | undefined;
  let background: string | undefined;
  for (const rule of recipe.rules) {
    const painted = paintOf(css(rule.file), rule.selector);
    if (painted.color !== undefined) color = painted.color;
    if (painted.background !== undefined) background = painted.background;
  }
  if (color === undefined) throw new Error(`${recipe.name}: no text colour found`);
  const backgrounds: Array<{ label: string; value: string }> = background
    ? [{ label: "", value: background }]
    : (recipe.surfaces ?? []).map((s) => ({ label: ` on ${s}`, value: `var(--${s})` }));
  if (backgrounds.length === 0) throw new Error(`${recipe.name}: no background and no surface`);

  const failures: Failure[] = [];
  let pairs = 0;
  for (const { label, value } of backgrounds) {
    for (const combination of COMBINATION_NAMES) {
      const back = over(resolveColor(TOKENS, combination, value), cardSurface(TOKENS, combination));
      const text = over(resolveColor(TOKENS, combination, color), back);
      const ratio = contrast(text, back);
      pairs++;
      if (ratio < FLOOR) failures.push({ recipe: `${recipe.name}${label}`, combination, ratio });
    }
  }
  return { pairs, failures };
}

const print = (failures: Failure[]) =>
  failures.map((f) => `${f.recipe} · ${f.combination} · ${f.ratio.toFixed(2)}`);

// ── The recipes ──────────────────────────────────────────────────────────────────────────────

const TONES_CHIP = ["neutral", "ok", "good", "warn", "bad", "info", "brand"] as const;
const TONES_NOTE = ["ok", "warn", "bad", "info", "brand"] as const;
const BADGES = ["green", "yellow", "red", "blue", "purple", "gray", "orange"] as const;

const RECIPES: Recipe[] = [
  // Badges (app.css): each rule is a complete colour pair.
  ...BADGES.map((tone) => ({
    name: `.badge-${tone}`,
    rules: [{ file: APP, selector: `.badge-${tone}` }],
  })),

  // Chips: the base recipe plus a tone.
  ...TONES_CHIP.map((tone) => ({
    name: `.chip-${tone}`,
    rules: [
      { file: APP, selector: ".chip" },
      { file: APP, selector: `.chip-${tone}` },
    ],
  })),

  // Notes: the base recipe alone and with each tone.
  { name: ".note", rules: [{ file: APP, selector: ".note" }] },
  ...TONES_NOTE.map((tone) => ({
    name: `.note-${tone}`,
    rules: [
      { file: APP, selector: ".note" },
      { file: APP, selector: `.note-${tone}` },
    ],
  })),

  // Eyebrows: brand-coloured lines on the page or the card they are placed on.
  // Phase 851: the PageHeader eyebrow is gone (owner acceptance 09.11.2026); its title is measured below.
  {
    name: ".serif-eyebrow",
    rules: [{ file: APP, selector: ".serif-eyebrow" }],
    surfaces: ["bg", "card"],
  },
  {
    name: ".modal-eyebrow",
    rules: [{ file: DIALOG, selector: ".modal-eyebrow" }],
    surfaces: ["card"],
  },
  {
    name: ".month-bar-eyebrow",
    rules: [{ file: PERIOD_PICKER, selector: ".month-bar-eyebrow" }],
    surfaces: ["bg", "card"],
  },

  // The rest of the page head text.
  {
    name: ".page-head .sub",
    rules: [{ file: PAGE_HEADER, selector: ".page-head .sub" }],
    surfaces: ["bg", "card"],
  },
  {
    // Phase 851: the accent word inherits the title colour, so the title itself is the pair.
    name: ".page-head title",
    rules: [{ file: PAGE_HEADER, selector: ".page-head :is(h1, h2)" }],
    surfaces: ["bg", "card"],
  },

  // Toast item: the inverse surface (text colour as fill, card colour as text).
  { name: ".toast", rules: [{ file: TOAST_ITEM, selector: ".toast" }] },
  {
    name: ".toast-icon",
    rules: [
      { file: TOAST_ITEM, selector: ".toast" },
      { file: TOAST_ITEM, selector: ".toast-icon" },
    ],
  },
  {
    name: ".toast-close",
    rules: [
      { file: TOAST_ITEM, selector: ".toast" },
      { file: TOAST_ITEM, selector: ".toast-close" },
    ],
  },

  // Stage: the three states of the clock stage.
  { name: ".stage", rules: [{ file: STAGE, selector: ".stage" }] },
  {
    name: ".stage arbeitet",
    rules: [
      { file: STAGE, selector: ".stage" },
      { file: STAGE, selector: '.stage[data-state="arbeitet"]' },
    ],
  },
  {
    name: ".stage pause",
    rules: [
      { file: STAGE, selector: ".stage" },
      { file: STAGE, selector: '.stage[data-state="pause"]' },
    ],
  },
];

// KPI cells: the text roles of a cell on the plain strip (card) and on the tinted band.
const KPI_TEXT: Array<[string, RuleRef[]]> = [
  ["label", [{ file: APP, selector: ".kpi-label" }]],
  ["value", [{ file: APP, selector: ".kpi-value" }]],
  ["unit", [{ file: APP, selector: ".kpi-unit" }]],
  ["delta", [{ file: APP, selector: ".kpi-delta" }]],
  [
    "delta-good",
    [
      { file: APP, selector: ".kpi-delta" },
      { file: APP, selector: ".kpi-delta-good" },
    ],
  ],
  [
    "delta-bad",
    [
      { file: APP, selector: ".kpi-delta" },
      { file: APP, selector: ".kpi-delta-bad" },
    ],
  ],
  [
    "delta-warn",
    [
      { file: APP, selector: ".kpi-delta" },
      { file: APP, selector: ".kpi-delta-warn" },
    ],
  ],
  ["explanation", [{ file: KPI_CELL, selector: ".kpi-explanation" }]],
  ["derivation", [{ file: KPI_CELL, selector: ".kpi-derivation" }]],
  ["progress-label", [{ file: KPI_CELL, selector: ".kpi-progress-label" }]],
];
for (const [role, rules] of KPI_TEXT) {
  RECIPES.push({ name: `.kpi-${role} on the strip`, rules, surfaces: ["card"] });
  // The band declares the tint as a background and re-colours the label (text-2) on top of it.
  const bandRules: RuleRef[] = [
    { file: KPI_STRIP, selector: ".kpi-strip--band" },
    ...rules,
    ...(role === "label"
      ? [{ file: KPI_STRIP, selector: ".kpi-strip--band :global(.kpi-label)" }]
      : []),
  ];
  RECIPES.push({ name: `.kpi-${role} on the band`, rules: bandRules });
}

// ── Tests ────────────────────────────────────────────────────────────────────────────────────

describe("recipe-contrast-843 - anti-vacuity", () => {
  it("finds the recipes and measures a healthy number of pairs", () => {
    expect(COMBINATION_NAMES).toHaveLength(6);
    expect(RECIPES.length).toBeGreaterThanOrEqual(15);
    const pairs = RECIPES.reduce((sum, r) => sum + measure(r, readCss).pairs, 0);
    // Every recipe is measured in six combinations; the surface lists add more.
    expect(pairs).toBeGreaterThanOrEqual(15 * 6);
  });

  it("covers every recipe family the plan names", () => {
    const names = RECIPES.map((r) => r.name).join("\n");
    for (const family of [".badge-", ".chip-", ".note", "eyebrow", ".toast", ".kpi-", ".stage"]) {
      expect(names, family).toContain(family);
    }
  });

  it("splits a selector list at the commas outside parentheses", () => {
    expect(splitSelectorList(".a :is(h1, h2) em, .b")).toEqual([".a :is(h1, h2) em", ".b"]);
  });

  it("fails loudly on a selector that no rule names", () => {
    expect(() => paintOf(["a { color: red; }"], ".gone")).toThrow(/selector not found/);
  });
});

describe.each(RECIPES.map((r) => [r.name, r] as const))("%s", (_name, recipe) => {
  it("reaches 4.5:1 in all six combinations", () => {
    expect(print(measure(recipe, readCss).failures)).toEqual([]);
  });
});

describe("recipe-contrast-843 - negative control (the checker can fail)", () => {
  // A border role used as text colour and the honey accent used as text colour: both are below
  // 4.5:1 on the card in every combination (the accent is a fill, D-842-07).
  const fixture: CssSource = () => [
    ".border-text { color: var(--line); background: var(--card); }",
    ".accent-text { color: var(--accent); background: var(--card); }",
    ".sound { color: var(--text); background: var(--card); }",
  ];

  it("reports a border role as text with recipe, combination and ratio, in all six", () => {
    const { failures, pairs } = measure(
      { name: ".border-text", rules: [{ file: "fixture", selector: ".border-text" }] },
      fixture,
    );
    expect(pairs).toBe(6);
    expect(failures).toHaveLength(6);
    expect(print([failures[0]])[0]).toMatch(/^\.border-text · pflaume-light · \d\.\d\d$/);
  });

  it("reports --accent used as a text colour", () => {
    const { failures } = measure(
      { name: ".accent-text", rules: [{ file: "fixture", selector: ".accent-text" }] },
      fixture,
    );
    expect(failures.length).toBeGreaterThan(0);
  });

  it("passes a proven pair", () => {
    const { failures, pairs } = measure(
      { name: ".sound", rules: [{ file: "fixture", selector: ".sound" }] },
      fixture,
    );
    expect(pairs).toBe(6);
    expect(failures).toEqual([]);
  });
});
