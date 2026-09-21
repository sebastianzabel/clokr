#!/usr/bin/env -S pnpm exec tsx
/**
 * lint:e2e-spec-registry — Phase 275 Plan 04 (Issue #275, D-07). The riegel against recurrence for
 * the phase's own finding: 22 of 24 `apps/e2e/tests/*.spec.ts` files ran nowhere, neither in CI
 * nor locally, with no checked-in record anywhere of when a given spec file was even meant to run.
 * Every spec file now carries exactly one entry in `apps/api/scripts/lint-e2e-spec-registry.json`
 * — category `in-ci` / `später-datum` / `später-seed`, plus a mandatory written reason — and this
 * gate fails the build the moment that completeness is no longer true.
 *
 * ── Placement (D-07's own parenthetical, "wird das neue Gate mitsehen") ──────────────────────────
 * This file lives under `apps/api/scripts/` — one of `lint-guard-vacuity.ts`'s five `ROOTS` — on
 * purpose, not under a hypothetical `apps/e2e/scripts/` (not one of those roots, and `apps/e2e` has
 * no `tsx` dependency of its own). Only this placement lets `lint-guard-vacuity.ts --check 0`
 * classify this file as a guard rather than miss it entirely.
 *
 * ── Three inputs, three independent empty-abort branches ─────────────────────────────────────────
 * 1. `apps/e2e/tests/*.spec.ts` — the discovered file set. Zero files means the path moved or the
 *    tree emptied, not that the register is complete.
 * 2. The register JSON, parsed then validated (`validateRegisterDocument`) and diffed against the
 *    discovered set (`diffRegisterAgainstFiles`) for missing and stale entries. An empty
 *    `entries` array is its own named failure, not a vacuous "0 problems".
 * 3. `apps/e2e/playwright.config.ts`'s text, from which `extractE2eCiTestMatch` derives the set of
 *    files some CI-invoked Playwright project actually runs — the input `diffInCiAgainstTestMatch`
 *    checks every `in-ci` register entry against, in both directions. This is the concrete
 *    sub-case that produced Issue #275: a file believed to run in CI that no project actually ran.
 * All I/O (`readdirSync`, `readFileSync`, `process.exit`) lives in this file; the pure
 * validation/diff/extraction logic lives in the zero-I/O sibling module
 * `./lint-e2e-spec-registry-validate.ts`, unit-tested there.
 *
 * ── House-form notes ──────────────────────────────────────────────────────────────────────────
 * Shebang, hand-rolled argv parsing, and the entry-point guard below match the
 * `lint-guard-vacuity.ts` / `lint-tenant-scoping.ts` convention (Issue #203 — an unguarded
 * `main()` once dropped a suite's own worker databases on import).
 *
 * ── There is no "exception" concept here ──────────────────────────────────────────────────────
 * Unlike `lint-guard-vacuity.ts` and `lint-tenant-scoping.ts`, every spec file gets EXACTLY one
 * category, never zero — a "hit on a clean tree" cannot occur by design once the register is
 * complete. A NEW spec file with no entry is the only way to turn this gate red, and the fix is
 * always the same: add the missing register entry naming the real, measured reason — never widen
 * a bypass (CLAUDE.md § Anti-vacuity gate: "a hit on a clean tree is a finding, not an exception").
 *
 * ── Flags ──────────────────────────────────────────────────────────────────────────────────────
 *   (none)     Full validation; prints a one-line summary and exits 0/1.
 *   --check    Same full validation — the explicit flag CI/pre-commit/README invocations use,
 *              matching `lint-guard-vacuity.ts`'s own `--check` convention.
 *   --rows     One line per registered file: `file | category | reason`, sorted by file. Printed
 *              only when validation passes — a row list built over an invalid register would be
 *              misleading.
 *   --json     Machine-readable `{ ok, errors, entries }` report.
 *
 * Exit codes:
 *   0 — every discovered file has exactly one valid, non-stale register entry, and the `in-ci`
 *       category matches, in both directions, the union of testMatch sets the `e2e-ci`, `axe-scan`
 *       and `visual` Playwright projects actually run.
 *   1 — no spec files discovered, a malformed/empty register, a missing or stale entry, an invalid
 *       category/reason, an absent or empty CI project testMatch block, or an in-ci/testMatch
 *       mismatch.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  validateRegisterDocument,
  diffRegisterAgainstFiles,
  extractE2eCiTestMatch,
  diffInCiAgainstTestMatch,
  type RegisterEntry,
} from "./lint-e2e-spec-registry-validate";

export const SPEC_DIR = "apps/e2e/tests";
export const REGISTER_FILE = "apps/api/scripts/lint-e2e-spec-registry.json";
export const PLAYWRIGHT_CONFIG_FILE = "apps/e2e/playwright.config.ts";

function resolveRepoRoot(): string {
  return join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
}

/** Walk-containing named function declaration (Issue #235's own AST classifier resolves
 * walk-derivedness through a call to a NAMED function declaration that itself calls a tracked
 * walk primitive — see `lint-guard-vacuity-detect.ts`'s `computeWalkContainingFunctions`). Must
 * stay a `function` declaration, not a `const ... = () => {}`, for that resolution to apply. */
function discoverSpecFiles(repoRoot: string): string[] {
  return readdirSync(join(repoRoot, SPEC_DIR))
    .filter((f) => f.endsWith(".spec.ts"))
    .map((f) => `${SPEC_DIR}/${f}`)
    .sort();
}

function renderRows(entries: readonly RegisterEntry[]): string {
  return [...entries]
    .sort((a, b) => a.file.localeCompare(b.file))
    .map((e) => `${e.file} | ${e.category} | ${e.reason}`)
    .join("\n");
}

function countByCategory(entries: readonly RegisterEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of entries) counts[e.category] = (counts[e.category] ?? 0) + 1;
  return counts;
}

export function run(repoRoot: string, argv: string[]): number {
  // ── Empty-abort 1/3: the walked directory (see module docblock "THE TOOL PASSES ITS OWN RULE"
  // analogue in lint-guard-vacuity.ts — a moved or emptied apps/e2e/tests must never present as
  // "0 problems, OK"). ──────────────────────────────────────────────────────────────────────────
  const discoveredFiles = discoverSpecFiles(repoRoot);
  if (discoveredFiles.length === 0) {
    console.error(
      `lint-e2e-spec-registry: no spec files found under ${SPEC_DIR} — check the path, not the count.`,
    );
    process.exit(1);
  }

  // ── Empty-abort 2/3: the register JSON — parse failure, malformed shape, or zero entries all
  // exit 1 BEFORE any counting. ────────────────────────────────────────────────────────────────
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(repoRoot, REGISTER_FILE), "utf8"));
  } catch (e) {
    console.error(
      `lint-e2e-spec-registry: ${REGISTER_FILE} is not valid JSON (${(e as Error).message}).`,
    );
    return 1;
  }

  const validated = validateRegisterDocument(raw, discoveredFiles);
  if (!validated.ok) {
    console.error(`lint-e2e-spec-registry: ${REGISTER_FILE} is invalid:`);
    for (const e of validated.errors) console.error(`  - ${e}`);
    return 1;
  }
  if (validated.doc.entries.length === 0) {
    console.error(
      `lint-e2e-spec-registry: ${REGISTER_FILE} has zero entries — expected one per ` +
        `${SPEC_DIR}/*.spec.ts file; check the register, not the count.`,
    );
    return 1;
  }

  const diffed = diffRegisterAgainstFiles(validated.doc.entries, discoveredFiles);
  const errors: string[] = diffed.ok ? [] : [...diffed.errors];

  // ── Empty-abort 3/3: the playwright.config.ts text, and the e2e-ci/axe-scan/visual testMatch
  // blocks it must contain — an absent block or an empty extraction exits 1, naming what was
  // looked for. ────────────────────────────────────────────────────────────────────────────────
  let configText: string;
  try {
    configText = readFileSync(join(repoRoot, PLAYWRIGHT_CONFIG_FILE), "utf8");
  } catch (e) {
    console.error(
      `lint-e2e-spec-registry: cannot read ${PLAYWRIGHT_CONFIG_FILE} (${(e as Error).message}).`,
    );
    return 1;
  }

  const extracted = extractE2eCiTestMatch(configText);
  if (!extracted.ok) {
    errors.push(...extracted.errors.map((e) => `${PLAYWRIGHT_CONFIG_FILE}: ${e}`));
  } else {
    const ciDiff = diffInCiAgainstTestMatch(validated.doc.entries, extracted.files);
    if (!ciDiff.ok) errors.push(...ciDiff.errors);
  }

  if (errors.length > 0) {
    console.error(`lint-e2e-spec-registry: FAILED —`);
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
    `lint-e2e-spec-registry: OK — ${validated.doc.entries.length} file(s) registered ` +
      `(in-ci: ${counts["in-ci"] ?? 0}, später-datum: ${counts["später-datum"] ?? 0}, ` +
      `später-seed: ${counts["später-seed"] ?? 0})`,
  );
  return 0;
}

function main(): void {
  const repoRoot = resolveRepoRoot();
  process.exitCode = run(repoRoot, process.argv.slice(2));
}

// Run the scan only when this file is the process entry point — importing it (e.g. from a test,
// or from another one of these lint-*.ts modules) never scans anything (Issue #203 — an unguarded
// `main()` once dropped a suite's own worker databases on import).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
