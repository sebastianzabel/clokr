// Issue #546 — regression shield for the dashboard clock card buttons ("Einstempeln" /
// "Ausstempeln", the loading spinner and the keyboard focus ring).
//
// Defect (measured in Chromium before the fix, editorial pflaume light, hover): white label on a
// 92 % white fill = 1.00..1.19:1, and the loading spinner arc (white) on the white fill = 1.00:1.
// Root cause: the primary card button composed the global `.btn-primary`, whose
// `.btn-primary:hover:not(:disabled)` (0,3,0) forced `color: #fff` and beat the card's own
// `.timer-card-wrap .timer-cta-primary` (0,2,0) colour; the modern skin layered more `.btn-primary`
// rules on top. After the fix (browser probe, 8 UI-selectable combinations x base/hover/focus/loading,
// idle and running fixture): label 6.31..12.11:1 in every state, focus ring 7.11..12.11:1 against its
// band, spinner arc 7.11..12.11:1 against the fill; the control element differs in every state.
//
// Why it reads SOURCE: no route page is mounted in this workspace (see dashboard-clock-card.test.ts
// for the precedent), and jsdom resolves neither custom properties nor `:hover`. The shield therefore
// proves two things from the stylesheets themselves:
//   1. cascade   - a card rule out-specifies EVERY app.css / tokens.css / page rule that can reach the
//                  button or its spinner, per state (so a new skin layer cannot silently win again);
//   2. contrast  - the tokens those winning rules reference, resolved per UI-selectable
//                  theme/mode/skin combination, give WCAG contrast (label >= 4.5, spinner arc >= 3,
//                  focus ring vs its band >= 3).
// The Svelte-compiled form of the page's scoped spinner rule, taken from the browser probe, is
// `.btn-spinner.svelte-<hash>` = (0,2,0); the page's scoped rules therefore count +(0,1,0) here.
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
const APP_CSS = readSource(new URL("../../../app.css", import.meta.url), "src/app.css");
const TOKENS_CSS = readSource(new URL("../../../tokens.css", import.meta.url), "src/tokens.css");
const THEME_TS = readSource(
  new URL("../../stores/theme.ts", import.meta.url),
  "src/lib/stores/theme.ts",
);
const ADMIN_THEMES = readSource(
  new URL("../../../routes/(app)/admin/themes/+page.svelte", import.meta.url),
  "src/routes/(app)/admin/themes/+page.svelte",
);
const DAY_STATE = readSource(
  new URL("../day-state.ts", import.meta.url),
  "src/lib/dashboard/day-state.ts",
);

// ── Selector specificity ────────────────────────────────────────────────────

type Spec = [number, number, number];

/** Replaces every Svelte `:global(...)` wrapper by its (paren-balanced) content. */
function unwrapGlobal(selector: string): string {
  let out = selector;
  for (;;) {
    const at = out.indexOf(":global(");
    if (at === -1) return out;
    const open = at + ":global".length;
    let depth = 0;
    let close = -1;
    for (let i = open; i < out.length; i++) {
      if (out[i] === "(") depth++;
      else if (out[i] === ")") {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) throw new Error(`Unbalanced :global( in ${selector}`);
    out = out.slice(0, at) + out.slice(open + 1, close) + out.slice(close + 1);
  }
}

/** True when the whole selector is exactly one `:global(...)` wrapper (a Svelte-unscoped rule). */
function isFullyGlobal(selector: string): boolean {
  const s = selector.trim();
  if (!s.startsWith(":global(")) return false;
  let depth = 0;
  for (let i = ":global".length; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) return i === s.length - 1;
    }
  }
  return false;
}

/** Splits at top-level combinators (whitespace, >, +, ~) outside () and []. */
function splitCompounds(selector: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let paren = 0;
  let bracket = 0;
  for (const ch of selector.trim()) {
    if (ch === "(") paren++;
    if (ch === ")") paren--;
    if (ch === "[") bracket++;
    if (ch === "]") bracket--;
    if (paren === 0 && bracket === 0 && /[\s>+~]/.test(ch)) {
      if (cur) parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

function splitTopLevelCommas(list: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  for (const ch of list) {
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

interface Compound {
  tag: string | null;
  ids: string[];
  classes: string[];
  attrs: string[];
  pseudos: { name: string; arg: string | null }[];
  pseudoElements: number;
}

function parseCompound(text: string): Compound {
  const c: Compound = {
    tag: null,
    ids: [],
    classes: [],
    attrs: [],
    pseudos: [],
    pseudoElements: 0,
  };
  let i = 0;
  const ident = () => {
    const m = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
    if (!m) return "";
    i += m[0].length;
    return m[0];
  };
  if (text[i] === "*") {
    c.tag = "*";
    i++;
  } else if (/[A-Za-z]/.test(text[i] ?? "")) {
    c.tag = ident();
  }
  while (i < text.length) {
    const ch = text[i];
    if (ch === "#") {
      i++;
      c.ids.push(ident());
    } else if (ch === ".") {
      i++;
      c.classes.push(ident());
    } else if (ch === "[") {
      const end = text.indexOf("]", i);
      c.attrs.push(text.slice(i + 1, end));
      i = end + 1;
    } else if (ch === ":") {
      if (text[i + 1] === ":") {
        i += 2;
        ident();
        c.pseudoElements++;
        continue;
      }
      i++;
      const name = ident();
      let arg: string | null = null;
      if (text[i] === "(") {
        let depth = 0;
        const start = i;
        for (; i < text.length; i++) {
          if (text[i] === "(") depth++;
          if (text[i] === ")") {
            depth--;
            if (depth === 0) {
              i++;
              break;
            }
          }
        }
        arg = text.slice(start + 1, i - 1);
      }
      if (["before", "after", "first-line", "first-letter"].includes(name)) c.pseudoElements++;
      else c.pseudos.push({ name, arg });
    } else {
      throw new Error(`Cannot parse compound selector "${text}" at ${i}`);
    }
  }
  return c;
}

const cmp = (a: Spec, b: Spec): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const add = (a: Spec, b: Spec): Spec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

function specificity(selector: string): Spec {
  let total: Spec = [0, 0, 0];
  for (const part of splitCompounds(unwrapGlobal(selector))) {
    const c = parseCompound(part);
    let s: Spec = [
      c.ids.length,
      c.classes.length + c.attrs.length,
      (c.tag && c.tag !== "*" ? 1 : 0) + c.pseudoElements,
    ];
    for (const p of c.pseudos) {
      if (p.name === "where") continue;
      if ((p.name === "not" || p.name === "is" || p.name === "has") && p.arg !== null) {
        const best = splitTopLevelCommas(p.arg)
          .map((a) => specificity(a))
          .sort(cmp)
          .pop()!;
        s = add(s, best);
      } else s = add(s, [0, 1, 0]);
    }
    total = add(total, s);
  }
  return total;
}

type State = "base" | "hover" | "focus";
const STATE_PSEUDOS: Record<State, string[]> = {
  base: [],
  hover: ["hover"],
  focus: ["focus", "focus-visible", "focus-within"],
};
const TRACKED_PSEUDOS = [
  "hover",
  "focus",
  "focus-visible",
  "focus-within",
  "active",
  "disabled",
  "checked",
];

interface Element {
  tag: string;
  classes: string[];
}

/** Conservative: false only when the rightmost compound provably cannot match the element/state. */
function canReach(selector: string, element: Element, state: State): boolean {
  const parts = splitCompounds(unwrapGlobal(selector));
  const c = parseCompound(parts[parts.length - 1]);
  if (c.ids.length > 0 || c.pseudoElements > 0) return false;
  if (c.tag && c.tag !== "*" && c.tag !== element.tag) return false;
  if (c.classes.some((k) => !element.classes.includes(k))) return false;
  for (const p of c.pseudos) {
    if (p.name === "not" && p.arg?.trim() === ":disabled") continue;
    if (TRACKED_PSEUDOS.includes(p.name) && !STATE_PSEUDOS[state].includes(p.name)) return false;
  }
  return true;
}

// ── Stylesheet model ────────────────────────────────────────────────────────

type Source = "app.css" | "tokens.css" | "page";
interface Rule {
  source: Source;
  selector: string; // one selector of the rule, as written
  spec: Spec;
  decls: { prop: string; value: string }[];
  order: number;
}

function parseRules(css: string, source: Source, scopedBonus: boolean): Rule[] {
  const rules: Rule[] = [];
  let order = 0;
  postcss.parse(css).walkRules((rule) => {
    const parent = rule.parent;
    if (parent && parent.type === "atrule" && /keyframes$/i.test((parent as postcss.AtRule).name))
      return;
    const decls: { prop: string; value: string }[] = [];
    rule.each((n) => {
      if (n.type === "decl") decls.push({ prop: n.prop.toLowerCase(), value: n.value });
    });
    for (const selector of rule.selectors) {
      let spec = specificity(selector);
      if (scopedBonus && !isFullyGlobal(selector)) spec = add(spec, [0, 1, 0]);
      rules.push({ source, selector: selector.trim(), spec, decls, order: order++ });
    }
  });
  return rules;
}

const styleBlocks = PAGE.match(/<style[^>]*>[\s\S]*?<\/style>/g) ?? [];
const PAGE_CSS = styleBlocks[0]?.replace(/^<style[^>]*>/, "").replace(/<\/style>$/, "") ?? "";
const APP_RULES = parseRules(APP_CSS, "app.css", false);
const TOKEN_RULES = parseRules(TOKENS_CSS, "tokens.css", false);
const PAGE_RULES = parseRules(PAGE_CSS, "page", true);
const GLOBAL_RULES = [...APP_RULES, ...TOKEN_RULES];

const isCardRule = (r: Rule) =>
  r.source === "page" && unwrapGlobal(r.selector).includes(".timer-card-wrap");
const CARD_RULES = PAGE_RULES.filter(isCardRule);
const PAGE_OTHER_RULES = PAGE_RULES.filter((r) => !isCardRule(r));

// ── Markup ──────────────────────────────────────────────────────────────────

/** End index of an opening tag, skipping `>` inside {...} expressions and quoted values. */
function tagEnd(text: string, from: number): number {
  let brace = 0;
  let quote: string | null = null;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (brace === 0 && (ch === '"' || ch === "'")) {
      quote = ch;
      continue;
    }
    if (ch === "{") brace++;
    else if (ch === "}") brace--;
    else if (ch === ">" && brace === 0) return i;
  }
  throw new Error("unterminated tag");
}

interface ButtonEl {
  classes: string[];
  body: string;
  open: string;
}

function collectButtons(text: string): ButtonEl[] {
  const out: ButtonEl[] = [];
  let at = text.indexOf("<button");
  while (at !== -1) {
    const end = tagEnd(text, at);
    const open = text.slice(at, end + 1);
    const closeMatch = /<\/button\s*>/.exec(text.slice(end));
    if (!closeMatch) throw new Error("button without closing tag");
    const close = end + closeMatch.index;
    const body = text.slice(end + 1, close);
    const cls = /\sclass="([^"]*)"/.exec(open)?.[1].split(/\s+/).filter(Boolean) ?? [];
    for (const m of open.matchAll(/class:([\w-]+)/g)) cls.push(m[1]);
    out.push({ classes: cls, body, open });
    at = text.indexOf("<button", close + 1);
  }
  return out;
}

const BUTTONS = collectButtons(PAGE);
const PRIMARIES = BUTTONS.filter((b) => b.classes.includes("timer-cta-primary"));
const GHOSTS = BUTTONS.filter((b) => b.classes.includes("timer-cta-ghost"));

// ── Tokens and colour maths ─────────────────────────────────────────────────

const DECLARED_TOKENS = new Set([...TOKENS_CSS.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));

function srgb(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
type Rgb = [number, number, number];
function hexToRgb(hex: string): Rgb {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`Not a 6-digit hex colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function luminance([r, g, b]: Rgb): number {
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
}
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

interface Combo {
  id: string;
  theme: string;
  mode: string;
  skin: string | null;
}

function comboList(): Combo[] {
  const slice = THEME_TS.slice(THEME_TS.indexOf("export const themes"));
  const block = slice.slice(0, slice.indexOf("];"));
  const themes = [...block.matchAll(/id:\s*"(\w+)"/g)].map((m) => m[1]);
  const combos: Combo[] = [];
  for (const theme of themes)
    for (const mode of ["light", "dark"])
      combos.push({ id: `editorial-${theme}-${mode}`, theme, mode, skin: null });
  for (const m of ADMIN_THEMES.matchAll(/skin:\s*"modern",\s*mode:\s*"(\w+)",\s*theme:\s*"(\w+)"/g))
    combos.push({ id: `modern-${m[2]}-${m[1]}`, theme: m[2], mode: m[1], skin: "modern" });
  return combos;
}

/** Resolves every custom property for one combination from the tokens.css cascade. */
function resolveTokens(combo: Combo): Map<string, string> {
  const winners = new Map<string, { spec: Spec; order: number; value: string }>();
  for (const rule of TOKEN_RULES) {
    const sel = rule.selector.replace(/^html(?=\[)/, "");
    let matches = false;
    if (sel === ":root") matches = true;
    else if (/^(\[data-(theme|mode|skin)="[a-z]+"\])+$/.test(sel)) {
      matches = [...sel.matchAll(/\[data-(theme|mode|skin)="([a-z]+)"\]/g)].every(([, k, v]) => {
        if (k === "theme") return combo.theme === v;
        if (k === "mode") return combo.mode === v;
        return combo.skin === v;
      });
    }
    if (!matches) continue;
    for (const d of rule.decls) {
      if (!d.prop.startsWith("--")) continue;
      const prev = winners.get(d.prop);
      if (
        !prev ||
        cmp(rule.spec, prev.spec) > 0 ||
        (cmp(rule.spec, prev.spec) === 0 && rule.order > prev.order)
      )
        winners.set(d.prop, { spec: rule.spec, order: rule.order, value: d.value.trim() });
    }
  }
  const out = new Map<string, string>();
  for (const [k, v] of winners) out.set(k, v.value);
  return out;
}

function tokenRgb(tokens: Map<string, string>, name: string, depth = 0): Rgb {
  if (depth > 8) throw new Error(`token cycle at ${name}`);
  const raw = tokens.get(name);
  if (raw === undefined) throw new Error(`token ${name} is not defined`);
  const ref = /^var\((--[\w-]+)\)$/.exec(raw);
  if (ref) return tokenRgb(tokens, ref[1], depth + 1);
  return hexToRgb(raw);
}

/** `var(--x)` or `color-mix(in srgb, var(--a) N%, var(--b))` (gamma-sRGB mix), nothing else. */
function evalColor(value: string, tokens: Map<string, string>): Rgb {
  const v = value.trim();
  const plain = /^var\((--[\w-]+)\)$/.exec(v);
  if (plain) return tokenRgb(tokens, plain[1]);
  const mix =
    /^color-mix\(\s*in srgb\s*,\s*var\((--[\w-]+)\)\s+(\d+(?:\.\d+)?)%\s*,\s*var\((--[\w-]+)\)\s*\)$/.exec(
      v,
    );
  if (mix) {
    const a = tokenRgb(tokens, mix[1]);
    const b = tokenRgb(tokens, mix[3]);
    const n = Number(mix[2]) / 100;
    return [0, 1, 2].map((i) => a[i] * n + b[i] * (1 - n)) as Rgb;
  }
  throw new Error(`Unsupported colour expression: ${value}`);
}

// ── Cascade helpers ─────────────────────────────────────────────────────────

const GROUPS = {
  COLOR: ["color"],
  FILL: ["background", "background-color", "background-image"],
  RING: ["outline", "outline-color", "outline-style", "outline-width", "box-shadow"],
  BORDER: [
    "border",
    "border-color",
    "border-top-color",
    "border-right-color",
    "border-bottom-color",
    "border-left-color",
  ],
} as const;
type Group = keyof typeof GROUPS;

const declares = (r: Rule, group: Group) =>
  r.decls.some((d) => (GROUPS[group] as readonly string[]).includes(d.prop));

function reaching(rules: Rule[], el: Element, state: State, group: Group): Rule[] {
  return rules.filter((r) => declares(r, group) && canReach(r.selector, el, state));
}

function top(rules: Rule[]): Rule | null {
  return rules.reduce<Rule | null>(
    (best, r) => (best && cmp(best.spec, r.spec) >= 0 ? best : r),
    null,
  );
}

function primaryEl(): Element {
  expect(PRIMARIES, "exactly one primary clock button").toHaveLength(1);
  return { tag: "button", classes: PRIMARIES[0].classes };
}
const SPINNER_EL: Element = { tag: "span", classes: ["btn-spinner"] };

// ── Tests ───────────────────────────────────────────────────────────────────

describe("clock card CTA (Issue #546) - specificity engine", () => {
  it("computes the specificity of the shapes that matter", () => {
    expect(specificity(".btn-primary:hover:not(:disabled)")).toEqual([0, 3, 0]);
    expect(specificity('[data-skin="modern"][data-mode="dark"] .btn-primary')).toEqual([0, 3, 0]);
    expect(specificity(":where(button, a):focus-visible")).toEqual([0, 1, 0]);
    expect(
      specificity(":global(.timer-card-wrap .timer-cta-primary:hover:not(:disabled))"),
    ).toEqual([0, 4, 0]);
    expect(specificity("button")).toEqual([0, 0, 1]);
  });

  it("parses a non-trivial amount of real CSS (anti-vacuity)", () => {
    expect(styleBlocks).toHaveLength(1);
    expect(GLOBAL_RULES.length).toBeGreaterThan(300);
    expect(CARD_RULES.length).toBeGreaterThan(5);
  });
});

describe("clock card CTA (Issue #546) - markup", () => {
  it("renders exactly one primary button with the label and the spinner, and no btn-* variant", () => {
    expect(PRIMARIES).toHaveLength(1);
    const p = PRIMARIES[0];
    expect(p.body).toContain("{primaryLabel}");
    expect(p.body).toMatch(/\{#if clockLoading\}\s*<span class="btn-spinner"><\/span>\s*\{\/if\}/);
    expect(
      p.classes.filter((k) => k.startsWith("btn-")),
      "no global variant on the primary card button",
    ).toEqual([]);
    expect(p.classes).toContain("btn");
  });

  it("primaryClockLabel can only return the two labels the CTA renders", () => {
    expect(DAY_STATE).toContain(
      'primaryClockLabel(day: DayState): "Einstempeln" | "Ausstempeln" | null',
    );
  });

  it("finds the ghost card buttons", () => {
    expect(GHOSTS.length).toBeGreaterThanOrEqual(2);
  });
});

describe("clock card CTA (Issue #546) - cascade", () => {
  const competitorsOf = (el: Element, state: State, group: Group): Rule[] => [
    ...reaching(GLOBAL_RULES, el, state, group),
    ...reaching(PAGE_OTHER_RULES, el, state, group),
  ];

  const check = (label: string, el: Element, state: State, group: Group) => {
    const card = top(reaching(CARD_RULES, el, state, group));
    expect(card, `${label} ${state} ${group}: a card rule must declare it`).not.toBeNull();
    for (const rival of competitorsOf(el, state, group)) {
      expect(
        cmp(card!.spec, rival.spec),
        `${label} ${state} ${group}: card rule "${card!.selector}" [${card!.spec}] must out-specify "${rival.selector}" [${rival.spec}] (${rival.source})`,
      ).toBeGreaterThan(0);
    }
  };

  it("primary button: colour and fill win in base, hover and focus", () => {
    const el = primaryEl();
    for (const state of ["base", "hover", "focus"] as State[])
      for (const group of ["COLOR", "FILL"] as Group[]) check("primary", el, state, group);
  });

  it("primary and ghost buttons: the focus ring wins", () => {
    check("primary", primaryEl(), "focus", "RING");
    for (const g of GHOSTS) check("ghost", { tag: "button", classes: g.classes }, "focus", "RING");
  });

  it("ghost buttons: colour and fill win in base and hover", () => {
    for (const g of GHOSTS)
      for (const state of ["base", "hover"] as State[])
        for (const group of ["COLOR", "FILL"] as Group[])
          check("ghost", { tag: "button", classes: g.classes }, state, group);
  });

  it("spinner inside the primary button: border colours win over the page's scoped rule", () => {
    check("spinner", SPINNER_EL, "base", "BORDER");
  });

  it("competitor lists are not vacuous", () => {
    const el = primaryEl();
    expect(
      competitorsOf(el, "focus", "RING").some((r) => r.selector.includes("focus-visible")),
    ).toBe(true);
    expect(competitorsOf(el, "base", "FILL").some((r) => r.selector === ".btn")).toBe(true);
    expect(
      competitorsOf(SPINNER_EL, "base", "BORDER").some(
        (r) => r.source === "page" && r.selector === ".btn-spinner",
      ),
    ).toBe(true);
    const scoped = competitorsOf(SPINNER_EL, "base", "BORDER").find(
      (r) => r.source === "page" && r.selector === ".btn-spinner",
    )!;
    expect(scoped.spec).toEqual([0, 2, 0]);
  });
});

describe("clock card CTA (Issue #546) - tokens only", () => {
  const spinnerRules = CARD_RULES.filter((r) => /\.btn-spinner$/.test(unwrapGlobal(r.selector)));
  const focusRules = CARD_RULES.filter((r) => r.selector.includes("focus-visible"));

  it("the primary rules, the card spinner rule and the focus rule use only tokens", () => {
    const el = primaryEl();
    const checked = new Set<Rule>([...spinnerRules, ...focusRules]);
    for (const state of ["base", "hover", "focus"] as State[])
      for (const group of ["COLOR", "FILL", "RING"] as Group[])
        for (const r of reaching(CARD_RULES, el, state, group)) checked.add(r);
    // positive controls: the spinner and focus rules really are part of the checked set
    expect(spinnerRules.length).toBeGreaterThanOrEqual(1);
    expect(focusRules.length).toBeGreaterThanOrEqual(1);
    expect(checked.size).toBeGreaterThanOrEqual(4);
    for (const r of checked) {
      for (const d of r.decls) {
        if (
          ![...GROUPS.COLOR, ...GROUPS.FILL, ...GROUPS.RING, ...GROUPS.BORDER].includes(
            d.prop as never,
          )
        )
          continue;
        expect(
          d.value,
          `${r.selector} { ${d.prop} } must not contain a literal colour`,
        ).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\b(white|black)\b/i);
        for (const m of d.value.matchAll(/var\((--[\w-]+)/g))
          expect(
            DECLARED_TOKENS.has(m[1]),
            `${r.selector} references undeclared token ${m[1]}`,
          ).toBe(true);
      }
    }
  });
});

describe("clock card CTA (Issue #546) - WCAG contrast per UI-selectable combination", () => {
  const combos = comboList();

  it("derives its combinations from the theme store and the admin presets", () => {
    expect(combos.filter((c) => c.skin === null && c.theme === "pflaume")).toHaveLength(2);
    expect(
      new Set(combos.filter((c) => c.skin === null).map((c) => c.theme)).size,
    ).toBeGreaterThanOrEqual(3);
    expect(combos.filter((c) => c.skin === "modern").length).toBeGreaterThanOrEqual(1);
    expect(combos.length).toBeGreaterThanOrEqual(8);
  });

  it("token resolution distinguishes skins and modes (positive controls)", () => {
    const get = (id: string) => resolveTokens(combos.find((c) => c.id === id)!);
    expect(get("modern-pflaume-dark").get("--brand-dark")).not.toBe(
      get("editorial-pflaume-light").get("--brand-dark"),
    );
    expect(get("editorial-pflaume-dark").get("--bg-card")).not.toBe(
      get("editorial-pflaume-light").get("--bg-card"),
    );
  });

  it("label >= 4.5:1 in base, hover and focus; spinner arc >= 3:1; focus ring >= 3:1 against its band", () => {
    const el = primaryEl();
    const effective = (state: State, group: Group, prop: RegExp): string => {
      const rule = top(reaching(CARD_RULES, el, state, group))!;
      const decl = [...rule.decls].reverse().find((d) => prop.test(d.prop))!;
      return decl.value;
    };
    const spinnerRule = top(
      CARD_RULES.filter((r) => /\.btn-spinner$/.test(unwrapGlobal(r.selector))),
    )!;
    let arcValue = "";
    for (const d of spinnerRule.decls)
      if (d.prop === "border-color" || d.prop === "border-top-color") arcValue = d.value;
    const ringRule = top(reaching(CARD_RULES, el, "focus", "RING"))!;
    const ringVar = /var\((--[\w-]+)\)/.exec(
      ringRule.decls.find((d) => d.prop === "outline")!.value,
    )![1];
    const bandVar = /var\((--[\w-]+)\)/.exec(
      ringRule.decls.find((d) => d.prop === "box-shadow")!.value,
    )![1];

    for (const combo of combos) {
      const tokens = resolveTokens(combo);
      for (const state of ["base", "hover", "focus"] as State[]) {
        const text = evalColor(effective(state, "COLOR", /^color$/), tokens);
        const fill = evalColor(effective(state, "FILL", /^background(-color)?$/), tokens);
        expect(contrast(text, fill), `${combo.id} ${state} label`).toBeGreaterThanOrEqual(4.5);
      }
      const baseFill = evalColor(effective("base", "FILL", /^background(-color)?$/), tokens);
      expect(
        contrast(evalColor(arcValue, tokens), baseFill),
        `${combo.id} loading spinner arc`,
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrast(tokenRgb(tokens, ringVar), tokenRgb(tokens, bandVar)),
        `${combo.id} focus ring vs band`,
      ).toBeGreaterThanOrEqual(3);
    }
  });
});
