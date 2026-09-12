#!/usr/bin/env node
/**
 * lint:comment-language — Issue #131 gate: code comments are English (CLAUDE.md:87).
 *
 * Scans `apps/api/src` and `apps/web/src` for comments (`//`, `/* … *​/`, JSDoc) written
 * in German prose and reports them. It does NOT rewrite anything — Issue #131's scope is
 * explicit: "erst die Regel und die Zahl, dann die Entscheidung über den Bestand" (first
 * the rule and the number, then the decision about what to do with the backlog). Existing
 * violations are tolerated via a checked-in baseline (see BASELINE_FILE below); the gate
 * fails CI only on comments that are German AND not already in that baseline.
 *
 * ── Detection strategy ──────────────────────────────────────────────────────────────────
 * Detection is by STOPWORD, not by umlaut/German-character heuristic. An umlaut heuristic
 * fires on exactly the terms CLAUDE.md says must stay untranslated inside English prose —
 * "Monatsabschluss", "Zeitnachtrag", "Revisionssicherheit", "Saldo", "Ist", "Soll", ArbZG/
 * BUrlG domain nouns, etc. (see lint-comment-language-terms.mjs). Those are not stopwords,
 * so an English comment that names one is never flagged.
 *
 * A comment is flagged as German only when it contains at least TWO DISTINCT German
 * function words (der/die/das/und/nicht/wird/muss/…, full list below) — STOPWORD_THRESHOLD.
 * One is not enough: a single stray "die" or "es" can appear as a false cognate or a code
 * fragment quoted in prose ("call `es.filter()`"). Two distinct function words in one
 * comment is a much stronger signal of actual German prose and, on this codebase, produced
 * no observed false positive during baseline generation (see SUMMARY.md for the count this
 * threshold produced against the real baseline).
 *
 * Only comment PROSE is checked — never string literals. German belongs in user-facing
 * string literals (UI text, error messages) and must stay there; a naive regex over raw
 * source would misfire on e.g. `"// nicht löschen"` inside a string. `extractComments()`
 * below is therefore a real character-level scanner: it tracks single/double-quoted
 * strings, template literals (including nested `${…}` expressions, which can themselves
 * contain further strings/templates/comments), and regex literals (vs. the `/` division
 * operator, disambiguated by the preceding significant token) so that only text the
 * JS/TS parser itself would treat as a comment is ever handed to the classifier.
 *
 * `.svelte` files are scanned by extracting their `<script>` block(s) (main + `module`/
 * `context="module"`) and running the same scanner on that content. Markup and `<style>`
 * blocks are OUT OF SCOPE — HTML comments (`<!-- -->`) and CSS comments are a different
 * comment grammar and are not covered by this gate. This mirrors where the vast majority
 * of substantive comments in this codebase live (route files, utils, stores — all .ts).
 *
 * Scope:
 *   - apps/api/src/**\/*.ts
 *   - apps/web/src/**\/*.ts
 *   - apps/web/src/**\/*.svelte  (script blocks only, see above)
 *
 * Flags:
 *   --update-baseline   Overwrite BASELINE_FILE with the current violation set and exit 0.
 *                        Run this after a deliberate cleanup pass, never to silence a new
 *                        violation you haven't looked at.
 *
 * Env:
 *   LINT_COMMENT_LANGUAGE_SOFT=1   Soft-mode: exit 0 even on new violations (migration
 *                                  window), mirroring LINT_UI_CLASSES_SOFT / LINT_SAVE_PATTERN_SOFT.
 *
 * Exit codes:
 *   0 — no NEW violations (baseline ones are tolerated) OR LINT_COMMENT_LANGUAGE_SOFT=1
 *   1 — new violations found and soft-mode disabled
 */
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, relative, join } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { GERMAN_DOMAIN_TERMS, GERMAN_DOMAIN_TERMS_LOWER } from "./lint-comment-language-terms.mjs";

// Resolve repo root the same way lint-ui-classes.mjs / lint-save-pattern.mjs do: walk up
// from this script's own location rather than trusting `git rev-parse --show-toplevel`,
// which can return a subdirectory when GIT_DIR is set (e.g. inside a git worktree).
const repoRoot = (() => {
  const scriptDir = import.meta.dirname ?? resolve(new URL(import.meta.url).pathname, "..");
  let dir = scriptDir;
  for (let i = 0; i < 10 && dir !== "/"; i++) {
    if (existsSync(resolve(dir, "apps", "api")) && existsSync(resolve(dir, "apps", "web")))
      return dir;
    dir = resolve(dir, "..");
  }
  return execSync("git rev-parse --show-toplevel").toString().trim();
})();

const BASELINE_FILE = resolve(repoRoot, "scripts/lint-comment-language-baseline.json");

const SCOPES = [
  { app: "apps/api", dir: "apps/api/src", exts: [".ts"] },
  { app: "apps/web", dir: "apps/web/src", exts: [".ts", ".svelte"] },
];

// ── German function-word stopwords (see header for the "why stopwords, not umlauts" note) ──
export const STOPWORDS = new Set([
  "der",
  "die",
  "das",
  "den",
  "dem",
  "des",
  "und",
  "oder",
  "nicht",
  "kein",
  "keine",
  "wenn",
  "wird",
  "werden",
  "muss",
  "müssen",
  "soll",
  "sollen",
  "kann",
  "können",
  "darf",
  "dürfen",
  "ohne",
  "für",
  "nur",
  "beim",
  "dann",
  "mit",
  "auf",
  "aus",
  "über",
  "nach",
  "vor",
  "seit",
  "damit",
  "weil",
  "dass",
  "sich",
  "wie",
  "hier",
  "diese",
  "dieser",
  "dieses",
  "es",
  "ist",
  "sind",
  "war",
  "haben",
  "hat",
]);

export const STOPWORD_THRESHOLD = 2;

const GERMAN_DOMAIN_TERMS_SET = new Set(GERMAN_DOMAIN_TERMS);

const WORD_RE = /[A-Za-zÀ-ÖØ-öø-ÿß]+/g;

// ── Character-level comment/string/template/regex scanner ──────────────────────────────
// Keywords after which a leading `/` starts a regex literal rather than division. This
// is the classic ambiguity in tokenizing JS without a full parser; the heuristic below
// (preceding significant token) is the same approach used by lightweight tokenizers.
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "do",
  "else",
  "case",
  "await",
  "default",
]);

function isRegexAllowed(state) {
  if (state.lastSig === "") return true;
  if (/[)\]]/.test(state.lastSig)) return false; // after ) or ] -> division
  if (/[a-zA-Z0-9_$]/.test(state.lastSig)) {
    // After an identifier/number -> division, UNLESS that identifier is a keyword that
    // can be immediately followed by a regex (return /foo/, typeof /foo/, ...).
    return REGEX_PRECEDING_KEYWORDS.has(state.lastWord);
  }
  return true; // after operators/punctuation/start-of-file -> regex likely
}

function makeComment(source, start, end, kind) {
  const text = source.slice(start, end);
  const line = source.slice(0, start).split("\n").length;
  return { text, start, end, kind, line };
}

/** Scans the inside of a template literal (after the opening `` ` ``) until its closing
 * `` ` ``, recursing into `${…}` expressions via scanRegion(stopAtBrace=true). */
function scanTemplate(source, state, comments) {
  const n = source.length;
  while (state.i < n) {
    const ch = source[state.i];
    if (ch === "\\") {
      state.i += 2;
      continue;
    }
    if (ch === "`") {
      state.i++;
      return;
    }
    if (ch === "$" && source[state.i + 1] === "{") {
      state.i += 2;
      scanRegion(source, state, comments, true);
      continue;
    }
    state.i++;
  }
}

/** Scans a region of code, collecting comments into `comments`. If `stopAtBrace` is true,
 * this is the inside of a `${…}` template expression: an unmatched `}` at brace-depth 0
 * ends the region (this is how nested `${…}` expressions containing their own strings,
 * templates, and comments are handled — see the `${` branch below, called recursively). */
function scanRegion(source, state, comments, stopAtBrace) {
  const n = source.length;
  let depth = 0;
  while (state.i < n) {
    const ch = source[state.i];
    const next = source[state.i + 1];

    if (stopAtBrace && ch === "}" && depth === 0) {
      state.i++;
      return;
    }
    if (ch === "{") {
      depth++;
      state.lastSig = "{";
      state.lastWord = "";
      state.i++;
      continue;
    }
    if (ch === "}") {
      depth--;
      state.lastSig = "}";
      state.lastWord = "";
      state.i++;
      continue;
    }

    if (ch === "/" && next === "/") {
      const start = state.i;
      let j = state.i + 2;
      while (j < n && source[j] !== "\n") j++;
      comments.push(makeComment(source, start, j, "line"));
      state.i = j;
      continue;
    }
    if (ch === "/" && next === "*") {
      const start = state.i;
      let j = state.i + 2;
      while (j < n && !(source[j] === "*" && source[j + 1] === "/")) j++;
      j = Math.min(j + 2, n);
      comments.push(makeComment(source, start, j, "block"));
      state.i = j;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = state.i + 1;
      while (j < n) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === quote) {
          j++;
          break;
        }
        j++;
      }
      state.i = j;
      state.lastSig = quote;
      state.lastWord = "";
      continue;
    }
    if (ch === "`") {
      state.i++;
      scanTemplate(source, state, comments);
      state.lastSig = "`";
      state.lastWord = "";
      continue;
    }
    if (ch === "/" && isRegexAllowed(state)) {
      let j = state.i + 1;
      let inClass = false;
      let ok = false;
      while (j < n) {
        const c = source[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "\n") break; // unterminated on this line -> not a regex, fall through
        if (c === "[") {
          inClass = true;
          j++;
          continue;
        }
        if (c === "]") {
          inClass = false;
          j++;
          continue;
        }
        if (c === "/" && !inClass) {
          j++;
          ok = true;
          break;
        }
        j++;
      }
      if (ok) {
        while (j < n && /[a-z]/i.test(source[j])) j++; // flags
        state.i = j;
        state.lastSig = "/";
        state.lastWord = "";
        continue;
      }
      // Not a valid regex (unterminated) — fall through, treat `/` as a plain operator char.
    }
    if (/\s/.test(ch)) {
      state.i++;
      continue; // whitespace never updates lastSig/lastWord
    }
    if (/[a-zA-Z0-9_$]/.test(ch)) {
      let j = state.i;
      while (j < n && /[a-zA-Z0-9_$]/.test(source[j])) j++;
      state.lastWord = source.slice(state.i, j);
      state.lastSig = source[j - 1];
      state.i = j;
      continue;
    }
    state.lastSig = ch;
    state.lastWord = "";
    state.i++;
  }
}

/** Extracts every `//` and `/* … *​/` comment (including JSDoc) from JS/TS source, never
 * looking inside string or template literals. Exported for unit testing. */
export function extractComments(source) {
  const comments = [];
  const state = { i: 0, lastSig: "", lastWord: "" };
  scanRegion(source, state, comments, false);
  return comments;
}

/** Extracts comments from a `.svelte` file by running extractComments() over each
 * `<script>` block's content, offsetting positions back into the full file. Markup and
 * `<style>` blocks are intentionally out of scope (see header). Exported for testing. */
export function extractSvelteComments(source) {
  const comments = [];
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = scriptRe.exec(source))) {
    const blockStart = m.index + m[0].indexOf(m[1]);
    for (const c of extractComments(m[1])) {
      const start = c.start + blockStart;
      const end = c.end + blockStart;
      comments.push({
        text: c.text,
        start,
        end,
        kind: c.kind,
        line: source.slice(0, start).split("\n").length,
      });
    }
  }
  return comments;
}

// ── Classification ──────────────────────────────────────────────────────────────────────
function commentInnerText(comment) {
  if (comment.kind === "line") return comment.text.replace(/^\/\//, "");
  return comment.text.replace(/^\/\*\*?/, "").replace(/\*\/$/, "");
}

/**
 * Classifies one comment's text. Returns `{ isGerman, matchedWords }`. A comment is
 * German when it contains at least STOPWORD_THRESHOLD DISTINCT German function words.
 * Words that exactly (case-sensitively) match a known German domain noun (GERMAN_DOMAIN_
 * TERMS) are excluded from matching — this is the one real collision class (e.g. the noun
 * "Ist" vs. the verb "ist"): capitalized-as-a-noun occurrences don't count, lowercase
 * prose occurrences still do.
 *
 * A second, narrower exclusion handles the ALL-CAPS form of the same nouns: this codebase
 * writes UI-label-style prose like "SOLL(BISHER)/IST/MONAT-SALDO" inside otherwise-English
 * comments, and an all-caps "SOLL"/"IST" is still the noun, not the stopword. A token is
 * excluded on this path only when it is ENTIRELY uppercase AND its lowercased form is a
 * known domain noun — this is deliberately narrower than "skip all-caps tokens", because
 * German prose also uses caps for emphasis (e.g. "KEINE Urlaubstage gutschreiben" in
 * apps/api/src/__tests__/section9-invariants.test.ts:333), and that must still count
 * toward its own comment's detection. Exported for unit testing.
 */
export function classifyComment(text) {
  const matched = new Set();
  let m;
  WORD_RE.lastIndex = 0;
  while ((m = WORD_RE.exec(text))) {
    const raw = m[0];
    if (GERMAN_DOMAIN_TERMS_SET.has(raw)) continue;
    if (raw === raw.toUpperCase() && GERMAN_DOMAIN_TERMS_LOWER.has(raw.toLowerCase())) continue;
    const lower = raw.toLowerCase();
    if (STOPWORDS.has(lower)) matched.add(lower);
  }
  return { isGerman: matched.size >= STOPWORD_THRESHOLD, matchedWords: [...matched].sort() };
}

/**
 * Runs the full pipeline (extract comments -> classify) over one file's source and
 * returns violation entries. `file` is a repo-relative path used only for reporting.
 * Exported for unit testing.
 */
export function findCommentLanguageViolations(source, file) {
  const comments = file.endsWith(".svelte")
    ? extractSvelteComments(source)
    : extractComments(source);
  const violations = [];
  for (const comment of comments) {
    const inner = commentInnerText(comment);
    const { isGerman, matchedWords } = classifyComment(inner);
    if (!isGerman) continue;
    const excerpt = inner.trim().replace(/\s+/g, " ").slice(0, 120);
    violations.push({ file, line: comment.line, text: excerpt, matchedWords });
  }
  return violations;
}

// ── File walking ─────────────────────────────────────────────────────────────────────────
function listSourceFiles(dir, exts) {
  const abs = resolve(repoRoot, dir);
  if (!existsSync(abs)) return [];
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (exts.some((ext) => entry.endsWith(ext))) out.push(full);
    }
  };
  walk(abs);
  return out;
}

// ── Baseline key: stable across line-number drift (hash of normalized comment text, plus
// an occurrence index to disambiguate identical comments repeated in the same file) ──────
function violationKey(v, occurrenceIndex) {
  const hash = createHash("sha1").update(v.text).digest("hex").slice(0, 12);
  return `${v.file}::${hash}::${occurrenceIndex}`;
}

function loadBaseline() {
  if (!existsSync(BASELINE_FILE)) return new Set();
  const data = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
  return new Set(data);
}

function writeBaseline(keys) {
  writeFileSync(BASELINE_FILE, JSON.stringify([...keys].sort(), null, 2) + "\n");
}

function main() {
  const updateBaseline = process.argv.includes("--update-baseline");

  const violations = [];
  const perApp = {};
  for (const { app, dir, exts } of SCOPES) {
    perApp[app] = 0;
    for (const file of listSourceFiles(dir, exts)) {
      const rel = relative(repoRoot, file);
      const source = readFileSync(file, "utf8");
      const fileViolations = findCommentLanguageViolations(source, rel);
      perApp[app] += fileViolations.length;
      violations.push(...fileViolations);
    }
  }

  // Assign occurrence-disambiguated baseline keys.
  const occurrenceCounts = new Map();
  const keyed = violations.map((v) => {
    const dupKey = `${v.file}::${v.text}`;
    const occurrence = (occurrenceCounts.get(dupKey) ?? 0) + 1;
    occurrenceCounts.set(dupKey, occurrence);
    return { ...v, key: violationKey(v, occurrence) };
  });

  if (updateBaseline) {
    writeBaseline(keyed.map((v) => v.key));
    console.log(
      `[lint:comment-language] Baseline updated: ${keyed.length} violation(s) written to ` +
        `${relative(repoRoot, BASELINE_FILE)} (apps/api: ${perApp["apps/api"]}, apps/web: ${perApp["apps/web"]}).`,
    );
    return;
  }

  const baseline = loadBaseline();
  const newViolations = keyed.filter((v) => !baseline.has(v.key));

  console.log(
    `[lint:comment-language] Current: ${keyed.length} German comment(s) found ` +
      `(apps/api: ${perApp["apps/api"]}, apps/web: ${perApp["apps/web"]}).`,
  );
  console.log(
    `[lint:comment-language] Baseline: ${baseline.size} known violation(s) tolerated ` +
      `(see ${relative(repoRoot, BASELINE_FILE)}).`,
  );
  console.log(`[lint:comment-language] New: ${newViolations.length} violation(s) not in baseline.`);

  if (newViolations.length > 0) {
    console.error(`\n[lint:comment-language] New German comment(s):\n`);
    for (const v of newViolations) {
      console.error(`  ${v.file}:${v.line} — [${v.matchedWords.join(", ")}] "${v.text}"`);
    }
    console.error(
      `\nFix options:\n` +
        `  1. Rewrite the comment in English (the required fix — CLAUDE.md:87)\n` +
        `  2. If this is a legitimate German domain noun the detector doesn't know about yet,\n` +
        `     add it to scripts/lint-comment-language-terms.mjs\n` +
        `  3. If you deliberately reviewed and are choosing to defer this comment,\n` +
        `     run 'node scripts/lint-comment-language.mjs --update-baseline' — do NOT do this\n` +
        `     to silence a violation you introduced without looking at it\n`,
    );
    if (process.env.LINT_COMMENT_LANGUAGE_SOFT === "1") {
      console.error(
        "[lint:comment-language] LINT_COMMENT_LANGUAGE_SOFT=1 — exiting 0 despite new violations (migration mode).\n",
      );
      return;
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `[lint:comment-language] OK — no new German comments (baseline of ${baseline.size} known violation(s) unchanged).`,
  );
}

// Run the walk only when the script is invoked directly, so importing the exported
// functions in a test does not lint (same guard as lint-save-pattern.mjs).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
