// Issue #854, D-854-15 - a section title is set in sentence case: no capitals transform and no
// letter-spacing. The guard parses the real CSS (postcss, as design-guards-842 does) of the shared
// Section recipe, the CardHeader title rule and the `.settings-group*` recipe of app.css, plus the
// <style> blocks of every walked Verwalten route file and area component (plan 854-30: no list).

import { describe, expect, it } from "vitest";
import postcss from "postcss";

import { SRC_ROOT, svelteStyleBlocks, walkFiles } from "./design-source-files";
import { verwaltenComponentFiles, verwaltenRouteFiles } from "./verwalten-854-files";

interface Source {
  name: string;
  css: string[];
}

const ALL = walkFiles(SRC_ROOT, [".css", ".svelte"], { includeTests: false });
const byRel = (rel: string) => {
  const file = ALL.find((f) => f.rel === rel);
  if (!file) throw new Error(`section-titles-854: ${rel} not found`);
  return file;
};

/** The rules of `css` whose selector satisfies `pick`, re-serialised so postcss can parse them again. */
function rulesMatching(css: string, pick: (selector: string) => boolean): string {
  const out: string[] = [];
  postcss.parse(css).walkRules((rule) => {
    if (rule.selectors.some(pick)) out.push(rule.toString());
  });
  return out.join("\n");
}

/** Every declaration that breaks the sentence-case rule, as `selector { prop: value }`. */
export function titleStyleViolations(css: string): string[] {
  const hits: string[] = [];
  postcss.parse(css).walkDecls((decl) => {
    const value = decl.value.trim().toLowerCase();
    const selector = decl.parent && "selector" in decl.parent ? String(decl.parent.selector) : "";
    if (decl.prop === "text-transform" && (value === "uppercase" || value === "capitalize")) {
      hits.push(`${selector} { text-transform: ${decl.value} }`);
    }
    if (decl.prop === "letter-spacing" && !["0", "normal", "0em", "0px"].includes(value)) {
      hits.push(`${selector} { letter-spacing: ${decl.value} }`);
    }
  });
  return hits;
}

const appCss = byRel("app.css").text;
const SOURCES: Source[] = [
  {
    name: "lib/components/admin/Section.svelte",
    css: svelteStyleBlocks(byRel("lib/components/admin/Section.svelte").text),
  },
  {
    name: "lib/components/ui/CardHeader.svelte",
    css: svelteStyleBlocks(byRel("lib/components/ui/CardHeader.svelte").text),
  },
  {
    name: "app.css (.settings-group*)",
    css: [rulesMatching(appCss, (s) => s.includes(".settings-group"))],
  },
  {
    name: "app.css (.card-title, .card-hd)",
    css: [rulesMatching(appCss, (s) => /^\.card-(title|hd)\b/.test(s.trim()))],
  },
  ...[...verwaltenRouteFiles(), ...verwaltenComponentFiles()].map((file) => ({
    name: file.rel,
    css: svelteStyleBlocks(file.text),
  })),
];

describe("section titles are sentence case (D-854-15)", () => {
  it("parses the four shared sources and every walked Verwalten file (at least 45)", () => {
    expect(SOURCES.length).toBeGreaterThanOrEqual(4 + 45);
  });

  it("reads real rules: the Section title rule and three settings-group rules", () => {
    const section = SOURCES[0].css.join("\n");
    expect(section).toContain(".section-title");
    const settings = SOURCES[2].css.join("\n");
    for (const selector of [
      ".settings-group-title",
      ".settings-group-desc",
      ".settings-group + .settings-group",
    ]) {
      expect(settings, selector).toContain(selector);
    }
    expect(SOURCES[3].css.join("\n")).toContain(".card-title");
  });

  for (const source of SOURCES) {
    it(`${source.name}: no uppercase / capitalize and no letter-spacing`, () => {
      expect(source.css.flatMap(titleStyleViolations)).toEqual([]);
    });
  }

  it("control: an uppercase, letter-spaced title rule is flagged", () => {
    const bad = ".section-title { text-transform: uppercase; letter-spacing: 0.08em; }";
    expect(titleStyleViolations(bad)).toHaveLength(2);
    expect(titleStyleViolations(".t { text-transform: capitalize }")).toHaveLength(1);
  });

  it("control: a sentence-case title rule is clean", () => {
    const clean =
      ".section-title { font-weight: 600; letter-spacing: normal; text-transform: none; }";
    expect(titleStyleViolations(clean)).toEqual([]);
    expect(titleStyleViolations(".t { letter-spacing: 0 }")).toEqual([]);
  });
});
