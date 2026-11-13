// Issue #840 G-7 — every primary button reaches WCAG AA (4.5:1) in every look the app offers.
//
// The self-test found "+ Neue Abwesenheit", "Planung verwalten" and "Wunsch hinzufügen" pale pink
// with white text. The browser measurement (e2e test 9 of leave-area-840.spec.ts) showed the cause
// is the shared recipe, not a local override: the modern skin drew white text on a light neon
// gradient and the editorial hover lightened the fill under white text.
//
// #842 (D-842-08, D-842-16, D-842-25): the skin layer is gone together with the rules this file
// used to guard (the modern gradient recipes and their dark-mode literal), so those cases are
// removed with them. What remains is the one recipe: `--brand-ink` on `--brand` at rest and
// `--brand-ink` on `--brand-hover` on hover, measured in the six theme x mode combinations.
//
// jsdom computes no colours, so this test resolves the pairs the recipe draws from the SOURCE of
// `tokens.css` (the cascade resolver applies each combination) and pins the declarations of the
// recipe in `app.css`, so a later edit that points a rule at another token or at a literal turns
// this red before any browser run.

import { describe, expect, it } from "vitest";
import {
  COMBINATION_NAMES,
  contrast,
  over,
  readAppCss,
  readTokensCss,
  resolveColor,
  type CombinationName,
  type Rgba,
} from "./token-css";

const TOKENS = readTokensCss();
const APP = readAppCss();

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const squash = (text: string) => text.replace(/\s+/g, " ").trim();

interface Rule {
  selectors: string[];
  declarations: Record<string, string>;
}

/** Every top-level style rule of the stylesheet with its selector list split at the commas. */
function rules(css: string): Rule[] {
  const out: Rule[] = [];
  for (const match of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations: Record<string, string> = {};
    for (const part of match[2].split(";")) {
      const colon = part.indexOf(":");
      if (colon === -1) continue;
      declarations[part.slice(0, colon).trim()] = squash(part.slice(colon + 1));
    }
    out.push({ selectors: match[1].split(",").map(squash), declarations });
  }
  return out;
}

const RULES = rules(APP);

/** The declarations of the LAST rule whose selector list is exactly `selector`. */
function lastRule(selector: string): Record<string, string> | null {
  const matching = RULES.filter(
    (rule) => rule.selectors.length === 1 && rule.selectors[0] === selector,
  );
  return matching.length ? matching[matching.length - 1].declarations : null;
}

function opaque(combination: CombinationName, token: string): Rgba {
  const color = resolveColor(TOKENS, combination, `var(${token})`);
  // A translucent token would need the surface under it; a primary fill is never translucent.
  return over(color, { r: 255, g: 255, b: 255, a: 1 });
}

describe("#840 G-7 / #842 the primary button recipe reaches 4.5:1 in all six combinations and both states", () => {
  it("measures all six combinations (anti-vacuity)", () => {
    expect(COMBINATION_NAMES).toHaveLength(6);
  });

  for (const combination of COMBINATION_NAMES as CombinationName[]) {
    it(`${combination}: rest is --brand-ink on --brand`, () => {
      const ratio = contrast(opaque(combination, "--brand-ink"), opaque(combination, "--brand"));
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });
    it(`${combination}: hover is --brand-ink on --brand-hover`, () => {
      const ratio = contrast(
        opaque(combination, "--brand-ink"),
        opaque(combination, "--brand-hover"),
      );
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("the checker can fail: the honey accent under the brand ink is far below the floor", () => {
    // Negative control: --accent is a fill without text (D-842-07), so this is deliberately no pair.
    const ratio = contrast(
      opaque("pflaume-light", "--brand-ink"),
      opaque("pflaume-light", "--accent"),
    );
    expect(ratio).toBeLessThan(4.5);
  });
});

describe("#840 G-7 / #842 the recipe declarations in app.css", () => {
  it("the rule draws --brand-ink on --brand and darkens to --brand-hover on hover", () => {
    const rest = lastRule(".btn-primary");
    expect(rest?.background).toBe("var(--brand)");
    expect(rest?.color).toBe("var(--brand-ink)");
    const hover = lastRule(".btn-primary:hover:not(:disabled)");
    expect(hover?.background, "the hover darkens (the original v1 rule), it never lightens").toBe(
      "var(--brand-hover)",
    );
  });

  it("no primary-button rule carries a colour literal", () => {
    const primary = RULES.filter((rule) => rule.selectors.some((s) => s.includes(".btn-primary")));
    // Anti-vacuity: the base rule, its hover and the count-pill rule at least.
    expect(primary.length).toBeGreaterThanOrEqual(4);
    const literal = primary.flatMap((rule) =>
      Object.entries(rule.declarations)
        .filter(
          ([property, value]) =>
            /(^|-)(color|background)$/.test(property) && /#[0-9a-f]{3,8}\b|rgba?\(/i.test(value),
        )
        .map(([property, value]) => `${rule.selectors.join(", ")} { ${property}: ${value} }`),
    );
    expect(literal).toEqual([]);
  });

  it("the skin recipes of the primary button are gone with the skin layer (D-842-16)", () => {
    // #842 D-842-16: the needle is built from fragments so the skin/density guard stays unmatched.
    expect(APP).not.toContain(["data", "skin"].join("-"));
    expect(APP).not.toContain("--text-on-brand");
  });

  it("--brand-ink is white on the light brand fills and a dark ink on the dark ones", () => {
    // It is also used as a BACKGROUND (the dashboard timer card, Issue #546), so each combination
    // must give it a value that reads on its own --brand.
    expect(resolveColor(TOKENS, "pflaume-light", "var(--brand-ink)")).toMatchObject({
      r: 255,
      g: 255,
      b: 255,
    });
    const dark = resolveColor(TOKENS, "pflaume-dark", "var(--brand-ink)");
    expect(dark.r + dark.g + dark.b).toBeLessThan(150);
  });
});
