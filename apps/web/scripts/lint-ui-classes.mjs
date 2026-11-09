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
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, relative } from "node:path";

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
