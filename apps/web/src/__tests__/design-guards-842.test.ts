// Issue #842, plan 17 — the design-system rules that are mechanical. Each guard walks the
// production sources of `apps/web/src` (tests excluded), states a non-empty floor and proves its
// matcher on in-memory fixtures (positive control), so a moved directory or a loosened regex turns
// the guard red instead of letting it report success having checked nothing.
//
//   D-842-12  no italic anywhere, an upright reset for em/i, no uppercase in the shared app.css
//             recipes, no letter-spacing on the eight shared label recipes
//   D-842-07  --accent is a fill, never a text colour
//   D-842-08  no white text on a brand, status or text fill (use --card / --brand-ink)
//   D-842-01  tokens.css is the only file that declares a colour role (D-05)
//   IN-02     data-mode is the colour-mode attribute: a component names its own modes differently
//   WR-02     app.css holds no colour literal outside a short, reasoned allow-list
//   WR-01     the live dot of the timer card is drawn from a role that reads on the brand gradient

import { describe, it, expect } from "vitest";
import postcss from "postcss";

import { SRC_ROOT, svelteStyleBlocks, walkFiles } from "./design-source-files";

const SOURCES = walkFiles(SRC_ROOT, [".css", ".svelte", ".ts", ".js"], { includeTests: false });
const STYLED = SOURCES.filter((f) => f.rel.endsWith(".css") || f.rel.endsWith(".svelte"));
const APP_CSS = SOURCES.find((f) => f.rel === "app.css")!;

/** All CSS of a file as parseable strings: a .css file whole, a .svelte file's <style> blocks. */
function cssChunks(file: { rel: string; text: string }): string[] {
  return file.rel.endsWith(".css") ? [file.text] : svelteStyleBlocks(file.text);
}

// ── Matchers (exported to the positive controls below) ───────────────────────────────────────

const ITALIC_RE = /font-style\s*:\s*(?:italic|oblique)/g;

const ACCENT_TEXT_RE =
  /(?<![\w-])color\s*:[^;}]*var\(\s*--accent(?![\w-])|style:color\s*=[^>]*--accent(?![\w-])/g;

const WHITE_RE = /^(?:#fff(?:fff)?|white|rgba?\(\s*255\s*[, ]\s*255\s*[, ]\s*255\b.*)$/i;
const FILL_RE = /var\(\s*--(?:brand|brand-hover|ok|warn|bad|info|text)\s*[,)]/;

/** Rules that pair a white text colour with a brand, status or text background. */
export function whiteOnFillRules(css: string): string[] {
  const hits: string[] = [];
  postcss.parse(css).walkRules((rule) => {
    let white = false;
    let fill = false;
    rule.each((node) => {
      if (node.type !== "decl") return;
      const value = node.value.trim();
      if (node.prop === "color" && WHITE_RE.test(value)) white = true;
      if ((node.prop === "background" || node.prop === "background-color") && FILL_RE.test(value)) {
        fill = true;
      }
    });
    if (white && fill) hits.push(rule.selector);
  });
  return hits;
}

const ROLES = [
  "bg",
  "card",
  "rail",
  "sunk",
  "hover",
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
  "ok",
  "ok-soft",
  "warn",
  "warn-soft",
  "bad",
  "bad-soft",
  "info",
  "info-soft",
  ...[1, 2, 3, 4, 5, 6].flatMap((n) => [`a${n}`, `a${n}-t`]),
];

/** Role names a text declares: `--x:`, `style:--x=`, `setProperty("--x"`. */
export function declaredRoles(text: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /(?<![\w-])(--[\w-]+)\s*:/g,
    /style:(--[\w-]+)/g,
    /setProperty\(\s*["'`](--[\w-]+)/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      if (ROLES.includes(m[1].slice(2))) found.add(m[1]);
    }
  }
  return [...found];
}

// ── WR-02: colour literals ───────────────────────────────────────────────────────────────────

const LITERAL_RE = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\([^)]*\)/gi;

export interface LiteralHit {
  selector: string;
  prop: string;
  literal: string;
}

/** Every hex / rgb[a] / hsl[a] literal in the declarations of `css` (keyframe steps included). */
export function colourLiterals(css: string): LiteralHit[] {
  const hits: LiteralHit[] = [];
  postcss.parse(css).walkDecls((decl) => {
    const rule = decl.parent as postcss.Rule | undefined;
    const selector = rule && "selector" in rule ? rule.selector.replace(/\s+/g, " ").trim() : "";
    for (const m of decl.value.matchAll(LITERAL_RE)) {
      hits.push({ selector, prop: decl.prop, literal: m[0] });
    }
  });
  return hits;
}

interface AllowedLiteral {
  prop: string;
  /** Matches the literal as written. */
  literal: RegExp;
  /** Restricts the entry to rules with exactly this selector; omitted = any selector. */
  selector?: string;
  reason: string;
}

/**
 * The only colour literals app.css may hold. Everything that is a colour of the design system is a
 * role of tokens.css (D-842-01); what remains is neutral black/ink that darkens whatever is behind
 * it, which must look the same in every theme and mode.
 */
export const ALLOWED_LITERALS: readonly AllowedLiteral[] = [
  {
    prop: "box-shadow",
    literal: /^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*[\d.]+\)$/,
    reason: "Neutral black elevation shadow; a shadow darkens the surface under it in every theme.",
  },
  {
    prop: "box-shadow",
    literal: /^rgba\(\s*20\s*,\s*16\s*,\s*24\s*,\s*0?\.28\)$/,
    selector: ".modal",
    reason:
      "Dark-ink drop shadow of the modal card, the same neutral darkening as the shadow tokens.",
  },
  {
    prop: "background",
    literal: /^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0?\.4\)$/,
    selector: ".dialog-backdrop",
    reason: "Dialog backdrop dims the page behind it; it is a scrim, not a theme colour.",
  },
  {
    prop: "background",
    literal: /^rgba\(\s*20\s*,\s*16\s*,\s*24\s*,\s*0?\.55\)$/,
    selector: ".scrim",
    reason: "Modal scrim dims the page behind it; it is a scrim, not a theme colour.",
  },
];

export function isAllowedLiteral(
  hit: LiteralHit,
  list: readonly AllowedLiteral[] = ALLOWED_LITERALS,
): boolean {
  return list.some(
    (entry) =>
      entry.prop === hit.prop &&
      entry.literal.test(hit.literal) &&
      (entry.selector === undefined || entry.selector === hit.selector),
  );
}

describe("Issue #842 design guards", () => {
  it("walk real trees (anti-vacuity)", () => {
    expect(SOURCES.length).toBeGreaterThan(50);
    expect(STYLED.length).toBeGreaterThan(50);
    expect(APP_CSS).toBeDefined();
    expect(SOURCES.some((f) => f.rel === "tokens.css")).toBe(true);
    expect(SOURCES.some((f) => f.rel.includes("__tests__"))).toBe(false);
    // Svelte files really contribute style blocks.
    expect(
      STYLED.filter((f) => f.rel.endsWith(".svelte") && cssChunks(f).length > 0).length,
    ).toBeGreaterThan(30);
  });

  describe("D-842-12 - no italics", () => {
    it("matcher fires (positive control)", () => {
      expect("a { font-style: italic; }".match(ITALIC_RE)).toHaveLength(1);
      expect("a { font-style:oblique }".match(ITALIC_RE)).toHaveLength(1);
      expect("a { font-style: normal; }".match(ITALIC_RE)).toBeNull();
    });

    it("no font-style italic in any CSS or Svelte file of src", () => {
      const hits = STYLED.filter((f) => ITALIC_RE.test(f.text) || f.text.match(ITALIC_RE)).map(
        (f) => f.rel,
      );
      expect(hits).toEqual([]);
    });

    it("app.css resets em and i to upright", () => {
      const reset = postcss
        .parse(APP_CSS.text)
        .nodes.filter((n): n is postcss.Rule => n.type === "rule")
        .find(
          (r) =>
            r.selectors.map((s) => s.trim()).includes("em") &&
            r.selectors.map((s) => s.trim()).includes("i"),
        );
      expect(reset, "a rule with the selectors em and i").toBeDefined();
      const decl = reset!.nodes.find(
        (n): n is postcss.Declaration => n.type === "decl" && n.prop === "font-style",
      );
      expect(decl?.value).toBe("normal");
    });
  });

  describe("D-842-07 - --accent is never a text colour", () => {
    it("matcher fires (positive control)", () => {
      expect("a { color: var(--accent); }".match(ACCENT_TEXT_RE)).toHaveLength(1);
      expect(
        "a { color: color-mix(in srgb, var(--accent) 50%, var(--card)); }".match(ACCENT_TEXT_RE),
      ).toHaveLength(1);
      expect('<b style:color="var(--accent)">'.match(ACCENT_TEXT_RE)).toHaveLength(1);
      expect(
        "a { background: var(--accent); border-color: var(--accent); }".match(ACCENT_TEXT_RE),
      ).toBeNull();
      expect("a { color: var(--accent-x); }".match(ACCENT_TEXT_RE)).toBeNull();
    });

    it("no color declaration reads --accent in src", () => {
      const hits = SOURCES.filter((f) => f.text.match(ACCENT_TEXT_RE)).map((f) => f.rel);
      expect(hits).toEqual([]);
    });
  });

  describe("D-842-08 - no white text on a brand, status or text fill", () => {
    it("matcher fires (positive control)", () => {
      expect(whiteOnFillRules(".a { color: #fff; background: var(--bad); }")).toEqual([".a"]);
      expect(
        whiteOnFillRules(".a { color: white; background-color: var(--brand-hover); }"),
      ).toEqual([".a"]);
      expect(
        whiteOnFillRules(".a { color: rgba(255, 255, 255, 0.7); background: var(--text); }"),
      ).toEqual([".a"]);
      expect(
        whiteOnFillRules(
          ".a { color: #ffffff; background: linear-gradient(var(--brand-hover), var(--brand)); }",
        ),
      ).toEqual([".a"]);
      expect(whiteOnFillRules(".a { color: var(--card); background: var(--bad); }")).toEqual([]);
      expect(whiteOnFillRules(".a { color: #fff; background: var(--bad-soft); }")).toEqual([]);
      expect(whiteOnFillRules(".a { color: #fff; background: var(--text-2); }")).toEqual([]);
    });

    it("no rule of app.css or a Svelte style block pairs white text with such a fill", () => {
      const hits = STYLED.flatMap((f) =>
        cssChunks(f).flatMap((chunk) => whiteOnFillRules(chunk).map((sel) => `${f.rel}: ${sel}`)),
      );
      expect(hits).toEqual([]);
    });
  });

  describe("D-842-12 - shared label recipes of app.css", () => {
    it("app.css has no text-transform: uppercase", () => {
      expect(APP_CSS.text.match(/text-transform\s*:\s*uppercase/g)).toBeNull();
      // Positive control of the matcher.
      expect(
        "a { text-transform: uppercase; }".match(/text-transform\s*:\s*uppercase/g),
      ).toHaveLength(1);
    });

    it("the eight shared label recipes carry no letter-spacing and no uppercase", () => {
      const LABELS = [
        ".stat-card .stat-label",
        ".data-table th",
        ".cal-dow",
        ".cal-cell .cal-abs-type",
        ".card-title",
        ".kpi-label",
        ".mini-stat .label",
        ".shift-grid .head",
      ];
      const norm = (s: string) => s.replace(/\s+/g, " ").trim();
      const found = new Map<string, string[]>();
      postcss.parse(APP_CSS.text).walkRules((rule) => {
        for (const sel of rule.selectors.map(norm)) {
          if (!LABELS.includes(sel)) continue;
          const props = rule.nodes
            .filter((n): n is postcss.Declaration => n.type === "decl")
            .map((d) => d.prop);
          found.set(sel, [...(found.get(sel) ?? []), ...props]);
        }
      });
      // Every recipe really exists (a renamed recipe must be renamed here too).
      expect([...found.keys()].sort()).toEqual([...LABELS].sort());
      for (const [sel, props] of found) {
        expect(props, sel).not.toContain("letter-spacing");
        expect(props, sel).not.toContain("text-transform");
      }
    });
  });

  describe("WR-01 - the live dot reads on the timer card in all six combinations", () => {
    it("draws from --brand-ink, the text colour of the brand gradient it sits on", () => {
      const dot: string[] = [];
      let timerInk = "";
      postcss.parse(APP_CSS.text).walkRules((rule) => {
        const sels = rule.selectors.map((s) => s.trim());
        rule.walkDecls((d) => {
          if (sels.includes(".live-dot") && d.prop === "background") dot.push(d.value.trim());
          if (sels.includes(".timer-card") && d.prop === "color") timerInk = d.value.trim();
        });
      });
      // The dot lives on .timer-card, whose text is --brand-ink; token-contrast-842 pins that
      // role at 4.5:1 on both gradient ends in every combination.
      expect(timerInk).toBe("var(--brand-ink)");
      expect(dot).toEqual(["var(--brand-ink)"]);
    });
  });

  describe("WR-02 - no colour literal in app.css outside the allow-list", () => {
    it("matcher fires (positive control)", () => {
      expect(colourLiterals("a { color: #c2410c; }")).toEqual([
        { selector: "a", prop: "color", literal: "#c2410c" },
      ]);
      expect(colourLiterals("a { border: 1px solid rgba(194, 65, 12, 0.2); }")).toEqual([
        { selector: "a", prop: "border", literal: "rgba(194, 65, 12, 0.2)" },
      ]);
      expect(colourLiterals("a { color: hsl(10 20% 30%); }")).toHaveLength(1);
      expect(colourLiterals("@keyframes k { 0% { box-shadow: 0 0 0 rgba(0,0,0,.1); } }")).toEqual([
        { selector: "0%", prop: "box-shadow", literal: "rgba(0,0,0,.1)" },
      ]);
      expect(colourLiterals("a { color: var(--ok); background: transparent; }")).toEqual([]);
      expect(
        colourLiterals("a { color: color-mix(in srgb, var(--bad) 30%, transparent); }"),
      ).toEqual([]);
      // The allow-list passes what it names and nothing else.
      const only = (css: string) => colourLiterals(css).filter((hit) => !isAllowedLiteral(hit));
      expect(only("a { box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15); }")).toEqual([]);
      expect(only("a { color: rgba(0, 0, 0, 0.15); }")).toHaveLength(1);
      expect(only(".scrim { background: rgba(20, 16, 24, 0.55); }")).toEqual([]);
      expect(only(".other { background: rgba(20, 16, 24, 0.55); }")).toHaveLength(1);
    });

    it("every literal left in app.css is allow-listed with a reason", () => {
      const hits = colourLiterals(APP_CSS.text);
      // The allow-listed shadows and scrims really exist (a removed one must leave the list too).
      expect(hits.length).toBeGreaterThanOrEqual(7);
      const unlisted = hits.filter((hit) => !isAllowedLiteral(hit));
      expect(unlisted.map((h) => `${h.selector} { ${h.prop}: ${h.literal} }`)).toEqual([]);
      for (const entry of ALLOWED_LITERALS) {
        expect(entry.reason.length, entry.prop).toBeGreaterThan(20);
        expect(
          hits.some((hit) => isAllowedLiteral(hit, [entry])),
          `${entry.prop} ${entry.literal} is no longer used - remove it from the allow-list`,
        ).toBe(true);
      }
    });
  });

  describe("IN-02 - data-mode is reserved for the colour mode", () => {
    const MODE_ATTR_RE = /<[A-Za-z][^<>]*\sdata-mode\s*=/g;

    it("matcher fires (positive control)", () => {
      expect("<div data-mode={mode}>".match(MODE_ATTR_RE)).toHaveLength(1);
      expect('<div data-mode="edit">'.match(MODE_ATTR_RE)).toHaveLength(1);
      expect("<div data-dialog-mode={mode}>".match(MODE_ATTR_RE)).toBeNull();
      expect('[data-mode="dark"] .a {}'.match(MODE_ATTR_RE)).toBeNull();
    });

    it("only the theme preview sets a data-mode attribute in markup", () => {
      const hits = SOURCES.filter(
        (f) => f.rel.endsWith(".svelte") && f.text.match(MODE_ATTR_RE) !== null,
      ).map((f) => f.rel);
      expect(hits).toEqual(["routes/(app)/admin/themes/+page.svelte"]);
    });
  });

  describe("D-842-01 - tokens.css is the only declaration site of a colour role", () => {
    it("matcher fires (positive control)", () => {
      expect(declaredRoles(":root { --brand: red; --card: white; }").sort()).toEqual([
        "--brand",
        "--card",
      ]);
      expect(declaredRoles('<i style:--a1-t="red">')).toEqual(["--a1-t"]);
      expect(declaredRoles('el.style.setProperty("--ok", "x");')).toEqual(["--ok"]);
      expect(declaredRoles(".a { color: var(--brand); --plan-col-w: 3px; }")).toEqual([]);
      expect(declaredRoles(".ksc--text: 1")).toEqual([]);
    });

    it("tokens.css declares roles, no other file does", () => {
      const tokens = SOURCES.find((f) => f.rel === "tokens.css")!;
      expect(declaredRoles(tokens.text).length).toBeGreaterThanOrEqual(ROLES.length);
      const offenders = SOURCES.filter((f) => f.rel !== "tokens.css")
        .map((f) => ({ rel: f.rel, roles: declaredRoles(f.text) }))
        .filter((f) => f.roles.length > 0)
        .map((f) => `${f.rel}: ${f.roles.join(", ")}`);
      expect(offenders).toEqual([]);
    });
  });
});
