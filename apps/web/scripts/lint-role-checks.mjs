#!/usr/bin/env node
/**
 * lint:role-checks — Phase 378 (Issue #378), the web-side analogue of
 * `apps/api/scripts/lint-role-checks.ts` (Phase 75b, Issue #75, D-19).
 *
 * Since Phase 378 the Team-Bereich UI decides visibility by the caller's PERMISSIONS
 * (`$authStore.user.permissions`, via `$lib/permissions.ts`), not by the legacy compat
 * `user.role` — a Salon/Personen-scope role assignment (Salonmanager, Ausbilder templates, #76)
 * never widens `role` (#357), but does widen the permission list. This gate keeps the FILES this
 * phase converted from regressing back to a role check.
 *
 * ── Why scoped to an explicit file list, not all of apps/web/src (unlike the API gate) ─────────
 * The API gate can scan its whole `src/` because Phase 75b converted EVERY access decision in the
 * API before it landed. The web has not had that pass yet: `/admin/*`, `/reports`' internal
 * `isManager`, `/settings`' role label, and other pre-existing role checks are deliberately
 * UNTOUCHED by Phase 378 (out of scope — #83 owns the role-management UI they belong to; see
 * `378-CONTEXT.md` D-03). A repo-wide gate would fail on all of those on day one with no way to
 * tell a legitimate pre-existing check from a regression. `SCOPE_FILES` below is exactly the set
 * of files Phase 378 converted; a file joins this list only when it is actually migrated off
 * `user.role` for a visibility decision, same spirit as `lint-tenant-scoping-exceptions.json` and
 * `lint-t100-09-routes.json`'s incremental-adoption registers.
 *
 * ── Why regex/line-based, not a Svelte AST walk (unlike the API gate) ──────────────────────────
 * `apps/api/scripts/lint-role-checks.ts` parses TypeScript with `ts.createSourceFile` — every
 * scoped file there is plain `.ts`. Most files here are `.svelte`: the `<script>` block is valid
 * TypeScript, but the template (`{#if ...}`, `{@const ...}`) is Svelte's own mustache syntax, which
 * is not parseable by `ts.createSourceFile` and has no first-party AST tool this repo already
 * depends on. A hand-rolled Svelte-template parser is disproportionate engineering for a bug-fix
 * phase whose actual regression surface is four known shapes (below). This gate is therefore a
 * PER-LINE regex sweep over the whole file (script AND template), not a walk of an AST — simpler,
 * but blind to a check split across multiple lines or reached through a renamed intermediate
 * (documented in "known limits" below, same convention `lint-role-checks.ts` and
 * `lint-t100-09-routes.ts` use for their own blind spots).
 *
 * ── What is flagged (per line, in every SCOPE_FILES entry) ─────────────────────────────────────
 *   - `authstore-role-read`  — `$authStore.user.role` / `$authStore.user?.role`;
 *   - `role-comparison`      — a bare `role` (or `.role`) compared with `===`/`!==`/`==`/`!=`
 *                              against `"ADMIN"`/`"MANAGER"`/`"EMPLOYEE"`, either side;
 *   - `role-membership`      — `[...].includes(...)` on an array literal containing one of those
 *                              three string literals;
 *   - `role-derived-identifier` — a declaration of `isManager` or `isAdmin`.
 *
 * ── What is tolerated ────────────────────────────────────────────────────────────────────────
 * Two lines per file, hand-listed in `ALLOWLIST` below with the reason inline — both are the
 * SAME documented exception (Phase 378, D-03): the `/admin/*` sub-nav gate in `Sidebar.svelte`
 * and `BottomTabBar.svelte` (out of scope, #83's territory) and Sidebar's own role-LABEL badge
 * (display text, decides nothing — the same class of read `compat-role.ts` is allowlisted for on
 * the API side). A finding on a clean tree is a role check to convert to a permission, never a
 * reason to widen `ALLOWLIST` — adding an entry there is itself a change to review, same as the
 * API gate's single allowlisted file.
 *
 * ── Known limits (accepted, stated not hidden) ──────────────────────────────────────────────────
 *   - A check reached through a renamed intermediate the regex does not recognise (e.g. a role
 *     value stored under a name other than `role`) is invisible here — code review is the second
 *     net, same as the API gate's own documented blind spots.
 *   - A check split across several template expressions, or hidden behind a function call, is not
 *     reconstructed — this gate reads text, not semantics.
 *   - `.svelte` files are scanned as plain text (script AND template together); a role literal
 *     inside a genuine string value unrelated to authorization (there are none in `SCOPE_FILES`
 *     today) would still be flagged — narrow the pattern or extend `ALLOWLIST` if that ever
 *     happens, never disable the file wholesale.
 *
 * Exit codes:
 *   0 — every file in SCOPE_FILES exists and none has a finding;
 *   1 — a scoped file is missing (the anti-vacuity concern: a moved/renamed file must turn this
 *       gate red, never let it silently scan nothing), or at least one finding.
 */
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

// Resolve repo root the same way lint-save-pattern.mjs / lint-ui-classes.mjs do — walking up from
// this script's own location, so it works from a worktree with GIT_DIR set (pre-commit hooks).
const repoRoot = (() => {
  const scriptDir = import.meta.dirname ?? resolve(new URL(import.meta.url).pathname, "..");
  let dir = scriptDir;
  for (let i = 0; i < 10 && dir !== "/"; i++) {
    if (existsSync(resolve(dir, "apps", "web"))) return dir;
    dir = resolve(dir, "..");
  }
  return execSync("git rev-parse --show-toplevel").toString().trim();
})();

/** Every file Phase 378 converted off `user.role` for a Team-Bereich visibility decision. */
export const SCOPE_FILES = [
  "apps/web/src/routes/(app)/dashboard/+page.svelte",
  "apps/web/src/routes/(app)/team/+layout.svelte",
  "apps/web/src/routes/(app)/team/time-entries/+page.svelte",
  "apps/web/src/routes/(app)/team/leave/+page.svelte",
  "apps/web/src/routes/(app)/inbox/+page.svelte",
  "apps/web/src/routes/(app)/shifts/+page.svelte",
  "apps/web/src/routes/(app)/teamcal/+page.svelte",
  "apps/web/src/routes/(app)/leave/+page.svelte",
  "apps/web/src/lib/components/leave/CalendarDayDetail.svelte",
  "apps/web/src/lib/leave/team-calendar-visibility.ts",
  "apps/web/src/lib/components/layout/BottomTabBar.svelte",
  "apps/web/src/lib/components/layout/Sidebar.svelte",
  "apps/web/src/lib/nav/team-nav.ts",
  "apps/web/src/lib/permissions.ts",
];

/** (file, exact trimmed line text) pairs that are read-but-decide-nothing (a display label) or
 *  are the documented `/admin/*`-only exception (#83 scope, Phase 378 D-03) — never a Team-Bereich
 *  visibility decision. See the module docblock. */
const ALLOWLIST = new Set([
  'apps/web/src/lib/components/layout/Sidebar.svelte::const role = $authStore.user?.role; // ADMIN sub-groups gate only (#83 scope) — see comment above',
  'apps/web/src/lib/components/layout/Sidebar.svelte::if (role === "ADMIN") {',
  'apps/web/src/lib/components/layout/Sidebar.svelte::{#if $authStore.user.role === "ADMIN"}',
  'apps/web/src/lib/components/layout/Sidebar.svelte::{:else if $authStore.user.role === "MANAGER"}',
  'apps/web/src/lib/components/layout/BottomTabBar.svelte::const role = $authStore.user?.role; // ADMIN-only /admin/* items gate — see comment above',
  'apps/web/src/lib/components/layout/BottomTabBar.svelte::? role === "ADMIN"',
]);

const ROLE_LITERALS = ["ADMIN", "MANAGER", "EMPLOYEE"];
const ROLE_LITERAL_ALT = ROLE_LITERALS.join("|");

const PATTERNS = [
  {
    shape: "authstore-role-read",
    re: /\$authStore\.user\??\.role\b/,
  },
  {
    shape: "role-comparison",
    re: new RegExp(
      `\\brole\\s*(===|!==|==|!=)\\s*["'](${ROLE_LITERAL_ALT})["']` +
        `|["'](${ROLE_LITERAL_ALT})["']\\s*(===|!==|==|!=)\\s*role\\b`,
    ),
  },
  {
    shape: "role-membership",
    re: new RegExp(`\\[[^\\]]*["'](${ROLE_LITERAL_ALT})["'][^\\]]*\\]\\s*\\.includes\\(`),
  },
  {
    shape: "role-derived-identifier",
    re: /\b(const|let)\s+is(Manager|Admin)\b/,
  },
];

/** Every finding in `text` (one file's full content, script + template), as `{ line, shape,
 *  text }`. Pure — no file I/O, so it is unit-testable against fixture strings. */
export function findRoleChecks(text) {
  const lines = text.split("\n");
  const findings = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    for (const { shape, re } of PATTERNS) {
      if (re.test(raw)) {
        findings.push({ line: i + 1, shape, text: trimmed });
      }
    }
  }
  return findings;
}

function run() {
  // Anti-vacuity: every scoped file must exist, or the gate is silently checking nothing.
  const missing = SCOPE_FILES.filter((f) => !existsSync(resolve(repoRoot, f)));
  if (missing.length > 0) {
    console.error(
      `lint:role-checks: FAILED — ${missing.length} SCOPE_FILES entr${missing.length === 1 ? "y" : "ies"} do not exist (moved/renamed without updating this gate):`,
    );
    for (const f of missing) console.error(`  ${f}`);
    process.exit(1);
  }

  const findings = [];
  for (const file of SCOPE_FILES) {
    const text = readFileSync(resolve(repoRoot, file), "utf8");
    for (const finding of findRoleChecks(text)) {
      if (ALLOWLIST.has(`${file}::${finding.text}`)) continue;
      findings.push({ file, ...finding });
    }
  }

  if (findings.length > 0) {
    console.error(
      `lint:role-checks: FAILED — ${findings.length} role check(s) in Phase-378-converted files (Issue #378):`,
    );
    for (const f of findings) console.error(`  ${f.file}:${f.line}: ${f.shape} — ${f.text}`);
    console.error(
      "Convert to a permission check via $lib/permissions.ts (hasPermission/hasAnyPermission) " +
        "against docs/permissions.md, or — if this is a genuine display-only read that decides " +
        "nothing — add it to ALLOWLIST in apps/web/scripts/lint-role-checks.mjs with a reason.",
    );
    process.exit(1);
  }

  console.log(
    `lint:role-checks: OK — 0 finding(s) in ${SCOPE_FILES.length} file(s) (Phase 378 scope)`,
  );
  process.exit(0);
}

// Run the scan only when this file is the process entry point — importing it (a future fixture
// test) never scans anything.
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  run();
}
