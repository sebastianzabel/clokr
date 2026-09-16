#!/usr/bin/env -S pnpm exec tsx
/**
 * lint:tenant-scoping — GitHub Issue #204: a mechanical check that a NEW route or service does not
 * read a client-supplied identifier into a tenant-scoped Prisma model without constraining the
 * result to the caller's own tenant. This is CLAUDE.md § Multi-Tenancy Convention ("All
 * data-access queries filter by tenantId from req.user.tenantId") made mechanical rather than left
 * to code review, which is exactly where the nine gaps PR #202 fixed slipped through.
 *
 * ── What this file is (and is not) ────────────────────────────────────────────────────────────
 * This is the CLI entry point ONLY. The actual analysis lives in three plan-01/02/03 modules this
 * file composes:
 *   - `lint-tenant-scoping-model-graph.ts` — which of the 41 schema models are tenant-scoped, and
 *     by what relation path (D-05/D-19).
 *   - `lint-tenant-scoping-candidates.ts` — `selectCandidates`: which in-scope Prisma calls even
 *     reach a client-supplied identifier (D-12/D-14's filter, run FIRST).
 *   - `lint-tenant-scoping-verdict.ts` — `reachVerdict`: D-13's three-way scoping recognition
 *     (inline where-scoping, fetch-then-compare, guard-fetch).
 * `lint-tenant-scoping-exceptions.ts` (this same plan) supplies the named, reasoned exception
 * mechanism this file's `runLint` consults before turning a raw finding into a reported one.
 *
 * ── Why a standalone script, not an ESLint rule (D-02) ────────────────────────────────────────
 * `eslint.config.js` today configures ONLY rules from third-party plugins — there is no local
 * ESLint plugin infrastructure in this repo. A real custom rule needs one. Building that
 * infrastructure for a single rule is exactly the generalisation-on-spec ADR 0001 rules out; the
 * house form for this kind of gate (`scripts/lint-comment-language.mjs`,
 * `apps/web/scripts/lint-ui-classes.mjs`, `apps/web/scripts/lint-save-pattern.mjs`) already exists
 * and is what this script follows: exit codes, a soft-mode env var, a counted report, fix options.
 *
 * ── Why `apps/api/scripts/`, not repo-root `scripts/` (D-20) ──────────────────────────────────
 * D-11's scope is exclusively `apps/api/src/routes` and `apps/api/src/services`, and `@clokr/db` —
 * needed here for the DMMF-derived model graph — is a real, already-present dependency of
 * `apps/api`, not of the repo root. `apps/api/scripts/` already has the `audit-*.ts` convention
 * this script follows (TypeScript, DB-free pure-function core, `__tests__` alongside). The D-02
 * house-form promise is about BUILD AND EXECUTION CONTRACT (exit codes, flags, output shape, CI
 * wiring) — not about the file extension: this script is `.ts`, not `.mjs`, on purpose.
 *
 * ── Scope (D-11) and the `__tests__` exclusion (D-15) ─────────────────────────────────────────
 * Only `apps/api/src/routes/` and `apps/api/src/services/` are walked (`SCOPED_DIRS` in
 * `lint-tenant-scoping-types.ts`); `utils/` and `plugins/` never see a client-supplied identifier
 * from a request, which is this gate's precondition (D-12), so they stay out. `__tests__`
 * subdirectories are excluded EXPLICITLY (`EXCLUDED_DIR_SEGMENT`), not by accident of globbing —
 * test fixtures construct their own literal identifiers and have no client-supplied value by
 * definition, so a correctly applied D-12 filter would exclude them anyway; making the exclusion
 * explicit means it cannot silently drift into scope later.
 *
 * ── The D-08 guardrail, stated once here for whoever reads a failing run first ───────────────
 * A hit on a clean tree is a FINDING and belongs in a GitHub issue, not in this list. Do not add an
 * exception entry to silence a finding you have not understood — see the fix-options message this
 * script prints on a failing run, and `lint-tenant-scoping-exceptions.ts`'s own header for how to
 * write a real one.
 *
 * ── Flags ──────────────────────────────────────────────────────────────────────────────────────
 *   --json   Print a machine-readable JSON array of findings and nothing else. Used by the first
 *            real run's triage (plan 04, Task 3) and by plan 05's red-once (D-09) proof.
 *
 * ── Env ────────────────────────────────────────────────────────────────────────────────────────
 *   LINT_TENANT_SCOPING_SOFT=1   Soft-mode: exit 0 even on findings outside the exception list
 *                                (migration window), mirroring LINT_COMMENT_LANGUAGE_SOFT /
 *                                LINT_UI_CLASSES_SOFT / LINT_SAVE_PATTERN_SOFT. An INVALID or STALE
 *                                exception entry is never softened — that is a gate-configuration
 *                                defect, not a migration-window violation, and softening it would
 *                                let a broken exceptions file silently disable itself.
 *
 * Exit codes:
 *   0 — no findings outside the exception list OR LINT_TENANT_SCOPING_SOFT=1
 *   1 — findings outside the exception list, or an invalid exception entry
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { PrismaCall, ScopedVia, Verdict } from "./lint-tenant-scoping-types";
import { buildModelGraph } from "./lint-tenant-scoping-model-graph";
import {
  listScopedFiles,
  findPrismaCalls,
  selectCandidates,
} from "./lint-tenant-scoping-candidates";
import { reachVerdict } from "./lint-tenant-scoping-verdict";
import {
  loadExceptions,
  validateExceptions,
  matchException,
} from "./lint-tenant-scoping-exceptions";
import type { TenantScopingException } from "./lint-tenant-scoping-exceptions";

// ── Public shape ───────────────────────────────────────────────────────────────────────────────

export type RunLintFinding = { call: PrismaCall; detail: string };

export type RunLintCounts = {
  /** Every relevant Prisma call found in SCOPED_DIRS, before the D-14 client-supplied filter. */
  inScope: number;
  /** In-scope calls that passed the D-14 client-supplied-identifier filter. */
  candidates: number;
  /** How many candidates were judged scoped, broken down by which D-13 way accepted them. */
  byVia: Record<ScopedVia, number>;
  /** Raw findings covered by a valid, matching (non-stale) exception entry. */
  excepted: number;
  /** Raw findings NOT covered by any exception — what actually gets reported. */
  findings: number;
};

export type RunLintResult = {
  exitCode: 0 | 1;
  findings: RunLintFinding[];
  counts: RunLintCounts;
  /** Exception-list validation errors (missing/whitespace/short reason, stale entry, malformed file). */
  errors: string[];
};

const EMPTY_BY_VIA: Record<ScopedVia, number> = {
  "inline-tenant-id": 0,
  "inline-principal-field": 0,
  "inline-relation-filter": 0,
  "fetch-then-compare": 0,
  "guard-fetch": 0,
};

/** `<file>:<line> — <model>.<method> — <detail>` — the one line-format every finding is printed as. */
export function formatFinding(
  call: PrismaCall,
  verdict: Extract<Verdict, { scoped: false }>,
): string {
  return `${call.file}:${call.line} — ${call.model}.${call.method} — ${verdict.detail}`;
}

/**
 * Runs the full gate against `opts.repoRoot` and returns a result — performs NO `process.exit`,
 * so the caller (this file's own `main()`, or a test) owns the exit decision. This is what makes
 * the gate testable without spawning a subprocess: `runLint` is a pure function of the tree on
 * disk plus the `LINT_TENANT_SCOPING_SOFT` env var.
 */
export function runLint(opts: { repoRoot: string; json?: boolean }): RunLintResult {
  const { repoRoot } = opts;
  const graph = buildModelGraph();

  // Total in-scope calls (before D-14) — computed separately from selectCandidates, which already
  // returns only the post-filter candidates, so the report can show BOTH numbers (plan's <behavior>:
  // "total in-scope calls, candidates after the D-14 filter").
  let inScope = 0;
  for (const relPath of listScopedFiles(repoRoot)) {
    const absPath = path.join(repoRoot, relPath);
    const text = fs.readFileSync(absPath, "utf8");
    const sourceFile = ts.createSourceFile(
      absPath,
      text,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
    );
    inScope += findPrismaCalls(sourceFile, relPath).length;
  }

  const candidates = selectCandidates(repoRoot);

  const byVia: Record<ScopedVia, number> = { ...EMPTY_BY_VIA };
  const rawFindings: RunLintFinding[] = [];

  for (const candidate of candidates) {
    const verdict = reachVerdict({
      call: candidate.call,
      node: candidate.node,
      whereArg: candidate.whereArg,
      handler: candidate.handler,
      bindings: candidate.bindings,
      graph,
      sourceFile: candidate.sourceFile,
    });
    if (verdict.scoped) {
      byVia[verdict.via] += 1;
    } else {
      rawFindings.push({ call: candidate.call, detail: verdict.detail });
    }
  }

  // Exception validation runs against the RAW finding set (pre-except), so staleness is judged
  // against what the gate actually found this run, not against some earlier snapshot.
  let exceptions: readonly TenantScopingException[] = [];
  const errors: string[] = [];
  try {
    const raw = loadExceptions(repoRoot);
    const validated = validateExceptions(
      raw,
      rawFindings.map((f) => f.call),
    );
    if (validated.ok) {
      exceptions = validated.entries;
    } else {
      errors.push(...validated.errors);
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  const findings: RunLintFinding[] = [];
  let excepted = 0;
  for (const f of rawFindings) {
    const match = matchException(f.call, exceptions);
    if (match && "matched" in match) {
      excepted += 1;
      continue;
    }
    findings.push(f);
  }

  const counts: RunLintCounts = {
    inScope,
    candidates: candidates.length,
    byVia,
    excepted,
    findings: findings.length,
  };

  const softMode = process.env.LINT_TENANT_SCOPING_SOFT === "1";
  let exitCode: 0 | 1 = 0;
  if (errors.length > 0) {
    // Never softened — see the header's Env section: an invalid/stale exception entry is a
    // gate-configuration defect, not a migration-window violation.
    exitCode = 1;
  } else if (findings.length > 0) {
    exitCode = softMode ? 0 : 1;
  }

  return { exitCode, findings, counts, errors };
}

// ── CLI entry ──────────────────────────────────────────────────────────────────────────────────

function resolveRepoRoot(): string {
  const scriptDir = import.meta.dirname ?? resolve(new URL(import.meta.url).pathname, "..");
  let dir = scriptDir;
  for (let i = 0; i < 10 && dir !== "/"; i++) {
    if (existsSync(resolve(dir, "apps", "api"))) return dir;
    dir = resolve(dir, "..");
  }
  return execSync("git rev-parse --show-toplevel").toString().trim();
}

function printReport(result: RunLintResult): void {
  if (result.errors.length > 0) {
    console.error(
      `\n[lint:tenant-scoping] ${result.errors.length} invalid exception ` +
        `entr${result.errors.length === 1 ? "y" : "ies"} in apps/api/scripts/lint-tenant-scoping-exceptions.json:\n`,
    );
    for (const e of result.errors) console.error(`  ${e}`);
  }

  console.log(
    `[lint:tenant-scoping] ${result.counts.inScope} in-scope call(s), ` +
      `${result.counts.candidates} candidate(s) after the D-14 filter ` +
      `(inline-tenant-id: ${result.counts.byVia["inline-tenant-id"]}, ` +
      `inline-principal-field: ${result.counts.byVia["inline-principal-field"]}, ` +
      `inline-relation-filter: ${result.counts.byVia["inline-relation-filter"]}, ` +
      `fetch-then-compare: ${result.counts.byVia["fetch-then-compare"]}, ` +
      `guard-fetch: ${result.counts.byVia["guard-fetch"]}), ` +
      `${result.counts.excepted} exception(s) applied, ${result.counts.findings} finding(s).`,
  );

  if (result.findings.length === 0 && result.errors.length === 0) {
    console.log(`[lint:tenant-scoping] OK — no findings outside the exception list.`);
    return;
  }

  if (result.findings.length > 0) {
    console.error(`\n[lint:tenant-scoping] ${result.findings.length} finding(s):\n`);
    for (const f of result.findings) {
      console.error(`  ${formatFinding(f.call, { scoped: false, detail: f.detail })}`);
    }
    console.error(
      `\nFix options:\n` +
        `  1. Scope the query: add \`tenantId: req.user.tenantId\` to the \`where\`, or a relation\n` +
        `     filter (e.g. \`employee: { tenantId: req.user.tenantId } }\`) for a model without its\n` +
        `     own column.\n` +
        `  2. Or fetch-then-compare: load the record, compare its tenantId against req.user.tenantId\n` +
        `     and return 404 BEFORE any write — the established idiom in this codebase\n` +
        `     (see apps/api/src/routes/time-entries.ts:681-698).\n` +
        `  3. Or, if this site is genuinely tenant-safe for a reason the check cannot see, add an\n` +
        `     entry to apps/api/scripts/lint-tenant-scoping-exceptions.json (one entry per HANDLER,\n` +
        `     naming every covered call explicitly — see that file's header):\n` +
        `       { "file": "...", "handler": "METHOD /path", "validatedAt": 0,\n` +
        `         "calls": [{ "call": "model.method", "line": 0 }], "reason": "<why this is safe>" }\n` +
        `     The reason is MANDATORY and is validated by this script — an entry without one fails\n` +
        `     the run, and so does a call this script finds that is not named in 'calls'. Do NOT add\n` +
        `     an entry to silence a finding you have not understood: per Issue #204, a hit on a\n` +
        `     clean tree is a finding and belongs in a GitHub issue, not in this list.\n`,
    );
  }

  if (result.exitCode === 0 && process.env.LINT_TENANT_SCOPING_SOFT === "1") {
    console.error(
      "[lint:tenant-scoping] LINT_TENANT_SCOPING_SOFT=1 — exiting 0 despite findings (migration mode).\n",
    );
  }
}

function main(): void {
  const repoRoot = resolveRepoRoot();
  const json = process.argv.includes("--json");
  const result = runLint({ repoRoot, json });

  if (json) {
    console.log(
      JSON.stringify(
        result.findings.map((f) => ({
          file: f.call.file,
          line: f.call.line,
          model: f.call.model,
          method: f.call.method,
          detail: f.detail,
        })),
        null,
        2,
      ),
    );
    process.exitCode = result.exitCode;
    return;
  }

  printReport(result);
  process.exitCode = result.exitCode;
}

// Run the scan only when this file is the process entry point — importing it (e.g. from a test,
// or from another one of these lint-tenant-scoping-*.ts modules) never scans anything (Issue #203;
// `apps/api/scripts/audit-workdays-vs-day-hours.ts:253-256` is the script that lacked this guard).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
