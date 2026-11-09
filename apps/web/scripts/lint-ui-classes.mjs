#!/usr/bin/env node
/**
 * lint:ui-classes — Primitive ↔ global-recipe alignment gate (UI-21, Plan 35-04).
 *
 * Inspects every `.svelte` file under
 *   - apps/web/src/lib/components/ui/
 *   - apps/web/src/lib/components/layout/
 * and verifies that every class name those files emit (either via
 * `class="…"` literals OR Svelte's `class:foo` / `class:foo={…}` shorthand)
 * has a matching selector somewhere in the global stylesheets:
 *   - apps/web/src/app.css
 *   - apps/web/src/tokens.css
 * OR — for unavoidable component-private classes — is declared in the
 * component's OWN scoped `<style>` block (Svelte already namespaces those).
 *
 * The goal is to catch primitives that emit a class name nothing has styled,
 * which is the failure mode tracked as UI-21: silent drift between the
 * primitive layer and the v2 design tokens (tokens.css, Issue #842).
 *
 * Flags:
 *   (none — full sweep only; the script is fast)
 *
 * Env:
 *   LINT_UI_CLASSES_SOFT=1   Soft-mode: exit 0 even on misses (migration window).
 *
 * Exit codes:
 *   0 — no misses OR LINT_UI_CLASSES_SOFT=1
 *   1 — misses found and soft-mode disabled
 *
 * Whitelist:
 *   `WHITELIST` (below) is a Set of class names that are intentionally emitted
 *   by primitives but do NOT have a global recipe — they are styled inline by
 *   a parent OR they are pure semantic hooks (e.g. `unread-dot` on bell items).
 *   Adding to the whitelist requires a code-review justification.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { extractEmittedClasses, extractScopedClasses } from "./lib/class-tokens.mjs";

// Resolve repo root: git rev-parse --show-toplevel can return a subdirectory
// when running inside a git worktree with GIT_DIR set (e.g. during pre-commit hooks).
// Workaround: walk up from this script's location to find the actual repo root
// (the directory that contains apps/web/).
const repoRoot = (() => {
  // import.meta.dirname is available in Node 21+; fall back to URL parsing
  const scriptDir = import.meta.dirname ?? resolve(new URL(import.meta.url).pathname, "..");
  let dir = scriptDir;
  for (let i = 0; i < 10 && dir !== "/"; i++) {
    if (existsSync(resolve(dir, "apps", "web"))) return dir;
    dir = resolve(dir, "..");
  }
  return execSync("git rev-parse --show-toplevel").toString().trim();
})();

const SCOPES = ["apps/web/src/lib/components/ui", "apps/web/src/lib/components/layout"];
const GLOBAL_CSS = ["apps/web/src/app.css", "apps/web/src/tokens.css"];

/**
 * Class names that primitives emit by design but that are NOT styled by a
 * global recipe (and not in the component's own scoped <style>). Each entry
 * needs a comment with the rationale.
 */
const WHITELIST = new Set([
  // Used by parent layout grids — primitives only emit them as anchors.
  // (none currently — placeholder kept for clarity.)
  // Sidebar.svelte logout button — semantic hook for e2e tests / future styling,
  // no global recipe needed (the .icon-btn recipe handles the actual visual).
  "logout",
]);

/** @param {string} scope repo-relative directory */
function listSvelteFiles(scope) {
  const out = execSync(`find '${scope}' -type f -name '*.svelte'`, {
    cwd: repoRoot,
  }).toString();
  return out
    .split("\n")
    .filter(Boolean)
    .map((f) => resolve(repoRoot, f));
}

/** All `.svelte` files across every SCOPES entry, combined. A named function calling
 * `listSvelteFiles` directly (rather than `SCOPES.flatMap(...)`), so the walk-derivation the
 * empty-abort below needs is a plain direct call, not a chain over a non-derived receiver
 * (235-08, mirroring lint-save-pattern.mjs's own listAllSvelteFiles() — the classifier's chain-
 * method resolution only checks a `.flatMap()`'s RECEIVER, SCOPES, which is never itself derived;
 * it does not look inside the callback body). */
function listAllSvelteFiles() {
  const out = [];
  for (const scope of SCOPES) {
    out.push(...listSvelteFiles(scope));
  }
  return out;
}

// ── Routes mode: page-own patterns (Issue #843, D-843-05, D-843-18) ─────────────────────────
//
// The primitive check above only looks at `ui/` and `layout/`. A page can still build its OWN
// filter bar, period control, KPI card or data table out of raw markup instead of the blocks, and
// it can hide such markup in an area component (`lib/components/leave/…`). The detectors below
// find those patterns in every `.svelte` file under `src/routes` and under `lib/components`
// outside `ui/` and `layout/`.

/** Rules whose existing occurrences are tolerated and counted in the ratchet register. */
export const RATCHET_RULES = [
  "own-filter-bar",
  "own-period-control",
  "own-kpi-card",
  "own-data-table",
];
/** Hard failure with no register: raw scrim/modal markup (the Dialog block replaces it). */
export const HARD_RULE = "raw-scrim-modal";
export const PATTERN_RULES = [...RATCHET_RULES, HARD_RULE];

/** Follow-up tickets a register entry may name (Issue #843, the page rebuilds #845 to #854). */
export const TICKET_RE = /^#8(4[5-9]|5[0-4])$/;

const FILTER_BAR_RE =
  /^(filter-bar|filter-row|filter-select|filter-count|filter-search|filter-toggle(--on)?|year-filter|table-toolbar|toolbar|filters|.+-filter-bar|.+-filters|.+-toolbar)$/;
const PERIOD_CONTROL_RE =
  /^(month-bar.*|cal-monthbar.*|.+-monthbar|period-(bar|nav|switch.*)|week-nav|month-nav|.+-nav-btn|nav-btn)$/;
const KPI_CARD_RE =
  /^(kpi|kpi-.+|stat-card|.+-kpis?|.+-kpi-.+|vac-stat|today-stat.*|mini-stat(-grid)?|mstat|stat-tile|summary-bar)$/;
const SCRIM_MODAL_RE = /^(scrim|modal|modal-hd|modal-body|modal-foot)$/;
const PERIOD_LABEL_RE =
  /\b(?:title|aria-label)\s*=\s*"\s*(?:Vorherig|Nächst|Vorwoche|Folgewoche|Vormonat)/;

/**
 * Drop `<script>`, `<style>` and HTML comments so only template markup is scanned.
 *
 * @param {string} source
 */
function stripNonMarkup(source) {
  return source
    .replace(/<script\b[\s\S]*?<\/script>/g, "")
    .replace(/<style\b[\s\S]*?<\/style>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * Every opening tag of a plain HTML element (lowercase name) in the markup, as source text.
 * Component tags (`<PeriodPicker`, `<KpiStrip`, …) and `svelte:` elements are skipped on purpose:
 * markup rendered through a block is not page-own markup. Svelte `{…}` expressions inside the
 * attributes may contain `>` and quotes, so the end of the tag is found by a small state machine.
 *
 * @param {string} markup
 * @returns {string[]}
 */
function openingTags(markup) {
  const tags = [];
  let from = 0;
  while (from < markup.length) {
    const lt = markup.indexOf("<", from);
    if (lt < 0) break;
    const name = /^<([A-Za-z][\w:.-]*)/.exec(markup.slice(lt, lt + 80));
    if (!name) {
      from = lt + 1;
      continue;
    }
    let brace = 0;
    let attrQuote = null;
    let jsString = null;
    let end = -1;
    let bogus = false;
    for (let j = lt + name[0].length; j < markup.length; j++) {
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
      if (c === "<") {
        // A new tag opens before this one closed: `a <b` in text, not a tag.
        bogus = true;
        break;
      }
      if (c === ">") {
        end = j;
        break;
      }
    }
    if (bogus || end < 0) {
      from = lt + 1;
      continue;
    }
    if (/^[a-z]/.test(name[1]) && !name[1].includes(":")) {
      tags.push(markup.slice(lt, end + 1));
    }
    from = end + 1;
  }
  return tags;
}

/**
 * Count the page-own patterns in one Svelte source, per rule. An element counts once per rule it
 * matches, however many of its class tokens match.
 *
 * @param {string} source whole `.svelte` source
 * @returns {Record<string, number>} a count for every rule in `PATTERN_RULES`
 */
export function detectPagePatterns(source) {
  /** @type {Record<string, number>} */
  const counts = Object.fromEntries(PATTERN_RULES.map((rule) => [rule, 0]));
  for (const tag of openingTags(stripNonMarkup(source))) {
    const tokens = [...extractEmittedClasses(tag)];
    const tagName = /^<([a-z][\w:.-]*)/.exec(tag)?.[1];
    if (tokens.some((t) => FILTER_BAR_RE.test(t))) counts["own-filter-bar"] += 1;
    if (tokens.some((t) => PERIOD_CONTROL_RE.test(t)) || PERIOD_LABEL_RE.test(tag)) {
      counts["own-period-control"] += 1;
    }
    if (tokens.some((t) => KPI_CARD_RE.test(t))) counts["own-kpi-card"] += 1;
    if (tagName === "table" && tokens.some((t) => t === "data-table" || t === "table")) {
      counts["own-data-table"] += 1;
    }
    if (tokens.some((t) => SCRIM_MODAL_RE.test(t))) counts[HARD_RULE] += 1;
  }
  return counts;
}

/**
 * Every `.svelte` file below `dir` (absolute paths), skipping test-harness directories.
 *
 * @param {string} dir
 */
function svelteFilesBelow(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".svelte"))
    .filter((f) => !f.split(sep).includes("__tests__"))
    .map((f) => resolve(dir, f));
}

/**
 * The two scopes of the routes mode (D-843-05, D-843-18): every `.svelte` file under
 * `src/routes`, and every one under `lib/components` outside `ui/` and `layout/`.
 *
 * @param {string} [root] repository root
 * @returns {{ routes: string[], components: string[] }} absolute paths, sorted
 */
export function walkPatternScopes(root = repoRoot) {
  const routes = svelteFilesBelow(resolve(root, "apps/web/src/routes")).sort();
  const uiDir = resolve(root, "apps/web/src/lib/components/ui") + sep;
  const layoutDir = resolve(root, "apps/web/src/lib/components/layout") + sep;
  const components = svelteFilesBelow(resolve(root, "apps/web/src/lib/components"))
    .filter((f) => !f.startsWith(uiDir) && !f.startsWith(layoutDir))
    .sort();
  return { routes, components };
}

/**
 * Compare found counts with the ratchet register. The register only falls: a higher count, an
 * unregistered file, a register count above the found count and an invalid entry all fail.
 *
 * @param {Record<string, Record<string, number>>} found rule -> repo-relative path -> count (> 0)
 * @param {{ rules?: Record<string, Record<string, { count: number, ticket: string | null, reason?: string }>> }} register
 * @returns {string[]} problems; empty when the tree conforms
 */
export function compareWithRegister(found, register) {
  const problems = [];
  const rules = register?.rules ?? {};
  for (const rule of Object.keys(rules)) {
    if (rule === HARD_RULE) {
      if (Object.keys(rules[rule] ?? {}).length > 0) {
        problems.push(`${rule}: raw scrim/modal markup has no register, remove the entries`);
      }
    } else if (!RATCHET_RULES.includes(rule)) {
      problems.push(`${rule}: unknown rule in the register`);
    }
  }
  for (const [path, count] of Object.entries(found[HARD_RULE] ?? {})) {
    problems.push(
      `${HARD_RULE}: ${path} has ${count} raw scrim/modal element(s) — use the Dialog block (hard failure, no register)`,
    );
  }
  for (const rule of RATCHET_RULES) {
    const registered = rules[rule] ?? {};
    const seen = found[rule] ?? {};
    for (const [path, count] of Object.entries(seen)) {
      const entry = registered[path];
      if (!entry) {
        problems.push(
          `${rule}: neues Seitenmuster in ${path} (${count} found, file not in the register) — build it from the blocks`,
        );
      } else if (count > entry.count) {
        problems.push(
          `${rule}: neues Seitenmuster in ${path} (${count} found, ${entry.count} registered) — build it from the blocks`,
        );
      } else if (count < entry.count) {
        problems.push(
          `${rule}: Register senken for ${path} (${count} found, ${entry.count} registered) — run with --print and lower the entry`,
        );
      }
    }
    for (const [path, entry] of Object.entries(registered)) {
      if (!seen[path]) {
        problems.push(
          `${rule}: Register senken for ${path} (0 found, ${entry.count} registered) — remove the entry`,
        );
      }
      if (!Number.isInteger(entry.count) || entry.count < 1) {
        problems.push(`${rule}: ${path} has an invalid count ${entry.count}`);
      }
      if (entry.ticket === null || entry.ticket === undefined) {
        if (!entry.reason || !String(entry.reason).trim()) {
          problems.push(`${rule}: ${path} has no ticket and no reason`);
        }
      } else if (!TICKET_RE.test(entry.ticket)) {
        problems.push(`${rule}: ${path} names ticket "${entry.ticket}", expected #845 to #854`);
      }
    }
  }
  return problems;
}

/**
 * Combined global recipe registry from app.css + tokens.css.
 * Returns a Set of class names that are mentioned (anywhere — selectors,
 * combinators, descendants) in the global stylesheets.
 */
function loadGlobalClasses() {
  const out = new Set();
  for (const rel of GLOBAL_CSS) {
    const abs = resolve(repoRoot, rel);
    if (!existsSync(abs)) continue;
    const css = readFileSync(abs, "utf8");
    const re = /\.([a-zA-Z_-][a-zA-Z0-9_-]*)/g;
    let m;
    while ((m = re.exec(css))) {
      out.add(m[1]);
    }
  }
  return out;
}

/** The primitive <-> global-recipe alignment sweep (UI-21): the check this script always ran. */
function runPrimitiveAlignment() {
  // Build the file list first (SCOPES above), abort on empty, THEN run the content check over it —
  // this is what makes the empty case a hard failure instead of a silent "0 miss(es)" success.
  const files = listAllSvelteFiles();
  if (files.length === 0) {
    console.error(
      `[lint:ui-classes] scanned 0 file(s) under ${SCOPES.join(", ")} — the scan root moved or ` +
        `the filter matched nothing. This is a failure, not a clean result.`,
    );
    process.exit(1);
  }

  const global = loadGlobalClasses();
  const misses = [];
  let totalEmitted = 0;
  const totalFiles = files.length;

  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const emitted = extractEmittedClasses(content);
    const scoped = extractScopedClasses(content);
    for (const cls of emitted) {
      totalEmitted += 1;
      if (global.has(cls)) continue;
      if (scoped.has(cls)) continue;
      if (WHITELIST.has(cls)) continue;
      misses.push({ file, cls });
    }
  }

  if (misses.length > 0) {
    console.error(`\n[lint:ui-classes] ${misses.length} miss(es) across ${totalFiles} file(s):\n`);
    for (const { file, cls } of misses) {
      const loc = relative(repoRoot, file);
      console.error(`  ${loc} — emitted class ".${cls}" has no global recipe match`);
    }
    console.error(
      `\nFix options:\n` +
        `  1. Add a recipe to apps/web/src/app.css or tokens.css\n` +
        `  2. Move the class into the component's own <style> block (scoped)\n` +
        `  3. Add to WHITELIST in scripts/lint-ui-classes.mjs with justification\n`,
    );
    if (process.env.LINT_UI_CLASSES_SOFT === "1") {
      console.error(
        "[lint:ui-classes] LINT_UI_CLASSES_SOFT=1 — exiting 0 despite misses (migration mode).\n",
      );
      process.exit(0);
    }
    process.exit(1);
  }

  console.log(
    `[lint:ui-classes] OK — ${totalEmitted} class token(s) across ${totalFiles} primitive file(s) all match a global recipe or are scoped/whitelisted.`,
  );
}

// Run the sweep only when the script is invoked directly, so importing the detectors in a test
// does not lint.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPrimitiveAlignment();
}
