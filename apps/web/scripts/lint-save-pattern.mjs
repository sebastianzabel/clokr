#!/usr/bin/env node
/**
 * lint:save-pattern — D-02/AK-02 gate (Phase 109, Issue #35, D-15/AK-14).
 *
 * This is the machine-checkable half of the Phase-109 save rule. The classification
 * judgment itself ("is this control an atomic single value or one field of a form
 * group?") is documented in `docs/ADMIN_STRUCTURE.md` §3.2.1 — a machine cannot make
 * that judgment, only enforce its type-based consequence.
 *
 * The rule (D-02): inside the admin scope, a text or number `<input>` must never write
 * outside a button-gated group — no debounced autosave, no save-on-blur, regardless of
 * whether the field has siblings. Concretely, such an input must not carry:
 *   (a) any `onblur=` handler, or
 *   (b) an `onchange=` / `oninput=` handler whose expression matches
 *       /\b(api\.|save[A-Z]|toggle[A-Z])/ — i.e. it writes to the server or flips a
 *       named save/toggle handler, rather than only touching local component state.
 *
 * Rule (b) deliberately allows inline arrows that only touch local state — e.g. the
 * `Standard-Arbeitstage` number input on `admin/system` normalises its own value with an
 * inline `oninput` arrow and must keep passing this gate.
 *
 * This gate does NOT try to judge whether a checkbox should be instant or grouped — that
 * classification judgment is documented, not linted (see §3.2.1). Checkboxes, selects,
 * and `type="time"`/`type="date"` inputs are out of scope for this rule by construction —
 * see EXCLUDED_INPUT_TYPES for the full list. An `<input>` with NO `type=` attribute is a
 * text input per the HTML spec and IS in scope (WR-04). `<textarea>` is text-like and would
 * be a D-02 violation on `onblur`, but this scanner only walks `<input>` tags — a `<textarea>`
 * autosave has to be caught in review, not by this gate.
 *
 * Scope:
 *   - apps/web/src/routes/(app)/admin/**\/+page.svelte
 *   - apps/web/src/lib/components/admin/**\/*.svelte
 *
 * Flags:
 *   (none — full sweep only; the script is fast)
 *
 * Env:
 *   LINT_SAVE_PATTERN_SOFT=1   Soft-mode: exit 0 even on violations (migration window),
 *                              mirroring LINT_UI_CLASSES_SOFT.
 *
 * Exit codes:
 *   0 — no violations OR LINT_SAVE_PATTERN_SOFT=1
 *   1 — violations found and soft-mode disabled
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, relative, join } from "node:path";
import { pathToFileURL } from "node:url";

// Resolve repo root: git rev-parse --show-toplevel can return a subdirectory when
// running inside a git worktree with GIT_DIR set (e.g. during pre-commit hooks).
// Workaround: walk up from this script's location to find the actual repo root
// (the directory that contains apps/web/) — same approach as lint-ui-classes.mjs.
const repoRoot = (() => {
  const scriptDir = import.meta.dirname ?? resolve(new URL(import.meta.url).pathname, "..");
  let dir = scriptDir;
  for (let i = 0; i < 10 && dir !== "/"; i++) {
    if (existsSync(resolve(dir, "apps", "web"))) return dir;
    dir = resolve(dir, "..");
  }
  return execSync("git rev-parse --show-toplevel").toString().trim();
})();

const SCOPES = ["apps/web/src/routes/(app)/admin", "apps/web/src/lib/components/admin"];

// `[Ss]ave[A-Z]` rather than `save[A-Z]` so `handleSaveField` — a plausible name in this
// codebase — is matched too; `persist`/`commitX`/`fetch(` close the same class of near-misses.
// Handler-vocabulary matching is inherently a heuristic: a write handler with a name outside
// this set is still a judgment call documented in §3.2.1 rather than something the gate can see.
// NOTE: `[Ss]ave[A-Z]` and `[Pp]ersist` deliberately carry NO leading `\b`. A word boundary
// only exists between a non-word and a word char, so `\bsave[A-Z]` cannot match the `SaveF`
// inside `handleSaveField` — the exact near-miss that motivated widening this pattern.
const WRITEISH = /(\bapi\.|[Ss]ave[A-Z]|\btoggle[A-Z]|[Pp]ersist|[Cc]ommit[A-Z]|\bfetch\()/;

// A missing or unrecognised `type` IS a text input per the HTML spec, so the detector must
// default to "text" rather than skipping the tag (WR-04: seven text inputs inside the linted
// scope carry no literal `type=` and were invisible to the gate). Only the types the rule
// deliberately excludes are skipped — checkbox/radio/time/date are out of scope by construction.
const EXCLUDED_INPUT_TYPES = new Set([
  "checkbox",
  "radio",
  "time",
  "date",
  "datetime-local",
  "file",
  "color",
  "range",
  "month",
  "week",
  "hidden",
  "submit",
  "button",
  "reset",
  "image",
]);

/**
 * Extract every `<input …>` tag from `source`, brace-depth aware.
 *
 * A naive `/<input\b[\s\S]*?>/` lazy match breaks the moment an attribute value contains
 * an arrow function (`() => …`), because the `>` inside `=>` looks like the tag's own
 * closing `>` to a regex that doesn't understand nesting. This scanner instead tracks
 * `{`/`}` depth char-by-char and only treats a bare `>` as the tag terminator while depth
 * is back at 0 — i.e. outside any `{…}` JS-expression attribute value.
 *
 * It additionally skips over quoted attribute values, because a literal `>` inside one would
 * otherwise truncate the tag and hide every attribute after it. That is not theoretical:
 * `admin/system/+page.svelte` carries `sub="Pflicht-Pausen nach § 4 ArbZG (>6h: 30 Min., …)"`.
 */
/** @param {string} source @returns {string[]} */
function extractInputTags(source) {
  /** @type {string[]} */
  const tags = [];
  const re = /<input\b/g;
  let m;
  while ((m = re.exec(source))) {
    let depth = 0;
    let end = -1;
    /** @type {string | null} */
    let quote = null;
    for (let i = m.index; i < source.length; i++) {
      const ch = source[i];
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth <= 0) {
        end = i + 1;
        break;
      }
    }
    if (end === -1) {
      // Unterminated tag (malformed source) — nothing sane to scan; stop here.
      break;
    }
    tags.push(source.slice(m.index, end));
    re.lastIndex = end;
  }
  return tags;
}

/**
 * Pure detector: returns a violation entry for every text/number `<input>` in `source`
 * that writes outside a button-gated group. `file` is carried through into each entry
 * purely for reporting — the detector itself is file-agnostic.
 */
/**
 * @param {string} source
 * @param {string} file
 * @returns {{ file: string, type: string, handler: string, rule: "a" | "b" }[]}
 */
export function findSavePatternViolations(source, file) {
  /** @type {{ file: string, type: string, handler: string, rule: "a" | "b" }[]} */
  const violations = [];
  for (const tag of extractInputTags(source)) {
    // Single OR double quotes, and a missing type defaults to "text" per the HTML spec.
    const type = tag.match(/type\s*=\s*["']([a-z-]+)["']/i)?.[1]?.toLowerCase() ?? "text";
    if (EXCLUDED_INPUT_TYPES.has(type)) continue;

    if (/onblur=/.test(tag)) {
      const onblur = tag.match(/onblur=\{([\s\S]*?)\}\s*(?:\n|\/?>|[a-z-]+=)/);
      violations.push({ file, type, handler: onblur?.[1]?.trim() ?? "(onblur)", rule: "a" });
      continue;
    }
    const handler = tag.match(/on(?:change|input)=\{([\s\S]*?)\}\s*(?:\n|\/?>|[a-z-]+=)/)?.[1];
    if (handler && WRITEISH.test(handler)) {
      violations.push({ file, type, handler: handler.trim(), rule: "b" });
    }
  }
  return violations;
}

/** @param {string} scope @returns {string[]} */
function listSvelteFiles(scope) {
  const abs = resolve(repoRoot, scope);
  if (!existsSync(abs)) return [];
  /** @type {string[]} */
  const out = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".svelte")) {
        out.push(full);
      }
    }
  };
  walk(abs);
  return out;
}

function main() {
  /** @type {{ file: string, type: string, handler: string, rule: "a" | "b" }[]} */
  const violations = [];
  let totalFiles = 0;

  for (const scope of SCOPES) {
    for (const file of listSvelteFiles(scope)) {
      totalFiles += 1;
      const source = readFileSync(file, "utf8");
      const rel = relative(repoRoot, file);
      violations.push(...findSavePatternViolations(source, rel));
    }
  }

  if (violations.length > 0) {
    console.error(
      `\n[lint:save-pattern] ${violations.length} violation(s) across ${totalFiles} file(s):\n`,
    );
    for (const { file, type, handler } of violations) {
      console.error(
        `  ${file} — ${type} input writes via {${handler}} outside a button-gated group (D-02/AK-02)`,
      );
    }
    console.error(
      `\nFix options:\n` +
        `  1. Move the field into its Section's footer() Speichern button (the D-01 form-group class)\n` +
        `  2. If it is genuinely an atomic toggle, use <input type="checkbox"> — D-02 covers text/number only\n` +
        `  3. See docs/ADMIN_STRUCTURE.md §3.2.1 for the classification rule\n`,
    );
    if (process.env.LINT_SAVE_PATTERN_SOFT === "1") {
      console.error(
        "[lint:save-pattern] LINT_SAVE_PATTERN_SOFT=1 — exiting 0 despite violations (migration mode).\n",
      );
      process.exit(0);
    }
    process.exit(1);
  }

  console.log(
    `[lint:save-pattern] OK — ${totalFiles} admin file(s) scanned, no text/number input writes outside a button-gated group.`,
  );
}

// Run the walk only when the script is invoked directly, so importing
// findSavePatternViolations() in a test does not lint.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
