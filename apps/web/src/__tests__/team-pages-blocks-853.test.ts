// Issue #853, AC-1 (D-853-03, D-853-18, D-853-19) - the guard of the Team pages: every Team route
// file and every Team component is built from the #843 blocks, not from page-own chrome. This is the
// SKELETON (plan 853-02): the walker, the detectors, the controls and the floors. The page plans do
// not edit this file - enforcement is keyed on the migration state that already lives in the repo:
//
//   - a Team ROUTE file is enforced once its head tag passes neither `eyebrow` nor `accent` AND the
//     falling-only ratchet register (`lint-ui-classes-route-ratchet.json`) holds no `#853` entry for
//     it (a page migrated over two plans keeps its entry until its last plan);
//   - a Team COMPONENT is enforced once the register holds no `#853` entry for it.
//
// Plan 853-16 adds the final assertion that every file is enforced. A walk that matches nothing
// reports OK forever, so the walked sets carry non-empty floors and every detector has a positive
// control and a clean control (the same discipline as no-loading-text-843).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { detectPagePatterns } from "../../scripts/lint-ui-classes.mjs";
import { APP_ROUTES } from "$lib/nav/routes";
import { pageLabel } from "$lib/nav/page-labels";

import { SRC_ROOT, walkFiles } from "./design-source-files";

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
 * The opening tag of the first `<Name …>` in `markup`, as source text, or null. Svelte `{…}`
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

/** The tags that carry a page head on a Team page (D-853-19: no eyebrow, no accent). */
const HEAD_TAGS = ["PageHead", "PageHeader", "ListDetail"];

export function headTagOf(source: string): string | null {
  return componentOpeningTag(markupOf(source), HEAD_TAGS);
}

// ── The detectors ────────────────────────────────────────────────────────────

const LEGACY_IMPORT_RE =
  /^\s*import\s+[\w$]+\s+from\s+["'][^"']*\/(?:Card|CardHeader|KPIStat|ApprovalRow|LeaveToolbar)\.svelte["']/m;
const VIEW_TABS_RE = /\bclass\s*=\s*["'{][^"'}]*\bview-tabs?\b/;
const NATIVE_DIALOG_RE = /(?<![\w$.])(?:window\.)?(?:alert|confirm|prompt)\s*\(/;

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
  "head-eyebrow",
  "head-accent",
] as const;
export type ChromeRule = (typeof CHROME_RULES)[number];

/**
 * The page-own chrome in one Svelte source, as rule ids (a rule appears once however often it
 * matches). `kind` "route" additionally checks the head tag for the inert `eyebrow` / `accent`
 * props (D-853-19: Team pages stop passing them).
 */
export function chromeFindings(
  source: string,
  kind: "route" | "component" = "component",
): ChromeRule[] {
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

  if (kind === "route") {
    const head = headTagOf(source);
    if (head && /\seyebrow\s*=|\s\{eyebrow\}|\s\{\.\.\./.test(head)) found.add("head-eyebrow");
    if (head && /\saccent\s*=|\s\{accent\}/.test(head)) found.add("head-accent");
  }
  return CHROME_RULES.filter((rule) => found.has(rule));
}

// ── The walked sets ──────────────────────────────────────────────────────────

const REPO_REL = "apps/web/src/";
const RATCHET = JSON.parse(
  readFileSync(join(SRC_ROOT, "..", "scripts", "lint-ui-classes-route-ratchet.json"), "utf8"),
) as { rules: Record<string, Record<string, { ticket: string | null }>> };

/** Repo-relative paths that the register still lists under #853. */
const REGISTERED_853 = new Set(
  Object.values(RATCHET.rules).flatMap((byFile) =>
    Object.entries(byFile)
      .filter(([, entry]) => entry.ticket === "#853")
      .map(([file]) => file),
  ),
);

interface TeamFile {
  /** Path relative to `src/`, POSIX separators. */
  rel: string;
  /** Route key (`file ?? href`) for a route file; the file name for a component. */
  key: string;
  text: string;
}

/**
 * The Team page files, derived from the route table (area `team`, key `file ?? href`), without
 * `/team/heute` (that page is #846). Files that do not exist are skipped.
 */
export function teamRouteFiles(): TeamFile[] {
  const out: TeamFile[] = [];
  for (const route of APP_ROUTES) {
    if (route.area !== "team" || route.href === "/team/heute") continue;
    const key = route.file ?? route.href;
    const rel = `routes/(app)${key}/+page.svelte`;
    const abs = join(SRC_ROOT, rel);
    if (existsSync(abs)) out.push({ rel, key, text: readFileSync(abs, "utf8") });
  }
  return out;
}

/** Every Team component below `lib/components/team/` (tests excluded). */
export function teamComponentFiles(): TeamFile[] {
  return walkFiles(join(SRC_ROOT, "lib/components/team"), [".svelte"], {
    includeTests: false,
  }).map((f) => ({ rel: `lib/components/team/${f.rel}`, key: f.rel, text: f.text }));
}

const routeFiles = teamRouteFiles();
const componentFiles = teamComponentFiles();

function routeEnforced(file: TeamFile): boolean {
  const head = headTagOf(file.text);
  const headClean = head === null || !/\s(?:eyebrow|accent)\s*=/.test(head);
  return headClean && !REGISTERED_853.has(REPO_REL + file.rel);
}

function componentEnforced(file: TeamFile): boolean {
  return !REGISTERED_853.has(REPO_REL + file.rel);
}

const enforcedRoutes = routeFiles.filter(routeEnforced);
const enforcedComponents = componentFiles.filter(componentEnforced);
const pending = [
  ...routeFiles.filter((f) => !routeEnforced(f)),
  ...componentFiles.filter((f) => !componentEnforced(f)),
].map((f) => f.rel);

// ── The walk ─────────────────────────────────────────────────────────────────

describe("Team pages guard - the walked set is not empty", () => {
  it("walks at least 7 Team route files", () => {
    expect(routeFiles.length).toBeGreaterThanOrEqual(7);
  });

  it("walks at least 2 Team component files", () => {
    expect(componentFiles.length).toBeGreaterThanOrEqual(2);
  });

  it("every Team route of the table has its page file", () => {
    const expected = APP_ROUTES.filter((r) => r.area === "team" && r.href !== "/team/heute");
    const withFile = expected.filter((r) =>
      existsSync(join(SRC_ROOT, `routes/(app)${r.file ?? r.href}/+page.svelte`)),
    );
    // A new-only route (no `file`) has no page file until its own plan; every old one has.
    for (const r of expected.filter((e) => e.file !== undefined)) {
      expect(withFile, `${r.href} -> ${r.file}`).toContain(r);
    }
  });
});

describe("Team pages guard - the head names the page by its table label (D-853-19)", () => {
  for (const file of routeFiles) {
    it(`${file.rel}: title={pageLabel("${file.key}")} and the label is the table label`, () => {
      const head = headTagOf(file.text);
      expect(head, "a page head tag").not.toBeNull();
      expect(head).toContain(`title={pageLabel("${file.key}")}`);
      const route = APP_ROUTES.find((r) => (r.file ?? r.href) === file.key)!;
      expect(pageLabel(file.key)).toBe(route.label);
    });
  }
});

describe("Team pages guard - enforcement follows the migration state", () => {
  it(`enforced: ${enforcedRoutes.length} route and ${enforcedComponents.length} component file(s); not yet enforced: ${pending.join(", ") || "none"}`, () => {
    // The title carries the state; the assertion only keeps the two sets disjoint from `pending`.
    for (const file of [...enforcedRoutes, ...enforcedComponents]) {
      expect(pending).not.toContain(file.rel);
    }
  });

  for (const file of enforcedRoutes) {
    it(`route ${file.rel} has no page-own chrome`, () => {
      expect(chromeFindings(file.text, "route")).toEqual([]);
    });
  }

  for (const file of enforcedComponents) {
    it(`component ${file.rel} has no page-own chrome`, () => {
      expect(chromeFindings(file.text, "component")).toEqual([]);
    });
  }
});

// ── Detector controls: one positive and one clean control per rule ───────────

const CONTROLS: Record<ChromeRule, { bad: string; clean: string; kind?: "route" }> = {
  "raw-h1": { bad: "<h1>Zeiten</h1>", clean: "<h2>Zeiten</h2>" },
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
    clean: '<DataTable columns={columns} rows={rows} rowKey={key} caption="Zeiten" />',
  },
  "legacy-import": {
    bad: '<script lang="ts">\n  import Card from "$components/ui/Card.svelte";\n</script>',
    clean: '<script lang="ts">\n  import List from "$components/ui/List.svelte";\n</script>',
  },
  "loading-text": {
    bad: "<p>Daten werden geladen…</p>",
    clean: '<p>Fehler beim Laden der Daten</p><Skeleton shape="row" />',
  },
  "native-dialog": {
    bad: '<script lang="ts">\n  if (confirm("Wirklich?")) go();\n</script>',
    clean: '<script lang="ts">\n  await dialog.confirm("Wirklich?");\n</script>',
  },
  "head-eyebrow": {
    bad: '<PageHead eyebrow="Team" title={pageLabel("/team/zeiten")} />',
    clean: '<PageHead title={pageLabel("/team/zeiten")} />',
    kind: "route",
  },
  "head-accent": {
    bad: '<PageHead title={pageLabel("/shifts")} accent="Schicht" />',
    clean: '<PageHead title={pageLabel("/shifts")} sub="Wochenplan" />',
    kind: "route",
  },
};

describe("Team pages guard - detector controls", () => {
  for (const rule of CHROME_RULES) {
    const control = CONTROLS[rule];
    it(`control: ${rule} flags its pattern`, () => {
      expect(chromeFindings(control.bad, control.kind ?? "component")).toContain(rule);
    });
    it(`control: ${rule} passes the block form`, () => {
      expect(chromeFindings(control.clean, control.kind ?? "component")).not.toContain(rule);
    });
  }

  it("control: the head rules need a route file, a component with the same tag is not judged", () => {
    expect(chromeFindings('<PageHead eyebrow="Team" title="x" />', "component")).toEqual([]);
  });

  it("control: the head tag is found past a `>` inside an attribute expression", () => {
    const tag = headTagOf(
      '<PageHead title={a > b ? "x" : "y"} eyebrow="Team">\n  {#snippet actions()}',
    );
    expect(tag).toContain('eyebrow="Team"');
  });

  it("control: a pattern only inside a comment or style block is not a finding", () => {
    expect(
      chromeFindings(
        '<!-- <h1>x</h1> -->\n<style>\n  .kpi { color: red; }\n</style>\n<script>\n  // confirm("x")\n</script>',
      ),
    ).toEqual([]);
  });

  it("control: every rule id has a control", () => {
    expect(Object.keys(CONTROLS).sort()).toEqual([...CHROME_RULES].sort());
    expect(CHROME_RULES.length).toBeGreaterThanOrEqual(11);
  });
});
