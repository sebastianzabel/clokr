#!/usr/bin/env node
/**
 * lint:tokens — design-system v2 token lint (Issue #842, D-842-23).
 *
 * Two checks over `apps/web/src` (`.css`, `.svelte`, `.ts`, `.js`; `__tests__` directories and
 * `*.test.ts` are excluded, the guard tests have their own walkers):
 *
 *   DENY   every retired name listed as a machine line in `apps/web/.lintrc-tokens.txt` fails,
 *          whether it is referenced or declared. The same file keeps the old -> new cheat sheet, so
 *          there is exactly one source for the deny list.
 *   ALLOW  every `var(--name)` must be declared somewhere in the scanned files. Declarations are
 *          `--x:` (CSS, inline `style="--x: …"`, an object key), `style:--x=` (Svelte directive)
 *          and `setProperty("--x", …)`. A `var(--prefix-${…})` reference passes when some declared
 *          name starts with that prefix. `var(--x, fallback)` still counts as a reference.
 *
 * Anti-vacuity: the CLI aborts with exit 1 when it scanned zero files or the deny list is empty.
 *
 * Exit codes: 0 clean, 1 violations / zero files / empty deny list.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, relative, join } from "node:path";
import { pathToFileURL } from "node:url";

const SCAN_EXTENSIONS = [".css", ".svelte", ".ts", ".js"];

// Identifier characters of a custom property or class name. A banned name only matches when it is
// not embedded in a longer identifier, so `.ksc-figure--good` and `--border-strong` (while looking
// for `--border`) are left alone.
const IDENT = "A-Za-z0-9_-";

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Parses the machine lines of `.lintrc-tokens.txt`.
 * @param {string} text
 * @returns {Array<{ kind: "token" | "prefix" | "literal"; value: string }>}
 */
export function parseDenyList(text) {
  /** @type {Record<string, "token" | "prefix" | "literal">} */
  const kinds = { "BANNED-TOKEN": "token", "BANNED-PREFIX": "prefix", "BANNED-LITERAL": "literal" };
  /** @type {Array<{ kind: "token" | "prefix" | "literal"; value: string }>} */
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    const m = /^(BANNED-TOKEN|BANNED-PREFIX|BANNED-LITERAL)\s+(.+)$/.exec(line);
    if (m) out.push({ kind: kinds[m[1]], value: m[2].trim() });
  }
  return out;
}

/** @param {{ kind: string; value: string }} rule */
function denyMatcher({ kind, value }) {
  let body = escapeRe(value);
  if (kind === "literal") {
    // Boundary only where the literal starts or ends with an identifier character.
    const pre = new RegExp(`^[${IDENT}]`).test(value) ? `(?<![${IDENT}])` : "";
    const post = new RegExp(`[${IDENT}]$`).test(value) ? `(?![${IDENT}])` : "";
    return new RegExp(`${pre}${body}${post}`, "g");
  }
  if (kind === "prefix") return new RegExp(`(?<![${IDENT}])${body}`, "g");
  return new RegExp(`(?<![${IDENT}])${body}(?![${IDENT}])`, "g");
}

/**
 * @param {string} text
 * @param {number} index
 */
const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/** Names a file declares: `--x:`, `style:--x=`, `setProperty("--x"`. */
/** @param {string} text */
function declaredNames(text) {
  /** @type {Set<string>} */
  const names = new Set();
  for (const m of text.matchAll(new RegExp(`(?<![${IDENT}])(--[${IDENT}]+)\\s*:`, "g"))) {
    names.add(m[1]);
  }
  for (const m of text.matchAll(new RegExp(`style:(--[${IDENT}]+)`, "g"))) names.add(m[1]);
  for (const m of text.matchAll(new RegExp(`setProperty\\(\\s*["'\`](--[${IDENT}]+)`, "g"))) {
    names.add(m[1]);
  }
  return names;
}

/**
 * @param {Array<{ path: string; text: string }>} files
 * @param {Array<{ kind: string; value: string }>} deny
 * @param {{ declared?: Iterable<string> }} [options] extra declared names (besides the files')
 * @returns {Array<{ path: string; line: number; rule: string; match: string }>}
 */
export function findTokenViolations(files, deny, options = {}) {
  const violations = [];
  const declared = new Set(options.declared ?? []);
  for (const f of files) for (const n of declaredNames(f.text)) declared.add(n);
  const declaredList = [...declared];

  const matchers = deny.map((d) => ({ d, re: denyMatcher(d) }));
  const refRe = new RegExp(`var\\(\\s*(--[${IDENT}]*)(\\$\\{|[,)\\s])`, "g");

  for (const f of files) {
    for (const { d, re } of matchers) {
      for (const m of f.text.matchAll(re)) {
        violations.push({
          path: f.path,
          line: lineOf(f.text, m.index),
          rule: `retired-${d.kind}`,
          match: m[0],
        });
      }
    }
    for (const m of f.text.matchAll(refRe)) {
      const name = m[1];
      const dynamic = m[2] === "${";
      const known = dynamic ? declaredList.some((d) => d.startsWith(name)) : declared.has(name);
      if (!known) {
        violations.push({
          path: f.path,
          line: lineOf(f.text, m.index),
          rule: "undeclared-var",
          match: dynamic ? `${name}\${…}` : name,
        });
      }
    }
  }
  return violations;
}

// Resolve the repo root by walking up from this script to the directory that holds apps/web — the
// same approach as lint-save-pattern.mjs (git rev-parse can return a subdirectory in a worktree).
export function resolveRepoRoot() {
  const scriptDir = import.meta.dirname ?? resolve(new URL(import.meta.url).pathname, "..");
  let dir = scriptDir;
  for (let i = 0; i < 10 && dir !== "/"; i++) {
    if (existsSync(resolve(dir, "apps", "web"))) return dir;
    dir = resolve(dir, "..");
  }
  return execSync("git rev-parse --show-toplevel").toString().trim();
}

/** Collects the scanned source files below `srcDir`: no tests, no `__tests__` directory. */
/** @param {string} srcDir */
export function collectSourceFiles(srcDir) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (name === "__tests__" || name === "node_modules") continue;
        walk(full);
      } else if (SCAN_EXTENSIONS.some((ext) => name.endsWith(ext)) && !name.endsWith(".test.ts")) {
        out.push(full);
      }
    }
  };
  if (existsSync(srcDir)) walk(srcDir);
  return out;
}

/**
 * The whole lint run, without process side effects. Throws on the two vacuity conditions (an empty
 * deny list, zero scanned files) so a green result always means something was checked.
 * @param {{ srcDir: string; denyText: string; root?: string }} args
 * @returns {{ code: number; messages: string[]; scanned: number; violations: object[] }}
 */
export function runLint({ srcDir, denyText, root }) {
  const deny = parseDenyList(denyText);
  if (deny.length === 0) {
    throw new Error(
      "[lint:tokens] ABORT — the deny list is empty (.lintrc-tokens.txt has no machine lines).",
    );
  }
  const paths = collectSourceFiles(srcDir);
  if (paths.length === 0) {
    throw new Error(`[lint:tokens] ABORT — scanned zero files below ${srcDir}.`);
  }
  const files = paths.map((p) => ({
    path: root ? relative(root, p) : p,
    text: readFileSync(p, "utf8"),
  }));
  const violations = findTokenViolations(files, deny);
  const messages = [];
  if (violations.length > 0) {
    messages.push(
      `[lint:tokens] ${violations.length} violation(s) across ${files.length} file(s):`,
    );
    for (const v of violations) messages.push(`  ${v.path}:${v.line} — ${v.rule}: ${v.match}`);
    messages.push(
      "See apps/web/.lintrc-tokens.txt for the replacement cheat sheet; declare a new token only in apps/web/src/tokens.css.",
    );
    return { code: 1, messages, scanned: files.length, violations };
  }
  messages.push(
    `[lint:tokens] OK — ${files.length} file(s) scanned, ${deny.length} deny rule(s), every var() is declared.`,
  );
  return { code: 0, messages, scanned: files.length, violations };
}

function main() {
  const root = resolveRepoRoot();
  const denyPath = resolve(root, "apps", "web", ".lintrc-tokens.txt");
  const denyText = existsSync(denyPath) ? readFileSync(denyPath, "utf8") : "";
  let result;
  try {
    result = runLint({ srcDir: resolve(root, "apps", "web", "src"), denyText, root });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  for (const line of result.messages) (result.code === 0 ? console.log : console.error)(line);
  process.exit(result.code);
}

// Run only when invoked directly, so importing the checker in a test does not lint.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
