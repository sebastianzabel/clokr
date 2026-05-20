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
 * primitive layer and the v1.5 design tokens.
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

const repoRoot = execSync("git rev-parse --show-toplevel").toString().trim();

const SCOPES = [
  "apps/web/src/lib/components/ui",
  "apps/web/src/lib/components/layout",
];
const GLOBAL_CSS = [
  "apps/web/src/app.css",
  "apps/web/src/tokens.css",
];

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

// CSS identifier syntax: start with letter/underscore/hyphen, then letters/digits/_/-
const CSS_IDENT_RE = /^[a-zA-Z_-][a-zA-Z0-9_-]*$/;

function listSvelteFiles(scope) {
  const out = execSync(`find '${scope}' -type f -name '*.svelte'`, {
    cwd: repoRoot,
  }).toString();
  return out
    .split("\n")
    .filter(Boolean)
    .map((f) => resolve(repoRoot, f));
}

/**
 * Extract every class token emitted by a Svelte file.
 *
 * - `class="a b c"`   — split on whitespace, all tokens harvested
 * - `class:foo`       — `foo`
 * - `class:foo={…}`   — `foo`
 * - `class="a-{$x}-b"` — interpolated chunks are skipped (we can't statically
 *   know the runtime value), but the literal `a-` / `-b` chunks are also
 *   skipped since they are not standalone class tokens.
 *
 * Multi-line `class="…"` values are supported.
 */
function extractEmittedClasses(content) {
  const stripped = content.replace(/<style[\s\S]*?<\/style>/g, "");
  const out = new Set();

  // Helper: tokenize a text fragment on whitespace, validating each candidate
  // against the CSS identifier regex. This drops noise like `?`, `:`, quote
  // characters, and any other Svelte template syntax that escapes the
  // interpolation extractor below.
  const harvestTokens = (text) => {
    for (const tok of text.split(/\s+/)) {
      if (!tok) continue;
      if (!CSS_IDENT_RE.test(tok)) continue;
      out.add(tok);
    }
  };

  // Helper: given the body of a Svelte interpolation `{...}`, pull out every
  // string-literal's contents and tokenize them. Anything that isn't inside a
  // string literal is dynamic — we can't statically resolve it — so we skip it.
  const harvestFromExpression = (body) => {
    const strRe = /(["'])((?:\\.|(?!\1)[^\\])*)\1/g;
    let s;
    while ((s = strRe.exec(body))) {
      harvestTokens(s[2]);
    }
  };

  // 1. Literal class="…" — multiline-safe. Inside the value, Svelte
  // interpolations `{...}` are valid and may contain string literals; pull
  // those out separately, and tokenize the remaining bare text on whitespace.
  const literalRe = /\bclass\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = literalRe.exec(stripped))) {
    const raw = m[1];
    // Extract any `{...}` interpolation bodies and harvest string literals
    // from them. Replace the interpolations with a sentinel non-identifier
    // character (NUL) — this kills concatenated fragments like
    // `toast-{toast.type}` (which would otherwise leave the partial token
    // `toast-`) while still letting standalone tokens through cleanly.
    const interpRe = /\{([^{}]*)\}/g;
    let interp;
    while ((interp = interpRe.exec(raw))) {
      harvestFromExpression(interp[1]);
    }
    const bareText = raw.replace(/\{[^{}]*\}/g, "\x00");
    // Split on whitespace AND on the sentinel boundary, but require that any
    // surviving token contains no sentinel character — adjacent text to a
    // `{...}` interpolation is a concatenation, not a complete class name.
    for (const tok of bareText.split(/\s+/)) {
      if (!tok) continue;
      if (tok.includes("\x00")) continue;
      if (!CSS_IDENT_RE.test(tok)) continue;
      out.add(tok);
    }
  }

  // 2. Dynamic class={expr} — extract string-literal members.
  // Matches things like  class={["card", animate ? "card-animate" : "", x].filter(...)...}
  const dynRe = /\bclass\s*=\s*\{([^}]*)\}/g;
  while ((m = dynRe.exec(stripped))) {
    harvestFromExpression(m[1]);
  }

  // 3. `class:foo` and `class:foo={…}` shorthand.
  const dirRe = /\bclass:([a-zA-Z][a-zA-Z0-9_-]*)/g;
  while ((m = dirRe.exec(stripped))) {
    out.add(m[1]);
  }

  return out;
}

/**
 * Extract every class name DECLARED inside the file's scoped `<style>` block.
 * Svelte namespaces these per-component, so they don't need a global recipe.
 */
function extractScopedClasses(content) {
  const out = new Set();
  const styleBlocks = content.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g);
  for (const block of styleBlocks) {
    const css = block[1];
    // `.foo`, `.foo-bar`, `.foo_bar` — class-name characters per CSS spec.
    const re = /\.([a-zA-Z_-][a-zA-Z0-9_-]*)/g;
    let m;
    while ((m = re.exec(css))) {
      out.add(m[1]);
    }
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

const global = loadGlobalClasses();
const misses = [];
let totalEmitted = 0;
let totalFiles = 0;

for (const scope of SCOPES) {
  for (const file of listSvelteFiles(scope)) {
    totalFiles += 1;
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
