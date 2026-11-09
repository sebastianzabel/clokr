// Phase 257 (GitHub issue #257, D-12) — the absence-bar label must be readable.
//
// D-07 makes the LABEL the compensating mechanism for "colour alone is not enough" (WCAG 1.4.1;
// Krank #d97706 and Kinderkrank #ea580c sit close together). A label that fails contrast
// compensates for nothing, so this assertion is load-bearing for the phase's own decision.
//
// It recomputes every ratio from tokens.css with the WCAG 2.x relative-luminance formula — no
// number is copied from the plan. jsdom resolves no custom properties and computes no contrast,
// so the source is parsed directly.
//
// #842 (D-842-10, revised): the leave-type tokens are no longer literal colours but `var()`
// ALIASES of the v2 roles, declared once on `:root, [data-theme], [data-mode]`. The proof
// therefore resolves them through the one cascade resolver (`token-css.ts` on `token-cascade.ts`)
// in all six theme x mode combinations, and Test 5 pins the alias table instead of hex values.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { parseTokenRules } from "./token-cascade";
import {
  COMBINATION_NAMES,
  contrast,
  cardSurface,
  over,
  resolveColor,
  type CombinationName,
} from "./token-css";

function readRepoFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const TOKENS_CSS = readRepoFile("../tokens.css", "src/tokens.css");
// #840 (D-840-07/10): the month grid and its `.cal-chip` left the team page; a bar is drawn by the
// one timeline component now, so Test 4 reads its bar CSS instead of the page's chip CSS.
const TIMELINE = readRepoFile(
  "../lib/components/leave/timeline/AbsenceTimeline.svelte",
  "src/lib/components/leave/timeline/AbsenceTimeline.svelte",
);

// ── The alias block of tokens.css (D-842-10) ────────────────────────────────
// The rule that declares the leave-type tokens, found by content (not by a selector substring, so
// the identifier-prefix trap of the earlier block extraction cannot come back).
const ALIAS_RULES = parseTokenRules(TOKENS_CSS).filter((rule) =>
  rule.decls.some((d) => d.prop.startsWith("--leave-type-")),
);
const ALIAS_SELECTORS = ALIAS_RULES.map((rule) => rule.selector).sort();
const ALIAS_DECLS = new Map(
  ALIAS_RULES.flatMap((rule) => rule.decls)
    .filter((d) => d.prop.startsWith("--leave-type-"))
    .map((d) => [d.prop, d.value] as const),
);
const FILLS = [...ALIAS_DECLS.keys()].filter((k) => !k.endsWith("-text")).sort();
const COMBINATIONS_UNDER_TEST = COMBINATION_NAMES as CombinationName[];

/** The D-842-10 alias table: fill token -> the role it is an alias of. The -text partner is --card, except HOLIDAY. */
const EXPECTED_FILL_ALIASES: Record<string, string> = {
  "--leave-type-vacation": "var(--ok)",
  "--leave-type-sick": "var(--warn)",
  "--leave-type-sick-child": "var(--a2-t)",
  "--leave-type-special": "var(--a5-t)",
  "--leave-type-overtime": "var(--a4-t)",
  "--leave-type-education": "var(--info)",
  "--leave-type-unpaid": "var(--a3-t)",
  "--leave-type-holiday": "var(--brand)",
  "--leave-type-maternity": "var(--a6-t)",
  "--leave-type-parental": "var(--a1-t)",
  "--leave-type-absent": "var(--text-2)",
  "--leave-type-absent-muted": "var(--text-3)",
  "--leave-type-default": "var(--text-2)",
};

describe("leave-chip-contrast — WCAG AA for every --leave-type-* fill/text pair (Phase 257, D-12; #842 D-842-10)", () => {
  it("Test 0: the alias block is parsed, holds all 26 leave tokens and is declared on every themed element", () => {
    expect(ALIAS_RULES.length).toBeGreaterThan(0);
    expect(ALIAS_DECLS.size).toBe(26);
    expect(FILLS).toHaveLength(13);
    // A var() alias resolves where it is declared: it has to be declared on the root, on a themed
    // element and on a moded element, otherwise a preview element would keep the document's colours.
    expect(ALIAS_SELECTORS).toEqual([":root", "[data-mode]", "[data-theme]"]);
    expect(COMBINATIONS_UNDER_TEST).toHaveLength(6);
  });

  it("Test 1: every fill token has a -text partner, resolvable in all six combinations", () => {
    const texts = [...ALIAS_DECLS.keys()]
      .filter((k) => k.endsWith("-text"))
      .map((k) => k.replace(/-text$/, ""))
      .sort();
    expect(texts).toEqual(FILLS);
    let resolved = 0;
    for (const combination of COMBINATIONS_UNDER_TEST) {
      for (const fill of FILLS) {
        expect(
          () => resolveColor(TOKENS_CSS, combination, `var(${fill})`),
          `${fill} in ${combination}`,
        ).not.toThrow();
        expect(
          () => resolveColor(TOKENS_CSS, combination, `var(${fill}-text)`),
          `${fill}-text in ${combination}`,
        ).not.toThrow();
        resolved += 2;
      }
    }
    expect(resolved).toBe(13 * 2 * 6);
  });

  it("Test 2: every fill/text pair reaches WCAG AA (>= 4.5:1), in all six combinations — generated", () => {
    let caseCount = 0;
    for (const combination of COMBINATIONS_UNDER_TEST) {
      const card = cardSurface(TOKENS_CSS, combination);
      for (const fill of FILLS) {
        caseCount++;
        const fillColor = over(resolveColor(TOKENS_CSS, combination, `var(${fill})`), card);
        const textColor = over(
          resolveColor(TOKENS_CSS, combination, `var(${fill}-text)`),
          fillColor,
        );
        const ratio = contrast(textColor, fillColor);
        expect(ratio, `${fill} in ${combination}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
    expect(caseCount).toBe(13 * 6);
  });

  it("Test 2b: the checker can fail — a role that is not a text pair measures below the floor", () => {
    // Negative control: the honey accent is a fill only (D-842-07) and does not reach 4.5:1 on the card.
    const combination: CombinationName = "pflaume-light";
    const card = cardSurface(TOKENS_CSS, combination);
    const accent = over(resolveColor(TOKENS_CSS, combination, "var(--accent)"), card);
    expect(contrast(accent, card)).toBeLessThan(4.5);
  });

  it("Test 3: -text tokens are foreground only — never a background", () => {
    let srcRoot: string;
    try {
      srcRoot = fileURLToPath(new URL("../", import.meta.url));
    } catch {
      srcRoot = resolve(process.cwd(), "src");
    }
    const files: string[] = [];
    function walk(dir: string) {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
          if (entry === "node_modules") continue;
          walk(full);
        } else if ([".svelte", ".css", ".ts"].includes(extname(full))) {
          files.push(full);
        }
      }
    }
    walk(srcRoot);

    // Anti-vacuity: a walk that found nothing must fail, not pass silently — this assertion
    // is itself the non-emptiness proof for the walked (input) set.
    expect(files.length).toBeGreaterThan(50);

    const offenders = files.filter((f) => {
      const content = readFileSync(f, "utf8");
      return /(background|background-color|border-color|fill)\s*:[^;]*--leave-type-[a-z-]+-text/.test(
        content,
      );
    });
    expect(offenders).toEqual([]);
  });

  it("Test 4: the bar renders the token and nothing dilutes it", () => {
    // #840: the invariant is unchanged - the bar text colour is the type's `-text` token and no
    // opacity or white wash is laid over it - but it now lives in AbsenceTimeline's bar CSS.
    expect(TIMELINE).toContain('style:--bar-text="var({color.text})"');
    const barStart = TIMELINE.indexOf("  .absence-bar--gesetzt {");
    const barEnd = TIMELINE.indexOf("  /* Wish: diagonal brand stripes with an outline. */");
    expect(barStart).toBeGreaterThan(-1);
    expect(barEnd).toBeGreaterThan(barStart);
    const BAR_CSS = TIMELINE.slice(barStart, barEnd);
    expect(BAR_CSS).toContain("color: var(--bar-text);");
    expect(BAR_CSS).toContain("border: 2px dashed var(--bar-fill);");
    expect(BAR_CSS).not.toContain("opacity: 0.85");
    expect(BAR_CSS).not.toContain("opacity: 0.9");
    expect(BAR_CSS).not.toContain("rgba(255, 255, 255, 0.7)");
    expect(BAR_CSS.length).toBeGreaterThan(200); // the slice actually found the block
  });

  it("Test 5: the alias table is exactly D-842-10 — no colour literal, no value of its own", () => {
    // Pins the alias table as `var()` references. This is the one place hardcoding is right: it is
    // the assertion that the leave palette stays an alias of the roles and that nobody "fixes"
    // contrast by writing a hex value into the alias block.
    for (const [fill, alias] of Object.entries(EXPECTED_FILL_ALIASES)) {
      expect(ALIAS_DECLS.get(fill), fill).toBe(alias);
      const expectedText = fill === "--leave-type-holiday" ? "var(--brand-ink)" : "var(--card)";
      expect(ALIAS_DECLS.get(`${fill}-text`), `${fill} text partner`).toBe(expectedText);
    }
    for (const rule of ALIAS_RULES) {
      for (const decl of rule.decls) {
        expect(decl.value, `${decl.prop} in ${rule.selector}`).not.toMatch(
          /#[0-9a-f]{3,8}\b|rgba?\(/i,
        );
      }
    }
  });
});
