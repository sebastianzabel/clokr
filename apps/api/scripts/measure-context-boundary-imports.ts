#!/usr/bin/env -S pnpm exec tsx
/**
 * Phase 101B Plan 01 (AC-1/AC-6, D-06/D-07) — the instrument the whole phase's later waves are
 * measured against. GitHub issue #101 (T6, "ESLint-Boundaries — fremde Kontext-Interna
 * maschinell verbieten").
 *
 * ── WHAT THIS MEASURES ──────────────────────────────────────────────────────────────────────────
 * Every relative module specifier in `apps/api/src/**\/*.ts` PRODUCTION code (any path segment
 * `__tests__` and any `*.test.ts` file are skipped — Owner decision #246: tests stay out of scope
 * for this rule) that RESOLVES into `src/contexts/<x>/**` for a context `<x>` that is not the
 * importing file's own area. A specifier resolving to `src/contexts/<x>/index.ts` is a LEGAL
 * import through the context's public surface (Phase 100b) and is not counted. Everything else
 * that resolves deeper is a DEEP import — the thing ADR 0001 rule 3 forbids and this phase's
 * ESLint rule (plan 02) will start rejecting. WORKLOAD is DEEP minus whatever
 * `context-boundary-import-exceptions.json` names as an exception (today: only `src/app.ts`, the
 * composition root, D-01/Form C).
 *
 * ── WHY `services/clock` / `services/phorest` ARE NOT A FOURTH AREA (ADR 0001 entry F) ────────────
 * Entry F states Zeiterfassung is `contexts/time-tracking/` AND `services/clock/`, and
 * Schichtplanung is `contexts/scheduling/` AND `services/phorest/` — two physical trees, one
 * context each. `classifyArea()` below encodes exactly that. Getting this wrong would invent two
 * false violations — `services/clock/resolver.ts` and `services/phorest/sync-shifts.ts` reading
 * their OWN context's internals, merely because the path happens to spell a different context's
 * name nowhere near it.
 *
 * ── WHY THIS DOES NOT RE-IMPLEMENT SPECIFIER EXTRACTION (AC-6, blind-spot inventory) ───────────────
 * `extractSpecifiers`/`resolveSpecifier` are imported from `./check-import-targets.ts`, not
 * rebuilt. That is what makes all four specifier forms (`from`, dynamic `import()`, `vi.mock()`,
 * `typeof import()`) and the NodeNext `.js` -> `.ts` resolution free instead of four separate blind
 * spots. The single most consequential blind spot in this tree (CONTEXT.md `<specifics>`,
 * RESEARCH.md "Blind-spot inventory" #2): most cross-context specifiers written FROM INSIDE
 * `contexts/` never repeat the literal segment `contexts/` — a file in `contexts/scheduling/`
 * importing `contexts/absence/` writes `from "../../absence"`, not `from "../../contexts/absence"`.
 * This tool classifies by the RESOLVED path, never by a substring match on the specifier text, so
 * that distinction is structurally impossible to get wrong here the way a naive `contexts/<name>`
 * glob would (RESEARCH.md "Anti-Patterns to Avoid").
 *
 * The five context names are a literal array (`BOUNDARY_CONTEXTS`), never a lowercase-letter-only
 * character class — `time-tracking` and `working-time-account` both carry a hyphen, and this repo
 * has made exactly this hyphen-blind mistake four times in one night (CONTEXT.md `<specifics>`).
 *
 * ── HOUSE-FORM NOTES ─────────────────────────────────────────────────────────────────────────────
 * Structured after `measure-foreign-context-access.ts`: Part A is exported pure-ish helpers (file
 * I/O confined to a handful of named `scan*`/`load*` functions so `__tests__/` can drive everything
 * else against a fixture directory); Part B is a `main()` guarded by the
 * `import.meta.url === pathToFileURL(process.argv[1]).href` check (Issue #203 — an unguarded
 * `main()` once dropped a suite's own worker databases; this script only reads, but the guard is
 * the house rule, not a database-specific precaution).
 *
 * The exceptions file mirrors `foreign-context-access-exceptions.json`'s validation shape
 * (mandatory `reason` >= `MIN_REASON_LENGTH` characters, staleness detection) but supports TWO
 * exception kinds (D-04): a `wholeFile` entry (matched by file, its count checked by EQUALITY
 * against `expectedCount` — today only `src/app.ts`, the composition root) and a per-site entry
 * (matched by file + exact specifier text — added by plan 04 onward, for E-1..E-5/E-7/E-8).
 *
 * ── Flags ────────────────────────────────────────────────────────────────────────────────────────
 *   (none)               Print the one-line summary and exit 0.
 *   --check <n>          Exit 0 iff WORKLOAD equals <n> EXACTLY (equality, not a floor — a
 *                         DECREASE is exactly as much a mismatch as an increase); otherwise print
 *                         the delta and the workload file list and exit 1.
 *   --rows               `file:line | form | fromArea -> target/targetModule | {symbols}` for every
 *                         workload row, sorted by target then file then line.
 *   --by-target          Workload count and importer-file count per target context, descending —
 *                         the unit each later wave (plans 05-09) converts.
 *   --forms               Workload count per import form. `no-restricted-imports` (plan 02) cannot
 *                         see the `dynamic-import` form (RESEARCH.md, live-probed) — the count on
 *                         that line is the exact size of the gap only THIS tool covers.
 *   --predict <context>  Before the named context's wave runs, print
 *                         `deep=<n> files=<m> files-already-importing-index=<k>
 *                         predicted-import-targets-delta=-(n-(m-k))` — the expected change to
 *                         `lint:import-targets`'s specifier count under the wave's merge rule (one
 *                         import statement per (file, target) pair, merged into an existing index
 *                         import when the file already has one).
 *
 * Exit codes:
 *   0 — summary/--rows/--by-target/--forms/--predict printed, or --check matched
 *   1 — the exceptions file is invalid (bad shape, short/missing reason, stale entry, count
 *       mismatch on a wholeFile entry), an unknown target was passed to --predict, or --check did
 *       not match
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as ts from "typescript";
import {
  extractSpecifiers,
  resolveSpecifier,
  type SpecifierOccurrence,
} from "./check-import-targets";

// ── Part A: exported pure-ish helpers (file I/O confined to scan*/load*) ───────────────────────

/** The five contexts this rule protects (ADR 0001 §3). A literal array, never a regex character
 * class — see the module docblock's hyphen warning. */
export const BOUNDARY_CONTEXTS = [
  "platform",
  "time-tracking",
  "absence",
  "scheduling",
  "working-time-account",
] as const;
export type BoundaryContext = (typeof BOUNDARY_CONTEXTS)[number];

const BOUNDARY_CONTEXT_SET: ReadonlySet<string> = new Set(BOUNDARY_CONTEXTS);

export function isBoundaryContext(value: string): value is BoundaryContext {
  return BOUNDARY_CONTEXT_SET.has(value);
}

/** Where an importing FILE sits: one of the five contexts, the cross-context `composition/`
 * layer, or `"other"` (`app.ts`, `middleware/`, `utils/`, `index.ts`, `config.ts`, …). */
export type FileArea = BoundaryContext | "composition" | "other";

/**
 * Classifies a file by where it sits, given a path relative to `apps/api` (POSIX, WITH the
 * leading `src/` — this is the same convention `SpecifierOccurrence.file` already uses in
 * `check-import-targets.ts`). Encodes ADR 0001 entry F exhaustively:
 * `src/contexts/<x>/**` -> `<x>` (only for `<x>` in `BOUNDARY_CONTEXTS`, else `"other"`);
 * `src/services/clock/**` -> `"time-tracking"`; `src/services/phorest/**` -> `"scheduling"`;
 * `src/composition/**` -> `"composition"`; anything else (`src/app.ts`, `src/middleware/**`,
 * `src/utils/**`, `src/index.ts`, `src/config.ts`, `src/services/**` outside clock/phorest) ->
 * `"other"`.
 */
export function classifyArea(repoRelToApiRoot: string): FileArea {
  if (repoRelToApiRoot.startsWith("src/contexts/")) {
    const seg = repoRelToApiRoot.split("/")[2];
    return isBoundaryContext(seg) ? seg : "other";
  }
  if (repoRelToApiRoot.startsWith("src/services/clock/")) return "time-tracking";
  if (repoRelToApiRoot.startsWith("src/services/phorest/")) return "scheduling";
  if (repoRelToApiRoot.startsWith("src/composition/")) return "composition";
  return "other";
}

// ── File discovery: production code only (D-06's own scope, distinct from check-import-targets's
// broader src+scripts+vitest* walk, which deliberately DOES include tests for ITS purpose) ─────

const SKIP_DIR_NAMES = new Set(["__tests__", "node_modules", "dist", ".git"]);

function walkProductionTsFiles(absDir: string, apiRoot: string, out: string[]): void {
  for (const entry of readdirSync(absDir)) {
    if (SKIP_DIR_NAMES.has(entry)) continue;
    const full = join(absDir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkProductionTsFiles(full, apiRoot, out);
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    out.push(relative(apiRoot, full).split(sep).join("/"));
  }
}

/** Every production `.ts` file under `apps/api/src` (Owner decision #246: `__tests__/` and
 * `*.test.ts` are out of scope), as paths relative to `apiRoot` WITH the leading `src/`. */
export function discoverProductionFiles(apiRoot: string): string[] {
  const out: string[] = [];
  const srcRoot = join(apiRoot, "src");
  walkProductionTsFiles(srcRoot, apiRoot, out);
  return out.sort();
}

// ── Symbol extraction (D-06's row shape) ────────────────────────────────────────────────────────

/** `propertyName ?? name`, prefixed `"type "` when the element or the whole clause is type-only. */
function bindingLabel(
  element: { propertyName?: ts.Identifier; name: ts.Identifier; isTypeOnly?: boolean },
  clauseIsTypeOnly: boolean,
): string {
  const base = (element.propertyName ?? element.name).text;
  return clauseIsTypeOnly || element.isTypeOnly ? `type ${base}` : base;
}

/**
 * Maps `${line}::${specifier}` (of a "from"-form ImportDeclaration/ExportDeclaration) to the
 * named bindings it pulls, exactly as D-06 specifies: `NamedImports`/`NamedExports` elements via
 * `propertyName ?? name`, prefixed `"type "` for a type-only element or a type-only whole clause.
 * `["*"]` for a bare `export * from` (no `exportClause` at all — D-09 says this SHOULD never
 * happen in a context's own `index.ts`, but a caller's `export * from` elsewhere must not crash
 * this tool). Only forms that are actual import/export declarations are keyed — dynamic imports,
 * `vi.mock()` and `typeof import()` never have named bindings and are handled by the caller.
 */
function buildSymbolsMap(sourceFile: ts.SourceFile): Map<string, string[]> {
  const map = new Map<string, string[]>();

  function lineOf(node: ts.Node): number {
    return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  }

  function visit(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const key = `${lineOf(node)}::${node.moduleSpecifier.text}`;
      const symbols: string[] = [];
      const clause = node.importClause;
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          symbols.push(bindingLabel(el, clause.isTypeOnly ?? false));
        }
      }
      map.set(key, symbols);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const key = `${lineOf(node)}::${node.moduleSpecifier.text}`;
      let symbols: string[];
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        symbols = node.exportClause.elements.map((el) =>
          bindingLabel(el, node.isTypeOnly ?? false),
        );
      } else {
        symbols = ["*"]; // bare `export * from "..."` — no named bindings to enumerate
      }
      map.set(key, symbols);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return map;
}

// ── The row shape and the scan itself ───────────────────────────────────────────────────────────

export interface BoundaryImport {
  /** Repo-relative to `apps/api`, e.g. "src/contexts/absence/api/leave.ts". */
  file: string;
  line: number;
  /** Raw specifier text, as written. */
  specifier: string;
  form: SpecifierOccurrence["form"];
  fromArea: FileArea;
  target: BoundaryContext;
  /** Path inside the target context, e.g. "timezone.ts", "api/leave.ts". */
  targetModule: string;
  /** Named bindings pulled by this import; `[]` for a dynamic import / vi.mock / typeof-import. */
  symbols: string[];
}

export interface BoundaryScan {
  /** Every DEEP cross-context import in production code — before any exception is applied. */
  deepImports: BoundaryImport[];
  /** For every file that has AT LEAST ONE specifier resolving to a context's own `index.ts`, the
   * set of contexts it already imports that way. Used by `--predict` (D-07's merge-rule delta). */
  indexImportsByFile: Map<string, ReadonlySet<BoundaryContext>>;
}

/**
 * Walks every production file under `apiRoot/src`, extracts every relative specifier (all four
 * forms, via `./check-import-targets.ts`), resolves it, and classifies it. A resolved specifier
 * that lands outside `src/contexts/<x>/**` for a `BOUNDARY_CONTEXTS` member is ignored entirely
 * (it is not a context-boundary crossing at all). One that lands on `<x>/index.ts` is recorded in
 * `indexImportsByFile` and is NOT a deep import. One that lands deeper, for an `<x>` that is not
 * the importing file's OWN area, is a deep import.
 */
export function scanApiRoot(apiRoot: string): BoundaryScan {
  const deepImports: BoundaryImport[] = [];
  const indexImportsByFile = new Map<string, Set<BoundaryContext>>();

  for (const relFile of discoverProductionFiles(apiRoot)) {
    const absFile = join(apiRoot, relFile);
    const fromArea = classifyArea(relFile);
    const text = readFileSync(absFile, "utf8");
    const sourceFile = ts.createSourceFile(absFile, text, ts.ScriptTarget.Latest, true);
    const symbolsMap = buildSymbolsMap(sourceFile);
    const occurrences = extractSpecifiers(sourceFile, relFile);

    for (const occ of occurrences) {
      const resolved = resolveSpecifier(absFile, occ.specifier);
      if (!resolved) continue; // unresolvable specifiers are `lint:import-targets`'s problem
      const resolvedRel = relative(apiRoot, resolved).split(sep).join("/");
      if (!resolvedRel.startsWith("src/contexts/")) continue;

      const parts = resolvedRel.split("/"); // ["src", "contexts", "<x>", ...]
      const targetSeg = parts[2];
      if (!isBoundaryContext(targetSeg)) continue;

      const targetModule = parts.slice(3).join("/");
      if (targetModule === "index.ts") {
        const set = indexImportsByFile.get(relFile) ?? new Set<BoundaryContext>();
        set.add(targetSeg);
        indexImportsByFile.set(relFile, set);
        continue; // legal — through the public surface
      }

      if (targetSeg === fromArea) continue; // own context, not a crossing

      const key = `${occ.line}::${occ.specifier}`;
      const symbols = occ.form === "from" ? (symbolsMap.get(key) ?? []) : [];
      deepImports.push({
        file: relFile,
        line: occ.line,
        specifier: occ.specifier,
        form: occ.form,
        fromArea,
        target: targetSeg,
        targetModule,
        symbols,
      });
    }
  }

  return { deepImports, indexImportsByFile };
}

// ── Exceptions file (D-04: two kinds), validated like foreign-context-access-exceptions.json ────

export const EXCEPTIONS_FILE = "apps/api/scripts/context-boundary-import-exceptions.json";

export const MIN_REASON_LENGTH = 30;

export interface WholeFileException {
  id: string;
  file: string;
  wholeFile: true;
  expectedCount: number;
  reason: string;
  disappearsIn: string;
}

export interface PerSiteException {
  id: string;
  file: string;
  specifier: string;
  reason: string;
  disappearsIn: string;
}

export type BoundaryException = WholeFileException | PerSiteException;

export interface ExceptionsDocument {
  registerSource: string;
  exceptions: BoundaryException[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const WHOLE_FILE_KEYS = new Set([
  "id",
  "file",
  "wholeFile",
  "expectedCount",
  "reason",
  "disappearsIn",
]);
const PER_SITE_KEYS = new Set(["id", "file", "specifier", "reason", "disappearsIn"]);

/**
 * Validates a raw (untyped) exceptions document against the CURRENT deep-import set — structural
 * shape, mandatory `reason` (>= `MIN_REASON_LENGTH` characters), no unknown keys, and staleness:
 * a `wholeFile` entry's `expectedCount` is checked against the ACTUAL count of deep imports in
 * that file BY EQUALITY (a 46th deep import in `app.ts` is a finding, not a silently absorbed
 * one — this equality check IS the staleness check for this kind); a per-site entry is stale if
 * no current deep import matches its `file` + `specifier` exactly (the call may have moved or
 * been fixed).
 */
export function validateExceptionsDocument(
  raw: unknown,
  deepImports: readonly BoundaryImport[],
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

  const countByFile = new Map<string, number>();
  for (const d of deepImports) {
    countByFile.set(d.file, (countByFile.get(d.file) ?? 0) + 1);
  }
  const deepByFileAndSpecifier = new Set<string>();
  for (const d of deepImports) deepByFileAndSpecifier.add(`${d.file}::${d.specifier}`);

  const validEntries: BoundaryException[] = [];

  (exceptions as unknown[]).forEach((entry, index) => {
    const label = isRecord(entry) && typeof entry.id === "string" ? entry.id : `entry #${index}`;

    if (!isRecord(entry)) {
      errors.push(`${label}: entry is not an object`);
      return;
    }
    const { id, file, reason, disappearsIn } = entry;
    if (typeof id !== "string" || id.length === 0) {
      errors.push(`${label}: missing or invalid 'id'`);
      return;
    }
    if (typeof file !== "string" || file.length === 0) {
      errors.push(`${label}: missing or invalid 'file'`);
      return;
    }
    if (typeof reason !== "string" || reason.trim().length === 0) {
      errors.push(`${label}: missing 'reason' — every exception MUST name WHY it exists`);
      return;
    }
    if (reason.trim().length < MIN_REASON_LENGTH) {
      errors.push(
        `${label}: 'reason' is only ${reason.trim().length} character(s) — must read as a ` +
          `sentence, not a label (minimum ${MIN_REASON_LENGTH})`,
      );
      return;
    }
    if (typeof disappearsIn !== "string" || disappearsIn.trim().length === 0) {
      errors.push(`${label}: missing 'disappearsIn' — every exception MUST name its exit point`);
      return;
    }

    const isWholeFile = entry.wholeFile === true;
    if (isWholeFile) {
      const unknownKeys = Object.keys(entry).filter((k) => !WHOLE_FILE_KEYS.has(k));
      if (unknownKeys.length > 0) {
        errors.push(`${label}: unknown key(s) on a wholeFile entry: ${unknownKeys.join(", ")}`);
        return;
      }
      const { expectedCount } = entry;
      if (
        typeof expectedCount !== "number" ||
        !Number.isInteger(expectedCount) ||
        expectedCount < 0
      ) {
        errors.push(`${label}: 'expectedCount' must be a non-negative integer`);
        return;
      }
      const actual = countByFile.get(file) ?? 0;
      if (actual !== expectedCount) {
        errors.push(
          `${label}: STALE — ${file} has ${actual} deep import(s) today, expectedCount says ` +
            `${expectedCount}. A count that moved without this file being updated is a finding, ` +
            `not something to silently re-baseline.`,
        );
        return;
      }
      validEntries.push({
        id,
        file,
        wholeFile: true,
        expectedCount,
        reason: reason.trim(),
        disappearsIn: disappearsIn.trim(),
      });
      return;
    }

    if (typeof entry.specifier !== "string" || entry.specifier.length === 0) {
      errors.push(`${label}: entry must have either 'wholeFile: true' or a 'specifier' string`);
      return;
    }
    const unknownKeys = Object.keys(entry).filter((k) => !PER_SITE_KEYS.has(k));
    if (unknownKeys.length > 0) {
      errors.push(`${label}: unknown key(s) on a per-site entry: ${unknownKeys.join(", ")}`);
      return;
    }
    const specifier = entry.specifier;
    if (!deepByFileAndSpecifier.has(`${file}::${specifier}`)) {
      errors.push(
        `${label}: STALE — no current deep import in ${file} matches specifier "${specifier}"; ` +
          `it may have moved or been fixed — update or remove it`,
      );
      return;
    }
    validEntries.push({
      id,
      file,
      specifier,
      reason: reason.trim(),
      disappearsIn: disappearsIn.trim(),
    });
  });

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    doc: { registerSource: (registerSource as string).trim(), exceptions: validEntries },
  };
}

export function loadExceptionsRaw(repoRoot: string): unknown {
  const abs = join(repoRoot, EXCEPTIONS_FILE);
  return JSON.parse(readFileSync(abs, "utf8"));
}

/** Is `row` covered by any exception in `doc`? A `wholeFile` exception covers EVERY row in that
 * file, regardless of specifier; a per-site exception covers only its exact file + specifier. */
export function isExcepted(row: BoundaryImport, doc: ExceptionsDocument): boolean {
  return doc.exceptions.some(
    (e) => e.file === row.file && ("wholeFile" in e ? e.wholeFile : e.specifier === row.specifier),
  );
}

export interface WorkloadResult {
  workload: BoundaryImport[];
  excepted: BoundaryImport[];
}

export function computeWorkload(
  deepImports: readonly BoundaryImport[],
  doc: ExceptionsDocument,
): WorkloadResult {
  const excepted = deepImports.filter((d) => isExcepted(d, doc));
  const workload = deepImports.filter((d) => !isExcepted(d, doc));
  return { workload, excepted };
}

// ── Rendering ────────────────────────────────────────────────────────────────────────────────────

export function summaryLine(deepTotal: number, result: WorkloadResult): string {
  return (
    `[measure:boundary-imports] ${deepTotal} deep import(s) total, workload ${result.workload.length} ` +
    `(${result.excepted.length} excepted).`
  );
}

export function renderRows(result: WorkloadResult): string {
  return result.workload
    .slice()
    .sort(
      (a, b) => a.target.localeCompare(b.target) || a.file.localeCompare(b.file) || a.line - b.line,
    )
    .map(
      (r) =>
        `${r.file}:${r.line} | ${r.form} | ${r.fromArea} -> ${r.target}/${r.targetModule} | ` +
        `{${r.symbols.join(", ")}}`,
    )
    .join("\n");
}

export function renderByTarget(result: WorkloadResult): string {
  const counts = new Map<BoundaryContext, { total: number; files: Set<string> }>();
  for (const r of result.workload) {
    const c = counts.get(r.target) ?? { total: 0, files: new Set<string>() };
    c.total++;
    c.files.add(r.file);
    counts.set(r.target, c);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]))
    .map(([target, c]) => `${target} ${c.total} (${c.files.size} file(s))`)
    .join("\n");
}

export function renderForms(result: WorkloadResult): string {
  const counts = new Map<string, number>();
  for (const r of result.workload) counts.set(r.form, (counts.get(r.form) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([form, n]) => `${form} ${n}`)
    .join("\n");
}

export interface PredictResult {
  deep: number;
  files: number;
  filesAlreadyImportingIndex: number;
  predictedImportTargetsDelta: number;
}

/**
 * D-07's per-wave predicted `lint:import-targets` delta. `n` = workload deep imports into
 * `context`; `m` = distinct importer files among those; `k` = how many of those `m` files ALREADY
 * import `context`'s index (any symbol) today. Under the wave's merge rule (one import statement
 * per (file, target), merged into an existing index import when present), each of the `k` files'
 * deep specifiers disappear into an already-counted statement (net `-n_i` each); each of the
 * `m - k` files' deep specifiers collapse into exactly ONE new statement (net `-(n_j - 1)` each).
 * Summed: `-(n - (m - k))`.
 */
export function predict(
  scan: BoundaryScan,
  workload: readonly BoundaryImport[],
  context: BoundaryContext,
): PredictResult {
  const rows = workload.filter((r) => r.target === context);
  const files = new Set(rows.map((r) => r.file));
  const filesAlreadyImportingIndex = [...files].filter((f) =>
    scan.indexImportsByFile.get(f)?.has(context),
  ).length;
  const deep = rows.length;
  const m = files.size;
  const k = filesAlreadyImportingIndex;
  return {
    deep,
    files: m,
    filesAlreadyImportingIndex: k,
    predictedImportTargetsDelta: -(deep - (m - k)),
  };
}

// ── Part B: CLI entry point ──────────────────────────────────────────────────────────────────────

function run(repoRoot: string, argv: string[]): number {
  const apiRoot = join(repoRoot, "apps/api");
  const scan = scanApiRoot(apiRoot);

  const raw = loadExceptionsRaw(repoRoot);
  const validated = validateExceptionsDocument(raw, scan.deepImports);
  if (!validated.ok) {
    console.error(`measure-context-boundary-imports: ${EXCEPTIONS_FILE} is invalid:`);
    for (const e of validated.errors) console.error(`  - ${e}`);
    return 1;
  }
  const result = computeWorkload(scan.deepImports, validated.doc);

  if (argv.includes("--rows")) {
    console.log(renderRows(result));
    return 0;
  }
  if (argv.includes("--by-target")) {
    console.log(renderByTarget(result));
    return 0;
  }
  if (argv.includes("--forms")) {
    console.log(renderForms(result));
    return 0;
  }
  const predictIdx = argv.indexOf("--predict");
  if (predictIdx !== -1) {
    const context = argv[predictIdx + 1];
    if (!context || !isBoundaryContext(context)) {
      console.error(
        `measure-context-boundary-imports: --predict requires one of: ${BOUNDARY_CONTEXTS.join(", ")}`,
      );
      return 1;
    }
    const p = predict(scan, result.workload, context);
    console.log(
      `deep=${p.deep} files=${p.files} files-already-importing-index=${p.filesAlreadyImportingIndex} ` +
        `predicted-import-targets-delta=${p.predictedImportTargetsDelta}`,
    );
    return 0;
  }

  const checkIdx = argv.indexOf("--check");
  if (checkIdx !== -1) {
    const expected = Number(argv[checkIdx + 1]);
    if (!Number.isInteger(expected)) {
      console.error(`measure-context-boundary-imports: --check requires an integer argument`);
      return 1;
    }
    console.log(summaryLine(scan.deepImports.length, result));
    if (result.workload.length === expected) return 0;
    const delta = result.workload.length - expected;
    console.error(
      `measure-context-boundary-imports: --check ${expected} FAILED — actual workload is ` +
        `${result.workload.length} (${delta > 0 ? "+" : ""}${delta}). Files in the current ` +
        `workload:\n` +
        [...new Set(result.workload.map((r) => r.file))].sort().join("\n"),
    );
    return 1;
  }

  console.log(summaryLine(scan.deepImports.length, result));
  return 0;
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
  process.exit(run(repoRoot, process.argv.slice(2)));
}
