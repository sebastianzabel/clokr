#!/usr/bin/env -S pnpm exec tsx
/**
 * lint:t100-09-routes — Phase 259 Plan 02 (Issue #259, D-01/D-03/D-03a/D-03c/D-05/D-06/D-06a/D-07).
 * The completeness half of the T-100-09 checker: every route with a path parameter across
 * `apps/api/src/contexts/*\/api/**\/*.ts` must carry exactly one checked-in classification entry in
 * `apps/api/scripts/lint-t100-09-routes.json`, with a measured reason. The behavioral half — hitting
 * every `probe`-classified route twice and comparing status+body — is plan 259-03's job.
 *
 * ── Why this gate exists (D-01) ────────────────────────────────────────────────────────────────
 * The existing tenant-scoping gate (#204, `lint-tenant-scoping.ts`) reports `0 finding(s)` on the
 * exact defective handler plan 259-01 just fixed — it answers "is the line scoped?", not "is the
 * rejection indistinguishable?". This gate answers the second question, by first making sure every
 * candidate route HAS an answer on record at all.
 *
 * ── Why the set is DERIVED, not maintained (D-03, corrected) ─────────────────────────────────────
 * Membership comes from parsing route-file SOURCE TEXT on disk — never from the presence of a
 * `CROSS_TENANT_ACCESS_DENIED` audit call. Deleting that call from a handler rewrites the handler
 * but does not remove the route from the set; both directions are checked (D-03a), so neither a new
 * route nor a deleted one can pass unnoticed. (`onRoute`/Fastify's route tree was the original idea
 * — 259-RESEARCH.md Q1 found no retrofit point onto the already-built shared test app, and
 * lint-guard-vacuity.ts cannot see a Fastify-instance-method call at all, only fs/child_process
 * primitives — so this gate parses source text instead, exactly like its sibling
 * `lint-e2e-spec-registry.ts` does for `apps/e2e/tests/*.spec.ts`.)
 *
 * ── Four independent empty-abort branches, each naming what was looked for ──────────────────────
 * 1. The recursive route-file walk under `apps/api/src/contexts/*\/api/` — zero files means the
 *    path moved, not that the codebase has no routes.
 * 2. The derived route set after the prefix join, and separately the path-param subset — zero means
 *    the parser broke.
 * 3. The register JSON — unparseable, malformed, or zero entries.
 * 4. The watched out-of-scope directory `apps/api/src/composition/` (D-05's named boundary,
 *    converted into an assertion instead of prose): walked and its path-param route count checked —
 *    fails naming any it finds (today 0, per 259-CONTEXT.md's measurement), and ALSO fails if the
 *    walk itself found zero files (the boundary silently disappearing is as bad as it silently
 *    growing).
 *
 * ── House-form notes ──────────────────────────────────────────────────────────────────────────
 * All I/O (`readdirSync`, `readFileSync`, `process.exit`) lives in this file; the pure
 * validation/derivation logic lives in the zero-I/O sibling module
 * `./lint-t100-09-routes-validate.ts`, unit-tested there. Shebang, hand-rolled argv parsing, and the
 * entry-point guard match the `lint-guard-vacuity.ts` / `lint-tenant-scoping.ts` /
 * `lint-e2e-spec-registry.ts` convention (Issue #203 — an unguarded `main()` once dropped a suite's
 * own worker databases on import). `readdirSync` calls sit inside named `function` declarations, not
 * arrow constants — `lint-e2e-spec-registry.ts`'s own comment explains why that resolution matters
 * to `lint-guard-vacuity-detect.ts`'s walk-containing-function tracking.
 *
 * ── D-06 — nothing found while classifying is fixed here ─────────────────────────────────────────
 * A route measured non-conformant while building the register is classified `bekannt-abweichend`
 * with a real, OPEN GitHub issue number and a `validatedAt` date — this gate lets exactly those
 * routes through and expires them after 90 days (D-06a, corrected: offline, no network call).
 *
 * ── Not wired anywhere by this plan ──────────────────────────────────────────────────────────────
 * This gate is NOT added to `package.json`, CI, or `.husky/pre-commit` by plan 259-02 — it is
 * expected to exit 1 until the register is complete (Task 2), and wiring it now would block the
 * very commits that finish it. Wiring is plan 259-03's last task.
 *
 * ── Flags ──────────────────────────────────────────────────────────────────────────────────────
 *   (none)     Full validation; prints a one-line summary and exits 0/1.
 *   --check    Same full validation — the explicit flag CI/pre-commit/README invocations use,
 *              matching `lint-guard-vacuity.ts`'s own `--check` convention.
 *   --rows     One line per registered route: `route | category | reason`, sorted by route. Printed
 *              only when validation passes.
 *   --json     Machine-readable `{ ok, entries }` report.
 *
 * Exit codes:
 *   0 — every derived path-parameter route has exactly one valid, non-stale register entry, no
 *       `bekannt-abweichend` entry has expired, and the composition/ boundary is still empty.
 *   1 — no route files discovered, zero derived routes, an unresolved route-function prefix, a
 *       malformed/empty register, a missing or stale entry, an invalid field, an expired deviation,
 *       or a path-param route found under `apps/api/src/composition/`.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  extractRouteDeclarations,
  extractPrefixMap,
  joinRoutes,
  hasPathParameter,
  validateRegisterDocument,
  diffRegisterAgainstRoutes,
  findExpiredDeviations,
  type RegisterEntry,
} from "./lint-t100-09-routes-validate";

export const CONTEXTS_DIR = "apps/api/src/contexts";
export const COMPOSITION_DIR = "apps/api/src/composition";
export const APP_TS_FILE = "apps/api/src/app.ts";
export const REGISTER_FILE = "apps/api/scripts/lint-t100-09-routes.json";

function resolveRepoRoot(): string {
  return join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
}

/** Recursively collects every `.ts` file under `dir`, skipping `__tests__` directories and
 * `*.test.ts` files. A named function declaration (not an arrow constant) — see module docblock. */
function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      out.push(...walkTsFiles(join(dir, entry.name)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** Every `apps/api/src/contexts/<context>/api/` directory that exists — recursive so a file one
 * directory deeper (`contexts/platform/api/admin/school-holidays.ts`) is still found. */
function discoverContextApiDirs(repoRoot: string): string[] {
  const contextsDir = join(repoRoot, CONTEXTS_DIR);
  return readdirSync(contextsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(contextsDir, e.name, "api"))
    .filter((p) => existsSync(p));
}

function discoverRouteFiles(repoRoot: string): string[] {
  const apiDirs = discoverContextApiDirs(repoRoot);
  const files: string[] = [];
  for (const dir of apiDirs) files.push(...walkTsFiles(dir));
  return files.sort();
}

/** The watched out-of-scope directory (D-05's boundary, turned into an assertion) — flat, one
 * level, `__tests__` excluded by the `isFile()` filter alone (it is a directory entry). */
function discoverCompositionFiles(repoRoot: string): string[] {
  const dir = join(repoRoot, COMPOSITION_DIR);
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts"))
    .map((e) => join(dir, e.name))
    .sort();
}

function relativeToRepoRoot(repoRoot: string, absPath: string): string {
  return absPath
    .slice(repoRoot.length + 1)
    .split("\\")
    .join("/");
}

function renderRows(entries: readonly RegisterEntry[]): string {
  return [...entries]
    .sort((a, b) => a.route.localeCompare(b.route))
    .map((e) => `${e.route} | ${e.category} | ${e.reason}`)
    .join("\n");
}

function countByCategory(entries: readonly RegisterEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of entries) counts[e.category] = (counts[e.category] ?? 0) + 1;
  return counts;
}

export function run(
  repoRoot: string,
  argv: string[],
  nowIso: string = new Date().toISOString(),
): number {
  // ── Empty-abort 1/4: the recursive route-file walk. Zero files means the path moved. This is the
  // gate's own genuine non-emptiness proof of its walked INPUT set (`routeFiles`, derived directly
  // from `discoverRouteFiles`) — `process.exit(1)` rather than `return 1` so
  // `lint-guard-vacuity-detect.ts`'s `branchAborts` recognises this branch as an abort (it tracks
  // `throw` / `process.exit(<nonzero>)` / `process.exitCode = <nonzero>`, never a bare `return`). ──
  const routeFiles = discoverRouteFiles(repoRoot);
  if (routeFiles.length === 0) {
    console.error(
      `lint-t100-09-routes: no route files found under ${CONTEXTS_DIR}/*/api/ — check the path, not the count.`,
    );
    process.exit(1);
  }

  // ── Derive the full route set, then the path-parameter subset (D-05) ────────────────────────────
  const appTsText = readFileSync(join(repoRoot, APP_TS_FILE), "utf8");
  const prefixMap = extractPrefixMap(appTsText);

  const allDeclarations = routeFiles.flatMap((f) =>
    extractRouteDeclarations(readFileSync(f, "utf8"), relativeToRepoRoot(repoRoot, f)),
  );
  const { routes: derivedAllRoutes, unresolved } = joinRoutes(allDeclarations, prefixMap);

  // ── Empty-abort 2/4: an unresolved route function is an ERROR (never a silent drop — this is how
  // shift-patterns.ts's two functions, two prefixes, would vanish under a naive mapping). ─────────
  if (unresolved.length > 0) {
    console.error(
      `lint-t100-09-routes: could not resolve a registration prefix for exported route function(s):`,
    );
    for (const fn of unresolved) console.error(`  - ${fn}`);
    return 1;
  }
  if (derivedAllRoutes.length === 0) {
    console.error(
      `lint-t100-09-routes: derived zero routes from ${routeFiles.length} route file(s) — the parser broke, not that the codebase has no routes.`,
    );
    return 1;
  }

  const derivedPathParamRoutes = derivedAllRoutes.filter((r) =>
    hasPathParameter(r.split(" ")[1] ?? ""),
  );
  if (derivedPathParamRoutes.length === 0) {
    console.error(
      `lint-t100-09-routes: derived ${derivedAllRoutes.length} route(s) but zero carry a path parameter — the parser broke, not that no route has one.`,
    );
    return 1;
  }

  // ── Empty-abort 3/4: the register JSON — unparseable, malformed, or zero entries. ───────────────
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(repoRoot, REGISTER_FILE), "utf8"));
  } catch (e) {
    console.error(
      `lint-t100-09-routes: ${REGISTER_FILE} is not valid JSON (${(e as Error).message}).`,
    );
    return 1;
  }

  const validated = validateRegisterDocument(raw, derivedPathParamRoutes);
  if (!validated.ok) {
    console.error(`lint-t100-09-routes: ${REGISTER_FILE} is invalid:`);
    for (const e of validated.errors) console.error(`  - ${e}`);
    return 1;
  }
  if (validated.doc.entries.length === 0) {
    console.error(
      `lint-t100-09-routes: ${REGISTER_FILE} has zero entries — expected one per derived path-parameter route; check the register, not the count.`,
    );
    return 1;
  }

  const errors: string[] = [];

  const diffed = diffRegisterAgainstRoutes(validated.doc.entries, derivedPathParamRoutes);
  if (!diffed.ok) errors.push(...diffed.errors);

  const expired = findExpiredDeviations(validated.doc.entries, nowIso);
  if (!expired.ok) errors.push(...expired.errors);

  // ── Empty-abort 4/4: the watched out-of-scope directory. Zero FILES there is also a failure —
  // the boundary silently disappearing is as bad as it silently growing a path-param route. Second
  // genuine walked-input-set proof (`compositionFiles`, direct call to `discoverCompositionFiles`);
  // `process.exit(1)` for the same `branchAborts` reason as the first empty-abort above. ───────────
  const compositionFiles = discoverCompositionFiles(repoRoot);
  if (compositionFiles.length === 0) {
    console.error(
      `lint-t100-09-routes: no files found under ${COMPOSITION_DIR}/ — the watched boundary moved, check the path.`,
    );
    process.exit(1);
  }
  const compositionDeclarations = compositionFiles.flatMap((f) =>
    extractRouteDeclarations(readFileSync(f, "utf8"), relativeToRepoRoot(repoRoot, f)),
  );
  const compositionPathParamRoutes = compositionDeclarations
    .filter((d) => hasPathParameter(d.path))
    .map(
      (d) =>
        `${d.method} ${d.path} (${relativeToRepoRoot(repoRoot, join(repoRoot, COMPOSITION_DIR))}/…)`,
    );
  if (compositionPathParamRoutes.length > 0) {
    errors.push(
      `${COMPOSITION_DIR}/ was measured to have 0 path-parameter routes (259-CONTEXT.md) but now has ${compositionPathParamRoutes.length}:`,
      ...compositionPathParamRoutes.map((r) => `  - ${r}`),
      `Classify ${compositionPathParamRoutes.length > 1 ? "them" : "it"} in ${REGISTER_FILE} and widen this gate's scope deliberately — do not silently absorb.`,
    );
  }

  if (errors.length > 0) {
    console.error(`lint-t100-09-routes: FAILED —`);
    for (const e of errors) console.error(`  - ${e}`);
    return 1;
  }

  if (argv.includes("--json")) {
    console.log(JSON.stringify({ ok: true, entries: validated.doc.entries }, null, 2));
    return 0;
  }

  if (argv.includes("--rows")) {
    console.log(renderRows(validated.doc.entries));
    return 0;
  }

  const counts = countByCategory(validated.doc.entries);
  console.log(
    `lint-t100-09-routes: OK — ${derivedPathParamRoutes.length} route(s) classified ` +
      `(probe: ${counts["probe"] ?? 0}, nicht anwendbar: ${counts["nicht anwendbar"] ?? 0}, ` +
      `bekannt-abweichend: ${counts["bekannt-abweichend"] ?? 0})`,
  );
  return 0;
}

function main(): void {
  const repoRoot = resolveRepoRoot();
  process.exitCode = run(repoRoot, process.argv.slice(2));
}

// Run the scan only when this file is the process entry point — importing it (e.g. from a test, or
// from another one of these lint-*.ts modules) never scans anything (Issue #203 — an unguarded
// `main()` once dropped a suite's own worker databases on import).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
