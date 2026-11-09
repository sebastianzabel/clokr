#!/usr/bin/env node
/**
 * lint:no-alert — no native browser dialogs in the web app (Issue #843, D-843-06).
 *
 * `alert()`, `prompt()` and `confirm()` block the page, cannot be styled or translated, and steal
 * focus. Feedback goes through `toasts` (`$stores/toast`), decisions through `ConfirmDialog` /
 * `ReasonDialog`.
 *
 * Rules, per non-test source file under apps/web/src (.svelte, .ts, .js):
 *   - a bare or window-qualified `alert(`, `prompt(` is always a hit;
 *   - `window.confirm(` is always a hit;
 *   - a bare `confirm(` is a hit unless the same file declares its own `confirm` (a
 *     `function confirm` or a `const|let|var confirm =`); the dialogs that name their own
 *     handler `confirm` are therefore not hits;
 *   - a method call on another object (`toasts.alert(`, `dialog.confirm(`), a longer identifier
 *     (`onConfirm(`, `alertTone(`) and anything inside a comment (JS or HTML) is not a hit.
 *
 * The CLI aborts with exit 1 when it walked zero files (the scan root moved), so an empty walk
 * is a failure, never a clean result.
 *
 * Exit codes: 0 clean, 1 a hit or an empty walk.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, relative, join } from "node:path";
import { pathToFileURL } from "node:url";

// Walk up from this script to the directory that contains apps/web (same approach as
// lint-ui-classes.mjs; `git rev-parse` can answer a subdirectory inside a worktree hook).
const repoRoot = (() => {
  const scriptDir = import.meta.dirname ?? resolve(new URL(import.meta.url).pathname, "..");
  let dir = scriptDir;
  for (let i = 0; i < 10 && dir !== "/"; i++) {
    if (existsSync(resolve(dir, "apps", "web"))) return dir;
    dir = resolve(dir, "..");
  }
  return execSync("git rev-parse --show-toplevel").toString().trim();
})();

const SCAN_ROOT = "apps/web/src";
const SOURCE_EXTENSIONS = [".svelte", ".ts", ".js"];

/**
 * Blank out comments, keeping every newline so line numbers stay true. A `//` only starts a
 * comment at the line start or after whitespace, so `https://…` inside a string survives.
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
  const blank = (/** @type {string} */ m) => m.replace(/[^\n]/g, " ");
  return source
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|\s)\/\/[^\n]*/g, (m, lead) => lead + blank(m.slice(lead.length)));
}

/**
 * Pure detector: every native dialog call in `source`.
 * @param {string} source
 * @returns {{ line: number, call: string }[]}
 */
export function findNativeDialogCalls(source) {
  const code = stripComments(source);
  const declaresOwnConfirm =
    /\bfunction\s+confirm\b/.test(code) || /\b(?:const|let|var)\s+confirm\s*=/.test(code);
  /** @type {{ line: number, call: string }[]} */
  const hits = [];
  const re = /(?<![\w$.])((?:(?:window|globalThis|self)\s*\.\s*)?)(alert|prompt|confirm)\s*\(/g;
  let m;
  while ((m = re.exec(code))) {
    const qualified = m[1] !== "";
    const name = m[2];
    // `function alert(` is a declaration, not a call.
    if (/\bfunction\s*\*?\s*$/.test(code.slice(0, m.index))) continue;
    if (name === "confirm" && !qualified && declaresOwnConfirm) continue;
    hits.push({
      line: code.slice(0, m.index).split("\n").length,
      call: `${m[1].replace(/\s+/g, "")}${name}(`,
    });
  }
  return hits;
}

/**
 * Every non-test source file under apps/web/src.
 * @returns {string[]}
 */
export function listSourceFiles() {
  const abs = resolve(repoRoot, SCAN_ROOT);
  if (!existsSync(abs)) return [];
  /** @type {string[]} */
  const out = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "__tests__" || entry === "node_modules") continue;
        walk(full);
      } else if (SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext)) && !/\.test\.ts$/.test(entry)) {
        out.push(full);
      }
    }
  };
  walk(abs);
  return out;
}

function main() {
  const files = listSourceFiles();
  if (files.length === 0) {
    console.error(
      `[lint:no-alert] scanned 0 file(s) under ${SCAN_ROOT} — the scan root moved or the filter ` +
        `matched nothing. This is a failure, not a clean result.`,
    );
    process.exit(1);
  }
  /** @type {string[]} */
  const lines = [];
  for (const file of files) {
    for (const { line, call } of findNativeDialogCalls(readFileSync(file, "utf8"))) {
      lines.push(`  ${relative(repoRoot, file)}:${line} — ${call}`);
    }
  }
  if (lines.length > 0) {
    console.error(`\n[lint:no-alert] ${lines.length} native dialog call(s) in ${files.length} file(s):\n`);
    for (const l of lines) console.error(l);
    console.error(
      `\nUse toasts.error / toasts.success ($stores/toast) for feedback and ConfirmDialog or ` +
        `ReasonDialog for decisions (Issue #843, D-843-06).\n`,
    );
    process.exit(1);
  }
  console.log(`[lint:no-alert] OK — ${files.length} file(s) scanned, no native dialog call.`);
}

// Run the walk only when invoked directly, so a test can import the detector.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
