// Test helper (not a `*.test.ts`) — resolves design tokens from the SOURCE of `tokens.css`.
//
// Why the source is parsed: jsdom resolves no custom properties and computes no colours, so a
// test that wants to know "how visible is this tint in editorial dark" has to read the declarations
// itself. The helper applies selector blocks in order (last declaration wins, as the cascade does
// for blocks of equal specificity on the one `<html>` element), resolves `var()`, hex, `rgb()` /
// `rgba()`, `transparent` and `color-mix(in srgb, ...)`, composites translucent colours and
// measures WCAG 2.x contrast.
//
// The identifier-prefix trap (Phase 258, see `leave-chip-contrast.test.ts`): `[data-mode="dark"] {`
// is a SUBSTRING of `html[data-mode="dark"] {`, which holds only `color-scheme: dark`. A lookup that
// takes the first substring match extracts nothing and passes having checked nothing. A block match
// is therefore rejected when an identifier character precedes it, and it must be followed by `{`.
//
// Issue #840 G-2 / G-4.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Rgba {
  /** 0..255 */
  r: number;
  g: number;
  b: number;
  /** 0..1 */
  a: number;
}

function readRepoFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

export function readTokensCss(): string {
  return readRepoFile("../tokens.css", "src/tokens.css");
}

export function readAppCss(): string {
  return readRepoFile("../app.css", "src/app.css");
}

/** The block chains of the four surface modes the timeline can be shown in. */
export const SURFACES = {
  "editorial-light": [":root"],
  "editorial-dark": [":root", '[data-mode="dark"]'],
  "modern-light": [":root", '[data-skin="modern"]', '[data-skin="modern"][data-mode="light"]'],
  "modern-dark": [
    ":root",
    '[data-mode="dark"]',
    '[data-skin="modern"]',
    '[data-skin="modern"][data-mode="dark"]',
  ],
} as const satisfies Record<string, readonly string[]>;

export type SurfaceName = keyof typeof SURFACES;

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

function blockBody(css: string, selector: string): string {
  const source = stripComments(css);
  const idChar = /[A-Za-z0-9_-]/;
  let from = 0;
  for (;;) {
    const idx = source.indexOf(selector, from);
    if (idx === -1) throw new Error(`Selector block not found in the stylesheet: ${selector}`);
    from = idx + selector.length;
    if (idx > 0 && idChar.test(source[idx - 1])) continue; // suffix of a longer selector
    if (!/^\s*\{/.test(source.slice(from))) continue; // a prefix of a longer compound selector
    const open = source.indexOf("{", from);
    const close = source.indexOf("}", open);
    if (close === -1) throw new Error(`Unterminated block: ${selector}`);
    return source.slice(open + 1, close);
  }
}

/**
 * The declared value of custom property `name` after the given selector blocks are applied in
 * order (the last declaration wins). Throws when no block declares it.
 */
export function tokenIn(css: string, blocks: readonly string[], name: string): string {
  let value: string | undefined;
  const declaration = new RegExp(`(?:^|[;{\\s])${name.replace(/-/g, "\\-")}\\s*:\\s*([^;]+);`, "g");
  for (const selector of blocks) {
    const body = blockBody(css, selector);
    for (const match of body.matchAll(declaration)) value = match[1].trim();
  }
  if (value === undefined) {
    throw new Error(`${name} is not declared in ${JSON.stringify(blocks)}`);
  }
  return value;
}

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

function parseMixArgument(
  css: string,
  blocks: readonly string[],
  argument: string,
): { color: Rgba; percent: number | null } {
  const match = /^(.*?)\s+(\d+(?:\.\d+)?)%$/.exec(argument);
  if (match) {
    return { color: resolveColor(css, blocks, match[1]), percent: Number(match[2]) / 100 };
  }
  return { color: resolveColor(css, blocks, argument), percent: null };
}

/** Resolves a CSS colour value (`var()`, hex, `rgb[a]()`, `transparent`, `color-mix(in srgb, …)`). */
export function resolveColor(css: string, blocks: readonly string[], value: string): Rgba {
  const text = value.trim();

  const variable = /^var\(\s*(--[a-z0-9-]+)\s*(?:,[\s\S]*)?\)$/i.exec(text);
  if (variable) return resolveColor(css, blocks, tokenIn(css, blocks, variable[1]));

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
    const first = parseMixArgument(css, blocks, args[0]);
    const second = parseMixArgument(css, blocks, args[1]);
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

/** The card surface of a block chain: `--bg-card` composited over `--bg`. */
export function cardSurface(css: string, blocks: readonly string[]): Rgba {
  return over(resolveColor(css, blocks, "var(--bg-card)"), resolveColor(css, blocks, "var(--bg)"));
}
