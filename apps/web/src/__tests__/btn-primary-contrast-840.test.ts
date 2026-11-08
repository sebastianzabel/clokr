// Issue #840 G-7 — every primary button reaches WCAG AA (4.5:1) in every look the app offers.
//
// The self-test found "+ Neue Abwesenheit", "Planung verwalten" and "Wunsch hinzufügen" pale pink
// with white text. The browser measurement (e2e test 9 of leave-area-840.spec.ts) showed the cause
// is the shared recipe, not a local override: the modern skin drew white text on a light neon
// gradient (1.4:1 to 2.1:1 in light mode) and the editorial hover lightened the fill under white
// text (2.5:1 to 4.4:1).
//
// jsdom computes no colours, so this test resolves the pairs the recipe draws from the SOURCE of
// `tokens.css` (the helper applies the block chain of each skin x theme x mode in cascade order)
// and pins the declarations of the recipe in `app.css`, so a later edit that points a rule at
// another token or at a literal turns this red before any browser run.

import { describe, expect, it } from "vitest";
import { contrast, over, readAppCss, readTokensCss, resolveColor, type Rgba } from "./token-css";

const TOKENS = readTokensCss();
const APP = readAppCss();

const SKINS = ["editorial", "modern"] as const;
const THEMES = ["pflaume", "nacht", "wald"] as const;
const MODES = ["light", "dark"] as const;

/** The selector blocks that apply to <html> for a look, in cascade order (specificity, then source). */
function blocksFor(skin: (typeof SKINS)[number], theme: (typeof THEMES)[number], mode: string) {
  const blocks: string[] = [":root"];
  if (theme !== "pflaume") blocks.push(`[data-theme="${theme}"]`);
  if (mode === "dark") blocks.push('[data-mode="dark"]');
  if (skin === "modern") {
    blocks.push('[data-skin="modern"]', `[data-skin="modern"][data-theme="${theme}"]`);
    blocks.push(`[data-skin="modern"][data-mode="${mode}"]`);
  }
  return blocks;
}

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** The declarations of the LAST rule whose selector list equals `selector` (whitespace-insensitive). */
function lastRule(css: string, selector: string): Record<string, string> | null {
  const source = stripComments(css);
  const wanted = squash(selector);
  let found: Record<string, string> | null = null;
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (squash(match[1]) !== wanted) continue;
    const declarations: Record<string, string> = {};
    for (const part of match[2].split(";")) {
      const colon = part.indexOf(":");
      if (colon === -1) continue;
      declarations[part.slice(0, colon).trim()] = squash(part.slice(colon + 1));
    }
    found = declarations;
  }
  return found;
}

const MODERN_PRIMARY =
  '[data-skin="modern"] .btn-primary, [data-skin="modern"] .btn.primary, [data-skin="modern"] .btn-brand';
const MODERN_PRIMARY_HOVER =
  '[data-skin="modern"] .btn-primary:hover, [data-skin="modern"] .btn.primary:hover, [data-skin="modern"] .btn-brand:hover';

function opaque(blocks: readonly string[], token: string): Rgba {
  const color = resolveColor(TOKENS, blocks, `var(${token})`);
  // A translucent token would need the surface under it; a primary fill is never translucent.
  return over(color, { r: 255, g: 255, b: 255, a: 1 });
}

describe("#840 G-7 the primary button recipe reaches 4.5:1 in every skin, theme, mode and state", () => {
  for (const skin of SKINS) {
    for (const theme of THEMES) {
      for (const mode of MODES) {
        const blocks = blocksFor(skin, theme, mode);
        const label = `${skin} / ${theme} / ${mode}`;

        if (skin === "editorial") {
          it(`${label}: rest is --text-on-brand on --brand`, () => {
            const ratio = contrast(opaque(blocks, "--text-on-brand"), opaque(blocks, "--brand"));
            expect(ratio).toBeGreaterThanOrEqual(4.5);
          });
          it(`${label}: hover is --text-on-brand on --brand-dark`, () => {
            const ratio = contrast(
              opaque(blocks, "--text-on-brand"),
              opaque(blocks, "--brand-dark"),
            );
            expect(ratio).toBeGreaterThanOrEqual(4.5);
          });
        } else {
          for (const state of ["rest", "hover"]) {
            it(`${label}: ${state} draws --text-on-brand-modern on both gradient stops`, () => {
              const text = opaque(blocks, "--text-on-brand-modern");
              for (const stop of ["--brand-light", "--brand"]) {
                expect(
                  contrast(text, opaque(blocks, stop)),
                  `${stop} (${state})`,
                ).toBeGreaterThanOrEqual(4.5);
              }
            });
          }
        }
      }
    }
  }
});

describe("#840 G-7 the recipe declarations in app.css", () => {
  it("the v1.5 rule draws --text-on-brand on --brand and darkens on hover", () => {
    const rest = lastRule(APP, ".btn-primary");
    expect(rest?.background).toBe("var(--brand)");
    expect(rest?.color).toBe("var(--text-on-brand)");
    const hover = lastRule(APP, ".btn-primary:hover:not(:disabled)");
    expect(hover?.background, "the hover darkens (the original v1 rule), it never lightens").toBe(
      "var(--brand-dark)",
    );
  });

  it("the modern rules draw --text-on-brand-modern on the gradient, at rest and on hover", () => {
    const gradient = "linear-gradient(135deg, var(--brand-light), var(--brand))";
    const rest = lastRule(APP, MODERN_PRIMARY);
    expect(rest?.background).toBe(gradient);
    expect(rest?.color).toBe("var(--text-on-brand-modern)");
    const hover = lastRule(APP, MODERN_PRIMARY_HOVER);
    expect(hover?.background, "the hover keeps the gradient instead of a solid light fill").toBe(
      gradient,
    );
    expect(hover?.color).toBe("var(--text-on-brand-modern)");
  });

  it("no modern primary rule carries a colour literal and no dark-mode literal rule remains", () => {
    expect(
      lastRule(
        APP,
        '[data-skin="modern"][data-mode="dark"] .btn-primary, [data-skin="modern"][data-mode="dark"] .btn.primary, [data-skin="modern"][data-mode="dark"] .btn-brand',
      ),
      "the dark mode uses the same token as the light mode",
    ).toBeNull();
    for (const selector of [MODERN_PRIMARY, MODERN_PRIMARY_HOVER]) {
      const rule = lastRule(APP, selector);
      expect(rule, selector).not.toBeNull();
      const literal = Object.entries(rule ?? {}).filter(
        ([property, value]) =>
          ["color", "background", "background-color"].includes(property) &&
          /#[0-9a-f]{3,8}\b|rgba?\(/i.test(value),
      );
      expect(literal, `${selector} must use tokens only`).toEqual([]);
    }
  });

  it("--text-on-brand itself is untouched: still white in every block that declares it", () => {
    // It is also used as a BACKGROUND (the dashboard timer card, Issue #546), so it must not flip.
    for (const blocks of [
      [":root"],
      [":root", '[data-skin="modern"]', '[data-skin="modern"][data-mode="dark"]'],
      [":root", '[data-skin="modern"]', '[data-skin="modern"][data-mode="light"]'],
    ]) {
      expect(resolveColor(TOKENS, blocks, "var(--text-on-brand)")).toMatchObject({
        r: 255,
        g: 255,
        b: 255,
      });
    }
  });
});
