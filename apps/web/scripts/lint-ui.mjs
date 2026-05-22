#!/usr/bin/env node
/**
 * lint:ui — UI primitive usage enforcement (D-04).
 *
 * Grep-based gate. Four rules, each tagged with a literal `rule:` identifier
 * (these literals are part of the public spec — acceptance criteria grep for them):
 *
 *   1. "page-head-required"      — Every (app)/+page.svelte must use <PageHead>.
 *   2. "no-raw-h1"               — No raw <h1> outside PageHead.svelte.
 *   3. "no-inline-color"         — No inline style with color/background/border declarations.
 *   4. "no-raw-primitive-class"  — No banned primitive classes in route files.
 *
 * Flags:
 *   --staged           Restrict scope to git-staged files (.svelte only).
 *
 * Env:
 *   LINT_UI_SOFT=1     Soft-mode: exit 0 even on violations (migration window).
 *
 * Escape-hatch:
 *   A line containing `eslint-disable-next-line.*clokr/ui` immediately
 *   PRECEDING the offending line silences the violation. PR review will
 *   scrutinize each use.
 *
 * Exit codes:
 *   0 — no violations OR LINT_UI_SOFT=1
 *   1 — violations found and soft-mode disabled
 */
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, relative } from "node:path";

const repoRoot = execSync("git rev-parse --show-toplevel").toString().trim();
const isStaged = process.argv.includes("--staged");

const APP_ROUTES = "apps/web/src/routes/(app)";
const ALL_SVELTE = "apps/web/src";

/**
 * List .svelte files under `scope` (relative to repo root).
 * In --staged mode, only files in the git index are returned.
 */
function listFiles(scope, ext = ".svelte") {
  if (isStaged) {
    const out = execSync(`git diff --cached --name-only --diff-filter=ACM`, {
      cwd: repoRoot,
    }).toString();
    return out
      .split("\n")
      .filter((f) => f.startsWith(scope) && f.endsWith(ext))
      .map((f) => resolve(repoRoot, f))
      .filter((f) => existsSync(f));
  }
  // Non-staged: full sweep via find. The `(app)` glob has shell-special chars so quote.
  const out = execSync(`find '${scope}' -type f -name '*${ext}'`, {
    cwd: repoRoot,
  }).toString();
  return out
    .split("\n")
    .filter(Boolean)
    .map((f) => resolve(repoRoot, f));
}

const violations = [];

// ── CHECK 1: page-head-required ────────────────────────────────────────────
// Every (app)/+page.svelte must render a page head. A page satisfies the rule
// by either using <PageHead> directly OR by using one of the admin templates
// that render <PageHead> internally (ListDetail, SectionStack, ToolPage).
// +layout.svelte is exempt. Redirect stubs (script body is only an
// onMount(() => goto(...)) call with no template markup) are exempt.
const REDIRECT_STUB_RE = /onMount\(\s*\(\s*\)\s*=>\s*goto\(/;
const HEAD_PROVIDER_RE = /<(?:PageHead|ListDetail|SectionStack|ToolPage)\b/;
function isRedirectStub(content) {
  const tplPart = content.replace(/<script[\s\S]*?<\/script>/g, "").trim();
  return tplPart === "" && REDIRECT_STUB_RE.test(content);
}
for (const file of listFiles(APP_ROUTES)) {
  if (!file.endsWith("+page.svelte")) continue;
  const content = readFileSync(file, "utf8");
  if (isRedirectStub(content)) continue;
  if (!HEAD_PROVIDER_RE.test(content)) {
    violations.push({
      rule: "page-head-required",
      file,
      msg: "Every (app)/ page must render a head via <PageHead>, <ListDetail>, <SectionStack>, or <ToolPage>",
    });
  }
}

// ── CHECK 2: no-raw-h1 ─────────────────────────────────────────────────────
// PageHead.svelte is the ONLY place raw <h1> is allowed inside the (app) shell.
// (auth)/ pages are standalone (no app shell, no PageHead) and may use their
// own <h1> — exempt from this rule.
for (const file of listFiles(ALL_SVELTE)) {
  if (file.endsWith("lib/components/layout/PageHead.svelte")) continue;
  if (file.includes("/routes/(auth)/")) continue;
  const content = readFileSync(file, "utf8");
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/<h1\b/.test(lines[i])) {
      if (i > 0 && /eslint-disable-next-line.*clokr\/ui/.test(lines[i - 1])) continue;
      violations.push({
        rule: "no-raw-h1",
        file,
        line: i + 1,
        msg: "Raw <h1> outside PageHead.svelte",
      });
    }
  }
}

// ── CHECK 3: no-inline-color ───────────────────────────────────────────────
// Inline `style="…"` declaring color/background/background-color/border is
// banned in route files. CSS custom property passthrough (style="--card-idx:3")
// is NOT matched by this regex.
const INLINE_STYLE_RE = /\bstyle="[^"]*(color:|background:|background-color:|border:)/;
for (const file of listFiles(APP_ROUTES)) {
  const content = readFileSync(file, "utf8");
  const stripped = content.replace(/<style[\s\S]*?<\/style>/g, "");
  const lines = stripped.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (INLINE_STYLE_RE.test(lines[i])) {
      if (i > 0 && /eslint-disable-next-line.*clokr\/ui/.test(lines[i - 1])) continue;
      violations.push({
        rule: "no-inline-color",
        file,
        line: i + 1,
        msg: "Inline color/background/border style attribute — use theme classes",
      });
    }
  }
}

// ── CHECK 4: no-raw-primitive-class ───────────────────────────────────────
// Banned classes belong to primitives. Routes must use the component instead.
const FORBIDDEN = [
  "scrim",
  "modal-hd",
  "modal-body",
  "modal-foot",
  "card-hd",
  "card-title",
  "card-sub",
  "month-bar",
  "month-bar-stats",
  "mstat",
  "approval-row",
];
const FORBIDDEN_RE = new RegExp(`\\b(class|class:)="[^"]*\\b(${FORBIDDEN.join("|")})\\b`);
for (const file of listFiles(APP_ROUTES)) {
  const content = readFileSync(file, "utf8");
  const stripped = content.replace(/<style[\s\S]*?<\/style>/g, "");
  const lines = stripped.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (FORBIDDEN_RE.test(lines[i])) {
      if (i > 0 && /eslint-disable-next-line.*clokr\/ui/.test(lines[i - 1])) continue;
      const match = lines[i].match(FORBIDDEN_RE);
      violations.push({
        rule: "no-raw-primitive-class",
        file,
        line: i + 1,
        msg: `Raw class "${match[2]}" — use the corresponding primitive (Modal/Card/MonthBar/ApprovalRow)`,
      });
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────
if (violations.length > 0) {
  console.error(`\n[lint:ui] ${violations.length} violation(s):\n`);
  for (const v of violations) {
    const loc = relative(repoRoot, v.file) + (v.line ? `:${v.line}` : "");
    console.error(`  [${v.rule}] ${loc} — ${v.msg}`);
  }
  console.error(`\nSee apps/web/src/lib/components/ui/README.md for the rules.\n`);
  if (process.env.LINT_UI_SOFT === "1") {
    console.error("[lint:ui] LINT_UI_SOFT=1 — exiting 0 despite violations (migration mode).\n");
    process.exit(0);
  }
  process.exit(1);
}
console.log(`[lint:ui] OK — no violations.`);
