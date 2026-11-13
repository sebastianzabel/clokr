// Test helper (not a `*.test.ts`) — the #840 helper API on top of the ONE cascade implementation.
//
// Issue #842, D-842-02 / D-842-25: the four surface modes the timeline used to be measured in
// (editorial/modern x light/dark) are retired together with the skin layer. A colour is now
// resolved for one of the six combinations (theme pflaume | salz | petrol x mode light | dark)
// through `token-cascade.ts`, which parses `tokens.css` with postcss and applies the cascade the
// way a browser does for an element carrying both attributes. This file owns no block extraction
// and no colour maths of its own: it re-exports the cascade module's functions and adds the
// combination-keyed names the #840 tests were written against.
//
// Why the source is parsed: jsdom resolves no custom properties and computes no colours, so a test
// that wants to know "how visible is this tint in Salz dark" has to read the declarations itself.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMBINATIONS,
  contrast,
  over,
  readTokensCss,
  resolveColor as resolveColorIn,
  resolveCombination,
  type Combination,
  type Rgba,
} from "./token-cascade";

export { contrast, over, readTokensCss };
export type { Rgba };

export function readAppCss(): string {
  try {
    return readFileSync(fileURLToPath(new URL("../app.css", import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), "src/app.css"), "utf8");
  }
}

/** The six combinations keyed `"<theme>-<mode>"`, theme-major (replaces the retired four surfaces). */
export const COMBINATION_CHAINS = Object.fromEntries(
  COMBINATIONS.map((combo) => [`${combo.theme}-${combo.mode}`, combo]),
) as Record<`${Combination["theme"]}-${Combination["mode"]}`, Combination>;

export type CombinationName = keyof typeof COMBINATION_CHAINS;

/** The six combination names, theme-major. */
export const COMBINATION_NAMES = Object.keys(COMBINATION_CHAINS) as CombinationName[];

// Resolving a combination parses the stylesheet; the tests ask for the same one hundreds of times.
const resolved = new Map<string, Map<CombinationName, Map<string, string>>>();

function propertiesOf(css: string, combination: CombinationName): Map<string, string> {
  let perCss = resolved.get(css);
  if (!perCss) {
    perCss = new Map();
    resolved.set(css, perCss);
  }
  let map = perCss.get(combination);
  if (!map) {
    const { theme, mode } = COMBINATION_CHAINS[combination];
    map = resolveCombination(css, theme, mode);
    perCss.set(combination, map);
  }
  return map;
}

/**
 * The fully resolved value of custom property `name` in the combination (every `var()` followed).
 * Throws when the combination does not declare it.
 */
export function tokenIn(css: string, combination: CombinationName, name: string): string {
  const value = propertiesOf(css, combination).get(name);
  if (value === undefined) throw new Error(`${name} is not declared in ${combination}`);
  return value;
}

/** Resolves a CSS colour value (`var()`, hex, `rgb[a]()`, `color-mix(in srgb, …)`) in the combination. */
export function resolveColor(css: string, combination: CombinationName, value: string): Rgba {
  return resolveColorIn(propertiesOf(css, combination), value);
}

/** The card surface of a combination: `--card` composited over `--bg`. */
export function cardSurface(css: string, combination: CombinationName): Rgba {
  return over(
    resolveColor(css, combination, "var(--card)"),
    resolveColor(css, combination, "var(--bg)"),
  );
}
