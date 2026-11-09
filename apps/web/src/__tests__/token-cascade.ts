// Test helper (not a `*.test.ts`) — the ONE resolver of the design-token cascade (Issue #842).
//
// Why the source is parsed: jsdom resolves no custom properties and computes no colours, so a test
// that wants to know "how readable is --text-3 on --card in Salz dark" has to read the declarations
// of `tokens.css` itself. This module applies the top-level rules of the file to one of the six
// combinations (theme pflaume | salz | petrol x mode light | dark) exactly as a browser would for an
// element that carries both attributes: a selector matches when every one of its parts matches, the
// higher specificity wins, and equal specificity is decided by source order (D-842-02).
//
// Only top-level rules are read. `@font-face`, `@keyframes` and `@media` are skipped on purpose: the
// phone hero size inside the media query is not a colour and no combination depends on it.
//
// The colour parsing, compositing and WCAG 2.x formulas are the ones of the older `token-css.ts`
// helper, copied unchanged so both agree to the last digit; a later plan turns that helper into a
// consumer of this module so the repository ends with a single implementation.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";

export const THEMES = ["pflaume", "salz", "petrol"] as const;
export const MODES = ["light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
export type Mode = (typeof MODES)[number];

export interface Combination {
  theme: Theme;
  mode: Mode;
}

/** The six combinations, theme-major. */
export const COMBINATIONS: readonly Combination[] = THEMES.flatMap((theme) =>
  MODES.map((mode) => ({ theme, mode })),
);

export interface Rgba {
  /** 0..255 */
  r: number;
  g: number;
  b: number;
  /** 0..1 */
  a: number;
}

export function readTokensCss(): string {
  try {
    return readFileSync(fileURLToPath(new URL("../tokens.css", import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), "src/tokens.css"), "utf8");
  }
}

// ── Cascade ──────────────────────────────────────────────────────────────

interface Declaration {
  prop: string;
  value: string;
}

/** One (rule, selector) pair of a top-level rule; a comma list yields one entry per selector. */
export interface TokenRule {
  selector: string;
  decls: Declaration[];
  /** Source order of the rule the selector belongs to. */
  order: number;
}

/** The top-level rules of the token file, one entry per selector of every comma list. */
export function parseTokenRules(css: string): TokenRule[] {
  const rules: TokenRule[] = [];
  let order = 0;
  for (const node of postcss.parse(css).nodes) {
    if (node.type !== "rule") continue;
    const decls: Declaration[] = [];
    node.each((child) => {
      if (child.type === "decl") decls.push({ prop: child.prop, value: child.value.trim() });
    });
    for (const selector of node.selectors) rules.push({ selector: selector.trim(), decls, order });
    order++;
  }
  return rules;
}

/**
 * The specificity of `selector` for the combination, or null when it does not match. A selector is
 * the root pseudo-class (matches always) or a compound of theme/mode attribute parts, each either
 * bare (matches always) or carrying a value that has to equal the combination's.
 */
function matchSpecificity(selector: string, combo: Combination): number | null {
  if (selector === ":root") return 1;
  if (!/^(\[data-(?:theme|mode)(?:="[a-z]+")?\])+$/.test(selector)) return null;
  const parts = [...selector.matchAll(/\[data-(theme|mode)(?:="([a-z]+)")?\]/g)];
  for (const [, key, value] of parts) {
    if (value === undefined) continue;
    if ((key === "theme" ? combo.theme : combo.mode) !== value) return null;
  }
  return parts.length;
}

/**
 * Every property (custom properties and `color-scheme`) the cascade yields for the combination,
 * with its value as written — `var()` references are NOT followed here (see `resolveCombination`).
 */
export function cascadeCombination(css: string, theme: Theme, mode: Mode): Map<string, string> {
  const combo = { theme, mode };
  const winners = new Map<string, { specificity: number; order: number; value: string }>();
  // A rule with several matching selectors counts with its most specific one.
  const bestSpecificity = new Map<number, number>();
  const byOrder = new Map<number, TokenRule>();
  for (const rule of parseTokenRules(css)) {
    const specificity = matchSpecificity(rule.selector, combo);
    if (specificity === null) continue;
    byOrder.set(rule.order, rule);
    bestSpecificity.set(rule.order, Math.max(bestSpecificity.get(rule.order) ?? 0, specificity));
  }
  for (const [order, rule] of byOrder) {
    const specificity = bestSpecificity.get(order)!;
    for (const decl of rule.decls) {
      if (!decl.prop.startsWith("--") && decl.prop !== "color-scheme") continue;
      const previous = winners.get(decl.prop);
      if (
        !previous ||
        specificity > previous.specificity ||
        (specificity === previous.specificity && order > previous.order)
      ) {
        winners.set(decl.prop, { specificity, order, value: decl.value });
      }
    }
  }
  const out = new Map<string, string>();
  for (const [prop, winner] of winners) out.set(prop, winner.value);
  return out;
}

const VAR_REFERENCE = /var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)/g;

/** Replaces every `var()` in `value` by the value of the property, repeatedly, until none is left. */
function substituteVars(map: Map<string, string>, value: string, depth = 0): string {
  if (depth > 12) throw new Error(`var() chain too deep or cyclic: ${value}`);
  if (!value.includes("var(")) return value;
  const next = value.replace(VAR_REFERENCE, (_all, name: string) => {
    const target = map.get(name);
    if (target === undefined) throw new Error(`${name} is not defined (needed by: ${value})`);
    return target;
  });
  return substituteVars(map, next, depth + 1);
}

/**
 * The fully resolved value of every property for one combination: the cascade of
 * `cascadeCombination` with every `var()` chain followed against the SAME combination.
 */
export function resolveCombination(css: string, theme: Theme, mode: Mode): Map<string, string> {
  const raw = cascadeCombination(css, theme, mode);
  const out = new Map<string, string>();
  for (const [prop, value] of raw) out.set(prop, substituteVars(raw, value));
  return out;
}

// ── Colour maths ─────────────────────────────────────────────────────────

/** Splits at the commas that are not inside parentheses. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current.trim());
  return parts;
}

function parseMixArgument(map: Map<string, string>, argument: string) {
  const match = /^(.*?)\s+(\d+(?:\.\d+)?)%$/.exec(argument);
  if (match) return { color: resolveColor(map, match[1]), percent: Number(match[2]) / 100 };
  return { color: resolveColor(map, argument), percent: null as number | null };
}

/**
 * Resolves a CSS colour value (`var()`, hex, `rgb[a]()`, `transparent`, `color-mix(in srgb, …)`)
 * against the resolved property map of one combination.
 */
export function resolveColor(map: Map<string, string>, value: string): Rgba {
  const text = substituteVars(map, value.trim());

  if (text === "transparent") return { r: 0, g: 0, b: 0, a: 0 };

  const hex = /^#([0-9a-f]{3,8})$/i.exec(text);
  if (hex) {
    let digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      digits = [...digits].map((d) => d + d).join("");
    }
    if (digits.length !== 6 && digits.length !== 8) throw new Error(`Bad hex colour: ${text}`);
    const int = (from: number) => parseInt(digits.slice(from, from + 2), 16);
    return { r: int(0), g: int(2), b: int(4), a: digits.length === 8 ? int(6) / 255 : 1 };
  }

  const rgb = /^rgba?\(([^)]*)\)$/i.exec(text);
  if (rgb) {
    const parts = rgb[1].split(",").map((p) => p.trim());
    if (parts.length < 3) throw new Error(`Unsupported rgb() form: ${text}`);
    return {
      r: Number(parts[0]),
      g: Number(parts[1]),
      b: Number(parts[2]),
      a: parts.length > 3 ? Number(parts[3]) : 1,
    };
  }

  const mix = /^color-mix\(\s*in srgb\s*,([\s\S]*)\)$/i.exec(text);
  if (mix) {
    const args = splitTopLevel(mix[1]);
    if (args.length !== 2) throw new Error(`color-mix() needs two colours: ${text}`);
    const first = parseMixArgument(map, args[0]);
    const second = parseMixArgument(map, args[1]);
    const p1 = first.percent ?? (second.percent === null ? 0.5 : 1 - second.percent);
    const p2 = second.percent ?? 1 - p1;
    // Premultiplied interpolation, as CSS Color 4 defines it for color-mix().
    const a = first.color.a * p1 + second.color.a * p2;
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    const channel = (key: "r" | "g" | "b") =>
      (first.color[key] * first.color.a * p1 + second.color[key] * second.color.a * p2) / a;
    return { r: channel("r"), g: channel("g"), b: channel("b"), a };
  }

  throw new Error(`Cannot resolve colour value: ${value}`);
}

/** Alpha compositing: `top` painted over `bottom`. */
export function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a + bottom.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const channel = (key: "r" | "g" | "b") =>
    (top[key] * top.a + bottom[key] * bottom.a * (1 - top.a)) / a;
  return { r: channel("r"), g: channel("g"), b: channel("b"), a };
}

function luminance(c: Rgba): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG 2.x contrast ratio of two OPAQUE colours (composite with `over()` first). */
export function contrast(a: Rgba, b: Rgba): number {
  if (a.a < 0.999 || b.a < 0.999) {
    throw new Error("contrast() needs opaque colours — composite with over() first");
  }
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
