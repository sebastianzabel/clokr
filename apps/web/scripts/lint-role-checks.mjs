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
 * API before it landed. The web converted its pages in steps (#378 Team-Bereich, #83 /admin,
 * #538 the rest: employees, reports, time-entries, settings, Topbar, Sidebar). A repo-wide gate
 * would also scan unrelated files (login payload types, fixtures) with no way to tell them from a
 * decision, so `SCOPE_FILES` below lists every file that decides or labels by permission; a file
 * joins this list when it is migrated off `user.role`, same spirit as
 * `lint-tenant-scoping-exceptions.json` and `lint-t100-09-routes.json`'s incremental-adoption
 * registers. A new page that needs the caller's access joins the list in the same change.
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
 *   - `authstore-snapshot-role-read` — the same read through `get(authStore)` or an `auth` snapshot;
 *   - `role-comparison`      — a bare `role` (or `.role`) compared with `===`/`!==`/`==`/`!=`
 *                              against `"ADMIN"`/`"MANAGER"`/`"EMPLOYEE"`, either side;
 *   - `role-membership`      — `[...].includes(...)` on an array literal containing one of those
 *                              three string literals;
 *   - `role-derived-identifier` — a declaration of `isManager` or `isAdmin`.
 *
 * ── What is tolerated ────────────────────────────────────────────────────────────────────────
 * Nothing, since #538: `ALLOWLIST` is empty. A finding is a role check to convert to a
 * permission, or a role label to derive from the assigned role names - never a reason to add an
 * entry. The mechanism (with its stale-entry check) stays for a future, reviewed exception.
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
  // Phase 83 (#83): the /admin route guard, index redirect, the three former page-level role
  // redirects, the route map and the role UI.
  "apps/web/src/routes/(app)/admin/+layout.svelte",
  "apps/web/src/routes/(app)/admin/+page.svelte",
  "apps/web/src/routes/(app)/admin/shifts/+page.svelte",
  "apps/web/src/routes/(app)/admin/availability/+page.svelte",
  "apps/web/src/routes/(app)/admin/availability/[employeeId]/+page.svelte",
  "apps/web/src/routes/(app)/admin/roles/+page.svelte",
  "apps/web/src/lib/nav/admin-route-permissions.ts",
  "apps/web/src/lib/api/roles.ts",
  "apps/web/src/lib/components/admin/roles/RolesTab.svelte",
  "apps/web/src/lib/components/admin/roles/RoleEditor.svelte",
  "apps/web/src/lib/components/admin/roles/AssignmentsTab.svelte",
  "apps/web/src/lib/components/admin/roles/AssignmentDialog.svelte",
  "apps/web/src/lib/components/ui/CommandPalette.svelte",
  // Phase 84 (#84): the Team block's salon filter and trend-card decisions.
  "apps/web/src/lib/dashboard/team-view.ts",
  // Issue #538: the remaining pages and shell parts that still decided or labelled by the compat
  // role. The persona store (`lib/stores/persona.ts`) is gone - nothing imported it.
  "apps/web/src/routes/(app)/admin/employees/+page.svelte",
  "apps/web/src/routes/(app)/admin/employees/[id]/+page.svelte",
  "apps/web/src/routes/(app)/reports/+page.svelte",
  "apps/web/src/lib/components/reports/PeriodBar.svelte",
  "apps/web/src/lib/components/reports/PeriodKpis.svelte",
  "apps/web/src/lib/components/reports/PeriodRangeDialog.svelte",
  "apps/web/src/lib/components/reports/PersonDrilldown.svelte",
  "apps/web/src/lib/components/reports/TimesAccountsTable.svelte",
  "apps/web/src/lib/reports/period-table.ts",
  "apps/web/src/routes/(app)/time-entries/+page.svelte",
  "apps/web/src/routes/(app)/settings/+page.svelte",
  "apps/web/src/lib/components/layout/Topbar.svelte",
  "apps/web/src/lib/stores/salon-context.ts",
  "apps/web/src/lib/page-rights.ts",
  // Issue #539: the session carries no role (anti-regression for the session store and both
  // sign-in pages; a role field or a role comparison coming back fails here).
  "apps/web/src/lib/stores/auth.ts",
  "apps/web/src/routes/(auth)/login/+page.svelte",
  "apps/web/src/routes/(auth)/otp/+page.svelte",
];

/** (file, exact trimmed line text) pairs that may keep a flagged line. Empty since #538: the last
 *  two entries (Sidebar's role-label badge) now show the assigned role names. The mechanism stays
 *  so a future exception is a reviewed, reasoned entry; a stale entry fails the run
 *  (`staleAllowlistEntries`) - a dead exception is a check that sees nothing. */
export const ALLOWLIST = new Set();

/**
 * ALLOWLIST entries whose file is not in scope or whose text matches no trimmed line of that file.
 * Pure — `readFile` is injected so it is unit-testable.
 * @param {Iterable<string>} allowlist
 * @param {readonly string[]} scopeFiles
 * @param {(file: string) => string} readFile
 * @returns {string[]}
 */
export function staleAllowlistEntries(allowlist, scopeFiles, readFile) {
  const stale = [];
  for (const entry of allowlist) {
    const [file, text] = entry.split("::");
    if (!scopeFiles.includes(file)) {
      stale.push(entry);
      continue;
    }
    const lines = readFile(file)
      .split("\n")
      .map((line) => line.trim());
    if (!lines.includes(text)) stale.push(entry);
  }
  return stale;
}

const ROLE_LITERALS = ["ADMIN", "MANAGER", "EMPLOYEE"];
const ROLE_LITERAL_ALT = ROLE_LITERALS.join("|");

const PATTERNS = [
  {
    shape: "authstore-role-read",
    re: /\$authStore\.user\??\.role\b/,
  },
  {
    // `get(authStore).user?.role`, `getStore(authStore).user.role`, `auth.user?.role` - the same
    // read of the caller's compat role through a store snapshot (Issue #538).
    shape: "authstore-snapshot-role-read",
    re: /\b(get|getStore)\(authStore\)[^;]*\.role\b|\bauth\w*\??\.user\??\.role\b/,
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
 *  text }`. Pure — no file I/O, so it is unit-testable against fixture strings.
 * @param {string} text
 * @returns {{ line: number, shape: string, text: string }[]} */
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

  const stale = staleAllowlistEntries(ALLOWLIST, SCOPE_FILES, (file) =>
    readFileSync(resolve(repoRoot, file), "utf8"),
  );
  if (stale.length > 0) {
    for (const entry of stale) {
      console.error(`lint:role-checks: FAILED — stale ALLOWLIST entry ${entry}`);
    }
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
      `lint:role-checks: FAILED — ${findings.length} role check(s) in converted files (Issues #378, #83, #538):`,
    );
    for (const f of findings) console.error(`  ${f.file}:${f.line}: ${f.shape} — ${f.text}`);
    console.error(
      "Convert to a permission check via $lib/permissions.ts (hasPermission/hasAnyPermission) " +
        "against docs/permissions.md. A role LABEL comes from the assigned role names " +
        "(GET /me/context `roles`), never from the compat role.",
    );
    process.exit(1);
  }

  console.log(
    `lint:role-checks: OK — 0 finding(s) in ${SCOPE_FILES.length} file(s) (Issues #378, #83, #538)`,
  );
  process.exit(0);
}

// Run the scan only when this file is the process entry point — importing it (a future fixture
// test) never scans anything.
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  run();
}
