// Issue #854, AC-1 (D-854-28) - the guard of the Verwalten pages: every Verwalten route file and area
// component is built from the #843 blocks, not from page-own chrome. It is modelled on the Team guard of #853
// (the detectors are re-stated here on purpose: the two phases ship independently and neither may
// import the other's test).
//
// Enforcement covers EVERY walked file (verwalten-854-files.ts); since plan 854-30 there is no migration
// list, so a new Verwalten page or component is guarded from its first commit. A walk that matches
// nothing reports OK forever, so the walked sets carry non-empty floors and every detector has a
// positive control and a clean control (the same discipline as no-loading-text-843).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { detectPagePatterns } from "../../scripts/lint-ui-classes.mjs";
import { APP_ROUTES } from "$lib/nav/routes";
import { pageLabel } from "$lib/nav/page-labels";

import { SRC_ROOT } from "./design-source-files";
import {
  isRedirectStub,
  verwaltenComponentFiles,
  verwaltenRouteFiles,
  type VerwaltenFile,
} from "./verwalten-854-files";

// ── Source stripping ─────────────────────────────────────────────────────────

function blank(text: string): string {
  return text.replace(/[^\n]/g, " ");
}

/** Template markup only: `<script>`, `<style>` and HTML comments blanked (line numbers kept). */
function markupOf(source: string): string {
  return source
    .replace(/<script\b[\s\S]*?<\/script>/g, blank)
    .replace(/<style\b[\s\S]*?<\/style>/g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank);
}

/** Script and markup without comments (a rule that looks at string literals reads both). */
function withoutComments(source: string): string {
  return source
    .replace(/<style\b[\s\S]*?<\/style>/g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, (m, lead: string) => lead + blank(m.slice(lead.length)));
}

/**
 * The opening tag of the first `<Name ...>` in `markup`, as source text, or null. Svelte `{...}`
 * expressions inside the attributes may contain `>` and quotes, so the end of the tag is found by a
 * small state machine (the same shape as the one in `lint-ui-classes.mjs`).
 */
export function componentOpeningTag(markup: string, names: string[]): string | null {
  const start = new RegExp(`<(?:${names.join("|")})(?=[\\s/>])`).exec(markup);
  if (!start) return null;
  let brace = 0;
  let attrQuote: string | null = null;
  let jsString: string | null = null;
  for (let j = start.index + start[0].length; j < markup.length; j++) {
    const c = markup[j];
    if (jsString) {
      if (c === "\\") j += 1;
      else if (c === jsString) jsString = null;
      continue;
    }
    if (brace > 0) {
      if (c === '"' || c === "'" || c === "`") jsString = c;
      else if (c === "{") brace += 1;
      else if (c === "}") brace -= 1;
      continue;
    }
    if (c === "{") {
      brace = 1;
      continue;
    }
    if (attrQuote) {
      if (c === attrQuote) attrQuote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      attrQuote = c;
      continue;
    }
    if (c === ">") return markup.slice(start.index, j + 1);
  }
  return null;
}

/** The tags that carry a page head on a Verwalten page (HubPage renders its head itself). */
const HEAD_TAGS = ["PageHead", "PageHeader", "HubPage"];

export function headTagOf(source: string): string | null {
  return componentOpeningTag(markupOf(source), HEAD_TAGS);
}

// ── The detectors ────────────────────────────────────────────────────────────

/** Default imports of the retired chrome: cards, KPI tiles, the old modal and the four legacy shells. */
const LEGACY_IMPORT_RE =
  /^\s*import\s+[\w$]+\s+from\s+["'][^"']*(?:\/(?:Card|CardHeader|KPIStat|ApprovalRow|Modal)|(?:\/admin\/|\.\/)(?:Section|SectionStack|ListDetail|ToolPage))\.svelte["']/m;
const VIEW_TABS_RE = /\bclass\s*=\s*["'{][^"'}]*\bview-tabs?\b/;
const NATIVE_DIALOG_RE = /(?<![\w$.])(?:window\.)?(?:alert|confirm|prompt)\s*\(/;
const HTML_TAG_RE = /\{@html\b/;

const LOADING_WORDS =
  /(?<![\p{L}\p{N}_])(?:(?:wird|werden)\s+geladen|lädt|lade|laden)(?![\p{L}\p{N}_])/iu;
/** Non-loading phrases that contain a loading word (the full register lives in no-loading-text-843). */
const LOADING_ALLOWED = [
  /fehler\s+beim\s+laden/giu,
  /erneut\s+laden/giu,
  /neu\s+laden/giu,
  /(?<![\p{L}\p{N}_])laden?\s+(?:sie\s+)?(?:die\s+)?seite\s+neu/giu,
  /datei\s+laden/giu,
  /zu\s+laden/giu,
  /(?<![\p{L}\p{N}_])lade\s+[\p{L}-]+\s+ein(?![\p{L}\p{N}_])/giu,
];

export const CHROME_RULES = [
  "raw-h1",
  "kpi-class",
  "filter-bar-class",
  "month-bar-class",
  "view-tabs-class",
  "own-table",
  "legacy-import",
  "loading-text",
  "native-dialog",
  "html-tag",
  "head-eyebrow",
  "head-accent",
  "head-title",
] as const;
export type ChromeRule = (typeof CHROME_RULES)[number];

interface ChromeOptions {
  /** "route" additionally checks the head tag; "component" judges only the markup rules. */
  kind?: "route" | "component";
  /** Route-table key (`file ?? href`) the page must name in `title={pageLabel(...)}`; set only for a table-entry page. */
  titleKey?: string;
}

/**
 * The page-own chrome in one Svelte source, as rule ids (a rule appears once however often it
 * matches). A route additionally checks the head tag for the inert `eyebrow` / `accent` props
 * (D-853-19, carried over) and, for a table-entry page (`titleKey`), that the head names the page
 * by its table label.
 */
export function chromeFindings(source: string, options: ChromeOptions = {}): ChromeRule[] {
  const { kind = "component", titleKey } = options;
  const found = new Set<ChromeRule>();
  const markup = markupOf(source);
  const patterns = detectPagePatterns(source) as Record<string, number>;

  if (/<h1[\s>]/.test(markup)) found.add("raw-h1");
  if (patterns["own-kpi-card"] > 0) found.add("kpi-class");
  if (patterns["own-filter-bar"] > 0) found.add("filter-bar-class");
  if (patterns["own-period-control"] > 0) found.add("month-bar-class");
  if (VIEW_TABS_RE.test(markup)) found.add("view-tabs-class");
  if (/<table[\s>]/.test(markup)) found.add("own-table");
  if (LEGACY_IMPORT_RE.test(source.match(/<script\b[\s\S]*?<\/script>/g)?.join("\n") ?? "")) {
    found.add("legacy-import");
  }

  const readable = withoutComments(source);
  let loadingScan = readable;
  for (const allowed of LOADING_ALLOWED) loadingScan = loadingScan.replace(allowed, blank);
  if (LOADING_WORDS.test(loadingScan)) found.add("loading-text");
  if (NATIVE_DIALOG_RE.test(readable)) found.add("native-dialog");
  if (HTML_TAG_RE.test(readable)) found.add("html-tag");

  if (kind === "route") {
    const head = headTagOf(source);
    if (head && /\seyebrow\s*=|\s\{eyebrow\}|\s\{\.\.\./.test(head)) found.add("head-eyebrow");
    if (head && /\saccent\s*=|\s\{accent\}/.test(head)) found.add("head-accent");
    if (titleKey !== undefined && !(head && head.includes(`title={pageLabel("${titleKey}")}`))) {
      found.add("head-title");
    }
  }
  return CHROME_RULES.filter((rule) => found.has(rule));
}

// ── The walked sets ──────────────────────────────────────────────────────────

const routeFiles = verwaltenRouteFiles();
const componentFiles = verwaltenComponentFiles();
const walkedRels = new Set([...routeFiles, ...componentFiles].map((f) => f.rel));

function findingsOf(file: VerwaltenFile, isRoute: boolean): ChromeRule[] {
  return chromeFindings(file.text, {
    kind: isRoute ? "route" : "component",
    titleKey: isRoute && file.tableEntry ? file.key : undefined,
  });
}

// ── The walk ─────────────────────────────────────────────────────────────────

describe("Verwalten pages guard - the walked set is not empty", () => {
  it("walks at least 20 Verwalten route files", () => {
    expect(routeFiles.length).toBeGreaterThanOrEqual(20);
  });

  it("walks at least 25 Verwalten component files", () => {
    expect(componentFiles.length).toBeGreaterThanOrEqual(25);
  });

  it("the walk reaches the four hub pages and a detail sub-route", () => {
    const rels = routeFiles.map((f) => f.rel);
    expect(rels).toContain("routes/(app)/verwalten/regeln/+page.svelte");
    expect(rels).toContain("routes/(app)/admin/employees/[id]/+page.svelte");
    expect(routeFiles.some((f) => f.tableEntry)).toBe(true);
    expect(routeFiles.some((f) => !f.tableEntry)).toBe(true);
  });

  it("the walk skips the Übersicht, the Bausteine page and #853's availability pages", () => {
    const rels = routeFiles.map((f) => f.rel);
    expect(rels).not.toContain("routes/(app)/verwalten/+page.svelte");
    expect(rels).not.toContain("routes/(app)/admin/bausteine/+page.svelte");
    expect(rels.some((r) => r.includes("admin/availability"))).toBe(false);
  });

  it("every Verwalten table entry with a route file has its page file in the walk", () => {
    const entries = APP_ROUTES.filter(
      (r) => r.area === "verwalten" && r.href !== "/verwalten" && !r.internal,
    );
    const rels = new Set(routeFiles.map((f) => f.rel));
    for (const route of entries.filter((e) => e.file !== undefined)) {
      const page = `routes/(app)${route.file}/+page.svelte`;
      // A redirect stub renders nothing of its own (its content lives on the page it redirects to, e.g.
      // /admin/shutdowns -> Abwesenheiten › Betriebsurlaub, plan 854-12) and is never walked.
      if (isRedirectStub(readFileSync(join(SRC_ROOT, page), "utf8"))) continue;
      expect(rels, `${route.href} -> ${route.file}`).toContain(page);
    }
  });

  it("the legacy shells are not walked as components (they stay for the operator console)", () => {
    const rels = componentFiles.map((f) => f.rel);
    for (const shell of ["Section", "SectionStack", "ListDetail", "ToolPage"]) {
      expect(rels).not.toContain(`lib/components/admin/${shell}.svelte`);
    }
  });
});

describe("Verwalten pages guard - the head names the page by its table label", () => {
  for (const file of routeFiles.filter((f) => f.tableEntry)) {
    it(`${file.rel}: pageLabel("${file.key}") is the table label`, () => {
      const route = APP_ROUTES.find((r) => (r.file ?? r.href) === file.key)!;
      expect(route, `route-table entry for ${file.key}`).toBeDefined();
      expect(pageLabel(file.key)).toBe(route.label);
    });
  }
});

describe("Verwalten pages guard - every walked file is enforced", () => {
  it(`enforces ${routeFiles.length} route and ${componentFiles.length} component file(s); none is exempt`, () => {
    // No list can leave a file out: the walked sets are the enforced sets, and the walk has floors above.
    expect(routeFiles.length + componentFiles.length).toBeGreaterThan(0);
    expect(new Set([...routeFiles, ...componentFiles].map((f) => f.rel)).size).toBe(
      routeFiles.length + componentFiles.length,
    );
  });

  it("the ratchet register holds no entry with the ticket #854 (the area is fully migrated)", () => {
    const register = JSON.parse(
      readFileSync(join(SRC_ROOT, "..", "scripts", "lint-ui-classes-route-ratchet.json"), "utf8"),
    ) as { rules: Record<string, Record<string, { ticket: string | null }>> };
    const entries = Object.values(register.rules).flatMap((rule) => Object.values(rule));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.filter((entry) => entry.ticket === "#854")).toEqual([]);
  });

  it("no Verwalten file imports a legacy shell", () => {
    for (const file of [...routeFiles, ...componentFiles])
      expect(findingsOf(file, file.rel.startsWith("routes/")), file.rel).not.toContain(
        "legacy-import",
      );
  });

  for (const file of routeFiles) {
    it(`route ${file.rel} has no page-own chrome`, () => {
      expect(findingsOf(file, true)).toEqual([]);
    });
  }

  for (const file of componentFiles) {
    it(`component ${file.rel} has no page-own chrome`, () => {
      expect(findingsOf(file, false)).toEqual([]);
    });
  }
});

// ── Detector controls: one positive and one clean control per rule ───────────

const CONTROLS: Record<ChromeRule, { bad: string; clean: string; options?: ChromeOptions }> = {
  "raw-h1": { bad: "<h1>Salons</h1>", clean: "<h2>Salons</h2>" },
  "kpi-class": {
    bad: '<div class="kpi-grid"><div class="kpi">3</div></div>',
    clean: '<KpiStrip items={items} ariaLabel="Zahlen" />',
  },
  "filter-bar-class": {
    bad: '<div class="filter-bar"><input /></div>',
    clean: "<TableToolbar bind:query count={1} total={1} />",
  },
  "month-bar-class": {
    bad: '<div class="month-bar"></div>',
    clean: '<PeriodPicker mode="month" />',
  },
  "view-tabs-class": {
    bad: '<div class="view-tabs" role="tablist"></div>',
    clean: '<PageTabs tabs={tabs} tabsLabel="Bereiche" />',
  },
  "own-table": {
    bad: '<table class="x"><tbody></tbody></table>',
    clean: '<DataTable columns={columns} rows={rows} rowKey={key} caption="Salons" />',
  },
  "legacy-import": {
    bad: '<script lang="ts">\n  import Section from "$components/admin/Section.svelte";\n</script>',
    clean: '<script lang="ts">\n  import SaveBar from "$components/ui/SaveBar.svelte";\n</script>',
  },
  "loading-text": {
    bad: "<p>Daten werden geladen…</p>",
    clean: '<p>Fehler beim Laden der Daten</p><Skeleton shape="row" />',
  },
  "native-dialog": {
    bad: '<script lang="ts">\n  if (confirm("Wirklich?")) go();\n</script>',
    clean: '<script lang="ts">\n  await dialog.confirm("Wirklich?");\n</script>',
  },
  "html-tag": {
    bad: "<div>{@html body}</div>",
    clean: "<div>{body}</div>",
  },
  "head-eyebrow": {
    bad: '<PageHead eyebrow="Verwalten" title={pageLabel("/verwalten/salons")} />',
    clean: '<PageHead title={pageLabel("/verwalten/salons")} />',
    options: { kind: "route" },
  },
  "head-accent": {
    bad: '<PageHead title={pageLabel("/verwalten/salons")} accent="Salon" />',
    clean: '<PageHead title={pageLabel("/verwalten/salons")} sub="Standorte" />',
    options: { kind: "route" },
  },
  "head-title": {
    bad: '<PageHead title="Salons" />',
    clean: '<PageHead title={pageLabel("/admin/salons")} />',
    options: { kind: "route", titleKey: "/admin/salons" },
  },
};

describe("Verwalten pages guard - detector controls", () => {
  for (const rule of CHROME_RULES) {
    const control = CONTROLS[rule];
    it(`control: ${rule} flags its pattern`, () => {
      expect(chromeFindings(control.bad, control.options)).toContain(rule);
    });
    it(`control: ${rule} passes the block form`, () => {
      expect(chromeFindings(control.clean, control.options)).not.toContain(rule);
    });
  }

  it("control: the head rules need a route file, a component with the same tag is not judged", () => {
    expect(chromeFindings('<PageHead eyebrow="Team" title="x" />')).toEqual([]);
  });

  it("control: a head carried by HubPage counts as a head tag", () => {
    const hub = '<HubPage title={pageLabel("/verwalten/regeln")} hub="/verwalten/regeln" />';
    expect(chromeFindings(hub, { kind: "route", titleKey: "/verwalten/regeln" })).toEqual([]);
    expect(chromeFindings(hub, { kind: "route", titleKey: "/verwalten/daten" })).toContain(
      "head-title",
    );
  });

  it("control: a page without any head tag fails head-title", () => {
    expect(chromeFindings("<p>x</p>", { kind: "route", titleKey: "/admin/salons" })).toContain(
      "head-title",
    );
  });

  it("control: the head tag is found past a `>` inside an attribute expression", () => {
    const tag = headTagOf(
      '<PageHead title={a > b ? "x" : "y"} eyebrow="Verwalten">\n  {#snippet actions()}',
    );
    expect(tag).toContain('eyebrow="Verwalten"');
  });

  it("control: the retired cards, the old modal and the other legacy shells are flagged", () => {
    for (const path of [
      "$components/ui/Card.svelte",
      "$components/ui/CardHeader.svelte",
      "$components/ui/KPIStat.svelte",
      "$components/ui/ApprovalRow.svelte",
      "$components/ui/Modal.svelte",
      "$components/admin/SectionStack.svelte",
      "$components/admin/ListDetail.svelte",
      "$components/admin/ToolPage.svelte",
      "./Section.svelte",
    ]) {
      const source = `<script lang="ts">\n  import X from "${path}";\n</script>`;
      expect(chromeFindings(source), path).toContain("legacy-import");
    }
    const sibling =
      '<script lang="ts">\n  import X from "./SalonHolidaysSection.svelte";\n</script>';
    expect(chromeFindings(sibling)).not.toContain("legacy-import");
  });

  it("control: a pattern only inside a comment or style block is not a finding", () => {
    expect(
      chromeFindings(
        '<!-- <h1>x</h1> {@html y} -->\n<style>\n  .kpi { color: red; }\n</style>\n<script>\n  // confirm("x")\n</script>',
      ),
    ).toEqual([]);
  });

  it("control: every rule id has a control", () => {
    expect(Object.keys(CONTROLS).sort()).toEqual([...CHROME_RULES].sort());
    expect(CHROME_RULES.length).toBeGreaterThanOrEqual(13);
  });

  it("control: a file that does not exist is not walked", () => {
    expect(walkedRels.has("routes/(app)/verwalten/gibt-es-nicht/+page.svelte")).toBe(false);
  });
});
