// Issue #842, D-842-25 (AC-2) — the contrast proof for design system v2.
//
// Parses the REAL `tokens.css`, resolves the cascade for the six combinations (pflaume | salz |
// petrol x light | dark) through the one resolver `token-cascade.ts`, asserts that every role the
// design system names is defined in each combination, and checks that every foreground/background
// pair that carries text reaches the WCAG 2.x floor of 4.5:1.
//
// This file supersedes `saldo-dark-contrast.test.ts` (removed in the same commit): the pairs it
// pinned — the former good/bad text colours on the dark card — are now the ok and bad roles on the
// card in all six combinations (see the status pairs below).
//
// Deliberate non-pairs, each with its reason:
//  - Text on --accent is not a pair: the honey accent is a fill/indicator only and never carries
//    text (D-842-07; a guard elsewhere fails on `color: var(--accent)`).
//  - --text-3 on --brand-soft / --brand-tint is not a pair (P7 of the research): the faint text
//    colour is for neutral surfaces; on the tinted brand surfaces the text colours that are used
//    are --text and --text-2. In Pflaume dark it measures 3.70:1, which the negative control below
//    uses to prove the checker can fail.
//  - --line and --line-2 are borders; the 3:1 non-text contrast of control borders belongs to the
//    field component (deferred to #843).
//
// Deviations from the prototype values (D-842-06) are pinned by value at the bottom, so a silent
// revert to a prototype hex turns this file red.

import { describe, expect, it } from "vitest";
import {
  COMBINATIONS,
  contrast,
  over,
  parseTokenRules,
  readTokensCss,
  resolveColor,
  resolveCombination,
  cascadeCombination,
  type Combination,
} from "./token-cascade";

const css = readTokensCss();

const SURFACES = ["bg", "card", "rail", "sunk", "hover"] as const;
const STATUSES = ["ok", "warn", "bad", "info"] as const;
const AVATARS = [1, 2, 3, 4, 5, 6] as const;

/** Every colour role of D-842-04 (names without the leading dashes). */
const COLOR_ROLES: readonly string[] = [
  ...SURFACES,
  "line",
  "line-2",
  "text",
  "text-2",
  "text-3",
  "brand",
  "brand-hover",
  "brand-soft",
  "brand-tint",
  "brand-ink",
  "accent",
  ...STATUSES.flatMap((s) => [s, `${s}-soft`]),
  ...AVATARS.flatMap((n) => [`a${n}`, `a${n}-t`]),
];

/** The non-colour tokens of D-842-09 that must resolve to a non-empty value everywhere. */
const PLAIN_TOKENS: readonly string[] = [
  "font-ui",
  "font-code",
  "fs-base",
  "fs-sm",
  "fs-xs",
  "fs-th",
  "fs-h1",
  "fs-h2",
  "fs-kpi",
  "fs-hero",
  "h-control",
  "h-control-sm",
  "h-stage",
  "h-row",
  "h-th",
  "r-card",
  "r-control",
  "r-stage",
  "r-pill",
  "shadow",
  "shadow-pop",
  "s-1",
  "s-2",
  "s-3",
  "s-4",
  "s-5",
  "s-6",
  "s-8",
  "s-10",
  "s-12",
  "s-16",
  "ease",
  "ease-out",
  "sidebar-w",
  "topbar-h",
];

/** The thirteen leave-type tokens (fill; the text partner appends `-text`). */
const LEAVE_TYPES = [
  "vacation",
  "sick",
  "sick-child",
  "special",
  "overtime",
  "education",
  "unpaid",
  "holiday",
  "maternity",
  "parental",
  "absent",
  "absent-muted",
  "default",
] as const;

const label = (c: Combination) => `${c.theme}/${c.mode}`;

/** Pairs of [foreground, background] role names that carry text (D-842-25). */
function textPairs(): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const fg of ["text", "text-2", "text-3"]) for (const bg of SURFACES) pairs.push([fg, bg]);
  for (const fg of ["text", "text-2"])
    for (const bg of ["brand-soft", "brand-tint"]) {
      pairs.push([fg, bg]);
    }
  for (const bg of [...SURFACES, "brand-soft", "brand-tint"]) pairs.push(["brand", bg]);
  for (const bg of ["brand", "brand-hover"]) pairs.push(["brand-ink", bg]);
  for (const s of STATUSES) {
    for (const bg of ["bg", "card", "sunk", `${s}-soft`]) pairs.push([s, bg]);
    pairs.push(["card", s]); // text on a solid status fill (D-842-08)
  }
  for (const n of AVATARS) pairs.push([`a${n}-t`, `a${n}`]);
  return pairs;
}

/** The ratio of a pair in one combination, both colours composited over the page background. */
function ratio(map: Map<string, string>, fg: string, bg: string): number {
  const page = resolveColor(map, "var(--bg)");
  const back = over(resolveColor(map, `var(--${bg})`), page);
  return contrast(over(resolveColor(map, `var(--${fg})`), back), back);
}

interface Failure {
  where: string;
  ratio: number;
}

/** The shared checker: every pair below `floor` in the combination, as failures. */
function failingPairs(
  combo: Combination,
  map: Map<string, string>,
  pairs: Array<[string, string]>,
  floor = 4.5,
): Failure[] {
  const failures: Failure[] = [];
  for (const [fg, bg] of pairs) {
    const r = ratio(map, fg, bg);
    if (r < floor) failures.push({ where: `${label(combo)} ${fg} on ${bg}`, ratio: r });
  }
  return failures;
}

const print = (failures: Failure[]) => failures.map((f) => `${f.where} = ${f.ratio.toFixed(2)}`);

describe("token-contrast-842 — anti-vacuity", () => {
  it("resolves exactly six combinations from a token file with enough rules", () => {
    expect(COMBINATIONS).toHaveLength(6);
    // One entry per selector of every top-level rule: ten at least (three themes light, the dark
    // roles, two theme-and-dark overrides, the alias block).
    expect(parseTokenRules(css).length).toBeGreaterThanOrEqual(9);
    expect(textPairs().length).toBeGreaterThanOrEqual(54);
  });
});

describe.each(COMBINATIONS.map((c) => [label(c), c] as const))("%s", (_name, combo) => {
  const map = resolveCombination(css, combo.theme, combo.mode);

  it("defines every colour role as an opaque colour", () => {
    const missing = COLOR_ROLES.filter((role) => !map.has(`--${role}`));
    expect(missing).toEqual([]);
    const translucent = COLOR_ROLES.filter((role) => resolveColor(map, `var(--${role})`).a < 0.999);
    expect(translucent).toEqual([]);
  });

  it("defines every non-colour token with a non-empty value", () => {
    const empty = PLAIN_TOKENS.filter((name) => !(map.get(`--${name}`) ?? "").trim());
    expect(empty).toEqual([]);
  });

  it("sets color-scheme from the mode", () => {
    expect(map.get("color-scheme")).toBe(combo.mode);
  });

  it("reaches 4.5:1 on every text pair of D-842-25", () => {
    expect(print(failingPairs(combo, map, textPairs()))).toEqual([]);
  });

  it("reaches 4.5:1 on every leave-type fill with its text partner (D-842-10)", () => {
    const pairs = LEAVE_TYPES.map((t): [string, string] => [
      `leave-type-${t}-text`,
      `leave-type-${t}`,
    ]);
    expect(pairs).toHaveLength(13);
    expect(print(failingPairs(combo, map, pairs))).toEqual([]);
  });
});

describe("token-contrast-842 — nested previews are complete (D-842-02, WR-03)", () => {
  // A preview element that carries both attributes but is not the document element does not match
  // `:root`. If a role is declared only there - or only in a block that does not match the
  // combination - the element inherits it from its ancestor: a Petrol preview inside a Salz page
  // got the Salz honey accent. The nested cascade therefore has to define every colour role.
  it.each(COMBINATIONS.map((c) => [label(c), c] as const))(
    "%s declares every colour role without :root",
    (_name, combo) => {
      const nested = cascadeCombination(css, combo.theme, combo.mode, true);
      expect(COLOR_ROLES.filter((role) => !nested.has(`--${role}`))).toEqual([]);
      expect(nested.get("color-scheme")).toBe(combo.mode);
    },
  );

  it("resolves the accent of the previewed theme, not an ancestor's", () => {
    for (const mode of ["light", "dark"] as const) {
      const accent = (theme: "pflaume" | "salz" | "petrol") =>
        resolveCombination(css, theme, mode, true).get("--accent");
      expect(accent("pflaume"), `pflaume/${mode}`).toBe("#d9a441");
      expect(accent("salz"), `salz/${mode}`).toBe("#c98a3a");
      expect(accent("petrol"), `petrol/${mode}`).toBe("#d9a441");
    }
  });

  it("negative control: without the Petrol accent declaration the nested cascade has a gap", () => {
    const stripped = css.replace(/\n\s*--accent: #d9a441;(?=[^}]*\}\s*\/\* ─── Shared dark)/, "");
    expect(stripped).not.toBe(css);
    expect(cascadeCombination(stripped, "petrol", "dark", true).has("--accent")).toBe(false);
  });
});

describe("token-contrast-842 — leave-type aliases (D-842-10)", () => {
  it("declares every leave-type token as a var() alias in every combination, never a literal", () => {
    for (const combo of COMBINATIONS) {
      const raw = cascadeCombination(css, combo.theme, combo.mode);
      const names = LEAVE_TYPES.flatMap((t) => [`--leave-type-${t}`, `--leave-type-${t}-text`]);
      expect(names).toHaveLength(26);
      const literal = names.filter((n) => !/^var\(--[a-z0-9-]+\)$/.test(raw.get(n) ?? ""));
      expect(literal, label(combo)).toEqual([]);
    }
  });
});

describe("token-contrast-842 — D-842-06 deviations from the prototype are pinned", () => {
  const value = (theme: string, mode: string, name: string) =>
    resolveCombination(css, theme as never, mode as never).get(name);

  it("pins --text-3 in all six combinations", () => {
    expect(value("pflaume", "light", "--text-3")).toBe("#72686d");
    expect(value("salz", "light", "--text-3")).toBe("#6b686d");
    expect(value("petrol", "light", "--text-3")).toBe("#616e6c");
    expect(value("pflaume", "dark", "--text-3")).toBe("#90878d");
    expect(value("salz", "dark", "--text-3")).toBe("#8c8b90");
    expect(value("petrol", "dark", "--text-3")).toBe("#859391");
  });

  it("pins the light --warn of all three themes", () => {
    for (const theme of ["pflaume", "salz", "petrol"]) {
      expect(value(theme, "light", "--warn"), theme).toBe("#975f16");
    }
  });

  it("pins the Petrol light --text-2", () => {
    expect(value("petrol", "light", "--text-2")).toBe("#5c6a68");
  });
});

describe("token-contrast-842 — negative control", () => {
  const dark = COMBINATIONS.find((c) => c.theme === "pflaume" && c.mode === "dark")!;
  const map = resolveCombination(css, dark.theme, dark.mode);

  it("reports a synthetic pair below 4.5:1", () => {
    const synthetic = new Map(map);
    synthetic.set("--fake-fg", "#8a8a8a");
    synthetic.set("--fake-bg", "#999999");
    expect(failingPairs(dark, synthetic, [["fake-fg", "fake-bg"]])).toHaveLength(1);
  });

  it("reports text-3 on brand-soft in Pflaume dark — a deliberate non-pair (measured 3.70:1)", () => {
    // Not part of D-842-25: --text-3 is for neutral surfaces. The pair is used here only to prove
    // that the checker reports a real failure of the real token file.
    const failures = failingPairs(dark, map, [["text-3", "brand-soft"]]);
    expect(failures).toHaveLength(1);
    expect(failures[0].ratio).toBeGreaterThan(3.5);
    expect(failures[0].ratio).toBeLessThan(4.5);
  });
});
