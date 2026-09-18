#!/usr/bin/env -S pnpm exec tsx
/**
 * Phase 235 Plan 02 (AC-1/AC-2/AC-4/AC-6/AC-8) — the CLI/gate built on top of plan 01's AST
 * classifier (`./lint-guard-vacuity-detect.ts`). GitHub issue #235 ("Lehre aus Phase 99b…"),
 * issue #240 (the third recurrence), issue #245 (the fourth).
 *
 * ── WHAT THIS TOOL DOES ─────────────────────────────────────────────────────────────────────────
 * Discovers every candidate source file under five repo roots, classifies each with
 * `classifyGuardFile`, and reports a VERDICT per file:
 *   - `not-a-guard`  — does not both walk the tree AND assert on the result (D-02's precondition)
 *   - `guard`        — walks, asserts, AND proves the walked set was non-empty (`inputProof !==
 *                      "none"`) — the healthy case
 *   - `vacuous`      — walks, asserts, proves nothing, and carries no exception — the defect D-02
 *                      exists to catch
 *   - `excepted`     — same as `vacuous`, but a validated register entry names it as a legitimately
 *                      empty-capable set (D-04)
 * "The guard set" (as `--guards` lists it, and as `235-BASELINE.md` groups it A-E) is every file
 * with verdict `guard`, `vacuous`, or `excepted` — i.e. every structural guard, proved or not. Only
 * `--check <n>` and the bare summary line count `vacuous` alone — that count, and ONLY that count,
 * is what plans 03-08 drive toward zero, per group.
 *
 * ── ROOTS AND WHAT IS EXCLUDED, AND WHY ────────────────────────────────────────────────────────
 * Five repo-relative roots: `apps/api/src`, `apps/api/scripts`, `apps/web/src`, `apps/web/scripts`,
 * `scripts` (root). Extensions `.ts`, `.mts`, `.mjs`, `.js`. `.svelte` is explicitly OUT OF SCOPE —
 * no guard in this repo lives in a `.svelte` file today, and this tool does not parse Svelte
 * templates.
 *
 * Skipped by DIRECTORY NAME (defensive — none of these basenames occur under the five roots today,
 * confirmed by `find`, but a walker that assumes so silently is the exact class of assumption this
 * phase distrusts): `node_modules`, `dist`, `.svelte-kit`, `build`, `coverage`, `.git`,
 * `generated` (the last one for `packages/db/generated`, which is not under any of the five roots
 * at all and therefore never reached regardless — named anyway so a future root addition does not
 * silently pull it in).
 *
 * Skipped by EXACT PATH PREFIX (not by directory name — `fixtures/` also exists at
 * `apps/web/src/__tests__/fixtures` and `apps/api/src/services/phorest/__tests__/fixtures`, and
 * those are NOT excluded): `apps/api/scripts/__tests__/fixtures/`. Plan 235-01's 13-file guard-
 * vacuity fixture corpus lives there and is DELIBERATELY vacuous by design (that is the whole point
 * of a fixture matrix) — a tool that reported its own test fixtures as findings would have to be
 * silenced with an exception entry per fixture, which is exactly how an exception register turns
 * into a bucket (D-04). Excluding by rule, not by exception, keeps the register meaning something.
 *
 * ── THE TOOL PASSES ITS OWN RULE ────────────────────────────────────────────────────────────────
 * `discoverCandidateFiles` walks the tree (via `walkDir`'s `readdirSync`); `main()` asserts on the
 * result with an explicit empty-abort (`if (files.length === 0) { …; process.exit(1); }`) BEFORE
 * doing anything else — never a silent "0 vacuous, OK" if discovery itself came back empty (e.g.
 * from a typo'd root or a `--scope` that matches nothing). This file therefore classifies itself as
 * `walks: true, asserts: true, inputProof: "empty-abort"` — a proved guard, not a vacuous one —
 * without any special-casing anywhere in this module or in `classifyGuardFile`.
 *
 * ── HOUSE-FORM NOTES ────────────────────────────────────────────────────────────────────────────
 * Structured after `measure-context-boundary-imports.ts` / `measure-foreign-context-access.ts`:
 * Part A exported pure-ish helpers (file I/O confined to `discover*`/`load*`/`classify*`), Part B a
 * `main()` guarded by `import.meta.url === pathToFileURL(process.argv[1]).href` (Issue #203 — an
 * unguarded `main()` once dropped a suite's own worker databases; this script only reads, but the
 * guard is the house rule, not a database-specific precaution).
 *
 * The exceptions file (`lint-guard-vacuity-exceptions.json`) is a SINGLE-KIND register — unlike
 * `context-boundary-import-exceptions.json`'s two kinds — because every entry here answers the
 * same question ("is this file's empty result legitimate"), never a whole-file count. Required
 * keys: `id`, `file` (repo-relative from the repo root, matching this tool's own `--rows`/`--guards`
 * convention — NOT relative to `apps/api` the way some older exception files in this repo are),
 * `reason` (>= `MIN_REASON_LENGTH` characters), `disappearsIn`. No unknown keys. Fails CLOSED: an
 * invalid register exits 1 before any counting happens, and a `file` that is no longer vacuous (the
 * guard got fixed) is a STALE-entry ERROR, not a silent no-op — a register that quietly tolerates
 * dead entries stops being readable exactly when it matters (mirrors
 * `measure-context-boundary-imports.ts`'s own `validateExceptionsDocument`).
 *
 * ── Flags ────────────────────────────────────────────────────────────────────────────────────────
 *   (none)          One-line summary: `N file(s) scanned, G guard(s), V vacuous, E excepted`.
 *                   Always exits 0 (informational only) unless the exceptions register is invalid
 *                   or discovery came back empty — equality gating is `--check <n>`'s job, not the
 *                   bare invocation's; CI/pre-commit wiring with a fixed number is plan 235-09.
 *   --rows          One line per STRUCTURAL GUARD (verdict `guard`/`vacuous`/`excepted`), sorted by
 *                   file: `file:line | <primitive> | asserts:<kinds> | input-proof:<kind> |
 *                   <verdict>`.
 *   --guards        The guard set only (verdict `guard`/`vacuous`/`excepted`) — one repo-relative
 *                   path per line, sorted. The work list plans 03-08 partition.
 *   --check <n>     Exit 0 iff the VACUOUS count equals `<n>` EXACTLY (equality, not a floor — a
 *                   DECREASE is exactly as much a mismatch as an increase, and the failure text says
 *                   so, because the first instinct on a decrease is to move the number instead of
 *                   asking why). On mismatch, print the delta AND the full vacuous file list, exit 1.
 *   --scope <p>     Restrict discovery (and therefore `--check`/`--guards`/`--rows`) to files whose
 *                   repo-relative path starts with `<p>`. Lets one wave gate its own group without
 *                   depending on a sibling wave's group landing first.
 *   --json          Machine-readable report (used by this plan's own test file).
 *
 * Exit codes:
 *   0 — summary/--rows/--guards/--json printed, or --check matched
 *   1 — no candidate files discovered, the exceptions register is invalid (bad shape, short/missing
 *       reason, stale entry, unknown file), or --check did not match
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  classifyGuardFile,
  type AssertKind,
  type GuardClassification,
  type WalkSite,
} from "./lint-guard-vacuity-detect";

// ── Part A: discovery ──────────────────────────────────────────────────────────────────────────

/** The five roots this tool scans, repo-relative, POSIX-separated. */
export const ROOTS = [
  "apps/api/src",
  "apps/api/scripts",
  "apps/web/src",
  "apps/web/scripts",
  "scripts",
] as const;

/** `.svelte` is deliberately OUT OF SCOPE — stated, not implicit (see module docblock). */
const EXTENSIONS = new Set([".ts", ".mts", ".mjs", ".js"]);

const SKIP_DIR_BASENAMES = new Set([
  "node_modules",
  "dist",
  ".svelte-kit",
  "build",
  "coverage",
  ".git",
  "generated",
]);

/** Plan 235-01's own fixture corpus — deliberately vacuous, excluded by RULE not by exception
 * (see module docblock). Repo-relative, trailing slash. */
const EXCLUDED_PATH_PREFIXES = ["apps/api/scripts/__tests__/fixtures/"];

function toRepoRelative(repoRoot: string, absPath: string): string {
  return relative(repoRoot, absPath).split(sep).join("/");
}

function isExcludedRelPath(relPath: string): boolean {
  return EXCLUDED_PATH_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

function hasTrackedExtension(fileName: string): boolean {
  const dot = fileName.lastIndexOf(".");
  if (dot === -1) return false;
  return EXTENSIONS.has(fileName.slice(dot));
}

/** Recursive tree walk collecting every candidate file's REPO-RELATIVE path into `out`. This
 * function is what makes `discoverCandidateFiles` — and, transitively, `main()`'s own `files`
 * binding — walk-derived under `classifyGuardFile`'s binding-resolution rules (see module
 * docblock, "THE TOOL PASSES ITS OWN RULE"). */
function walkDir(absDir: string, repoRoot: string, out: string[]): void {
  for (const entry of readdirSync(absDir)) {
    if (SKIP_DIR_BASENAMES.has(entry)) continue;
    const full = join(absDir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkDir(full, repoRoot, out);
    } else if (hasTrackedExtension(entry)) {
      const relPath = toRepoRelative(repoRoot, full);
      if (!isExcludedRelPath(relPath)) out.push(relPath);
    }
  }
}

/** Every candidate file across the five roots, repo-relative, sorted. `scope`, if given, restricts
 * the result to paths starting with that prefix (applied post-walk — cheap at this file count, and
 * keeps `walkDir` itself scope-agnostic). */
export function discoverCandidateFiles(repoRoot: string, scope?: string): string[] {
  const out: string[] = [];
  for (const root of ROOTS) {
    const absRoot = join(repoRoot, root);
    if (existsSync(absRoot)) walkDir(absRoot, repoRoot, out);
  }
  const scoped = scope ? out.filter((f) => f.startsWith(scope)) : out;
  return scoped.sort();
}

// ── Part A continued: classification (read + classifyGuardFile per file) ─────────────────────────

/** Reads and classifies every file in `files` (repo-relative, from `discoverCandidateFiles`).
 * `classifyGuardFile` is given the REPO-RELATIVE path as `filePath` — its only use of that string
 * is the `.mjs`/`.js` extension check, which a repo-relative path satisfies identically to an
 * absolute one — so `GuardClassification.file` comes back repo-relative for free, matching this
 * tool's own `--rows`/`--guards`/exceptions-file convention throughout. */
export function classifyDiscoveredFiles(
  repoRoot: string,
  files: readonly string[],
): GuardClassification[] {
  return files.map((relPath) => {
    const text = readFileSync(join(repoRoot, relPath), "utf8");
    return classifyGuardFile(relPath, text);
  });
}

// ── Part A continued: exception register (D-04, single-kind — see module docblock) ───────────────

export const EXCEPTIONS_FILE = "apps/api/scripts/lint-guard-vacuity-exceptions.json";

export const MIN_REASON_LENGTH = 30;

export interface GuardVacuityException {
  id: string;
  /** Repo-relative from the repo root — the SAME convention `--rows`/`--guards` use. */
  file: string;
  reason: string;
  disappearsIn: string;
}

export interface ExceptionsDocument {
  registerSource: string;
  exceptions: GuardVacuityException[];
}

const EXCEPTION_KEYS = new Set(["id", "file", "reason", "disappearsIn"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Reads and JSON-parses the exceptions file. Returns the raw (untyped) value — validation is
 * `validateExceptionsDocument`'s job, kept separate so a caller can test validation against
 * synthetic documents without touching disk. */
export function loadExceptionsRaw(repoRoot: string): unknown {
  const abs = join(repoRoot, EXCEPTIONS_FILE);
  return JSON.parse(readFileSync(abs, "utf8"));
}

/**
 * Validates a raw (untyped) exceptions document against the CURRENT vacuous-candidate set —
 * structural shape, mandatory `reason` (>= `MIN_REASON_LENGTH` characters, a sentence not a
 * label), no unknown keys, and staleness in BOTH directions:
 *   - a `file` absent from `allFiles` (the full discovered set) FAILS as "does not exist"
 *   - a `file` present in `allFiles` but ABSENT from `vacuousFiles` (i.e. it was walked and
 *     asserted on but is no longer vacuous — the guard got fixed) FAILS as STALE
 * Fails CLOSED: any error means `{ ok: false }` and the caller must not proceed to counting.
 */
export function validateExceptionsDocument(
  raw: unknown,
  vacuousFiles: readonly string[],
  allFiles: readonly string[],
): { ok: true; doc: ExceptionsDocument } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  if (!isRecord(raw)) {
    return { ok: false, errors: [`${EXCEPTIONS_FILE} must contain a JSON object`] };
  }
  const { registerSource, exceptions } = raw;
  if (typeof registerSource !== "string" || registerSource.trim().length === 0) {
    errors.push(`'registerSource' must be a non-empty string`);
  }
  if (!Array.isArray(exceptions)) {
    errors.push(`'exceptions' must be an array`);
    return { ok: false, errors };
  }

  const vacuousSet = new Set(vacuousFiles);
  const allSet = new Set(allFiles);
  const validEntries: GuardVacuityException[] = [];
  const seenIds = new Set<string>();

  (exceptions as unknown[]).forEach((entry, index) => {
    const label = isRecord(entry) && typeof entry.id === "string" ? entry.id : `entry #${index}`;

    if (!isRecord(entry)) {
      errors.push(`${label}: entry is not an object`);
      return;
    }

    const unknownKeys = Object.keys(entry).filter((k) => !EXCEPTION_KEYS.has(k));
    if (unknownKeys.length > 0) {
      errors.push(`${label}: unknown key(s) ${unknownKeys.join(", ")}`);
    }

    const { id, file, reason, disappearsIn } = entry;
    if (typeof id !== "string" || id.trim().length === 0) {
      errors.push(`${label}: 'id' must be a non-empty string`);
    } else if (seenIds.has(id)) {
      errors.push(`${label}: duplicate id '${id}'`);
    } else {
      seenIds.add(id);
    }
    if (typeof file !== "string" || file.trim().length === 0) {
      errors.push(`${label}: 'file' must be a non-empty string`);
      return;
    }
    if (typeof reason !== "string" || reason.trim().length < MIN_REASON_LENGTH) {
      errors.push(
        `${label}: 'reason' must be a string of at least ${MIN_REASON_LENGTH} characters — a ` +
          `sentence, not a label (minimum ${MIN_REASON_LENGTH})`,
      );
    }
    if (typeof disappearsIn !== "string" || disappearsIn.trim().length === 0) {
      errors.push(`${label}: 'disappearsIn' is mandatory (a non-empty string)`);
    }

    if (!allSet.has(file)) {
      errors.push(`${label}: '${file}' does not exist among discovered candidate files`);
      return;
    }
    if (!vacuousSet.has(file)) {
      errors.push(
        `${label}: STALE — '${file}' is no longer vacuous (the guard was fixed); remove this ` +
          `exception entry instead of leaving it in place`,
      );
      return;
    }

    if (
      typeof id === "string" &&
      typeof reason === "string" &&
      reason.trim().length >= MIN_REASON_LENGTH &&
      typeof disappearsIn === "string" &&
      disappearsIn.trim().length > 0
    ) {
      validEntries.push({ id, file, reason, disappearsIn });
    }
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, doc: { registerSource: registerSource as string, exceptions: validEntries } };
}

// ── Part A continued: the report — GuardClassification + verdict ─────────────────────────────────

export type GuardVerdict = "not-a-guard" | "guard" | "vacuous" | "excepted";

export interface GuardReportRow extends GuardClassification {
  verdict: GuardVerdict;
  exceptionId?: string;
}

export interface GuardReport {
  /** Every discovered candidate file, structural guard or not, sorted by file. */
  rows: GuardReportRow[];
  /** verdict === "guard" (proved) */
  guards: GuardReportRow[];
  /** verdict === "vacuous" (the defect) */
  vacuous: GuardReportRow[];
  /** verdict === "excepted" */
  excepted: GuardReportRow[];
}

/**
 * Pure: turns already-computed `GuardClassification[]` (from `classifyDiscoveredFiles`) plus a
 * VALIDATED exceptions document into a `GuardReport`. Throws if `classifications` is empty — this
 * is the "empty-discovery abort" AC-6 names explicitly: a report built over zero files must never
 * quietly present as "0 vacuous, OK", because zero scanned and zero found are not the same fact.
 */
export function buildGuardReport(
  classifications: readonly GuardClassification[],
  exceptionsDoc: ExceptionsDocument,
): GuardReport {
  if (classifications.length === 0) {
    throw new Error(
      "buildGuardReport: classifications is empty — discovery found nothing to report on. " +
        "A report over zero files is a finding, not a result.",
    );
  }

  const exceptionByFile = new Map(exceptionsDoc.exceptions.map((e) => [e.file, e]));

  const rows: GuardReportRow[] = classifications
    .map((c): GuardReportRow => {
      const isStructuralGuard = c.walks && c.asserts;
      if (!isStructuralGuard) {
        return { ...c, verdict: "not-a-guard" };
      }
      if (c.inputProof !== "none") {
        return { ...c, verdict: "guard" };
      }
      const exception = exceptionByFile.get(c.file);
      if (exception) {
        return { ...c, verdict: "excepted", exceptionId: exception.id };
      }
      return { ...c, verdict: "vacuous" };
    })
    .sort((a, b) => a.file.localeCompare(b.file));

  return {
    rows,
    guards: rows.filter((r) => r.verdict === "guard"),
    vacuous: rows.filter((r) => r.verdict === "vacuous"),
    excepted: rows.filter((r) => r.verdict === "excepted"),
  };
}

/** All structural guards (proved, vacuous, or excepted) — "the guard set" plans 03-08 partition. */
export function structuralGuards(report: GuardReport): GuardReportRow[] {
  return report.rows.filter((r) => r.verdict !== "not-a-guard");
}

// ── Part B: CLI ────────────────────────────────────────────────────────────────────────────────

function readFlagValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

function primaryAssertKind(assertSites: { kind: AssertKind }[]): string {
  if (assertSites.length === 0) return "none";
  return [...new Set(assertSites.map((s) => s.kind))].join(",");
}

function primaryWalkSite(walkSites: WalkSite[]): { line: number; primitive: string } {
  return walkSites[0] ?? { line: 0, primitive: "none" };
}

function renderRows(rows: GuardReportRow[]): string {
  return rows
    .map((r) => {
      const { line, primitive } = primaryWalkSite(r.walkSites);
      const assertKinds = primaryAssertKind(r.assertSites);
      return `${r.file}:${line} | ${primitive} | asserts:${assertKinds} | input-proof:${r.inputProof} | ${r.verdict}`;
    })
    .join("\n");
}

function summaryLine(report: GuardReport): string {
  return (
    `${report.rows.length} file(s) scanned, ${structuralGuards(report).length} guard(s), ` +
    `${report.vacuous.length} vacuous, ${report.excepted.length} excepted`
  );
}

/**
 * Pure equality check (D-08): `ok` iff `report.vacuous.length === expected` EXACTLY — a decrease
 * is exactly as much a mismatch as an increase, and `message` says so on failure, together with
 * the full vacuous file list (never only the delta), so the next reader can see WHICH guard
 * changed rather than only THAT one did (T-235-05). Exported and tested directly (both directions)
 * independent of argv parsing.
 */
export function evaluateCheck(
  report: GuardReport,
  expected: number,
): { ok: boolean; message: string } {
  if (report.vacuous.length === expected) {
    return { ok: true, message: `--check ${expected} OK — ${summaryLine(report)}` };
  }
  const delta = report.vacuous.length - expected;
  return {
    ok: false,
    message:
      `--check ${expected} FAILED — actual vacuous count is ${report.vacuous.length} ` +
      `(${delta > 0 ? "+" : ""}${delta}). A DECREASE is as much a mismatch as an increase — do ` +
      `not move this number without knowing which file changed. Vacuous file(s):\n` +
      report.vacuous.map((r) => r.file).join("\n"),
  };
}

export function run(repoRoot: string, argv: string[]): number {
  const scope = readFlagValue(argv, "--scope");
  const files = discoverCandidateFiles(repoRoot, scope);

  // Explicit empty-abort (D-02's own precondition, applied to this tool itself — see module
  // docblock "THE TOOL PASSES ITS OWN RULE"): `process.exit(1)` here, not a bare `return`, is
  // what `classifyGuardFile` recognises as the `"empty-abort"` input-proof shape. A silent
  // "0 vacuous, OK" on a typo'd root or an over-narrow --scope would be exactly the defect this
  // whole phase exists to forbid, applied to the forbidding tool itself.
  if (files.length === 0) {
    console.error(
      `lint-guard-vacuity: no candidate files found under roots (${ROOTS.join(", ")})` +
        (scope ? ` with --scope ${scope}` : "") +
        ` — check the roots/scope, not the count.`,
    );
    process.exit(1);
  }

  const classifications = classifyDiscoveredFiles(repoRoot, files);
  const vacuousCandidates = classifications
    .filter((c) => c.walks && c.asserts && c.inputProof === "none")
    .map((c) => c.file);

  const raw = loadExceptionsRaw(repoRoot);
  const validated = validateExceptionsDocument(raw, vacuousCandidates, files);
  if (!validated.ok) {
    console.error(`lint-guard-vacuity: ${EXCEPTIONS_FILE} is invalid:`);
    for (const e of validated.errors) console.error(`  - ${e}`);
    return 1;
  }

  const report = buildGuardReport(classifications, validated.doc);

  if (argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  if (argv.includes("--guards")) {
    console.log(
      structuralGuards(report)
        .map((r) => r.file)
        .join("\n"),
    );
    return 0;
  }

  if (argv.includes("--rows")) {
    console.log(renderRows(structuralGuards(report)));
    return 0;
  }

  const checkIdx = argv.indexOf("--check");
  if (checkIdx !== -1) {
    const expected = Number(argv[checkIdx + 1]);
    if (!Number.isInteger(expected)) {
      console.error(`lint-guard-vacuity: --check requires an integer argument`);
      return 1;
    }
    const { ok, message } = evaluateCheck(report, expected);
    if (ok) {
      console.log(`lint-guard-vacuity: ${message}`);
      return 0;
    }
    console.error(`lint-guard-vacuity: ${message}`);
    return 1;
  }

  console.log(summaryLine(report));
  return 0;
}

function resolveRepoRoot(): string {
  return join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
  } catch {
    return false;
  }
})();

if (isMain) {
  process.exit(run(resolveRepoRoot(), process.argv.slice(2)));
}
